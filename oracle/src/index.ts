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
import { uploadToFilecoin }                            from './synapse-client';
import {
  saveIntermediateEvidence, saveAgentCheckpoint,
  loadAllCheckpoints, readPeerEvidence, getAllHeads,
} from './storacha-client';
import { submitAttestation, recordEvidence, updateReputation, getAgentInfo, getAgentCount } from './registry-client';
import { postERC8004Reputation }                       from './erc8004-client';
import type {
  ResolutionSession, OracleAgent, LogEntry, WsMessage, AgentStatus,
} from './types';

dotenv.config();

// ── App setup ──────────────────────────────────────────────────────────────────

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = Number(process.env.PORT ?? 8080);
const ACTIVE_AGENT_COUNT = Math.max(1, Math.min(
  AGENT_DEFINITIONS.length,
  Number(process.env.ACTIVE_ORACLE_AGENTS ?? 4),
));
const quorumThreshold = (agentCount: number): number => Math.floor(agentCount / 2) + 1;

app.use(cors());
app.use(express.json());

// ── In-memory session store ────────────────────────────────────────────────────

const sessions = new Map<string, ResolutionSession>();

// WS clients subscribed per market
const subscribers = new Map<string, Set<WebSocket>>();

// Agent reputation restored from Storacha checkpoints on startup
const agentReputation = new Map<number, number>();   // agentId → score
const agentLastMarket = new Map<number, string | number>();   // agentId → last resolved market

// Load checkpoints asynchronously — non-blocking, results available within a few seconds
loadAllCheckpoints().then(checkpoints => {
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
}).catch(() => {
  console.log('[Storacha] Checkpoint load skipped (not configured)');
});

// ── WebSocket ──────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const match    = req.url?.match(/\/oracle\/ws\/([^/?]+)/);
  const marketId = match ? match[1] : null;

  if (!marketId) { ws.close(); return; }

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

function addLog(session: ResolutionSession, message: string, opts: {
  agentName?: string | null;
  txHash?: string | null;
  cid?: string | null;
} = {}) {
  const entry: LogEntry = {
    ts:        Date.now(),
    agentName: opts.agentName ?? null,
    message,
    txHash:    opts.txHash ?? null,
    cid:       opts.cid ?? null,
  };
  session.log.push(entry);
  broadcast(session.marketId, { type: 'log', marketId: session.marketId, payload: entry });
}

function updateAgent(session: ResolutionSession, agentId: number, patch: Partial<OracleAgent>) {
  const agent = session.agents.find(a => a.id === agentId);
  if (!agent) return;
  Object.assign(agent, patch);
  broadcast(session.marketId, {
    type:     'agent_update',
    marketId: session.marketId,
    payload:  agent,
  });
}

// ── Resolution engine ──────────────────────────────────────────────────────────

async function runAgent(
  session: ResolutionSession,
  agent: OracleAgent,
  marketOutcome: boolean,  // the "correct" outcome for this market
) {
  const delay      = agentDelay(agent.id);
  const agentDef   = AGENT_DEFINITIONS.find(d => d.id === agent.id);
  const source     = agentDef?.source ?? 'unknown';

  // ── FETCHING ────────────────────────────────────────────────────────────────
  updateAgent(session, agent.id, { status: 'fetching' });
  addLog(session, `fetching source data from ${source}`, { agentName: agent.name });

  await sleep(delay);

  // Simulate slight disagreement: agent 7 occasionally votes against consensus
  const vote = agent.id === 7 && Math.random() < 0.15 ? !marketOutcome : marketOutcome;

  // ── ATTESTING ───────────────────────────────────────────────────────────────
  updateAgent(session, agent.id, { status: 'attesting', vote });
  addLog(session, `attested ${vote ? 'YES' : 'NO'} — uploading evidence to Storacha`, {
    agentName: agent.name,
  });

  // Upload intermediate evidence to Storacha
  let storachaCid = '';
  try {
    storachaCid = await saveIntermediateEvidence(agent.id, session.marketId, {
      source,
      timestamp: new Date().toISOString(),
      claim:     vote ? 'YES' : 'NO',
      vote,
      dataHash:  ethers.keccak256(ethers.toUtf8Bytes(`${agent.name}-${session.marketId}-${Date.now()}`)),
      reasoning: `Simulated vote from ${agent.name} based on ${source} data`,
    });
  } catch (err) {
    storachaCid = `storacha-not-configured-agent-${agent.id}`;
    console.warn(`[Agent ${agent.id}] Storacha unavailable: ${(err as Error).message}`);
  }

  updateAgent(session, agent.id, { storachaCid });
  addLog(session, `evidence → Storacha CID: ${storachaCid.slice(0, 20)}...`, {
    agentName: agent.name,
    cid:       storachaCid,
  });

  // Submit attestation on-chain to OracleAgentRegistry (Calibration)
  let calibrationTxHash = '';
  try {
    calibrationTxHash = await submitAttestation(agent.id, session.marketId, vote, storachaCid);
    addLog(session, `attestation recorded on Calibration`, {
      agentName: agent.name,
      txHash:    calibrationTxHash,
    });
  } catch (err) {
    console.warn(`[Agent ${agent.id}] Registry tx failed (registry not deployed?):`, (err as Error).message);
  }

  // ── SUBMITTED ───────────────────────────────────────────────────────────────
  updateAgent(session, agent.id, { status: 'submitted', attestedAt: Date.now() });

  // Save agent checkpoint to Storacha (persists state across restarts)
  try {
    await saveAgentCheckpoint(agent.id, {
      lastMarket:      session.marketId,
      lastVote:        vote,
      storachaCid,
      calibrationTx:   calibrationTxHash,
      reputationScore: agent.reputationScore,
      correctVotes:    vote ? 1 : 0,
      totalVotes:      1,
    });
  } catch { /* non-critical */ }

  // Count votes and check for quorum
  session.yesVotes = session.agents.filter(a => a.vote === true).length;
  session.noVotes  = session.agents.filter(a => a.vote === false).length;

  if (
    session.phase === 'collecting' &&
    (
      session.yesVotes >= quorumThreshold(session.agents.length) ||
      session.noVotes >= quorumThreshold(session.agents.length)
    )
  ) {
    await finalizeResolution(session);
  }
}

async function finalizeResolution(session: ResolutionSession) {
  if (session.phase !== 'collecting') return;
  session.phase   = 'quorum_reached';
  session.outcome = session.yesVotes >= quorumThreshold(session.agents.length);

  const outcome = session.outcome;

  addLog(
    session,
    `QUORUM REACHED ${session.yesVotes}/${session.agents.length} → outcome: ${outcome ? 'YES' : 'NO'}`,
    {
    agentName: null,
    }
  );

  broadcast(session.marketId, {
    type:     'quorum_reached',
    marketId: session.marketId,
    payload:  {
      yesVotes: session.yesVotes,
      noVotes:  session.noVotes,
      outcome,
    },
  });

  // ── Upload finalized evidence bundle to Filecoin via Synapse SDK ─────────────

  session.phase = 'uploading';
  addLog(session, 'uploading finalized evidence bundle to Filecoin via Synapse SDK...');

  const evidenceBundle = {
    type:      'finalized-evidence-bundle',
    marketId:  session.marketId,
    outcome:   outcome ? 'YES' : 'NO',
    quorum:    `${session.yesVotes}-of-${session.agents.length}`,
    finalizedAt: new Date().toISOString(),
    attestations: session.agents
      .filter(a => a.vote !== null)
      .map(a => ({
        agentId:    a.id,
        agentName:  a.name,
        vote:       a.vote ? 'YES' : 'NO',
        storachaCid: a.storachaCid,
      })),
  };

  let finalEvidenceCid = '';
  try {
    finalEvidenceCid = await uploadToFilecoin(evidenceBundle, `market-${session.marketId}-evidence-bundle`);
    session.finalEvidenceCid = finalEvidenceCid;
    addLog(session, `evidence bundle → Filecoin Piece CID: ${finalEvidenceCid}`, {
      cid: finalEvidenceCid,
    });
  } catch (err) {
    console.warn('[Synapse] Upload failed:', (err as Error).message);
    finalEvidenceCid = 'bafkzcib-not-configured';
    session.finalEvidenceCid = finalEvidenceCid;
  }

  // ── Record evidence CID in OracleAgentRegistry ───────────────────────────────

  let calibrationTxHash = '';
  for (const agent of session.agents.filter(a => a.vote !== null)) {
    try {
      calibrationTxHash = await recordEvidence(agent.id, session.marketId, finalEvidenceCid);
    } catch { /* registry may not be deployed in dev */ }
  }

  if (calibrationTxHash) {
    session.calibrationTxHash = calibrationTxHash;
    addLog(session, `OracleAgentRegistry updated → Calibration tx: ${calibrationTxHash.slice(0, 18)}...`, {
      txHash: calibrationTxHash,
    });
  }

  // ── Upload reputation snapshots to Filecoin + update registry ────────────────

  addLog(session, 'uploading reputation snapshots to Filecoin...');

  for (const agent of session.agents.filter(a => a.vote !== null)) {
    const correct   = agent.vote === outcome;
    const newScore  = correct
      ? Math.min(100, agent.reputationScore + 2)
      : Math.max(0,   agent.reputationScore - 10);

    const repSnapshot = {
      type:         'reputation-snapshot',
      agentId:      agent.id,
      agentName:    agent.name,
      marketId:     session.marketId,
      vote:         agent.vote ? 'YES' : 'NO',
      correct,
      scoreBefore:  agent.reputationScore,
      scoreAfter:   newScore,
      timestamp:    new Date().toISOString(),
    };

    let repCid = '';
    try {
      repCid = await uploadToFilecoin(repSnapshot, `agent-${agent.id}-rep-snapshot`);
      await updateReputation(agent.id, repCid, newScore);
    } catch { /* not fatal in dev */ }

    // Post ERC-8004 feedback if agent has an ERC-8004 identity
    if (agent.erc8004Id !== null) {
      try {
        await postERC8004Reputation(
          agent.erc8004Id,
          newScore,
          finalEvidenceCid,
          session.marketId,
        );
      } catch { /* not fatal */ }
    }

    updateAgent(session, agent.id, { reputationScore: newScore });
  }

  // ── Mark session finalized ───────────────────────────────────────────────────

  session.phase       = 'finalized';
  session.finalizedAt = Date.now();

  addLog(session, 'market FINALIZED — settlement delivery to Flow pending (Phase 6)');

  broadcast(session.marketId, {
    type:     'finalized',
    marketId: session.marketId,
    payload:  {
      outcome,
      finalEvidenceCid,
      calibrationTxHash: session.calibrationTxHash,
    },
  });
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
    if (!data) return res.status(404).json({ error: 'CID not found or unreadable' });
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
  const rep     = agentReputation.get(agentId);
  const last    = agentLastMarket.get(agentId);
  if (rep !== undefined) {
    res.json({ agentId, reputationScore: rep, lastMarket: last ?? null, source: 'storacha-checkpoint' });
  } else {
    res.json({ agentId, reputationScore: 80, lastMarket: null, source: 'default' });
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
    const cid = await saveIntermediateEvidence(agentId, marketId, evidence as Parameters<typeof saveIntermediateEvidence>[2]);
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
    const txHash = await submitAttestation(agentId, marketId, vote, storachaCid);
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
      agents: Array<{ id: number; name: string; vote: boolean; storachaCid: string | null; reasoning: string }>;
    };

    const payload = {
      type:        'finalized-evidence-bundle',
      ...bundle,
      outcome:     bundle.outcome ? 'YES' : 'NO',
      quorum:      `${bundle.yesVotes}-of-${bundle.agents.length}`,
      finalizedAt: new Date().toISOString(),
    };

    const pieceCid = await uploadToFilecoin(payload, `market-${bundle.marketId}-bundle`);

    // Record evidence CID in registry for each attesting agent
    let calibrationTx = '';
    for (const agent of bundle.agents) {
      try {
        calibrationTx = await recordEvidence(agent.id, bundle.marketId, pieceCid);
      } catch { /* non-fatal */ }
    }

    res.json({ pieceCid, calibrationTx });
  } catch (err) {
    console.warn('[Synapse] bundle upload failed:', (err as Error).message);
    res.json({ pieceCid: null, calibrationTx: null, error: (err as Error).message });
  }
});

/** Upload reputation snapshots to Filecoin + update registry + post ERC-8004 feedback */
app.post('/oracle/reputation/update', async (req, res) => {
  try {
    const { marketId, outcome, agents, evidenceCid } = req.body as {
      marketId: number;
      outcome: boolean;
      evidenceCid: string;
      agents: Array<{ id: number; name: string; vote: boolean | null; reputation: number; erc8004Id: number | null }>;
    };

    const updates: Array<{ agentId: number; newScore: number; repCid: string }> = [];

    for (const agent of agents) {
      if (agent.vote === null) continue;

      const correct   = agent.vote === outcome;
      const newScore  = correct
        ? Math.min(100, agent.reputation + 2)
        : Math.max(0,   agent.reputation - 10);

      const snapshot = {
        type:        'reputation-snapshot',
        agentId:     agent.id,
        agentName:   agent.name,
        marketId,
        vote:        agent.vote ? 'YES' : 'NO',
        correct,
        scoreBefore: agent.reputation,
        scoreAfter:  newScore,
        timestamp:   new Date().toISOString(),
      };

      let repCid = '';
      try {
        repCid = await uploadToFilecoin(snapshot, `agent-${agent.id}-rep`);
        await updateReputation(agent.id, repCid, newScore);
      } catch { /* not fatal in dev */ }

      if (agent.erc8004Id !== null) {
        try {
          await postERC8004Reputation(
            BigInt(agent.erc8004Id),
            newScore,
            evidenceCid || repCid,
            marketId,
          );
        } catch { /* not fatal */ }
      }

      updates.push({ agentId: agent.id, newScore, repCid });
    }

    res.json({ updates });
  } catch (err) {
    res.json({ updates: [], error: (err as Error).message });
  }
});

// ── REST endpoints ─────────────────────────────────────────────────────────────

app.get('/oracle/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ghost-oracle', timestamp: new Date().toISOString() });
});

app.get('/oracle/agents', async (_req, res) => {
  try {
    let count = 0;
    try { count = await getAgentCount(); } catch { /* registry not deployed */ }
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
  const session  = sessions.get(marketId);
  if (!session) return res.status(404).json({ error: 'No resolution session for this market' });
  res.json(session);
});

app.post('/oracle/resolve/:marketId', async (req, res) => {
  const marketId = req.params.marketId;

  if (sessions.has(marketId)) {
    const existing = sessions.get(marketId)!;
    if (existing.phase !== 'finalized' && existing.phase !== 'failed') {
      return res.status(409).json({ error: 'Resolution already in progress', phase: existing.phase });
    }
  }

  // The caller can suggest the correct outcome; in production this comes from
  // trusted data sources fetched by the agents themselves.
  const marketOutcome: boolean = req.body?.outcome !== false;

  // Build fresh agent list with wallet addresses derived at runtime,
  // restoring reputation scores from Storacha checkpoints if available.
  const baseKey = process.env.CALIBRATION_PRIVATE_KEY ?? ethers.hexlify(ethers.randomBytes(32));
  const addresses = Array.from({ length: ACTIVE_AGENT_COUNT }, (_, i) => {
    try {
      const derived = new ethers.Wallet(
        ethers.keccak256(ethers.toUtf8Bytes(`${baseKey}-oracle-${i + 1}`))
      );
      return derived.address;
    } catch {
      return `0x${(i + 1).toString(16).padStart(40, '0')}`;
    }
  });

  const agentList = buildAgents(addresses).slice(0, ACTIVE_AGENT_COUNT).map(a => ({
    ...a,
    // Restore reputation from checkpoint if this agent has one
    reputationScore: agentReputation.get(a.id) ?? a.reputationScore,
  }));

  const session: ResolutionSession = {
    marketId,
    phase:           'collecting',
    agents:          agentList,
    yesVotes:        0,
    noVotes:         0,
    outcome:         null,
    finalEvidenceCid: null,
    calibrationTxHash: null,
    flowTxHash:      null,
    startedAt:       Date.now(),
    finalizedAt:     null,
    log:             [],
  };

  sessions.set(marketId, session);

  addLog(session, `resolution started for market ${marketId} — ${ACTIVE_AGENT_COUNT} agents initializing`);

  res.json({ marketId, status: 'started', wsUrl: `/oracle/ws/${marketId}` });

  // Run active agents concurrently (each has its own delay, simulating async data fetching)
  Promise.allSettled(
    session.agents.map(agent => runAgent(session, agent, marketOutcome))
  ).then(() => {
    if (session.phase === 'collecting') {
      // Shouldn't happen normally, but handle edge case
      session.phase = 'failed';
      addLog(session, 'resolution failed — quorum not reached');
    }
  });
});

// ── Utilities ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n=== GhostMarket Oracle Service ===`);
  console.log(`HTTP  : http://localhost:${PORT}/oracle/health`);
  console.log(`WS    : ws://localhost:${PORT}/oracle/ws/:marketId`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /oracle/resolve/:marketId   — trigger resolution`);
  console.log(`  GET  /oracle/status/:marketId    — resolution state`);
  console.log(`  GET  /oracle/agents              — registry info`);
  console.log(`  Active agents: ${ACTIVE_AGENT_COUNT} (quorum ${quorumThreshold(ACTIVE_AGENT_COUNT)})`);
  console.log(`\nOracle ready.\n`);
});
