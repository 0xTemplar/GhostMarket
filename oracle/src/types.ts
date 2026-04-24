// ── Agent state ────────────────────────────────────────────────────────────────

export type AgentStatus =
  | 'idle'
  | 'fetching'
  | 'attesting'
  | 'submitted';

export interface OracleAgent {
  id: number;           // 1–7
  name: string;
  source?: string;
  walletAddress: string;
  reputationScore: number;
  status: AgentStatus;
  vote: boolean | null;
  reasoning?: string;
  attestedAt: number | null;    // unix ms
}

// ── Resolution session ─────────────────────────────────────────────────────────

export type ResolutionPhase =
  | 'pending'
  | 'collecting'
  | 'quorum_reached'
  | 'finalized'
  | 'failed';

export interface ResolutionSession {
  marketId: string;
  marketTitle: string;
  phase: ResolutionPhase;
  agents: OracleAgent[];
  yesVotes: number;
  noVotes: number;
  outcome: boolean | null;
  sepoliaResolutionSync: {
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
  log: LogEntry[];
}

export interface LogEntry {
  ts: number;           // unix ms
  agentName: string | null;
  message: string;
  txHash: string | null;
}

// ── WebSocket message ──────────────────────────────────────────────────────────

export type WsMessageType =
  | 'session_init'
  | 'agent_update'
  | 'log'
  | 'quorum_reached'
  | 'finalized'
  | 'settlement_delivered'
  | 'session_patch'
  | 'error';

export interface WsMessage {
  type: WsMessageType;
  marketId: string;
  payload: unknown;
}

// ── Settlement ─────────────────────────────────────────────────────────────────

/** Response from POST /oracle/settle/:marketId */
export interface SettlementClaimResponse {
  marketId:        string;
  userAddress:     string;
  sig:             string;    // 65-byte ECDSA signature hex
  payout:          string;    // net payout in wei (decimal string)
  nonce:           string;    // replay-protection nonce
  expiry:          string;    // unix seconds
  marketIdBytes32: string;    // 0x-padded bytes32 for claimPayout()
  vaultAddress:    string;
  signerAddress:   string;
  signingPath:     'oracle';
  deliveredTx:     string | null;
}
