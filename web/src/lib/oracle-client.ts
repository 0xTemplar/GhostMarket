/**
 * oracle-client.ts — Frontend client for the GhostMarket Oracle Service.
 *
 * Used by the portfolio page to request a signed settlement claim after a
 * market is finalized.  The oracle returns the signature and payout amount
 * that the user submits to GhostVault.claimPayout() on Flow EVM.
 */

const ORACLE_API_BASE = '/api/oracle';

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

export interface OracleAgentView {
  id: number;
  name: string;
  walletAddress: string;
  reputationScore: number;
  erc8004Id: string | null;
  status: 'idle' | 'fetching' | 'attesting' | 'submitted' | 'slashed' | 'suspended';
  vote: boolean | null;
  storachaCid: string | null;
  filecoinCid: string | null;
  attestedAt: number | null;
}

export interface OracleLogEntry {
  ts: number;
  agentName: string | null;
  message: string;
  txHash: string | null;
  cid: string | null;
}

export interface OracleSession {
  marketId: string;
  phase: 'pending' | 'collecting' | 'quorum_reached' | 'uploading' | 'finalized' | 'failed';
  agents: OracleAgentView[];
  yesVotes: number;
  noVotes: number;
  outcome: boolean | null;
  finalEvidenceCid: string | null;
  calibrationTxHash: string | null;
  flowTxHash: string | null;
  sepoliaResolutionSync: {
    status: 'idle' | 'pending' | 'synced' | 'failed' | 'skipped';
    txHash: string | null;
  };
  flowResolutionSync: {
    status: 'idle' | 'pending' | 'synced' | 'failed' | 'skipped';
    txHash: string | null;
  };
  startedAt: number;
  finalizedAt: number | null;
  log: OracleLogEntry[];
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
  const res = await fetch(`${ORACLE_API_BASE}/settle/${marketId}`, {
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
    `${ORACLE_API_BASE}/settle/${marketId}/${userAddress}`,
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
    const res = await fetch(`${ORACLE_API_BASE}/health`, {
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
    const res = await fetch(`${ORACLE_API_BASE}/status/${marketId}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/** Fetch full oracle session payload for Oracle Room panel. */
export async function getOracleSession(
  marketId: string | number,
): Promise<OracleSession | null> {
  try {
    const res = await fetch(`${ORACLE_API_BASE}/status/${marketId}`);
    if (!res.ok) return null;
    return res.json() as Promise<OracleSession>;
  } catch {
    return null;
  }
}

/**
 * Trigger oracle resolution workflow for a market.
 * Intended for admin/ops control panel usage.
 */
export async function triggerOracleResolution(
  marketId: string | number,
  outcome: boolean,
): Promise<{ marketId: string; status: string; wsUrl?: string }> {
  const res = await fetch(`${ORACLE_API_BASE}/resolve/${marketId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome }),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error(body.error ?? `Oracle error ${res.status}`);
  }
  return body as { marketId: string; status: string; wsUrl?: string };
}

/**
 * Register a canonical BetPlaced tx hash for deterministic settlement lookup.
 *
 * This is non-critical metadata for oracle settlement reliability.
 * Call after bet tx confirmation; failures should not block UX.
 */
export async function registerCanonicalBetTxHash(
  marketId: string | number,
  userAddress: string,
  betTxHash: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${ORACLE_API_BASE}/bets/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketId: String(marketId),
        userAddress,
        betTxHash,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
