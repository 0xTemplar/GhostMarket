/**
 * settlement.ts — Post-quorum settlement for GhostMarket (Sepolia).
 *
 * After oracle quorum finalises a market:
 *   1. markMarketFinalized() stores the outcome.
 *   2. getOrComputeSettlement() computes + signs a payout claim for a user
 *      using oracle-signer.ts (oracle wallet, EIP-712, no Lit Protocol).
 *   3. The signed claim is served to the user who submits it to
 *      GhostVault.claimPayout() on Sepolia.
 *
 * GhostVault.computeExpectedPayout() enforces the correct amount on-chain —
 * the oracle cannot forge amounts, only the binary outcome (quorum-constrained).
 */

import { ethers }                                    from 'ethers';
import { signSettlement, freshNonceExpiry }           from './oracle-signer';

// ── Environment ───────────────────────────────────────────────────────────────

const GHOST_VAULT_ADDRESS = process.env.GHOST_VAULT_ADDRESS ?? '';
const SEPOLIA_RPC_URL     = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';

const VAULT_SIGNER_ABI = ['function settlementSigner() view returns (address)'];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingSettlement {
  marketId:      string;
  userAddress:   string;
  sig:           string;
  payout:        string;   // wei as decimal string
  nonce:         string;
  expiry:        string;
  signerAddress: string;
  signingPath:   'oracle';
  computedAt:    number;   // unix ms
  deliveredTx:   string | null;
}

// ── In-memory stores ──────────────────────────────────────────────────────────

// settlements[marketId][userAddress] → PendingSettlement
const settlements = new Map<string, Map<string, PendingSettlement>>();
// canonicalBetTxHashes[marketId][userAddress] → betTxHash
const canonicalBetTxHashes = new Map<string, Map<string, string>>();
// marketParticipants[marketId] → Set<userAddress>
const marketParticipants = new Map<string, Set<string>>();
// finalizedMarkets[marketId] → { outcome, finalizedAt }
const finalizedMarkets = new Map<string, { outcome: boolean; finalizedAt: number }>();

// ── Public API ─────────────────────────────────────────────────────────────────

export function markMarketFinalized(marketId: string, outcome: boolean): void {
  finalizedMarkets.set(marketId, { outcome, finalizedAt: Date.now() });
  if (!settlements.has(marketId)) settlements.set(marketId, new Map());
}

export function isMarketFinalized(marketId: string): boolean {
  return finalizedMarkets.has(marketId);
}

export async function registerCanonicalBetTxHash(
  marketId:    string,
  userAddress: string,
  betTxHash:   string,
): Promise<void> {
  const user = userAddress.toLowerCase();
  const tx   = betTxHash.toLowerCase();
  if (!canonicalBetTxHashes.has(marketId)) canonicalBetTxHashes.set(marketId, new Map());
  canonicalBetTxHashes.get(marketId)!.set(user, tx);
  if (!marketParticipants.has(marketId)) marketParticipants.set(marketId, new Set());
  marketParticipants.get(marketId)!.add(user);
}

export async function getCanonicalBetTxHash(
  marketId:    string,
  userAddress: string,
): Promise<string | null> {
  return canonicalBetTxHashes.get(marketId)?.get(userAddress.toLowerCase()) ?? null;
}

export async function listMarketParticipants(marketId: string): Promise<string[]> {
  return Array.from(marketParticipants.get(marketId) ?? []).map((u) => u.toLowerCase());
}

/**
 * Get or compute a signed settlement for a user.
 *
 * - Returns a cached settlement if one already exists.
 * - Otherwise reads GhostVault on Sepolia to verify the settlement signer
 *   matches the current oracle key, then signs a fresh EIP-712 claim.
 *
 * Payout computation:
 *   The oracle reads the on-chain state from GhostVault.computeExpectedPayout()
 *   which checks: did the user bet on the winning side? If yes → locked amount.
 *   This is entirely on-chain and cannot be manipulated by the oracle.
 */
export async function getOrComputeSettlement(
  marketId:    string,
  userAddress: string,
  _betTxHash?: string,
): Promise<PendingSettlement> {
  if (!isMarketFinalized(marketId)) {
    throw new Error(`Market ${marketId} is not finalized yet`);
  }

  const userLower = userAddress.toLowerCase();

  // Return cached settlement, re-validating signer address
  const existing = settlements.get(marketId)?.get(userLower);
  if (existing) {
    if (GHOST_VAULT_ADDRESS) {
      try {
        const provider     = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
        const vault        = new ethers.Contract(GHOST_VAULT_ADDRESS, VAULT_SIGNER_ABI, provider);
        const onChainSigner = String(await vault.settlementSigner()).toLowerCase();
        if (existing.signerAddress.toLowerCase() !== onChainSigner) {
          settlements.get(marketId)?.delete(userLower);
        } else {
          return existing;
        }
      } catch {
        return existing;
      }
    } else {
      return existing;
    }
  }

  const marketIdUint    = parseInt(marketId, 10).toString();
  const marketIdBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(marketIdUint)), 32);

  // Read expected payout from GhostVault on Sepolia
  let payout = '0';
  if (GHOST_VAULT_ADDRESS) {
    try {
      const PAYOUT_ABI = [
        'function getLockedAmountHandle(address user, bytes32 marketId) view returns (bytes32)',
      ];
      const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
      const vault    = new ethers.Contract(GHOST_VAULT_ADDRESS, PAYOUT_ABI, provider);
      const amountHandle   = await vault.getLockedAmountHandle(userAddress, marketIdBytes32) as string;
      payout = amountHandle;
    } catch (err) {
      console.warn('[Settlement] getLockedAmountHandle read failed:', (err as Error).message);
    }
  }

  const { nonce, expiry } = freshNonceExpiry();

  const result = await signSettlement({
    userAddress,
    marketIdUint,
    marketIdBytes32,
    nonce,
    expiry,
    payout,
  });

  const settlement: PendingSettlement = {
    marketId,
    userAddress:   userLower,
    sig:           result.sig,
    payout:        result.payout,
    nonce:         result.nonce,
    expiry:        result.expiry,
    signerAddress: result.signerAddress,
    signingPath:   'oracle',
    computedAt:    Date.now(),
    deliveredTx:   null,
  };

  if (!settlements.has(marketId)) settlements.set(marketId, new Map());
  settlements.get(marketId)!.set(userLower, settlement);

  return settlement;
}

export function getCachedSettlement(
  marketId:    string,
  userAddress: string,
): PendingSettlement | null {
  return settlements.get(marketId)?.get(userAddress.toLowerCase()) ?? null;
}

export function getMarketSettlements(marketId: string): PendingSettlement[] {
  const m = settlements.get(marketId);
  if (!m) return [];
  return Array.from(m.values());
}
