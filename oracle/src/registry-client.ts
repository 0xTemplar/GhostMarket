/**
 * registry-client.ts
 *
 * Interacts with OracleAgentRegistry.sol deployed on Filecoin Calibration testnet.
 * All oracle agent state that needs permanent, PDP-verified storage lives here.
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const CALIBRATION_RPC      = process.env.CALIBRATION_RPC_URL ?? 'https://filecoin-calibration.drpc.org';
const CALIBRATION_CHAIN_ID = 314159;
const NUMERIC_MARKET_ID_RE = /^\d+$/;

// ── Minimal ABI (mirrors OracleAgentRegistry.sol) ─────────────────────────────

const REGISTRY_ABI = [
  // Registration
  'function register(uint256 agentId, string calldata metadataCID, uint256 erc8004Id) external payable',
  'function linkERC8004(uint256 agentId, uint256 erc8004Id) external',

  // Attestation
  'function submitAttestation(uint256 agentId, uint256 marketId, bool vote, string calldata intermediateEvidenceCID) external',

  // Evidence + reputation
  'function recordEvidence(uint256 agentId, uint256 marketId, string calldata evidenceCID) external',
  'function updateReputation(uint256 agentId, string calldata repCID, uint256 newScore) external',

  // Slashing
  'function slash(uint256 agentId, string calldata slashCID) external',
  'function suspend(uint256 agentId) external',

  // Views
  'function getAgentInfo(uint256 agentId) external view returns (address owner, string memory metadataCID, uint256 stake, bool active, uint256 reputationScore, uint256 correctVotes, uint256 totalVotes, uint256 erc8004Id)',
  'function getQuorumStatus(uint256 marketId) external view returns (uint256 totalAttestations, uint256 yesVotes, uint256 noVotes, bool quorumReached, bool finalized, bool outcome)',
  'function getReputationHistory(uint256 agentId) external view returns (string[] memory)',
  'function getMarketAttesters(uint256 marketId) external view returns (uint256[] memory)',
  'function agentCount() external view returns (uint256)',

  // Events
  'event AgentRegistered(uint256 indexed agentId, address indexed owner, string metadataCID, uint256 stake, uint256 erc8004Id)',
  'event AttestationSubmitted(uint256 indexed agentId, uint256 indexed marketId, bool vote)',
  'event MarketFinalized(uint256 indexed marketId, bool outcome, uint256 yesVotes, uint256 noVotes, string evidenceBundleCID)',
  'event ReputationUpdated(uint256 indexed agentId, string repCID, uint256 newScore)',
  'event AgentSlashed(uint256 indexed agentId, uint256 slashAmount, string slashCID)',
];

// ── Provider / Signer ──────────────────────────────────────────────────────────

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(CALIBRATION_RPC, {
    chainId:  CALIBRATION_CHAIN_ID,
    name:     'filecoin-calibration',
  });
}

function getSigner(): ethers.Wallet {
  const key = process.env.CALIBRATION_PRIVATE_KEY;
  if (!key) throw new Error('CALIBRATION_PRIVATE_KEY not set in oracle/.env');
  return new ethers.Wallet(key, getProvider());
}

function getRegistryAddress(): string {
  const addr = process.env.ORACLE_REGISTRY_ADDRESS;
  if (!addr) throw new Error('ORACLE_REGISTRY_ADDRESS not set in oracle/.env');
  return addr;
}

function getRegistry(readOnly = false) {
  const provider = getProvider();
  const runner   = readOnly ? provider : getSigner();
  return new ethers.Contract(getRegistryAddress(), REGISTRY_ABI, runner);
}

let writeQueue: Promise<unknown> = Promise.resolve();

async function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => undefined);
  return next;
}

// ── Registration ───────────────────────────────────────────────────────────────

export async function registerAgent(
  agentId: number,
  metadataCID: string,
  erc8004Id: bigint,
  stakeWei: bigint = 0n,
): Promise<string> {
  return enqueueWrite(async () => {
    const registry = getRegistry();
    console.log(`[Registry] Registering agent ${agentId} with CID=${metadataCID}...`);
    const tx      = await registry.register(agentId, metadataCID, erc8004Id, { value: stakeWei });
    const receipt = await tx.wait();
    console.log(`[Registry] ✓ Agent ${agentId} registered (tx: ${receipt.hash})`);
    return receipt.hash as string;
  });
}

export async function linkERC8004(agentId: number, erc8004Id: bigint): Promise<string> {
  return enqueueWrite(async () => {
    const registry = getRegistry();
    const tx       = await registry.linkERC8004(agentId, erc8004Id);
    const receipt  = await tx.wait();
    return receipt.hash as string;
  });
}

// ── Attestation ────────────────────────────────────────────────────────────────

function marketIdToUint256(marketId: string | number): bigint {
  if (typeof marketId === 'number') return BigInt(marketId);
  const trimmed = marketId.trim();
  if (NUMERIC_MARKET_ID_RE.test(trimmed)) return BigInt(trimmed);
  // Derive a stable uint256 from an arbitrary string ID
  return BigInt(ethers.keccak256(ethers.toUtf8Bytes(trimmed)));
}

export async function submitAttestation(
  agentId: number,
  marketId: string | number,
  vote: boolean,
  storachaCid: string,
): Promise<string> {
  return enqueueWrite(async () => {
    const registry   = getRegistry();
    const marketUint = marketIdToUint256(marketId);
    console.log(`[Registry] Agent ${agentId} submitting attestation for market ${marketId} (vote: ${vote ? 'YES' : 'NO'})...`);
    try {
      const tx      = await registry.submitAttestation(agentId, marketUint, vote, storachaCid);
      const receipt = await tx.wait();
      console.log(`[Registry] ✓ Attestation recorded (tx: ${receipt.hash})`);
      return receipt.hash as string;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // These are expected in re-runs or when agent is not yet registered — not fatal.
      if (msg.includes('Already attested')) {
        console.log(`[Registry] Agent ${agentId} market ${marketId} — already attested, skipping`);
        return '';
      }
      if (msg.includes('Market finalized')) {
        // On-chain quorum was reached by earlier agents in the write queue — correct behaviour.
        console.log(`[Registry] Agent ${agentId} market ${marketId} — on-chain quorum already reached, skipping`);
        return '';
      }
      if (msg.includes('Agent not found')) {
        console.log(`[Registry] Agent ${agentId} not registered on Calibration — run register-agents.ts to fix`);
        return '';
      }
      throw err; // re-throw unexpected errors
    }
  });
}

// ── Evidence + Reputation ──────────────────────────────────────────────────────

export async function recordEvidence(
  agentId: number,
  marketId: string | number,
  evidenceCID: string,
): Promise<string> {
  return enqueueWrite(async () => {
    const registry   = getRegistry();
    const marketUint = marketIdToUint256(marketId);
    const tx         = await registry.recordEvidence(agentId, marketUint, evidenceCID);
    const receipt  = await tx.wait();
    console.log(`[Registry] ✓ Evidence CID recorded for agent ${agentId} market ${marketId}`);
    return receipt.hash as string;
  });
}

export async function updateReputation(
  agentId: number,
  repCID: string,
  newScore: number,
): Promise<string> {
  return enqueueWrite(async () => {
    const registry = getRegistry();
    console.log(`[Registry] Updating reputation for agent ${agentId} → score=${newScore}, CID=${repCID}...`);
    const tx      = await registry.updateReputation(agentId, repCID, newScore);
    const receipt = await tx.wait();
    console.log(`[Registry] ✓ Reputation updated (tx: ${receipt.hash})`);
    return receipt.hash as string;
  });
}

export async function slashAgent(agentId: number, slashCID: string): Promise<string> {
  return enqueueWrite(async () => {
    const registry = getRegistry();
    const tx       = await registry.slash(agentId, slashCID);
    const receipt  = await tx.wait();
    return receipt.hash as string;
  });
}

// ── Views ──────────────────────────────────────────────────────────────────────

export async function getAgentInfo(agentId: number) {
  const registry = getRegistry(true);
  const result   = await registry.getAgentInfo(agentId);
  return {
    owner:           result[0] as string,
    metadataCID:     result[1] as string,
    stake:           result[2] as bigint,
    active:          result[3] as boolean,
    reputationScore: Number(result[4]),
    correctVotes:    Number(result[5]),
    totalVotes:      Number(result[6]),
    erc8004Id:       result[7] as bigint,
  };
}

export async function getQuorumStatus(marketId: number) {
  const registry = getRegistry(true);
  const result   = await registry.getQuorumStatus(marketId);
  return {
    totalAttestations: Number(result[0]),
    yesVotes:          Number(result[1]),
    noVotes:           Number(result[2]),
    quorumReached:     result[3] as boolean,
    finalized:         result[4] as boolean,
    outcome:           result[5] as boolean,
  };
}

export async function getAgentCount(): Promise<number> {
  const registry = getRegistry(true);
  return Number(await registry.agentCount());
}
