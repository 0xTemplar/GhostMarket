/**
 * lit-client.ts — Lit Protocol execution client for settlement signing.
 *
 * Provides `signSettlement()` which either:
 *   A) Executes the registered Lit Action via a Lit PKP (production path), or
 *   B) Signs with SETTLEMENT_SIGNER_PRIVATE_KEY directly (demo / dev fallback).
 *
 * The fallback is identical to what simulate-settlement.ts does and is
 * sufficient for testnet demos.  Switch to the Lit path by setting
 * LIT_PKP_PUBLIC_KEY, LIT_PKP_ETH_ADDRESS, and LIT_ACTION_IPFS_CID in env.
 *
 * Lit PKP setup:
 *   1. Mint a PKP: https://explorer.litprotocol.com/pkps (Datil-test network)
 *   2. Upload lit-action.js to IPFS via Pinata / NFT.Storage; get the CID
 *   3. Add a permitted action: pkp.addPermittedAction(ipfsCid) on the PKP NFT
 *   4. Set the PKP ETH address as GhostVault.settlementSigner via update-settlement-signer.ts
 *   5. Set LIT_PKP_PUBLIC_KEY, LIT_PKP_ETH_ADDRESS, LIT_ACTION_IPFS_CID in .env
 */

import { ethers }  from 'ethers';
import dotenv       from 'dotenv';
import path         from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// ── Constants ─────────────────────────────────────────────────────────────────

const SEPOLIA_RPC_URL      = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
const FLOW_RPC_URL         = process.env.FLOW_RPC_URL    ?? 'https://testnet.evm.nodes.onflow.org';
const GHOST_EAMM_ADDRESS   = process.env.GHOST_EAMM_ADDRESS ?? '';
const GHOST_VAULT_ADDRESS  = process.env.GHOST_VAULT_ADDRESS ?? '0xAf470490b2462DC7359605B8e5D731CbB7816B55';
const SETTLEMENT_SIGNER_KEY = process.env.SETTLEMENT_SIGNER_PRIVATE_KEY ?? '';

// Lit Protocol config — optional; only needed for the production PKP path
const LIT_PKP_PUBLIC_KEY   = process.env.LIT_PKP_PUBLIC_KEY   ?? '';
const LIT_PKP_ETH_ADDRESS  = process.env.LIT_PKP_ETH_ADDRESS  ?? '';
const LIT_ACTION_IPFS_CID  = process.env.LIT_ACTION_IPFS_CID  ?? '';
const LIT_NETWORK          = process.env.LIT_NETWORK           ?? 'datil-test';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SettlementSignInput {
  userAddress:     string;
  marketIdUint:    string;   // uint256 as decimal string
  marketIdBytes32: string;   // abi.encode(uint256) as 0x-prefixed hex
  nonce:           string;   // decimal string
  expiry:          string;   // unix seconds as decimal string
}

export interface SettlementSignOutput {
  sig:         string;   // 65-byte ECDSA signature (hex)
  payout:      string;   // net payout in wei (decimal string)
  nonce:       string;
  expiry:      string;
  signerAddress: string;
  path:        'lit' | 'deployer';
}

// ── ABI fragments for on-chain reads ─────────────────────────────────────────

const EAMM_ABI = [
  'function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)',
  'function hasPosition(uint256 marketId, address user) external view returns (bool)',
  'event BetPlaced(uint256 indexed marketId, address indexed user, bool side)',
  // Pool totals — available as public mappings on GhostEAMM
  'function totalYesStake(uint256 marketId) external view returns (uint256)',
  'function totalNoStake(uint256 marketId) external view returns (uint256)',
];

const VAULT_ABI = [
  'function lockedAmounts(address user, bytes32 marketId) external view returns (uint256)',
  'function settlementSigner() external view returns (address)',
];

// ── Signing helper (must exactly match GhostVault._recoverSigner) ─────────────

export async function buildSettlementSignature(
  signer:       ethers.Wallet,
  user:         string,
  marketIdBytes32: string,
  payout:       bigint,
  nonce:        bigint,
  expiry:       bigint,
  vaultAddress: string,
): Promise<string> {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'bytes32', 'uint256', 'uint256', 'uint256', 'address'],
      [user, marketIdBytes32, payout, nonce, expiry, vaultAddress],
    ),
  );
  return signer.signMessage(ethers.getBytes(inner));
}

// ── On-chain reads ─────────────────────────────────────────────────────────────

async function readOnChainSettlementData(input: SettlementSignInput) {
  const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const flowProvider    = new ethers.JsonRpcProvider(FLOW_RPC_URL);

  const eamm  = new ethers.Contract(GHOST_EAMM_ADDRESS, EAMM_ABI, sepoliaProvider);
  const vault = new ethers.Contract(GHOST_VAULT_ADDRESS, VAULT_ABI, flowProvider);

  // Market outcome
  const [status, outcome] = await eamm.getMarketMeta(BigInt(input.marketIdUint));
  if (Number(status) !== 1) {
    throw new Error(`Market ${input.marketIdUint} is not resolved (status: ${status})`);
  }

  // User's bet side — read from BetPlaced events
  const filter = eamm.filters.BetPlaced(BigInt(input.marketIdUint), input.userAddress);
  const logs   = await eamm.queryFilter(filter);
  if (logs.length === 0) {
    throw new Error(`No bet found for user ${input.userAddress} in market ${input.marketIdUint}`);
  }
  const latestLog = logs[logs.length - 1] as ethers.EventLog;
  const userSide  = latestLog.args[2] as boolean; // BetPlaced.side

  // Locked collateral from GhostVault
  const lockedAmount: bigint = await vault.lockedAmounts(input.userAddress, input.marketIdBytes32);

  // Pool totals from GhostEAMM (public mappings)
  let totalYesPool = 0n;
  let totalNoPool  = 0n;
  try {
    totalYesPool = await eamm.totalYesStake(BigInt(input.marketIdUint));
    totalNoPool  = await eamm.totalNoStake(BigInt(input.marketIdUint));
  } catch {
    // Function may not be present on older contract versions — fallback to 1:1 payout
    console.warn('[Settlement] totalYesStake/totalNoStake not available — using 1:1 payout');
    totalYesPool = lockedAmount;
    totalNoPool  = lockedAmount;
  }

  return { outcome, userSide, lockedAmount, totalYesPool, totalNoPool };
}

// ── Payout computation ─────────────────────────────────────────────────────────

function computePayout(
  outcome:      boolean,
  userSide:     boolean,
  lockedAmount: bigint,
  totalYesPool: bigint,
  totalNoPool:  bigint,
): bigint {
  const userWon    = userSide === outcome;
  if (!userWon) return 0n;

  const winnerPool = outcome ? totalYesPool : totalNoPool;
  const loserPool  = outcome ? totalNoPool  : totalYesPool;

  if (winnerPool === 0n) return lockedAmount; // safety: just return stake
  return lockedAmount + (lockedAmount * loserPool / winnerPool);
}

// ── Lit Action path ────────────────────────────────────────────────────────────

async function signViaLitAction(input: SettlementSignInput): Promise<SettlementSignOutput> {
  // Dynamically require @lit-protocol packages so the oracle can start even when
  // they are not installed (the fallback deployer-key path is used in that case).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const litNodeClientPkg  = require('@lit-protocol/lit-node-client') as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authHelpersPkg    = require('@lit-protocol/auth-helpers') as Record<string, unknown>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const LitNodeClientCtor = litNodeClientPkg['LitNodeClient'] as new (opts: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const LitActionResource = authHelpersPkg['LitActionResource'] as new (pattern: string) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const LitAbility        = authHelpersPkg['LitAbility'] as Record<string, string>;

  const litNodeClient = new LitNodeClientCtor({ litNetwork: LIT_NETWORK });
  await litNodeClient.connect();

  const sessionSigs = await litNodeClient.getSessionSigs({
    chain:              'ethereum',
    expiration:         new Date(Date.now() + 3_600_000).toISOString(),
    resourceAbilityRequests: [
      {
        resource: new LitActionResource('*'),
        ability:  LitAbility['LitActionExecution'],
      },
    ],
  });

  const response = await litNodeClient.executeJs({
    ipfsId:      LIT_ACTION_IPFS_CID,
    sessionSigs,
    jsParams: {
      userAddress:     input.userAddress,
      marketIdUint:    input.marketIdUint,
      marketIdBytes32: input.marketIdBytes32,
      eammAddress:     GHOST_EAMM_ADDRESS,
      vaultAddress:    GHOST_VAULT_ADDRESS,
      sepoliaRpc:      SEPOLIA_RPC_URL,
      flowRpc:         FLOW_RPC_URL,
      nonce:           input.nonce,
      expiry:          input.expiry,
      pkpPublicKey:    LIT_PKP_PUBLIC_KEY,
    },
  });

  const actionResponse = JSON.parse(response.response as string);
  if (actionResponse.error) throw new Error(`Lit Action error: ${actionResponse.error}`);

  // The signature is returned in response.signatures['settlement']
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sigShare = (response.signatures as Record<string, any>)?.['settlement'];
  if (!sigShare) throw new Error('Lit Action did not return a signature');

  // Reconstruct 65-byte ECDSA sig from r, s, v
  const r   = sigShare.r.startsWith('0x') ? sigShare.r : '0x' + sigShare.r;
  const s   = sigShare.s.startsWith('0x') ? sigShare.s : '0x' + sigShare.s;
  const v   = sigShare.recid ? 28 : 27;
  const sig = ethers.concat([r, s, `0x${v.toString(16).padStart(2, '0')}`]);

  await litNodeClient.disconnect();

  return {
    sig:           ethers.hexlify(sig),
    payout:        actionResponse.payout,
    nonce:         input.nonce,
    expiry:        input.expiry,
    signerAddress: LIT_PKP_ETH_ADDRESS,
    path:          'lit',
  };
}

// ── Deployer key fallback path ─────────────────────────────────────────────────

async function signViaDeployerKey(input: SettlementSignInput): Promise<SettlementSignOutput> {
  if (!SETTLEMENT_SIGNER_KEY) {
    throw new Error('SETTLEMENT_SIGNER_PRIVATE_KEY not set and Lit Protocol not configured');
  }

  const signer = new ethers.Wallet(SETTLEMENT_SIGNER_KEY);

  // Read on-chain data to compute the correct payout
  const { outcome, userSide, lockedAmount, totalYesPool, totalNoPool } =
    await readOnChainSettlementData(input);

  const payout = computePayout(outcome, userSide, lockedAmount, totalYesPool, totalNoPool);

  const sig = await buildSettlementSignature(
    signer,
    input.userAddress,
    input.marketIdBytes32,
    payout,
    BigInt(input.nonce),
    BigInt(input.expiry),
    GHOST_VAULT_ADDRESS,
  );

  return {
    sig,
    payout:        payout.toString(),
    nonce:         input.nonce,
    expiry:        input.expiry,
    signerAddress: signer.address,
    path:          'deployer',
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Sign a settlement message for a user claiming their payout.
 *
 * Uses the Lit Action PKP when LIT_PKP_PUBLIC_KEY, LIT_PKP_ETH_ADDRESS, and
 * LIT_ACTION_IPFS_CID are all set.  Falls back to SETTLEMENT_SIGNER_PRIVATE_KEY
 * for testnet demos.
 */
export async function signSettlement(input: SettlementSignInput): Promise<SettlementSignOutput> {
  const litConfigured =
    LIT_PKP_PUBLIC_KEY.length > 0 &&
    LIT_PKP_ETH_ADDRESS.length > 0 &&
    LIT_ACTION_IPFS_CID.length > 0;

  if (litConfigured) {
    try {
      console.log('[Lit] Executing settlement Lit Action via PKP…');
      return await signViaLitAction(input);
    } catch (err) {
      console.warn('[Lit] Lit Action failed, falling back to deployer key:', (err as Error).message);
    }
  }

  console.log('[Settlement] Signing with deployer key (set Lit env vars for production)');
  return signViaDeployerKey(input);
}

/**
 * Build a fresh nonce + expiry pair for a settlement request.
 * Nonce = Date.now() in milliseconds ensures uniqueness across claims.
 * Expiry = 24 hours from now (long enough for a user to submit on-chain).
 */
export function freshNonceExpiry(): { nonce: string; expiry: string } {
  return {
    nonce:  Date.now().toString(),
    expiry: (Math.floor(Date.now() / 1000) + 86_400).toString(), // 24 h
  };
}
