/**
 * oracle-client.ts — Frontend client for the GhostMarket Oracle Service.
 *
 * Used by the portfolio page to request a signed settlement claim after a
 * market is finalized.  The oracle returns the signature and payout amount
 * that the user submits to GhostVault.claimPayout() on Flow EVM.
 */

const ORACLE_URL =
  process.env.NEXT_PUBLIC_ORACLE_URL ?? 'http://localhost:8080';

// ── Types (mirrors oracle/src/types.ts SettlementClaimResponse) ───────────────

export interface SettlementClaim {
  marketId:       string;
  userAddress:    string;
  sig:            string;    // 65-byte ECDSA signature hex
  payout:         string;    // net payout in wei (decimal string)
  nonce:          string;
  expiry:         string;
  marketIdBytes32: string;  // 0x-padded bytes32 for claimPayout()
  vaultAddress:   string;
  signerAddress:  string;
  signingPath:    'lit' | 'deployer';
  deliveredTx:    string | null;
}

// ── REST calls ────────────────────────────────────────────────────────────────

/**
 * Request a signed settlement claim from the oracle service.
 *
 * Calls POST /oracle/settle/:marketId with the user's address.
 * The oracle reads on-chain data, computes the payout, and returns a
 * signature the user can submit to GhostVault.claimPayout().
 *
 * Throws if the market is not finalized or if the user has no position.
 */
export async function requestSettlement(
  marketId: string | number,
  userAddress: string,
): Promise<SettlementClaim> {
  const res = await fetch(`${ORACLE_URL}/oracle/settle/${marketId}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ userAddress }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Oracle error ${res.status}`);
  }

  return res.json();
}

/**
 * Fetch a cached settlement claim if one already exists.
 * Returns null if the oracle has not computed a settlement yet.
 */
export async function fetchCachedSettlement(
  marketId: string | number,
  userAddress: string,
): Promise<SettlementClaim | null> {
  const res = await fetch(
    `${ORACLE_URL}/oracle/settle/${marketId}/${userAddress}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

/**
 * Check oracle health.
 */
export async function checkOracleHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ORACLE_URL}/oracle/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Get the current resolution status for a market.
 */
export async function getOracleStatus(marketId: string | number): Promise<{
  phase: string;
  outcome: boolean | null;
  finalEvidenceCid: string | null;
} | null> {
  try {
    const res = await fetch(`${ORACLE_URL}/oracle/status/${marketId}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
