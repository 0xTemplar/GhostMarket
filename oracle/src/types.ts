// ── Agent state ────────────────────────────────────────────────────────────────

export type AgentStatus =
  | 'idle'
  | 'fetching'
  | 'attesting'
  | 'submitted'
  | 'slashed'
  | 'suspended';

export interface OracleAgent {
  id: number;           // 1–7
  name: string;         // Ghost-01 … Ghost-07
  walletAddress: string;
  reputationScore: number;
  erc8004Id: bigint | null;
  status: AgentStatus;
  vote: boolean | null;
  storachaCid: string | null;   // intermediate evidence CID (Storacha)
  filecoinCid: string | null;   // finalized evidence CID (Synapse/Filecoin)
  attestedAt: number | null;    // unix ms
}

// ── Resolution session ─────────────────────────────────────────────────────────

export type ResolutionPhase =
  | 'pending'
  | 'collecting'
  | 'quorum_reached'
  | 'uploading'
  | 'finalized'
  | 'failed';

export interface ResolutionSession {
  marketId: string;
  phase: ResolutionPhase;
  agents: OracleAgent[];
  yesVotes: number;
  noVotes: number;
  outcome: boolean | null;
  finalEvidenceCid: string | null;   // Synapse Piece CID
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
  log: LogEntry[];
}

export interface LogEntry {
  ts: number;           // unix ms
  agentName: string | null;
  message: string;
  txHash: string | null;
  cid: string | null;
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
  marketId:      string;
  userAddress:   string;
  sig:           string;    // 65-byte ECDSA signature hex
  payout:        string;    // net payout in wei (decimal string)
  nonce:         string;    // replay-protection nonce
  expiry:        string;    // unix seconds
  marketIdBytes32: string;  // 0x-padded bytes32 for claimPayout()
  vaultAddress:  string;
  signerAddress: string;
  signingPath:   'lit' | 'deployer';
  deliveredTx:   string | null;   // Flow EVM tx if oracle auto-delivered
}
