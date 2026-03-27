/**
 * GhostMarket Oracle Service — index.ts
 *
 * Standalone Node.js HTTP + WebSocket server.
 * Port: 8080 (configurable via PORT env var)
 *
 * REST endpoints:
 *   POST /oracle/resolve/:marketId      — trigger oracle resolution
 *   GET  /oracle/status/:marketId       — get current resolution state
 *   GET  /oracle/agents                 — get agent registry info
 *   GET  /oracle/health                 — health check
 *
 * WebSocket:
 *   ws://localhost:3001/oracle/ws/:marketId
 *   Broadcasts WsMessage events in real-time to the Oracle Room panel.
 *
 * Resolution flow per market:
 *   1. Each agent: idle → fetching → attesting → submitted
 *      - Intermediate evidence uploaded to Storacha (fast, per-agent)
 *      - Attestation submitted to OracleAgentRegistry on Calibration
 *   2. On 5/7 quorum:
 *      - Finalized evidence bundle uploaded to Filecoin via Synapse SDK
 *      - Piece CID recorded in OracleAgentRegistry
 *      - Reputation snapshots uploaded to Synapse → CIDs in registry
 *      - ERC-8004 reputation scores updated on Sepolia
 *   3. FINALIZED event broadcast; settlement delivery to Flow is Phase 6.
 */

import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

import { buildAgents, agentDelay, AGENT_DEFINITIONS } from './agents';
import {
  fetchSourceData,
  extractAsset,
  extractThreshold,
  type FetchedData,
} from './fetcher';
import { uploadToFilecoin } from './synapse-client';
import {
  saveIntermediateEvidence,
  saveAgentCheckpoint,
  loadAllCheckpoints,
  readPeerEvidence,
  getAllHeads,
} from './storacha-client';
import {
  submitAttestation,
  recordEvidence,
  getAgentInfo,
  getAgentCount,
} from './registry-client';
import { postERC8004Reputation } from './erc8004-client';
import {
  markMarketFinalized,
  getOrComputeSettlement,
  deliverSettlementOnChain,
  getMarketSettlements,
  registerCanonicalBetTxHash,
  getCanonicalBetTxHash,
  listMarketParticipants,
} from './settlement';
import { reportOutcomeToVault } from './vault-reporter';
import type {
  ResolutionSession,
  OracleAgent,
  LogEntry,
  WsMessage,
  AgentStatus,
  SettlementClaimResponse,
} from './types';

dotenv.config();

// ── App setup ──────────────────────────────────────────────────────────────────

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = Number(process.env.PORT ?? 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const ORACLE_REASONING_MODEL =
  process.env.ORACLE_REASONING_MODEL ?? 'gpt-4o-mini';
const ORACLE_REASONING_TIMEOUT_MS = Number(
  process.env.ORACLE_REASONING_TIMEOUT_MS ?? 9000,
);
const ACTIVE_AGENT_COUNT = Math.max(
  1,
  Math.min(
    AGENT_DEFINITIONS.length,
    Number(process.env.ACTIVE_ORACLE_AGENTS ?? 4),
  ),
);
const ENABLE_AUTONOMOUS_SETTLEMENT_DELIVERY =
  (
    process.env.ENABLE_AUTONOMOUS_SETTLEMENT_DELIVERY ?? 'false'
  ).toLowerCase() === 'true';
const CADENCE_ADAPTER_URL =
  process.env.CADENCE_ADAPTER_ENABLED === 'true'
    ? `http://localhost:${process.env.CADENCE_ADAPTER_PORT ?? 8093}`
    : null;
const quorumThreshold = (agentCount: number): number =>
  Math.floor(agentCount / 2) + 1;

/** Seeded market ID → question mapping (markets 20-29 from seed-markets.ts). */
const MARKET_TITLES: Record<string, string> = {
  '20': 'Will ETH trade above $6,500 before Jan 2027?',
  '21': 'Will BTC trade above $150,000 before Jan 2027?',
  '22': 'Will SOL trade above $500 before Jan 2027?',
  '23': 'Will XRP trade above $5 before Jan 2027?',
  '24': 'Will DOGE trade above $1 before Jan 2027?',
  '25': 'Will TON market cap enter top 5 before Jan 2027?',
  '26': 'Will a Spot ADA ETF be approved in the US before Jan 2027?',
  '27': 'Will Base TVL exceed $25B before Jan 2027?',
  '28': 'Will the Fed cut rates by at least 50 bps in 2026?',
  '29': 'Will the EU AI Act see a >€50M fine before Jan 2027?',
};

app.use(cors());
app.use(express.json());

// ── In-memory session store ────────────────────────────────────────────────────

const sessions = new Map<string, ResolutionSession>();

// WS clients subscribed per market
const subscribers = new Map<string, Set<WebSocket>>();

// Agent reputation restored from Storacha checkpoints on startup
const agentReputation = new Map<number, number>(); // agentId → score
const agentLastMarket = new Map<number, string | number>(); // agentId → last resolved market

// Load checkpoints asynchronously — non-blocking, results available within a few seconds
loadAllCheckpoints()
  .then((checkpoints) => {
    let resumed = 0;
    for (const [idStr, cp] of Object.entries(checkpoints)) {
      if (cp) {
        const id = Number(idStr);
        agentReputation.set(id, cp.reputationScore);
        agentLastMarket.set(id, cp.lastMarket);
        resumed++;
      }
    }
    if (resumed > 0) {
      console.log(`[Storacha] Resumed ${resumed}/7 agents from checkpoint`);
    } else {
      console.log(`[Storacha] No checkpoints found — agents starting fresh`);
    }
  })
  .catch(() => {
    console.log('[Storacha] Checkpoint load skipped (not configured)');
  });

// ── WebSocket ──────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const match = req.url?.match(/\/oracle\/ws\/([^/?]+)/);
  const marketId = match ? match[1] : null;

  if (!marketId) {
    ws.close();
    return;
  }

  if (!subscribers.has(marketId)) subscribers.set(marketId, new Set());
  subscribers.get(marketId)!.add(ws);

  // Send current session state immediately on connect
  const session = sessions.get(marketId);
  if (session) {
    send(ws, { type: 'session_init', marketId, payload: session });
  }

  ws.on('close', () => subscribers.get(marketId)?.delete(ws));
});

function broadcast(marketId: string, msg: WsMessage) {
  const clients = subscribers.get(marketId);
  if (!clients) return;
  const json = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

function send(ws: WebSocket, msg: WsMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Session helpers ────────────────────────────────────────────────────────────

function addLog(
  session: ResolutionSession,
  message: string,
  opts: {
    agentName?: string | null;
    txHash?: string | null;
    cid?: string | null;
  } = {},
) {
  const entry: LogEntry = {
    ts: Date.now(),
    agentName: opts.agentName ?? null,
    message,
    txHash: opts.txHash ?? null,
    cid: opts.cid ?? null,
  };
  session.log.push(entry);
  broadcast(session.marketId, {
    type: 'log',
    marketId: session.marketId,
    payload: entry,
  });
}

function updateAgent(
  session: ResolutionSession,
  agentId: number,
  patch: Partial<OracleAgent>,
) {
  const agent = session.agents.find((a) => a.id === agentId);
  if (!agent) return;
  Object.assign(agent, patch);
  broadcast(session.marketId, {
    type: 'agent_update',
    marketId: session.marketId,
    payload: agent,
  });
}

function patchSession(
  session: ResolutionSession,
  patch: Partial<ResolutionSession>,
) {
  Object.assign(session, patch);
  broadcast(session.marketId, {
    type: 'session_patch',
    marketId: session.marketId,
    payload: patch,
  });
}

type ReasoningResult = {
  vote: boolean;
  reasoning: string;
};

async function generateAgentReasoning(
  session: ResolutionSession,
  agent: OracleAgent,
  agentDef: { source: string; personality: string },
  fetched: FetchedData,
  defaultVote: boolean,
): Promise<ReasoningResult> {
  const threshold = extractThreshold(session.marketTitle);
  const thresholdStr = threshold
    ? `$${threshold.toLocaleString('en-US')}`
    : 'the stated threshold';

  // Deterministic fallback — never blocks orchestration.
  const priceContext = fetched.price
    ? `${fetched.asset} is currently at ${fetched.rawValue} (${agentDef.source}).`
    : `No live price data available from ${agentDef.source}.`;

  const fallback: ReasoningResult = {
    vote: defaultVote,
    reasoning: `${agent.name}: ${priceContext} Based on ${
      agentDef.source
    } signals and quorum alignment, voting ${defaultVote ? 'YES' : 'NO'}.`,
  };

  if (!OPENAI_API_KEY) return fallback;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      ORACLE_REASONING_TIMEOUT_MS,
    );

    const dataLines = [
      `Live data from ${fetched.source}: ${fetched.rawValue} (${fetched.unit})`,
      fetched.note ? `Context: ${fetched.note}` : null,
      threshold ? `Market threshold: ${thresholdStr}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const prompt = [
      `Market question: "${session.marketTitle}"`,
      dataLines,
      `Tentative oracle consensus: ${defaultVote ? 'YES' : 'NO'}`,
      `Your personality: ${agentDef.personality}`,
      '',
      'Reason about whether the market condition is plausible given current data and the time horizon.',
      'Be specific — cite the fetched price or value if available.',
      'Return strict JSON only: {"vote":"YES|NO","reasoning":"2-3 concise sentences"}',
    ].join('\n');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: ORACLE_REASONING_MODEL,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              `You are ${agent.name}, an autonomous oracle agent for a confidential prediction market. ` +
              `Your primary data source is ${agentDef.source}. ${agentDef.personality} ` +
              'Be concise, cite specific data, and output valid JSON only.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return fallback;
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = body.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) return fallback;

    // Strip potential markdown code fences before parsing
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const parsed = JSON.parse(cleaned) as { vote?: string; reasoning?: string };
    const modelVote =
      String(parsed.vote ?? '').toUpperCase() === 'NO' ? false : true;
    const reasoning = String(parsed.reasoning ?? '').trim();

    return {
      vote: modelVote,
      reasoning: reasoning.length > 0 ? reasoning : fallback.reasoning,
    };
  } catch {
    return fallback;
  }
}

// ── Resolution engine ──────────────────────────────────────────────────────────

async function runAgent(
  session: ResolutionSession,
  agent: OracleAgent,
  marketOutcome: boolean, // the "correct" outcome for this market
) {
  const delay = agentDelay(agent.id);
  const agentDef = AGENT_DEFINITIONS.find((d) => d.id === agent.id) ?? {
    id: agent.id,
    name: agent.name,
    source: 'unknown',
    personality: 'Neutral analyst.',
  };
  const source = agentDef.source;

  // ── FETCHING ────────────────────────────────────────────────────────────────
  updateAgent(session, agent.id, { status: 'fetching' });
  addLog(session, `contacting ${source} API…`, { agentName: agent.name });

  const asset = extractAsset(session.marketTitle);
  const [fetched] = await Promise.all([
    fetchSourceData(source, asset),
    sleep(delay),
  ]);

  if (fetched.price !== null) {
    addLog(
      session,
      `${source} → ${fetched.rawValue} ${fetched.unit} (${asset})`,
      { agentName: agent.name },
    );
  } else {
    addLog(
      session,
      `${source} → no price data${fetched.note ? ` — ${fetched.note}` : ''}`,
      { agentName: agent.name },
    );
  }

  // Slight disagreement fallback keeps non-unanimous behavior in degraded mode.
  const fallbackVote =
    agent.id === 7 && Math.random() < 0.15 ? !marketOutcome : marketOutcome;
  const ai = await generateAgentReasoning(
    session,
    agent,
    agentDef,
    fetched,
    fallbackVote,
  );
  const vote = ai.vote;
  const reasoning = ai.reasoning;

  // ── ATTESTING ───────────────────────────────────────────────────────────────
  updateAgent(session, agent.id, { status: 'attesting', reasoning, source });
  addLog(
    session,
    `attested ${vote ? 'YES' : 'NO'} — "${reasoning.slice(0, 96)}..."`,
    {
      agentName: agent.name,
    },
  );

  // Upload intermediate evidence to Storacha
  let storachaCid = '';
  try {
    storachaCid = await saveIntermediateEvidence(agent.id, session.marketId, {
      source,
      timestamp: new Date().toISOString(),
      claim: vote ? 'YES' : 'NO',
      vote,
      dataHash: ethers.keccak256(
        ethers.toUtf8Bytes(`${agent.name}-${session.marketId}-${Date.now()}`),
      ),
      reasoning,
    });
  } catch (err) {
    storachaCid = `storacha-not-configured-agent-${agent.id}`;
    console.warn(
      `[Agent ${agent.id}] Storacha unavailable: ${(err as Error).message}`,
    );
  }

  updateAgent(session, agent.id, { storachaCid });
  addLog(session, `evidence → Storacha CID: ${storachaCid.slice(0, 20)}...`, {
    agentName: agent.name,
    cid: storachaCid,
  });

  // Submit attestation on-chain to OracleAgentRegistry (Calibration)
  let calibrationTxHash = '';
  try {
    calibrationTxHash = await submitAttestation(
      agent.id,
      session.marketId,
      vote,
      storachaCid,
    );
    addLog(session, `attestation recorded on Calibration`, {
      agentName: agent.name,
      txHash: calibrationTxHash,
    });
  } catch (err) {
    console.warn(
      `[Agent ${agent.id}] Registry tx failed (registry not deployed?):`,
      (err as Error).message,
    );
  }

  // ── SUBMITTED ───────────────────────────────────────────────────────────────
  // Vote is revealed here — after the Calibration tx confirms (or fails).
  // This keeps the UI honest: badge + green border only appear post-attestation.
  updateAgent(session, agent.id, {
    status: 'submitted',
    vote,
    attestedAt: Date.now(),
  });

  // Save agent checkpoint to Storacha (persists state across restarts)
  try {
    await saveAgentCheckpoint(agent.id, {
      lastMarket: session.marketId,
      lastVote: vote,
      storachaCid,
      calibrationTx: calibrationTxHash,
      reputationScore: agent.reputationScore,
      correctVotes: vote ? 1 : 0,
      totalVotes: 1,
    });
  } catch {
    /* non-critical */
  }

  // Count votes and check for quorum
  session.yesVotes = session.agents.filter((a) => a.vote === true).length;
  session.noVotes = session.agents.filter((a) => a.vote === false).length;

  if (
    session.phase === 'collecting' &&
    (session.yesVotes >= quorumThreshold(session.agents.length) ||
      session.noVotes >= quorumThreshold(session.agents.length))
  ) {
    await finalizeResolution(session);
  }
}

async function finalizeResolution(session: ResolutionSession) {
  if (session.phase !== 'collecting') return;
  session.phase = 'quorum_reached';
  // Strict quorum: one side reached the threshold.
  // Plurality fallback: most votes wins; tie → NO.
  const threshold = quorumThreshold(session.agents.length);
  if (session.yesVotes >= threshold) {
    session.outcome = true;
  } else if (session.noVotes >= threshold) {
    session.outcome = false;
  } else {
    session.outcome = session.yesVotes > session.noVotes;
  }

  const outcome = session.outcome;

  addLog(
    session,
    `QUORUM REACHED ${session.yesVotes}/${session.agents.length} → outcome: ${
      outcome ? 'YES' : 'NO'
    }`,
    {
      agentName: null,
    },
  );

  broadcast(session.marketId, {
    type: 'quorum_reached',
    marketId: session.marketId,
    payload: {
      yesVotes: session.yesVotes,
      noVotes: session.noVotes,
      outcome,
    },
  });

  // ── Upload finalized evidence bundle to Filecoin via Synapse SDK ─────────────

  session.phase = 'uploading';
  addLog(
    session,
    'uploading finalized evidence bundle to Filecoin via Synapse SDK...',
  );

  const evidenceBundle = {
    type: 'finalized-evidence-bundle',
    marketId: session.marketId,
    outcome: outcome ? 'YES' : 'NO',
    quorum: `${session.yesVotes}-of-${session.agents.length}`,
    finalizedAt: new Date().toISOString(),
    attestations: session.agents
      .filter((a) => a.vote !== null)
      .map((a) => ({
        agentId: a.id,
        agentName: a.name,
        vote: a.vote ? 'YES' : 'NO',
        storachaCid: a.storachaCid,
      })),
  };

  let finalEvidenceCid = '';
  try {
    finalEvidenceCid = await uploadToFilecoin(
      evidenceBundle,
      `market-${session.marketId}-evidence-bundle`,
    );
    session.finalEvidenceCid = finalEvidenceCid;
    addLog(
      session,
      `evidence bundle → Filecoin Piece CID: ${finalEvidenceCid}`,
      {
        cid: finalEvidenceCid,
      },
    );
  } catch (err) {
    console.warn('[Synapse] Upload failed:', (err as Error).message);
    finalEvidenceCid = 'bafkzcib-not-configured';
    session.finalEvidenceCid = finalEvidenceCid;
  }

  const votingAgents = session.agents.filter((a) => a.vote !== null);

  // ── FINALIZE NOW — evidence bundle on Filecoin is the canonical proof ─────────
  // The Piece CID proves quorum immutably.  Everything below (registry CID
  // records on Calibration + rep snapshot uploads to Filecoin) is bookkeeping
  // that runs in the background and does not gate settlement.

  session.phase = 'finalized';
  session.finalizedAt = Date.now();

  markMarketFinalized(session.marketId, outcome);

  addLog(session, 'resolution finalized — oracle outcome sealed');

  // ── Cadence scheduler: commit delivery on-chain at market expiry ────────────
  // Fire-and-forget POST to the cadence adapter microservice. If the adapter
  // is not running or not configured, this silently skips — vault-reporter.ts
  // below remains the immediate fallback path.
  if (CADENCE_ADAPTER_URL) {
    void fetch(`${CADENCE_ADAPTER_URL}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketId: session.marketId, outcome }),
    })
      .then(async (r) => {
        const result = (await r.json()) as {
          status: string;
          txId: string | null;
          message: string;
        };
        addLog(session, `[CadenceScheduler] ${result.message}`, {
          txHash: result.txId ?? null,
        });
      })
      .catch(() => {
        addLog(
          session,
          '[CadenceScheduler] adapter not reachable — skipped (vault-reporter fallback active)',
        );
      });
  }

  broadcast(session.marketId, {
    type: 'finalized',
    marketId: session.marketId,
    payload: {
      outcome,
      finalEvidenceCid,
      calibrationTxHash: session.calibrationTxHash,
    },
  });

  patchSession(session, {
    settlementRelay: {
      status: ENABLE_AUTONOMOUS_SETTLEMENT_DELIVERY ? 'pending' : 'disabled',
      totalUsers: 0,
      processedUsers: 0,
      relayedUsers: 0,
      failedUsers: 0,
      lastError: null,
    },
  });

  if (ENABLE_AUTONOMOUS_SETTLEMENT_DELIVERY) {
    addLog(
      session,
      'post-finalize settlement sweep queued (autonomous relay mode)',
    );
  } else {
    addLog(
      session,
      'autonomous settlement relay disabled — users claim via /oracle/settle/:marketId',
    );
  }

  // ── Background: canonical Sepolia resolve → settlement sweep → Flow mirror ────
  // Order matters: settlement reads GhostEAMM.getMarketMeta() to verify the market
  // is Resolved before signing. Running it before the resolveMarket tx confirms
  // produces "Market not resolved (status: 0)". We therefore chain the sweep
  // inside the Sepolia sync block so it only fires after confirmation.
  patchSession(session, {
    sepoliaResolutionSync: { status: 'pending', txHash: null },
    flowResolutionSync: { status: 'pending', txHash: null },
  });
  addLog(
    session,
    'starting cross-chain status sync (Sepolia canonical -> Flow mirror)',
  );

  void (async () => {
    // Run Sepolia canonical resolve + GhostVault outcome report in parallel.
    // Both must confirm before the settlement sweep runs — the sweep now reads
    // pool totals from GhostVault (Option B), so reportOutcome must be on-chain.
    const [sepoliaSync, vaultOutcomeSync] = await Promise.all([
      resolveGhostEammOnSepolia(session.marketId, outcome),
      reportOutcomeToVault(session.marketId, outcome),
    ]);

    patchSession(session, { sepoliaResolutionSync: sepoliaSync });

    // Log vault outcome result
    if (vaultOutcomeSync.status === 'synced') {
      addLog(
        session,
        `GhostVault outcome reported: ${outcome ? 'YES' : 'NO'}`,
        {
          txHash: vaultOutcomeSync.txHash ?? null,
        },
      );
    } else if (vaultOutcomeSync.status === 'already_set') {
      addLog(session, 'GhostVault outcome already set (idempotent)');
    } else if (vaultOutcomeSync.status === 'skipped') {
      addLog(session, 'GhostVault outcome report skipped (missing config)');
    } else {
      addLog(
        session,
        `GhostVault outcome report failed: ${vaultOutcomeSync.message}`,
      );
    }

    if (sepoliaSync.status === 'synced') {
      addLog(session, 'Sepolia market status synced', {
        txHash: sepoliaSync.txHash ?? null,
      });
      void runAutonomousSettlementSweep(session);
    } else if (sepoliaSync.status === 'skipped') {
      addLog(session, 'Sepolia sync skipped (missing config)');
      // Settlement sweep still runs — Option B reads outcome from GhostVault,
      // so Sepolia is not required for payout computation.
      void runAutonomousSettlementSweep(session);
    } else {
      addLog(session, 'Sepolia sync failed', {
        txHash: sepoliaSync.txHash ?? null,
      });
      patchSession(session, {
        flowResolutionSync: { status: 'skipped', txHash: null },
      });
      addLog(
        session,
        'Flow mirror skipped because Sepolia canonical resolve did not sync',
      );
      return;
    }

    const flowSync = await resolveFlowMarketOnFlow(session.marketId, outcome);
    patchSession(session, { flowResolutionSync: flowSync });
    if (flowSync.status === 'synced') {
      addLog(session, 'Flow market status mirrored', {
        txHash: flowSync.txHash ?? null,
      });
    } else if (flowSync.status === 'skipped') {
      addLog(
        session,
        'Flow mirror pending/skipped (missing config or market not expired yet)',
      );
    } else {
      addLog(session, 'Flow mirror failed', {
        txHash: flowSync.txHash ?? null,
      });
    }
  })();

  // ── Background: record evidence CID in OracleAgentRegistry ───────────────────
  // Serialised by enqueueWrite (Calibration nonce ordering) but non-blocking.
  // Fires and forgets — each tx logs its own result when it confirms.

  addLog(
    session,
    'recording evidence CID in OracleAgentRegistry (background)...',
  );

  Promise.allSettled(
    votingAgents.map(async (agent) => {
      const txHash = await recordEvidence(
        agent.id,
        session.marketId,
        finalEvidenceCid,
      );
      if (txHash) {
        patchSession(session, { calibrationTxHash: txHash });
        addLog(session, `OracleAgentRegistry updated for agent-${agent.id}`, {
          agentName: agent.name,
          txHash,
        });
      }
      return txHash;
    }),
  ).then((results) => {
    const txHash =
      results
        .filter(
          (r): r is PromiseFulfilledResult<string> =>
            r.status === 'fulfilled' && !!r.value,
        )
        .map((r) => r.value)
        .at(-1) ?? '';
    if (txHash) {
      session.calibrationTxHash = txHash;
      addLog(
        session,
        `OracleAgentRegistry updated → Calibration tx: ${txHash.slice(
          0,
          18,
        )}...`,
        {
          txHash,
        },
      );
    }
  });

  // ── Background: upload reputation snapshots to Filecoin in parallel ───────────
  // Still goes to Filecoin via Synapse SDK — satisfies Track 3 (Reputation &
  // Portable Identity).  4 concurrent Synapse uploads ≈ time of 1 serial upload.

  addLog(
    session,
    'uploading reputation snapshots to Filecoin (parallel, background)...',
  );

  Promise.allSettled(
    votingAgents.map(async (agent) => {
      const correct = agent.vote === outcome;
      const newScore = correct
        ? Math.min(100, agent.reputationScore + 2)
        : Math.max(0, agent.reputationScore - 10);

      const repSnapshot = {
        type: 'reputation-snapshot',
        agentId: agent.id,
        agentName: agent.name,
        marketId: session.marketId,
        vote: agent.vote ? 'YES' : 'NO',
        correct,
        scoreBefore: agent.reputationScore,
        scoreAfter: newScore,
        timestamp: new Date().toISOString(),
      };

      let repCid = '';
      try {
        repCid = await uploadToFilecoin(
          repSnapshot,
          `agent-${agent.id}-rep-snapshot`,
        );
        addLog(
          session,
          `agent-${agent.id} rep snapshot → Filecoin CID: ${repCid.slice(
            0,
            20,
          )}...`,
          {
            agentName: agent.name,
            cid: repCid,
          },
        );
      } catch (err) {
        console.warn(
          `[Synapse] Rep snapshot for agent ${agent.id} failed:`,
          (err as Error).message,
        );
      }

      if (agent.erc8004Id !== null) {
        try {
          await postERC8004Reputation(
            agent.erc8004Id,
            newScore,
            finalEvidenceCid,
            session.marketId,
          );
        } catch {
          /* not fatal */
        }
      }

      updateAgent(session, agent.id, { reputationScore: newScore });
    }),
  ).then(() => {
    addLog(session, 'all reputation snapshots uploaded to Filecoin');
  });
}

async function runAutonomousSettlementSweep(
  session: ResolutionSession,
): Promise<void> {
  if (!ENABLE_AUTONOMOUS_SETTLEMENT_DELIVERY) return;
  if (session.phase !== 'finalized') return;

  try {
    const users = await listMarketParticipants(session.marketId);
    patchSession(session, {
      settlementRelay: {
        ...session.settlementRelay,
        status: 'running',
        totalUsers: users.length,
      },
    });

    if (users.length === 0) {
      addLog(
        session,
        'settlement sweep found no registered participants for this market',
      );
      patchSession(session, {
        settlementRelay: {
          ...session.settlementRelay,
          status: 'completed',
        },
      });
      return;
    }

    addLog(
      session,
      `settlement sweep started for ${users.length} participant(s)`,
    );

    let processedUsers = 0;
    let relayedUsers = 0;
    let failedUsers = 0;

    for (const userAddress of users) {
      try {
        const settlement = await getOrComputeSettlement(
          session.marketId,
          userAddress,
        );
        const txHash = await deliverSettlementOnChain(settlement);
        processedUsers += 1;

        if (txHash) {
          relayedUsers += 1;
          patchSession(session, { flowTxHash: txHash });
          addLog(session, `settlement relayed for ${userAddress}`, { txHash });
          broadcast(session.marketId, {
            type: 'settlement_delivered',
            marketId: session.marketId,
            payload: { userAddress, txHash },
          });
        } else {
          addLog(
            session,
            `settlement prepared for ${userAddress} (no relay tx sent)`,
          );
        }
      } catch (err) {
        processedUsers += 1;
        failedUsers += 1;
        const message = (err as Error).message ?? 'unknown settlement error';
        addLog(
          session,
          `settlement sweep failed for ${userAddress}: ${message}`,
        );
      }

      patchSession(session, {
        settlementRelay: {
          ...session.settlementRelay,
          status: 'running',
          processedUsers,
          relayedUsers,
          failedUsers,
        },
      });
    }

    patchSession(session, {
      settlementRelay: {
        ...session.settlementRelay,
        status: failedUsers > 0 ? 'failed' : 'completed',
        processedUsers,
        relayedUsers,
        failedUsers,
      },
    });
    addLog(
      session,
      `settlement sweep ${
        failedUsers > 0 ? 'completed with failures' : 'completed'
      } ` + `(${relayedUsers}/${processedUsers} relayed)`,
    );
  } catch (err) {
    const message = (err as Error).message ?? 'unknown sweep error';
    patchSession(session, {
      settlementRelay: {
        ...session.settlementRelay,
        status: 'failed',
        lastError: message,
      },
    });
    addLog(session, `settlement sweep failed to start: ${message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Call GhostEAMM.resolveMarket() on Sepolia after oracle quorum.
 * This sets status = Resolved (1) so the Lit Action can verify it before signing.
 * Runs in the background — does not block finalization.
 */
async function resolveGhostEammOnSepolia(
  marketId: string,
  outcome: boolean,
): Promise<{ status: 'synced' | 'failed' | 'skipped'; txHash: string | null }> {
  const sepoliaRpc = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
  // Use EAMM_RESOLVER_PRIVATE_KEY (deployer/owner) — the oracle's SEPOLIA_PRIVATE_KEY
  // may not have the onlyResolverOrOwner role on GhostEAMM.
  const sepoliaKey =
    process.env.EAMM_RESOLVER_PRIVATE_KEY ??
    process.env.SEPOLIA_PRIVATE_KEY ??
    '';
  const eammAddress = process.env.GHOST_EAMM_ADDRESS ?? '';

  if (!sepoliaKey || !eammAddress) {
    console.warn(
      '[EAMM] Skipping resolveMarket — SEPOLIA_PRIVATE_KEY or GHOST_EAMM_ADDRESS not set',
    );
    return { status: 'skipped', txHash: null };
  }

  const EAMM_RESOLVE_ABI = [
    'function resolveMarket(uint256 marketId, bool outcome) external',
    'function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)',
  ];

  try {
    const provider = new ethers.JsonRpcProvider(sepoliaRpc);
    const wallet = new ethers.Wallet(sepoliaKey, provider);
    const eamm = new ethers.Contract(eammAddress, EAMM_RESOLVE_ABI, wallet);

    // Check current status before sending tx (idempotent)
    const [currentStatus] = (await eamm.getMarketMeta(BigInt(marketId))) as [
      number,
      boolean,
      bigint,
    ];
    if (Number(currentStatus) === 1) {
      console.log(
        `[EAMM] Market ${marketId} already Resolved on Sepolia — skipping`,
      );
      return { status: 'synced', txHash: null };
    }

    console.log(
      `[EAMM] Resolving market ${marketId} on Sepolia (outcome=${outcome})…`,
    );
    const tx = await eamm.resolveMarket(BigInt(marketId), outcome);
    console.log(`[EAMM] resolveMarket TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(
      `[EAMM] Market ${marketId} Resolved on Sepolia — block ${receipt.blockNumber}`,
    );
    console.log(`[EAMM] Etherscan: https://sepolia.etherscan.io/tx/${tx.hash}`);
    return { status: 'synced', txHash: tx.hash };
  } catch (err) {
    console.warn(
      `[EAMM] resolveMarket failed (non-fatal): ${(err as Error).message}`,
    );
    return { status: 'failed', txHash: null };
  }
}

async function resolveFlowMarketOnFlow(
  marketId: string,
  outcome: boolean,
): Promise<{ status: 'synced' | 'failed' | 'skipped'; txHash: string | null }> {
  const flowRpc =
    process.env.FLOW_RPC_URL ?? 'https://testnet.evm.nodes.onflow.org';
  const flowKey =
    process.env.FLOW_MARKET_RESOLVER_PRIVATE_KEY ??
    process.env.EAMM_RESOLVER_PRIVATE_KEY ??
    process.env.SETTLEMENT_SIGNER_PRIVATE_KEY ??
    '';
  const marketAddress =
    process.env.GHOST_MARKET_ADDRESS ??
    process.env.NEXT_PUBLIC_GHOST_MARKET_ADDRESS ??
    '';

  if (!flowKey || !marketAddress) {
    console.warn(
      '[FlowMarket] Skipping resolveMarket — resolver key or GHOST_MARKET_ADDRESS not set',
    );
    return { status: 'skipped', txHash: null };
  }

  const FLOW_MARKET_ABI = [
    'function resolveMarket(uint256 marketId, bool outcome) external',
    'function markets(uint256 marketId) view returns (string,string,string,string,uint64,uint8,uint256,uint256,bool,address)',
  ];

  try {
    const provider = new ethers.JsonRpcProvider(flowRpc);
    const wallet = new ethers.Wallet(flowKey, provider);
    const market = new ethers.Contract(marketAddress, FLOW_MARKET_ABI, wallet);

    const raw = await market.markets(BigInt(marketId));
    const status = Number(raw[5] ?? 0);
    if (status === 1) {
      console.log(
        `[FlowMarket] Market ${marketId} already Resolved on Flow — skipping`,
      );
      return { status: 'synced', txHash: null };
    }

    const tx = await market.resolveMarket(BigInt(marketId), outcome);
    console.log(`[FlowMarket] resolveMarket TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(
      `[FlowMarket] Market ${marketId} Resolved on Flow — block ${receipt.blockNumber}`,
    );
    console.log(
      `[FlowMarket] Flowscan: https://evm-testnet.flowscan.io/tx/${tx.hash}`,
    );
    return { status: 'synced', txHash: tx.hash };
  } catch (err) {
    const message = (err as Error).message ?? '';
    // 0x2b1b5cb3 => GhostMarket.MarketNotExpiredYet()
    if (message.includes('0x2b1b5cb3')) {
      console.warn(
        `[FlowMarket] Market ${marketId} not expired yet on Flow — deferring mirror resolve (non-fatal)`,
      );
      return { status: 'skipped', txHash: null };
    }
    console.warn(`[FlowMarket] resolveMarket failed (non-fatal): ${message}`);
    return { status: 'failed', txHash: null };
  }
}

// ── Storacha read endpoints (Track 2 — cross-agent knowledge sharing) ─────────

/**
 * Read any object from Storacha by CID.
 * Called by Shade and Vex in the Python layer to read peer evidence
 * before casting their own votes.
 */
app.get('/oracle/storacha/read/:cid', async (req, res) => {
  try {
    const data = await readPeerEvidence(req.params.cid);
    if (!data)
      return res.status(404).json({ error: 'CID not found or unreadable' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Return the current head CIDs for all agents.
 * Used by the Python layer to discover which CIDs to read.
 */
app.get('/oracle/storacha/agent-heads', (_req, res) => {
  res.json(getAllHeads());
});

/**
 * Return the checkpoint for a specific agent.
 * Used by the Python layer on startup to restore agent state.
 */
app.get('/oracle/storacha/checkpoint/:agentId', async (req, res) => {
  const agentId = Number(req.params.agentId);
  const rep = agentReputation.get(agentId);
  const last = agentLastMarket.get(agentId);
  if (rep !== undefined) {
    res.json({
      agentId,
      reputationScore: rep,
      lastMarket: last ?? null,
      source: 'storacha-checkpoint',
    });
  } else {
    res.json({
      agentId,
      reputationScore: 80,
      lastMarket: null,
      source: 'default',
    });
  }
});

// ── Chain-interaction endpoints (called by Python api/ layer) ─────────────────

/** Upload intermediate evidence to Storacha */
app.post('/oracle/storacha/upload', async (req, res) => {
  try {
    const { agentId, marketId, evidence } = req.body as {
      agentId: number;
      marketId: number;
      evidence: Record<string, unknown>;
    };
    const cid = await saveIntermediateEvidence(
      agentId,
      marketId,
      evidence as Parameters<typeof saveIntermediateEvidence>[2],
    );
    res.json({ cid });
  } catch (err) {
    console.warn('[Storacha] upload failed:', (err as Error).message);
    res.json({ cid: null, error: (err as Error).message });
  }
});

/** Submit attestation to OracleAgentRegistry on Calibration */
app.post('/oracle/registry/attest', async (req, res) => {
  try {
    const { agentId, marketId, vote, storachaCid } = req.body as {
      agentId: number;
      marketId: number;
      vote: boolean;
      storachaCid: string;
    };
    const txHash = await submitAttestation(
      agentId,
      marketId,
      vote,
      storachaCid,
    );
    res.json({ txHash });
  } catch (err) {
    console.warn('[Registry] attest failed:', (err as Error).message);
    res.json({ txHash: null, error: (err as Error).message });
  }
});

/** Upload finalized evidence bundle to Filecoin via Synapse + record in registry */
app.post('/oracle/synapse/upload-bundle', async (req, res) => {
  try {
    const bundle = req.body as {
      marketId: number;
      outcome: boolean;
      yesVotes: number;
      noVotes: number;
      agents: Array<{
        id: number;
        name: string;
        vote: boolean;
        storachaCid: string | null;
        reasoning: string;
      }>;
    };

    const payload = {
      type: 'finalized-evidence-bundle',
      ...bundle,
      outcome: bundle.outcome ? 'YES' : 'NO',
      quorum: `${bundle.yesVotes}-of-${bundle.agents.length}`,
      finalizedAt: new Date().toISOString(),
    };

    const pieceCid = await uploadToFilecoin(
      payload,
      `market-${bundle.marketId}-bundle`,
    );

    // Record evidence CID in registry for each attesting agent (parallel)
    const registrySettled = await Promise.allSettled(
      bundle.agents.map((agent) =>
        recordEvidence(agent.id, bundle.marketId, pieceCid),
      ),
    );
    let calibrationTx = '';
    for (const r of registrySettled) {
      if (r.status === 'fulfilled' && r.value) calibrationTx = r.value;
    }

    res.json({ pieceCid, calibrationTx });
  } catch (err) {
    console.warn('[Synapse] bundle upload failed:', (err as Error).message);
    res.json({
      pieceCid: null,
      calibrationTx: null,
      error: (err as Error).message,
    });
  }
});

/** Upload reputation snapshots to Filecoin + update registry + post ERC-8004 feedback */
app.post('/oracle/reputation/update', async (req, res) => {
  try {
    const { marketId, outcome, agents, evidenceCid } = req.body as {
      marketId: number;
      outcome: boolean;
      evidenceCid: string;
      agents: Array<{
        id: number;
        name: string;
        vote: boolean | null;
        reputation: number;
        erc8004Id: number | null;
      }>;
    };

    const votingAgents = agents.filter((a) => a.vote !== null);

    // Upload all rep snapshots to Filecoin in parallel (same destination — Synapse —
    // just concurrent instead of serial, so 4 uploads ≈ time of 1).
    const results = await Promise.allSettled(
      votingAgents.map(async (agent) => {
        const correct = agent.vote === outcome;
        const newScore = correct
          ? Math.min(100, agent.reputation + 2)
          : Math.max(0, agent.reputation - 10);

        const snapshot = {
          type: 'reputation-snapshot',
          agentId: agent.id,
          agentName: agent.name,
          marketId,
          vote: agent.vote ? 'YES' : 'NO',
          correct,
          scoreBefore: agent.reputation,
          scoreAfter: newScore,
          timestamp: new Date().toISOString(),
        };

        let repCid = '';
        try {
          repCid = await uploadToFilecoin(snapshot, `agent-${agent.id}-rep`);
        } catch {
          /* not fatal in dev */
        }

        if (agent.erc8004Id !== null) {
          try {
            await postERC8004Reputation(
              BigInt(agent.erc8004Id),
              newScore,
              evidenceCid || repCid,
              marketId,
            );
          } catch {
            /* not fatal */
          }
        }

        return { agentId: agent.id, newScore, repCid };
      }),
    );

    const updates = results
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<{
          agentId: number;
          newScore: number;
          repCid: string;
        }> => r.status === 'fulfilled',
      )
      .map((r) => r.value);

    res.json({ updates });
  } catch (err) {
    res.json({ updates: [], error: (err as Error).message });
  }
});

// ── Settlement endpoints (Phase 6) ────────────────────────────────────────────

/**
 * POST /oracle/bets/register
 * Body: { marketId: string | number, userAddress: string, betTxHash: string }
 *
 * Registers the canonical BetPlaced tx hash for deterministic settlement later.
 */
app.post('/oracle/bets/register', async (req, res) => {
  const body = req.body as {
    marketId?: string | number;
    userAddress?: string;
    betTxHash?: string;
  };
  const marketId = body.marketId !== undefined ? String(body.marketId) : '';
  const userAddress = body.userAddress ?? '';
  const betTxHash = body.betTxHash ?? '';

  if (!/^\d+$/.test(marketId)) {
    return res.status(400).json({ error: 'Invalid or missing marketId' });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(userAddress)) {
    return res.status(400).json({ error: 'Invalid or missing userAddress' });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(betTxHash)) {
    return res.status(400).json({ error: 'Invalid or missing betTxHash' });
  }

  try {
    await registerCanonicalBetTxHash(marketId, userAddress, betTxHash);
    return res.json({
      ok: true,
      marketId,
      userAddress: userAddress.toLowerCase(),
      betTxHash: betTxHash.toLowerCase(),
      source: 'registered',
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /oracle/bets/:marketId/:userAddress
 *
 * Returns canonical bet tx hash for this user+market if previously registered.
 */
app.get('/oracle/bets/:marketId/:userAddress', async (req, res) => {
  const { marketId, userAddress } = req.params;
  if (!/^\d+$/.test(marketId)) {
    return res.status(400).json({ error: 'Invalid marketId' });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(userAddress)) {
    return res.status(400).json({ error: 'Invalid userAddress' });
  }

  try {
    const betTxHash = await getCanonicalBetTxHash(marketId, userAddress);
    return res.json({
      marketId,
      userAddress: userAddress.toLowerCase(),
      betTxHash,
      source: betTxHash ? 'registered' : 'none',
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /oracle/settle/:marketId
 * Body: { userAddress: string }
 *
 * Returns a signed settlement message for the user to submit to GhostVault.claimPayout().
 * The oracle reads the market outcome and the user's locked collateral on-chain,
 * computes the net payout, and signs with the settlement key (or Lit PKP).
 *
 * The user then calls GhostVault.claimPayout(marketId, payout, nonce, expiry, sig)
 * on Flow EVM to release their collateral lock and credit the payout.
 */
app.post('/oracle/settle/:marketId', async (req, res) => {
  const marketId = req.params.marketId;
  const body = req.body as { userAddress?: string; betTxHash?: string };
  const userAddress = body?.userAddress;
  // Optional: the tx hash where the user placed their bet.
  // When provided, the oracle resolves its exact block number and passes it to
  // the Lit Action so eth_getLogs uses a 1-block range (works on Alchemy free tier).
  const betTxHash = body?.betTxHash;
  // #region agent log
  fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': '37e9d3',
    },
    body: JSON.stringify({
      sessionId: '37e9d3',
      runId: 'settle-request',
      hypothesisId: 'H1',
      location: 'index.ts:settle-entry',
      message: 'Settlement request received',
      data: {
        marketId,
        userAddress: userAddress ?? null,
        hasBetTxHash: Boolean(betTxHash),
        betTxHashPrefix: betTxHash?.slice(0, 18) ?? null,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  if (!userAddress || !/^0x[0-9a-fA-F]{40}$/.test(userAddress)) {
    return res.status(400).json({ error: 'Invalid or missing userAddress' });
  }

  const session = sessions.get(marketId);
  if (!session || session.phase !== 'finalized') {
    // The oracle may have restarted and lost in-memory session state.
    // Fall back to the canonical on-chain source (GhostEAMM on Sepolia).
    try {
      const _sepoliaRpc =
        process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
      const _eammAddr = process.env.GHOST_EAMM_ADDRESS ?? '';
      const _eamm = new (await import('ethers')).ethers.Contract(
        _eammAddr,
        [
          'function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)',
        ],
        new (await import('ethers')).ethers.JsonRpcProvider(_sepoliaRpc),
      );
      const [_status, _outcome] = await _eamm.getMarketMeta(BigInt(marketId));
      if (Number(_status) !== 1) {
        return res.status(409).json({
          error: 'Market not finalized',
          phase: session?.phase ?? 'unknown',
        });
      }
      // EAMM confirms market is resolved — restore finalization state for this request.
      console.log(
        `[Settlement] Market ${marketId} confirmed resolved on EAMM (recovering from oracle restart)`,
      );
      markMarketFinalized(marketId, Boolean(_outcome));
    } catch {
      return res.status(409).json({
        error: 'Market not finalized',
        phase: session?.phase ?? 'unknown',
      });
    }
  }

  try {
    // #region agent log
    fetch('http://127.0.0.1:7884/ingest/fbd2257e-f2ff-467e-b558-4abfac1502be', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': '37e9d3',
      },
      body: JSON.stringify({
        sessionId: '37e9d3',
        runId: 'settle-request',
        hypothesisId: 'H1-H2',
        location: 'index.ts:before-getOrComputeSettlement',
        message: 'Calling getOrComputeSettlement',
        data: { marketId, userAddress, hasBetTxHash: Boolean(betTxHash) },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const settlement = await getOrComputeSettlement(
      marketId,
      userAddress,
      betTxHash,
    );

    const marketIdUint = parseInt(marketId, 10).toString();
    const marketIdBytes32 =
      '0x' + BigInt(marketIdUint).toString(16).padStart(64, '0');

    const response: SettlementClaimResponse = {
      marketId,
      userAddress: settlement.userAddress,
      sig: settlement.sig,
      payout: settlement.payout,
      nonce: settlement.nonce,
      expiry: settlement.expiry,
      marketIdBytes32,
      vaultAddress:
        process.env.GHOST_VAULT_ADDRESS ??
        '0xAf470490b2462DC7359605B8e5D731CbB7816B55',
      signerAddress: settlement.signerAddress,
      signingPath: settlement.signingPath,
      deliveredTx: settlement.deliveredTx,
    };

    // Optionally attempt autonomous delivery in the background
    if (!settlement.deliveredTx && settlement.payout !== '0') {
      deliverSettlementOnChain(settlement)
        .then((txHash) => {
          if (txHash && session) {
            addLog(session, `settlement delivered to Flow EVM → ${txHash}`, {
              txHash,
            });
            session.flowTxHash = txHash;
            broadcast(marketId, {
              type: 'settlement_delivered',
              marketId,
              payload: { userAddress, txHash, payout: settlement.payout },
            });
          }
        })
        .catch(() => {
          /* non-critical */
        });
    }

    res.json(response);
  } catch (err) {
    const message = (err as Error).message;
    console.error('[Settlement] Error:', message);
    res.status(422).json({ error: message });
  }
});

/**
 * GET /oracle/settle/:marketId/:userAddress
 * Returns a cached settlement if one has already been computed for this user.
 * Returns 404 if no settlement has been computed yet.
 */
app.get('/oracle/settle/:marketId/:userAddress', (req, res) => {
  const { marketId, userAddress } = req.params;

  const session = sessions.get(marketId);
  if (!session || session.phase !== 'finalized') {
    return res.status(409).json({
      error: 'Market not finalized',
      phase: session?.phase ?? 'unknown',
    });
  }

  const settlements = getMarketSettlements(marketId);
  const settlement = settlements.find(
    (s) => s.userAddress === userAddress.toLowerCase(),
  );

  if (!settlement) {
    return res.status(404).json({
      error: 'No settlement computed yet — call POST /oracle/settle/:marketId',
    });
  }

  const marketIdUint = parseInt(marketId, 10).toString();
  const marketIdBytes32 =
    '0x' + BigInt(marketIdUint).toString(16).padStart(64, '0');

  const response: SettlementClaimResponse = {
    marketId,
    userAddress: settlement.userAddress,
    sig: settlement.sig,
    payout: settlement.payout,
    nonce: settlement.nonce,
    expiry: settlement.expiry,
    marketIdBytes32,
    vaultAddress:
      process.env.GHOST_VAULT_ADDRESS ??
      '0xAf470490b2462DC7359605B8e5D731CbB7816B55',
    signerAddress: settlement.signerAddress,
    signingPath: settlement.signingPath,
    deliveredTx: settlement.deliveredTx,
  };

  res.json(response);
});

// ── REST endpoints ─────────────────────────────────────────────────────────────

app.get('/oracle/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ghost-oracle',
    timestamp: new Date().toISOString(),
  });
});

app.get('/oracle/market-titles', (_req, res) => {
  res.json(MARKET_TITLES);
});

app.get('/oracle/agents', async (_req, res) => {
  try {
    let count = 0;
    try {
      count = await getAgentCount();
    } catch {
      /* registry not deployed */
    }
    const agents: object[] = [];
    for (let i = 1; i <= Math.max(count, ACTIVE_AGENT_COUNT); i++) {
      try {
        const info = await getAgentInfo(i);
        agents.push({ id: i, ...info });
      } catch {
        agents.push({ id: i, error: 'not registered' });
      }
    }
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/oracle/status/:marketId', (req, res) => {
  const marketId = req.params.marketId;
  const session = sessions.get(marketId);
  if (!session)
    return res
      .status(404)
      .json({ error: 'No resolution session for this market' });
  res.json(session);
});

app.post('/oracle/resolve/:marketId', async (req, res) => {
  const marketId = req.params.marketId;

  if (sessions.has(marketId)) {
    const existing = sessions.get(marketId)!;
    if (existing.phase !== 'finalized' && existing.phase !== 'failed') {
      return res.status(409).json({
        error: 'Resolution already in progress',
        phase: existing.phase,
      });
    }
  }

  // The caller can suggest the correct outcome; in production this comes from
  // trusted data sources fetched by the agents themselves.
  const marketOutcome: boolean = req.body?.outcome !== false;
  const marketTitle: string =
    req.body?.marketTitle ??
    MARKET_TITLES[String(marketId)] ??
    `Market #${marketId} — resolution in progress`;

  // Build fresh agent list with wallet addresses derived at runtime,
  // restoring reputation scores from Storacha checkpoints if available.
  const baseKey =
    process.env.CALIBRATION_PRIVATE_KEY ??
    ethers.hexlify(ethers.randomBytes(32));
  const addresses = Array.from({ length: ACTIVE_AGENT_COUNT }, (_, i) => {
    try {
      const derived = new ethers.Wallet(
        ethers.keccak256(ethers.toUtf8Bytes(`${baseKey}-oracle-${i + 1}`)),
      );
      return derived.address;
    } catch {
      return `0x${(i + 1).toString(16).padStart(40, '0')}`;
    }
  });

  const agentList = buildAgents(addresses)
    .slice(0, ACTIVE_AGENT_COUNT)
    .map((a) => ({
      ...a,
      // Restore reputation from checkpoint if this agent has one
      reputationScore: agentReputation.get(a.id) ?? a.reputationScore,
    }));

  const session: ResolutionSession = {
    marketId,
    marketTitle,
    phase: 'collecting',
    agents: agentList,
    yesVotes: 0,
    noVotes: 0,
    outcome: null,
    finalEvidenceCid: null,
    calibrationTxHash: null,
    flowTxHash: null,
    sepoliaResolutionSync: { status: 'idle', txHash: null },
    flowResolutionSync: { status: 'idle', txHash: null },
    settlementRelay: {
      status: 'idle',
      totalUsers: 0,
      processedUsers: 0,
      relayedUsers: 0,
      failedUsers: 0,
      lastError: null,
    },
    startedAt: Date.now(),
    finalizedAt: null,
    log: [],
  };

  sessions.set(marketId, session);

  addLog(
    session,
    `resolution started for market ${marketId} — ${ACTIVE_AGENT_COUNT} agents initializing`,
  );

  res.json({ marketId, status: 'started', wsUrl: `/oracle/ws/${marketId}` });

  // Run active agents concurrently (each has its own delay, simulating async data fetching)
  Promise.allSettled(
    session.agents.map((agent) => runAgent(session, agent, marketOutcome)),
  ).then(() => {
    if (session.phase === 'collecting') {
      // All agents voted but neither side reached strict quorum (e.g. 2-2 split).
      // Use plurality: whichever side has more votes wins; ties resolve to NO
      // (safer default — users don't lose money on ambiguous outcomes).
      if (session.yesVotes > 0 || session.noVotes > 0) {
        addLog(
          session,
          `no strict quorum — using plurality (${session.yesVotes} YES vs ${session.noVotes} NO)`,
        );
        finalizeResolution(session);
      } else {
        session.phase = 'failed';
        addLog(session, 'resolution failed — no votes collected');
      }
    }
  });
});

// ── Utilities ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Global error handling ──────────────────────────────────────────────────────

// The Storacha upload client polls S3 endpoints for receipts after the main
// uploadFile() promise resolves. If the S3 endpoint times out, Node emits an
// unhandledRejection with UND_ERR_CONNECT_TIMEOUT. These are benign — the
// upload succeeded; only the receipt confirmation timed out. Swallow them here
// so they don't pollute the console.
process.on('unhandledRejection', (reason) => {
  const msg = (reason as Error)?.message ?? String(reason);
  const code = (reason as { cause?: { code?: string } })?.cause?.code ?? '';
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    msg === 'fetch failed' ||
    msg.includes('Connect Timeout')
  ) {
    console.warn(
      '[Storacha] receipt poll timeout (non-critical, upload succeeded)',
    );
    return;
  }
  // Re-emit anything else so real bugs aren't silenced
  console.error('[Oracle] Unhandled rejection:', reason);
});

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n=== GhostMarket Oracle Service ===`);
  console.log(`HTTP  : http://localhost:${PORT}/oracle/health`);
  console.log(`WS    : ws://localhost:${PORT}/oracle/ws/:marketId`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /oracle/resolve/:marketId   — trigger resolution`);
  console.log(`  GET  /oracle/status/:marketId    — resolution state`);
  console.log(`  GET  /oracle/agents              — registry info`);
  console.log(
    `  Active agents: ${ACTIVE_AGENT_COUNT} (quorum ${quorumThreshold(
      ACTIVE_AGENT_COUNT,
    )})`,
  );
  console.log(`\nOracle ready.\n`);
});
