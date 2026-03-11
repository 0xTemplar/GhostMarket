/**
 * erc8004-client.ts
 *
 * Interacts with deployed ERC-8004 registries on Ethereum Sepolia.
 *
 * Identity Registry  : 0x8004A818BFB912233c491871b3d84c89A494BD9e
 * Reputation Registry: 0x8004B663056A597Dffe9eCcC1965A193B7388713
 *
 * ERC-8004 is mandatory for:
 *  - "Agent Only: Let the agent cook" track ($16,000 prize pool) — requires
 *    each agent to register a unique ERC-8004 identity
 *  - "Agents With Receipts — 8004" dedicated track
 *
 * Our 7 oracle agents are perfect ERC-8004 citizens: they have autonomous
 * decision loops, build reputation through quorum participation, and are
 * slashable for incorrect votes.
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

// ── Deployed ERC-8004 contract addresses (Sepolia) ────────────────────────────

const IDENTITY_REGISTRY_ADDRESS  = process.env.ERC8004_IDENTITY_REGISTRY
  ?? '0x8004A818BFB912233c491871b3d84c89A494BD9e';

const REPUTATION_REGISTRY_ADDRESS = process.env.ERC8004_REPUTATION_REGISTRY
  ?? '0x8004B663056A597Dffe9eCcC1965A193B7388713';

// ── Minimal ABIs (from EIP-8004 spec) ─────────────────────────────────────────

const IDENTITY_ABI = [
  'function register(string calldata agentURI) external returns (uint256 agentId)',
  'function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external',
  'function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory)',
  'function setAgentURI(uint256 agentId, string calldata newURI) external',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
];

const REPUTATION_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external',
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
];

// ── Client ─────────────────────────────────────────────────────────────────────

function getProvider(): ethers.JsonRpcProvider {
  const url = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
  return new ethers.JsonRpcProvider(url, { chainId: 11155111, name: 'sepolia' });
}

function getSigner(): ethers.Wallet {
  const key = process.env.SEPOLIA_PRIVATE_KEY ?? process.env.CALIBRATION_PRIVATE_KEY;
  if (!key) throw new Error('SEPOLIA_PRIVATE_KEY not set in oracle/.env');
  return new ethers.Wallet(key, getProvider());
}

function identityRegistry() {
  return new ethers.Contract(IDENTITY_REGISTRY_ADDRESS, IDENTITY_ABI, getSigner());
}

function reputationRegistry() {
  return new ethers.Contract(REPUTATION_REGISTRY_ADDRESS, REPUTATION_ABI, getSigner());
}

/**
 * Register an oracle agent in the ERC-8004 Identity Registry on Sepolia.
 *
 * The agentURI must resolve to an ERC-8004 registration file (JSON).
 * We use a data URI so the metadata is fully on-chain — no external host needed.
 *
 * @returns ERC-8004 token ID (agentId in the registry)
 */
export async function registerERC8004Agent(
  agentName: string,
  agentDescription: string,
  filecoinMetadataCid: string,
  oracleServiceEndpoint: string,
): Promise<bigint> {
  const registrationFile = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: agentName,
    description: agentDescription,
    image: 'https://ghostmarket.io/oracle-agent.png',
    services: [
      {
        name: 'web',
        endpoint: oracleServiceEndpoint,
      },
    ],
    active: true,
    supportedTrust: ['reputation', 'crypto-economic'],
    ghostmarket: {
      role: 'oracle-agent',
      filecoinMetadataCid,
      registryChain: 'filecoin-calibration',
    },
  };

  const json    = JSON.stringify(registrationFile);
  const encoded = Buffer.from(json).toString('base64');
  const dataUri = `data:application/json;base64,${encoded}`;

  console.log(`[ERC-8004] Registering ${agentName} in Identity Registry on Sepolia...`);

  const registry = identityRegistry();
  const tx       = await registry.register(dataUri);
  const receipt  = await tx.wait();

  // Parse the Registered event to get the agentId
  const iface     = new ethers.Interface(IDENTITY_ABI);
  const eventTopic = iface.getEvent('Registered')!.topicHash;

  for (const log of receipt.logs ?? []) {
    if (log.topics[0] === eventTopic) {
      const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (decoded) {
        const agentId = decoded.args[0] as bigint;
        console.log(`[ERC-8004] ✓ ${agentName} registered → agentId: ${agentId} (tx: ${receipt.hash})`);

        // Store filecoin CID as on-chain metadata
        await setERC8004Metadata(agentId, 'filecoinCid', filecoinMetadataCid);

        return agentId;
      }
    }
  }

  throw new Error('ERC-8004 Registered event not found in receipt');
}

/**
 * Store a key-value pair in the ERC-8004 Identity Registry's on-chain metadata.
 */
export async function setERC8004Metadata(
  erc8004Id: bigint,
  key: string,
  value: string,
): Promise<void> {
  const registry = identityRegistry();
  const encoded  = ethers.toUtf8Bytes(value);
  const tx       = await registry.setMetadata(erc8004Id, key, encoded);
  await tx.wait();
  console.log(`[ERC-8004] ✓ metadata set: agentId=${erc8004Id} key=${key}`);
}

/**
 * Post a reputation score to the ERC-8004 Reputation Registry.
 *
 * value / 10^valueDecimals is the actual score (e.g. 87/0 = reputation 87/100).
 * tag1 = 'reputationScore', tag2 = 'oracle-quorum'
 */
export async function postERC8004Reputation(
  erc8004Id: bigint,
  reputationScore: number,
  evidenceCid: string,
  marketId: string | number,
): Promise<string> {
  console.log(`[ERC-8004] Posting reputation score=${reputationScore} for agentId=${erc8004Id}...`);

  const registry = reputationRegistry();

  const feedbackURI  = `ipfs://${evidenceCid}`;
  const feedbackHash = ethers.zeroPadBytes(ethers.toUtf8Bytes(evidenceCid).slice(0, 32), 32);

  const tx = await registry.giveFeedback(
    erc8004Id,
    BigInt(reputationScore),  // value
    0,                        // valueDecimals (score is already integer 0-100)
    'reputationScore',        // tag1
    `market-${marketId}`,     // tag2
    '',                       // endpoint
    feedbackURI,              // feedbackURI (points to Filecoin/Storacha evidence)
    feedbackHash,             // feedbackHash
  );

  const receipt = await tx.wait();
  console.log(`[ERC-8004] ✓ feedback posted (tx: ${receipt.hash})`);
  return receipt.hash as string;
}
