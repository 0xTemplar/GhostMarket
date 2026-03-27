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
  reasoning?: string;
  source?: string;
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
  settlementRelay: {
    status: 'idle' | 'pending' | 'running' | 'completed' | 'disabled' | 'failed';
    totalUsers: number;
    processedUsers: number;
    relayedUsers: number;
    failedUsers: number;
    lastError: string | null;
  };
  startedAt: number;
  finalizedAt: number | null;
  log: OracleLogEntry[];
}

const ORACLE_AI_BASE = process.env.NEXT_PUBLIC_ORACLE_AI_URL ?? 'http://localhost:8000';

function normalizeOracleSession(raw: Record<string, unknown>): OracleSession {
  const agents = (Array.isArray(raw.agents) ? raw.agents : []).map((a) => {
    const agent = a as Record<string, unknown>;
    return {
      id: Number(agent.id ?? 0),
      name: String(agent.name ?? `Agent-${String(agent.id ?? '')}`),
      walletAddress: String(agent.walletAddress ?? ''),
      reputationScore: Number(agent.reputationScore ?? agent.reputation ?? 80),
      erc8004Id: agent.erc8004Id ? String(agent.erc8004Id) : null,
      status: String(agent.status ?? 'idle') as OracleAgentView['status'],
      vote: typeof agent.vote === 'boolean' ? agent.vote : null,
      storachaCid: agent.storachaCid ? String(agent.storachaCid) : null,
      filecoinCid: agent.filecoinCid ? String(agent.filecoinCid) : null,
      attestedAt: agent.attestedAt ? Number(agent.attestedAt) : null,
      reasoning: agent.reasoning ? String(agent.reasoning) : undefined,
      source: agent.source ? String(agent.source) : undefined,
    } as OracleAgentView;
  });

  const log = (Array.isArray(raw.log) ? raw.log : []).map((l) => {
    const entry = l as Record<string, unknown>;
    return {
      ts: Number(entry.ts ?? Date.now()),
      agentName: entry.agentName
        ? String(entry.agentName)
        : entry.agent
        ? String(entry.agent)
        : null,
      message: String(entry.message ?? ''),
      txHash: entry.txHash ? String(entry.txHash) : null,
      cid: entry.cid ? String(entry.cid) : null,
    } as OracleLogEntry;
  });

  return {
    marketId: String(raw.marketId ?? ''),
    phase: String(raw.phase ?? 'pending') as OracleSession['phase'],
    agents,
    yesVotes: Number(raw.yesVotes ?? 0),
    noVotes: Number(raw.noVotes ?? 0),
    outcome: typeof raw.outcome === 'boolean' ? raw.outcome : null,
    finalEvidenceCid: raw.finalEvidenceCid ? String(raw.finalEvidenceCid) : null,
    calibrationTxHash: raw.calibrationTxHash
      ? String(raw.calibrationTxHash)
      : raw.calibrationTx
      ? String(raw.calibrationTx)
      : null,
    flowTxHash: raw.flowTxHash
      ? String(raw.flowTxHash)
      : raw.flowTx
      ? String(raw.flowTx)
      : null,
    sepoliaResolutionSync: (raw.sepoliaResolutionSync as OracleSession['sepoliaResolutionSync']) ?? {
      status: 'idle',
      txHash: null,
    },
    flowResolutionSync: (raw.flowResolutionSync as OracleSession['flowResolutionSync']) ?? {
      status: 'idle',
      txHash: null,
    },
    settlementRelay: (raw.settlementRelay as OracleSession['settlementRelay']) ?? {
      status: 'idle',
      totalUsers: 0,
      processedUsers: 0,
      relayedUsers: 0,
      failedUsers: 0,
      lastError: null,
    },
    startedAt: Number(raw.startedAt ?? Date.now()),
    finalizedAt: raw.finalizedAt ? Number(raw.finalizedAt) : null,
    log,
  };
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
 * Oracle Room AI session endpoint (FastAPI backend).
 * Falls back to null if API backend is offline.
 */
export async function getOracleAiSession(
  marketId: string | number,
): Promise<OracleSession | null> {
  try {
    const res = await fetch(`${ORACLE_AI_BASE}/api/oracle/status/${marketId}`);
    if (!res.ok) return null;
    const raw = await res.json() as Record<string, unknown>;
    return normalizeOracleSession(raw);
  } catch {
    return null;
  }
}

/**
 * Trigger AI-backed oracle run (FastAPI).
 */
export async function triggerOracleAiResolution(
  marketId: string | number,
  marketQuestion?: string,
): Promise<{ marketId: string; status: string; wsUrl?: string }> {
  const res = await fetch(`${ORACLE_AI_BASE}/api/oracle/resolve/${marketId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      market_question: marketQuestion ?? `Resolve market ${marketId} using agent consensus`,
    }),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error(body.error ?? body.detail ?? `Oracle AI error ${res.status}`);
  }
  return body as { marketId: string; status: string; wsUrl?: string };
}

/**
 * Trigger oracle resolution workflow for a market.
 * Intended for admin/ops control panel usage.
 *
 * @param marketTitle  Optional market question string passed to agents for
 *                     grounded GPT reasoning (e.g. "Will ETH trade above $6,500?").
 */
export async function triggerOracleResolution(
  marketId: string | number,
  outcome: boolean,
  marketTitle?: string,
): Promise<{ marketId: string; status: string; wsUrl?: string }> {
  const res = await fetch(`${ORACLE_API_BASE}/resolve/${marketId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      outcome,
      ...(marketTitle ? { marketTitle } : {}),
    }),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error(body.error ?? `Oracle error ${res.status}`);
  }
  return body as { marketId: string; status: string; wsUrl?: string };
}

/** Fetch the market ID → question mapping from the oracle. */
export async function getMarketTitles(): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${ORACLE_API_BASE}/market-titles`);
    if (!res.ok) return {};
    return (await res.json()) as Record<string, string>;
  } catch {
    return {};
  }
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
