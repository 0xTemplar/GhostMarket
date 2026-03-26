/**
 * settlement.ts — Post-quorum settlement delivery for GhostMarket.
 *
 * After oracle quorum finalises a market, this module:
 *   1. Stores a pending settlement record for the market.
 *   2. Provides `getOrComputeSettlement()` — called when a user requests their
 *      signed payout claim (via the REST endpoint POST /oracle/settle/:marketId).
 *   3. Delivers the settlement to Flow EVM by calling GhostVault.claimPayout()
 *      on behalf of the user when `deliverSettlementOnChain()` is called.
 *
 * Design:
 *   - Settlements are computed on-demand per user (lazy) so the oracle
 *     service doesn't need to know which users placed bets at resolution time.
 *   - Signed settlement messages are cached in memory so repeated requests
 *     from the same user return the same nonce/sig.
 *   - The oracle can optionally deliver the payout autonomously after quorum
 *     (using the deployer key as relayer) but the default path is the user
 *     submitting the signed claim themselves.
 */

import { ethers }            from 'ethers';
import type { ResolutionSession } from './types';
import { signSettlement, freshNonceExpiry } from './lit-client';
import Redis from 'ioredis';

// ── Environment ───────────────────────────────────────────────────────────────

const GHOST_VAULT_ADDRESS  = process.env.GHOST_VAULT_ADDRESS ?? '0xAf470490b2462DC7359605B8e5D731CbB7816B55';
const FLOW_RPC_URL         = process.env.FLOW_RPC_URL ?? 'https://testnet.evm.nodes.onflow.org';
const SETTLEMENT_SIGNER_KEY = process.env.SETTLEMENT_SIGNER_PRIVATE_KEY ?? '';
const SETTLEMENT_SIGNATURE_MODE = (process.env.SETTLEMENT_SIGNATURE_MODE ?? 'eip191').toLowerCase();
const ENABLE_AUTONOMOUS_SETTLEMENT_DELIVERY =
  (process.env.ENABLE_AUTONOMOUS_SETTLEMENT_DELIVERY ?? 'false').toLowerCase() === 'true';
const ORACLE_REDIS_URL      = process.env.ORACLE_REDIS_URL ?? process.env.REDIS_URL ?? '';
const VAULT_SIGNER_ABI       = ['function settlementSigner() view returns (address)'];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingSettlement {
  marketId:       string;
  userAddress:    string;
  sig:            string;
  payout:         string;   // wei as decimal string
  nonce:          string;
  expiry:         string;
  signerAddress:  string;
  signingPath:    'lit' | 'deployer';
  computedAt:     number;   // unix ms
  deliveredTx:    string | null;   // Flow EVM tx hash if oracle delivered on-chain
}

// ── In-memory settlement cache ────────────────────────────────────────────────

// settlements[marketId][userAddress] → PendingSettlement
const settlements = new Map<string, Map<string, PendingSettlement>>();
// In-memory fallback store when Redis is not configured.
// canonicalBetTxHashes[marketId][userAddress] -> betTxHash
const canonicalBetTxHashes = new Map<string, Map<string, string>>();
// in-memory fallback list of participants per market
const marketParticipants = new Map<string, Set<string>>();
let redisClient: Redis | null = null;

function canonicalTxHashKey(marketId: string, userAddress: string): string {
  return `ghost:oracle:betTxHash:${marketId}:${userAddress.toLowerCase()}`;
}

function marketParticipantsKey(marketId: string): string {
  return `ghost:oracle:marketParticipants:${marketId}`;
}

function getRedisClient(): Redis | null {
  if (!ORACLE_REDIS_URL) return null;
  if (!redisClient) {
    redisClient = new Redis(ORACLE_REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    });
  }
  return redisClient;
}

// finalized markets: marketId → { outcome, finalizedAt }
const finalizedMarkets = new Map<string, { outcome: boolean; finalizedAt: number }>();

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Mark a market as finalized after quorum.
 * Called by the oracle resolution engine.
 */
export function markMarketFinalized(marketId: string, outcome: boolean): void {
  finalizedMarkets.set(marketId, { outcome, finalizedAt: Date.now() });
  if (!settlements.has(marketId)) {
    settlements.set(marketId, new Map());
  }
}

/**
 * Register the canonical BetPlaced transaction hash for a user+market.
 * Call this at bet-placement time from the app/backend for deterministic settling.
 */
export async function registerCanonicalBetTxHash(
  marketId: string,
  userAddress: string,
  betTxHash: string,
): Promise<void> {
  const user = userAddress.toLowerCase();
  const tx   = betTxHash.toLowerCase();

  const redis = getRedisClient();
  if (redis) {
    try {
      if (redis.status === 'wait') await redis.connect();
      await redis.set(canonicalTxHashKey(marketId, user), tx);
      await redis.sadd(marketParticipantsKey(marketId), user);
      return;
    } catch (err) {
      console.warn('[Settlement] Redis write failed, using in-memory fallback:', (err as Error).message);
    }
  }

  if (!canonicalBetTxHashes.has(marketId)) canonicalBetTxHashes.set(marketId, new Map());
  canonicalBetTxHashes.get(marketId)!.set(user, tx);
  if (!marketParticipants.has(marketId)) marketParticipants.set(marketId, new Set());
  marketParticipants.get(marketId)!.add(user);
}

/**
 * Return previously registered canonical bet tx hash for a user+market.
 */
export async function getCanonicalBetTxHash(
  marketId: string,
  userAddress: string,
): Promise<string | null> {
  const user  = userAddress.toLowerCase();
  const redis = getRedisClient();
  if (redis) {
    try {
      if (redis.status === 'wait') await redis.connect();
      const tx = await redis.get(canonicalTxHashKey(marketId, user));
      if (tx) return tx;
    } catch (err) {
      console.warn('[Settlement] Redis read failed, using in-memory fallback:', (err as Error).message);
    }
  }
  return canonicalBetTxHashes.get(marketId)?.get(user) ?? null;
}

/**
 * Return known users for a market based on canonical bet registrations.
 */
export async function listMarketParticipants(marketId: string): Promise<string[]> {
  const redis = getRedisClient();
  if (redis) {
    try {
      if (redis.status === 'wait') await redis.connect();
      const users = await redis.smembers(marketParticipantsKey(marketId));
      if (users.length > 0) return users.map((u) => u.toLowerCase());
    } catch (err) {
      console.warn('[Settlement] Redis participant read failed, using in-memory fallback:', (err as Error).message);
    }
  }
  return Array.from(marketParticipants.get(marketId) ?? []).map((u) => u.toLowerCase());
}

/**
 * Check if a market has been finalized.
 */
export function isMarketFinalized(marketId: string): boolean {
  return finalizedMarkets.has(marketId);
}

/**
 * Get a signed settlement for a user.
 *
 * - Returns a cached settlement if one already exists for this user+market.
 * - Otherwise, computes on-chain data via lit-client.ts and generates a fresh
 *   signed settlement message.
 *
 * Throws if the market is not finalized or if on-chain reads fail.
 */
export async function getOrComputeSettlement(
  marketId:    string,
  userAddress: string,
  betTxHash?:  string,  // optional: tx hash of BetPlaced — lets oracle resolve exact block for Alchemy
): Promise<PendingSettlement> {
  // #region agent log
  fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'37e9d3'},body:JSON.stringify({sessionId:'37e9d3',runId:'settle-compute',hypothesisId:'H2',location:'settlement.ts:getOrComputeSettlement-entry',message:'Entered settlement compute',data:{marketId,userAddress:userAddress.toLowerCase(),hasBetTxHash:Boolean(betTxHash),betTxHashPrefix:betTxHash?.slice(0,18) ?? null,isMarketFinalized:isMarketFinalized(marketId)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!isMarketFinalized(marketId)) {
    throw new Error(`Market ${marketId} is not finalized yet`);
  }

  // Return cached settlement if available
  const existing = settlements.get(marketId)?.get(userAddress.toLowerCase());
  if (existing) {
    try {
      const provider = new ethers.JsonRpcProvider(FLOW_RPC_URL);
      const vault = new ethers.Contract(GHOST_VAULT_ADDRESS, VAULT_SIGNER_ABI, provider);
      const onChainSigner = String(await vault.settlementSigner()).toLowerCase();
      if (existing.signerAddress.toLowerCase() !== onChainSigner) {
        // Drop stale cache entry when signer has rotated.
        settlements.get(marketId)?.delete(userAddress.toLowerCase());
      } else {
        // #region agent log
        fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'37e9d3'},body:JSON.stringify({sessionId:'37e9d3',runId:'settle-compute',hypothesisId:'H2',location:'settlement.ts:getOrComputeSettlement-cache-hit',message:'Returning cached settlement',data:{marketId,userAddress:userAddress.toLowerCase(),signingPath:existing.signingPath,payout:existing.payout},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        return existing;
      }
    } catch {
      // If signer read fails, keep previous behavior and return cache.
      // #region agent log
      fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'37e9d3'},body:JSON.stringify({sessionId:'37e9d3',runId:'settle-compute',hypothesisId:'H2',location:'settlement.ts:getOrComputeSettlement-cache-hit',message:'Returning cached settlement',data:{marketId,userAddress:userAddress.toLowerCase(),signingPath:existing.signingPath,payout:existing.payout},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      return existing;
    }
  }

  // Derive bytes32 market ID: abi.encode(uint256) zero-padded
  const marketIdUint = parseInt(marketId, 10).toString();
  const marketIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(marketIdUint)), 32);

  const { nonce, expiry } = freshNonceExpiry();

  // Priority:
  // 1) betTxHash from request body
  // 2) previously registered canonical bet tx hash
  const resolvedBetTxHash = betTxHash ?? await getCanonicalBetTxHash(marketId, userAddress) ?? undefined;

  const result = await signSettlement({
    userAddress,
    marketIdUint,
    marketIdBytes32,
    nonce,
    expiry,
    betTxHash: resolvedBetTxHash,
  });

  const settlement: PendingSettlement = {
    marketId,
    userAddress:   userAddress.toLowerCase(),
    sig:           result.sig,
    payout:        result.payout,
    nonce:         result.nonce,
    expiry:        result.expiry,
    signerAddress: result.signerAddress,
    signingPath:   result.path,
    computedAt:    Date.now(),
    deliveredTx:   null,
  };

  if (!settlements.has(marketId)) settlements.set(marketId, new Map());
  settlements.get(marketId)!.set(userAddress.toLowerCase(), settlement);

  return settlement;
}

/**
 * Retrieve a cached settlement without re-computing.
 * Returns null if no settlement exists for this user+market.
 */
export function getCachedSettlement(marketId: string, userAddress: string): PendingSettlement | null {
  return settlements.get(marketId)?.get(userAddress.toLowerCase()) ?? null;
}

/**
 * Deliver the settlement on-chain by calling GhostVault.claimPayout()
 * on behalf of the user (oracle acts as relayer, pays gas on Flow EVM).
 *
 * Only works when SETTLEMENT_SIGNER_PRIVATE_KEY is set (oracle controls a
 * funded wallet on Flow EVM).  Useful for automated post-resolution delivery.
 *
 * Returns the Flow EVM transaction hash on success, or null if delivery
 * is not configured / was already delivered.
 */
export async function deliverSettlementOnChain(
  settlement: PendingSettlement,
): Promise<string | null> {
  if (!ENABLE_AUTONOMOUS_SETTLEMENT_DELIVERY) {
    console.log('[Settlement] Autonomous delivery disabled (ENABLE_AUTONOMOUS_SETTLEMENT_DELIVERY=false)');
    return null;
  }

  if (!SETTLEMENT_SIGNER_KEY) {
    console.log('[Settlement] Autonomous delivery skipped (no SETTLEMENT_SIGNER_PRIVATE_KEY)');
    return null;
  }

  if (settlement.deliveredTx) {
    console.log('[Settlement] Already delivered:', settlement.deliveredTx);
    return settlement.deliveredTx;
  }

  if (settlement.payout === '0') {
    // Loser — nothing to deliver. Claim still needs to happen to release the lock.
    // Let the user trigger it themselves with a 0-payout message.
    return null;
  }

  const VAULT_ABI = [
    'function claimPayout(bytes32 marketId, uint256 amount, uint256 nonce, uint256 expiry, bytes calldata sig) external',
    'function claimPayoutFor(address user, bytes32 marketId, uint256 amount, uint256 nonce, uint256 expiry, bytes calldata sig) external',
    'event PayoutClaimed(address indexed user, bytes32 indexed marketId, uint256 amount)',
  ];

  try {
    const provider  = new ethers.JsonRpcProvider(FLOW_RPC_URL);
    const relayer   = new ethers.Wallet(SETTLEMENT_SIGNER_KEY, provider);
    const vault     = new ethers.Contract(GHOST_VAULT_ADDRESS, VAULT_ABI, relayer);

    const marketIdUint    = parseInt(settlement.marketId, 10).toString();
    const marketIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(marketIdUint)), 32);

    console.log(`[Settlement] Delivering settlement on Flow EVM for ${settlement.userAddress}…`);

    const tx = SETTLEMENT_SIGNATURE_MODE === 'eip712'
      ? await vault.claimPayoutFor(
        settlement.userAddress,
        marketIdBytes32,
        BigInt(settlement.payout),
        BigInt(settlement.nonce),
        BigInt(settlement.expiry),
        settlement.sig,
      )
      : await vault.claimPayout(
        marketIdBytes32,
        BigInt(settlement.payout),
        BigInt(settlement.nonce),
        BigInt(settlement.expiry),
        settlement.sig,
      );

    console.log(`[Settlement] TX submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[Settlement] Confirmed in block ${receipt.blockNumber}`);
    console.log(`[Settlement] Flowscan: https://evm-testnet.flowscan.io/tx/${tx.hash}`);

    settlement.deliveredTx = tx.hash as string;

    // Update cached entry
    settlements.get(settlement.marketId)?.set(settlement.userAddress.toLowerCase(), settlement);

    return tx.hash as string;
  } catch (err) {
    const message = (err as Error).message ?? '';
    // 0x8baa579f => InvalidSignature() on GhostVault; expected when relayer != user.
    if (message.includes('0x8baa579f')) {
      console.warn(
        '[Settlement] Autonomous claim rejected with InvalidSignature (relayer is not the claiming user). ' +
        'Use user-initiated claim flow instead.',
      );
      return null;
    }
    console.error('[Settlement] On-chain delivery failed:', message);
    return null;
  }
}

/**
 * Return a summary of all settlements for a given market.
 * Useful for the Oracle Room panel.
 */
export function getMarketSettlements(marketId: string): PendingSettlement[] {
  const marketSettlements = settlements.get(marketId);
  if (!marketSettlements) return [];
  return Array.from(marketSettlements.values());
}
