/**
 * GhostMarket Oracle Service — index.ts
 *
 * Standalone Node.js HTTP + WebSocket server.
 * Port: 8080 (configurable via PORT env var)
 *
 * REST endpoints:
 *   POST /oracle/resolve/:marketId      — trigger oracle resolution
 *   POST /oracle/settle/:marketId       — get signed settlement for a user
 *   GET  /oracle/settle/:marketId/:user — retrieve cached settlement
 *   POST /oracle/bets/register          — register a bet tx hash
 *   GET  /oracle/bets/:marketId/:user   — retrieve registered bet tx hash
 *   GET  /oracle/status/:marketId       — get current resolution state
 *   GET  /oracle/agents                 — get agent info
 *   GET  /oracle/market-titles          — known market titles
 *   GET  /oracle/health                 — health check
 *
 * WebSocket:
 *   ws://localhost:8080/oracle/ws/:marketId
 *   Broadcasts WsMessage events in real-time to the Oracle Room panel.
 *
 * Resolution flow per market:
 *   1. Each agent: idle → fetching → attesting → submitted
 *   2. On quorum (floor(n/2)+1 votes for one side):
 *      - GhostEAMM.resolveMarket() called on Sepolia
 *      - FINALIZED event broadcast
 *   3. Per user request: oracle signs EIP-712 settlement → user claims on GhostVault
 */

import express    from 'express';
import cors       from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer }               from 'http';
import dotenv     from 'dotenv';

import { buildAgents, agentDelay, AGENT_DEFINITIONS } from './agents';
import { startSealedWindowWatcher } from './sealed-window-watcher';
import { fetchSourceData, extractAsset, extractThreshold, type FetchedData } from './fetcher';
import { resolveEammMarket }  from './eamm-resolver';
import {
  markMarketFinalized,
  getOrComputeSettlement,
  getMarketSettlements,
  registerCanonicalBetTxHash,
  getCanonicalBetTxHash,
  listMarketParticipants,
  isMarketFinalized,
} from './settlement';
import type {
  ResolutionSession,
  OracleAgent,
  LogEntry,
  WsMessage,
  SettlementClaimResponse,
} from './types';

dotenv.config();

// ── App setup ──────────────────────────────────────────────────────────────────

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = Number(process.env.PORT ?? 8080);

const OPENAI_API_KEY            = process.env.OPENAI_API_KEY ?? '';
const ORACLE_REASONING_MODEL    = process.env.ORACLE_REASONING_MODEL ?? 'gpt-4o-mini';
const ORACLE_REASONING_TIMEOUT  = Number(process.env.ORACLE_REASONING_TIMEOUT_MS ?? 9000);
const ACTIVE_AGENT_COUNT        = Math.max(
  1,
  Math.min(AGENT_DEFINITIONS.length, Number(process.env.ACTIVE_ORACLE_AGENTS ?? 4)),
);

const quorumThreshold = (n: number): number => Math.floor(n / 2) + 1;

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

// ── In-memory state ────────────────────────────────────────────────────────────

const sessions    = new Map<string, ResolutionSession>();
const subscribers = new Map<string, Set<WebSocket>>();
// Restored agent reputation across restarts (in-memory only now — Storacha removed)
const agentReputation  = new Map<number, number>();
const agentLastMarket  = new Map<number, string | number>();

// ── WebSocket ──────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const match    = req.url?.match(/\/oracle\/ws\/([^/?]+)/);
  const marketId = match ? match[1] : null;
  if (!marketId) { ws.close(); return; }

  if (!subscribers.has(marketId)) subscribers.set(marketId, new Set());
  subscribers.get(marketId)!.add(ws);

  const session = sessions.get(marketId);
  if (session) send(ws, { type: 'session_init', marketId, payload: session });

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
  opts: { agentName?: string | null; txHash?: string | null } = {},
) {
  const entry: LogEntry = {
    ts:        Date.now(),
    agentName: opts.agentName ?? null,
    message,
    txHash:    opts.txHash ?? null,
  };
  session.log.push(entry);
  broadcast(session.marketId, { type: 'log', marketId: session.marketId, payload: entry });
}

function updateAgent(session: ResolutionSession, agentId: number, patch: Partial<OracleAgent>) {
  const agent = session.agents.find((a) => a.id === agentId);
  if (!agent) return;
  Object.assign(agent, patch);
  broadcast(session.marketId, { type: 'agent_update', marketId: session.marketId, payload: agent });
}

function patchSession(session: ResolutionSession, patch: Partial<ResolutionSession>) {
  Object.assign(session, patch);
  broadcast(session.marketId, { type: 'session_patch', marketId: session.marketId, payload: patch });
}

// ── Agent reasoning ───────────────────────────────────────────────────────────

type ReasoningResult = { vote: boolean; reasoning: string };

async function generateAgentReasoning(
  session:    ResolutionSession,
  agent:      OracleAgent,
  agentDef:   { source: string; personality: string },
  fetched:    FetchedData,
  defaultVote: boolean,
): Promise<ReasoningResult> {
  const threshold    = extractThreshold(session.marketTitle);
  const thresholdStr = threshold ? `$${threshold.toLocaleString('en-US')}` : 'the stated threshold';
  const priceContext = fetched.price
    ? `${fetched.asset} is currently at ${fetched.rawValue} (${agentDef.source}).`
    : `No live price data available from ${agentDef.source}.`;

  const fallback: ReasoningResult = {
    vote:      defaultVote,
    reasoning: `${agent.name}: ${priceContext} Based on ${agentDef.source} signals, voting ${defaultVote ? 'YES' : 'NO'}.`,
  };

  if (!OPENAI_API_KEY) return fallback;

  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), ORACLE_REASONING_TIMEOUT);

    const dataLines = [
      `Live data from ${fetched.source}: ${fetched.rawValue} (${fetched.unit})`,
      fetched.note    ? `Context: ${fetched.note}` : null,
      threshold       ? `Market threshold: ${thresholdStr}` : null,
    ].filter(Boolean).join('\n');

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
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model:       ORACLE_REASONING_MODEL,
        temperature: 0.3,
        messages: [
          {
            role:    'system',
            content: `You are ${agent.name}, an autonomous oracle agent for a confidential prediction market. ` +
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
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw  = body.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) return fallback;

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed  = JSON.parse(cleaned) as { vote?: string; reasoning?: string };
    const vote    = String(parsed.vote ?? '').toUpperCase() === 'NO' ? false : true;
    const reasoning = String(parsed.reasoning ?? '').trim();

    return { vote, reasoning: reasoning.length > 0 ? reasoning : fallback.reasoning };
  } catch {
    return fallback;
  }
}

// ── Resolution engine ──────────────────────────────────────────────────────────

async function runAgent(
  session:       ResolutionSession,
  agent:         OracleAgent,
  marketOutcome: boolean,
) {
  const delay    = agentDelay(agent.id);
  const agentDef = AGENT_DEFINITIONS.find((d) => d.id === agent.id) ?? {
    id: agent.id, name: agent.name, source: 'unknown', personality: 'Neutral analyst.',
  };
  const source = agentDef.source;

  // FETCHING
  updateAgent(session, agent.id, { status: 'fetching' });
  addLog(session, `contacting ${source} API…`, { agentName: agent.name });

  const asset   = extractAsset(session.marketTitle);
  const [fetched] = await Promise.all([fetchSourceData(source, asset), sleep(delay)]);

  if (fetched.price !== null) {
    addLog(session, `${source} → ${fetched.rawValue} ${fetched.unit} (${asset})`, { agentName: agent.name });
  } else {
    addLog(session, `${source} → no price data${fetched.note ? ` — ${fetched.note}` : ''}`, { agentName: agent.name });
  }

  const fallbackVote = agent.id === 7 && Math.random() < 0.15 ? !marketOutcome : marketOutcome;
  const ai           = await generateAgentReasoning(session, agent, agentDef, fetched, fallbackVote);
  const { vote, reasoning } = ai;

  // ATTESTING
  updateAgent(session, agent.id, { status: 'attesting', reasoning, source });
  addLog(
    session,
    `attested ${vote ? 'YES' : 'NO'} — "${reasoning.slice(0, 96)}..."`,
    { agentName: agent.name },
  );

  // SUBMITTED
  updateAgent(session, agent.id, { status: 'submitted', vote, attestedAt: Date.now() });

  // Count votes and check for quorum
  session.yesVotes = session.agents.filter((a) => a.vote === true).length;
  session.noVotes  = session.agents.filter((a) => a.vote === false).length;

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
    `QUORUM REACHED ${session.yesVotes}/${session.agents.length} → outcome: ${outcome ? 'YES' : 'NO'}`,
  );

  broadcast(session.marketId, {
    type:    'quorum_reached',
    marketId: session.marketId,
    payload: { yesVotes: session.yesVotes, noVotes: session.noVotes, outcome },
  });

  session.phase       = 'finalized';
  session.finalizedAt = Date.now();

  markMarketFinalized(session.marketId, outcome);
  addLog(session, 'resolution finalized — oracle outcome sealed');

  patchSession(session, {
    settlementRelay: {
      status:          'disabled',
      totalUsers:      0,
      processedUsers:  0,
      relayedUsers:    0,
      failedUsers:     0,
      lastError:       null,
    },
  });

  broadcast(session.marketId, {
    type:    'finalized',
    marketId: session.marketId,
    payload: { outcome },
  });

  addLog(session, 'users can now claim via POST /oracle/settle/:marketId');

  // Background: resolve GhostEAMM on Sepolia
  patchSession(session, {
    sepoliaResolutionSync: { status: 'pending', txHash: null },
  });

  void (async () => {
    const sync = await resolveEammMarket(session.marketId, outcome);
    patchSession(session, { sepoliaResolutionSync: sync });
    if (sync.status === 'synced') {
      addLog(session, 'GhostEAMM market resolved on Sepolia', { txHash: sync.txHash ?? null });
    } else if (sync.status === 'skipped') {
      addLog(session, 'Sepolia EAMM sync skipped (ORACLE_PRIVATE_KEY or GHOST_EAMM_ADDRESS not set)');
    } else {
      addLog(session, `Sepolia EAMM sync failed: ${sync.message ?? 'unknown error'}`);
    }
  })();

  // Update agent reputation scores in memory
  for (const agent of session.agents.filter((a) => a.vote !== null)) {
    const correct  = agent.vote === outcome;
    const newScore = correct
      ? Math.min(100, agent.reputationScore + 2)
      : Math.max(0, agent.reputationScore - 10);
    updateAgent(session, agent.id, { reputationScore: newScore });
    agentReputation.set(agent.id, newScore);
    agentLastMarket.set(agent.id, session.marketId);
  }
}

// ── Settlement endpoints ───────────────────────────────────────────────────────

app.post('/oracle/bets/register', async (req, res) => {
  const body = req.body as { marketId?: string | number; userAddress?: string; betTxHash?: string };
  const marketId   = body.marketId !== undefined ? String(body.marketId) : '';
  const userAddress = body.userAddress ?? '';
  const betTxHash   = body.betTxHash ?? '';

  if (!/^\d+$/.test(marketId))
    return res.status(400).json({ error: 'Invalid or missing marketId' });
  if (!/^0x[0-9a-fA-F]{40}$/.test(userAddress))
    return res.status(400).json({ error: 'Invalid or missing userAddress' });
  if (!/^0x[0-9a-fA-F]{64}$/.test(betTxHash))
    return res.status(400).json({ error: 'Invalid or missing betTxHash' });

  try {
    await registerCanonicalBetTxHash(marketId, userAddress, betTxHash);
    return res.json({ ok: true, marketId, userAddress: userAddress.toLowerCase(), betTxHash: betTxHash.toLowerCase() });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/oracle/bets/:marketId/:userAddress', async (req, res) => {
  const { marketId, userAddress } = req.params;
  if (!/^\d+$/.test(marketId))      return res.status(400).json({ error: 'Invalid marketId' });
  if (!/^0x[0-9a-fA-F]{40}$/.test(userAddress)) return res.status(400).json({ error: 'Invalid userAddress' });
  try {
    const betTxHash = await getCanonicalBetTxHash(marketId, userAddress);
    return res.json({ marketId, userAddress: userAddress.toLowerCase(), betTxHash, source: betTxHash ? 'registered' : 'none' });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/oracle/settle/:marketId', async (req, res) => {
  const marketId    = req.params.marketId;
  const body        = req.body as { userAddress?: string };
  const userAddress = body?.userAddress;

  if (!userAddress || !/^0x[0-9a-fA-F]{40}$/.test(userAddress)) {
    return res.status(400).json({ error: 'Invalid or missing userAddress' });
  }

  // If oracle restarted and lost session, check EAMM on-chain
  const session = sessions.get(marketId);
  if (!session || session.phase !== 'finalized') {
    if (!isMarketFinalized(marketId)) {
      try {
        const { ethers: eth } = await import('ethers');
        const eamm = new eth.Contract(
          process.env.GHOST_EAMM_ADDRESS ?? '',
          ['function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)'],
          new eth.JsonRpcProvider(process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org'),
        );
        const [_status, _outcome] = await eamm.getMarketMeta(BigInt(marketId));
        if (Number(_status) !== 1) {
          return res.status(409).json({ error: 'Market not finalized', phase: session?.phase ?? 'unknown' });
        }
        markMarketFinalized(marketId, Boolean(_outcome));
      } catch {
        return res.status(409).json({ error: 'Market not finalized', phase: session?.phase ?? 'unknown' });
      }
    }
  }

  try {
    const settlement = await getOrComputeSettlement(marketId, userAddress);

    const marketIdBytes32 = '0x' + BigInt(parseInt(marketId, 10)).toString(16).padStart(64, '0');

    const response: SettlementClaimResponse = {
      marketId,
      userAddress:     settlement.userAddress,
      sig:             settlement.sig,
      payout:          settlement.payout,
      nonce:           settlement.nonce,
      expiry:          settlement.expiry,
      marketIdBytes32,
      vaultAddress:    process.env.GHOST_VAULT_ADDRESS ?? '',
      signerAddress:   settlement.signerAddress,
      signingPath:     'oracle',
      deliveredTx:     settlement.deliveredTx,
    };

    res.json(response);
  } catch (err) {
    const message = (err as Error).message;
    console.error('[Settlement] Error:', message);
    res.status(422).json({ error: message });
  }
});

app.get('/oracle/settle/:marketId/:userAddress', (req, res) => {
  const { marketId, userAddress } = req.params;
  const session = sessions.get(marketId);
  if (!session || session.phase !== 'finalized') {
    return res.status(409).json({ error: 'Market not finalized', phase: session?.phase ?? 'unknown' });
  }

  const settlements = getMarketSettlements(marketId);
  const settlement  = settlements.find((s) => s.userAddress === userAddress.toLowerCase());
  if (!settlement) {
    return res.status(404).json({ error: 'No settlement computed yet — call POST /oracle/settle/:marketId' });
  }

  const marketIdBytes32 = '0x' + BigInt(parseInt(marketId, 10)).toString(16).padStart(64, '0');

  const response: SettlementClaimResponse = {
    marketId,
    userAddress:     settlement.userAddress,
    sig:             settlement.sig,
    payout:          settlement.payout,
    nonce:           settlement.nonce,
    expiry:          settlement.expiry,
    marketIdBytes32,
    vaultAddress:    process.env.GHOST_VAULT_ADDRESS ?? '',
    signerAddress:   settlement.signerAddress,
    signingPath:     'oracle',
    deliveredTx:     settlement.deliveredTx,
  };

  res.json(response);
});

// ── REST endpoints ─────────────────────────────────────────────────────────────

app.get('/oracle/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ghost-oracle', timestamp: new Date().toISOString() });
});

app.get('/oracle/market-titles', (_req, res) => {
  res.json(MARKET_TITLES);
});

app.get('/oracle/agents', (_req, res) => {
  const agents = AGENT_DEFINITIONS.slice(0, ACTIVE_AGENT_COUNT).map((def) => ({
    id:             def.id,
    name:           def.name,
    source:         def.source,
    reputationScore: agentReputation.get(def.id) ?? 80,
    lastMarket:     agentLastMarket.get(def.id) ?? null,
  }));
  res.json({ agents });
});

app.get('/oracle/status/:marketId', (req, res) => {
  const session = sessions.get(req.params.marketId);
  if (!session)
    return res.status(404).json({ error: 'No resolution session for this market' });
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

  const marketOutcome: boolean = req.body?.outcome !== false;
  const marketTitle: string =
    req.body?.marketTitle ??
    MARKET_TITLES[String(marketId)] ??
    `Market #${marketId} — resolution in progress`;

  const baseKey = process.env.ORACLE_PRIVATE_KEY ?? '';
  const { ethers } = await import('ethers');
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
      reputationScore: agentReputation.get(a.id) ?? a.reputationScore,
    }));

  const session: ResolutionSession = {
    marketId,
    marketTitle,
    phase:   'collecting',
    agents:  agentList,
    yesVotes: 0,
    noVotes:  0,
    outcome:  null,
    sepoliaResolutionSync: { status: 'idle', txHash: null },
    settlementRelay: {
      status:         'idle',
      totalUsers:     0,
      processedUsers: 0,
      relayedUsers:   0,
      failedUsers:    0,
      lastError:      null,
    },
    startedAt:   Date.now(),
    finalizedAt: null,
    log:         [],
  };

  sessions.set(marketId, session);
  addLog(session, `resolution started for market ${marketId} — ${ACTIVE_AGENT_COUNT} agents initializing`);

  res.json({ marketId, status: 'started', wsUrl: `/oracle/ws/${marketId}` });

  Promise.allSettled(
    session.agents.map((agent) => runAgent(session, agent, marketOutcome)),
  ).then(() => {
    if (session.phase === 'collecting') {
      if (session.yesVotes > 0 || session.noVotes > 0) {
        addLog(session, `no strict quorum — using plurality (${session.yesVotes} YES vs ${session.noVotes} NO)`);
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

process.on('unhandledRejection', (reason) => {
  const msg  = (reason as Error)?.message ?? String(reason);
  const code = (reason as { cause?: { code?: string } })?.cause?.code ?? '';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || msg === 'fetch failed' || msg.includes('Connect Timeout')) return;
  console.error('[Oracle] Unhandled rejection:', reason);
});

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n=== GhostMarket Oracle Service ===`);
  console.log(`HTTP : http://localhost:${PORT}/oracle/health`);
  console.log(`WS   : ws://localhost:${PORT}/oracle/ws/:marketId`);
  console.log(`Active agents: ${ACTIVE_AGENT_COUNT} (quorum ${quorumThreshold(ACTIVE_AGENT_COUNT)})`);
  console.log(`\nOracle ready.\n`);

  // Start the sealed-window watcher.  It polls every WINDOW_POLL_MS (default
  // 10 s) for expired-but-unsettled windows, settles them on-chain, gateway-
  // decrypts pool totals, and emits PriceRevealed.
  startSealedWindowWatcher();
});
