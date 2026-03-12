'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check, CircleDashed, Clock, Copy, Database, ExternalLink,
  Fingerprint, Loader2, Radio, Shield, Zap, Activity,
} from 'lucide-react';
import {
  getOracleSession,
  triggerOracleResolution,
  type OracleAgentView,
  type OracleLogEntry,
  type OracleSession,
} from '@/lib/oracle-client';
import { cn } from '@/lib/utils';

const ORACLE_HTTP_BASE = process.env.NEXT_PUBLIC_ORACLE_URL ?? 'http://localhost:8080';
const CALIBRATION_EXPLORER_TX_BASE =
  process.env.NEXT_PUBLIC_CALIBRATION_EXPLORER_TX_BASE ?? 'https://calibration.filscan.io/tx/';

type WsMessage =
  | { type: 'session_init'; marketId: string; payload: OracleSession }
  | { type: 'agent_update'; marketId: string; payload: OracleAgentView }
  | { type: 'log'; marketId: string; payload: OracleLogEntry }
  | { type: 'quorum_reached'; marketId: string; payload: { yesVotes: number; noVotes: number; outcome: boolean } }
  | { type: 'finalized'; marketId: string; payload: { outcome: boolean; finalEvidenceCid: string | null; calibrationTxHash: string | null } }
  | { type: 'settlement_delivered'; marketId: string; payload: { userAddress?: string; txHash?: string; payout?: string } }
  | { type: 'error'; marketId: string; payload: unknown };

// ── utilities ─────────────────────────────────────────────────────────────────

function shorten(value: string, start = 10, end = 8): string {
  if (value.length <= start + end) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function wsUrlForMarket(marketId: string): string {
  const base = ORACLE_HTTP_BASE.replace(/^http/i, 'ws');
  return `${base}/oracle/ws/${marketId}`;
}

function quorumThreshold(agentCount: number): number {
  return Math.floor(agentCount / 2) + 1;
}

function useElapsedTime(startedAt: number | null | undefined): string {
  const [elapsed, setElapsed] = useState('');
  useEffect(() => {
    if (!startedAt) { setElapsed(''); return; }
    const update = () => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      const m = Math.floor(s / 60);
      const sec = s % 60;
      setElapsed(m > 0 ? `${m}m ${sec}s` : `${sec}s`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return elapsed;
}

function useCopyToClipboard() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((value: string, key: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  }, []);
  return { copied, copy };
}

// ── design tokens ─────────────────────────────────────────────────────────────

const PHASE_CFG: Record<string, { label: string; cls: string; dot: string }> = {
  idle:          { label: 'Idle',         cls: 'text-slate-400 border-slate-600/40 bg-slate-800/60',        dot: 'bg-slate-500' },
  pending:       { label: 'Pending',      cls: 'text-slate-400 border-slate-600/40 bg-slate-800/60',        dot: 'bg-slate-500' },
  collecting:    { label: 'Collecting',   cls: 'text-blue-300 border-blue-500/40 bg-blue-950/40',           dot: 'bg-blue-400 animate-pulse' },
  quorum_reached:{ label: 'Quorum',       cls: 'text-amber-300 border-amber-500/40 bg-amber-950/40',        dot: 'bg-amber-400 animate-pulse' },
  uploading:     { label: 'Uploading',    cls: 'text-violet-300 border-violet-500/40 bg-violet-950/40',     dot: 'bg-violet-400 animate-pulse' },
  finalized:     { label: 'Finalized',    cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/40',  dot: 'bg-emerald-400' },
  failed:        { label: 'Failed',       cls: 'text-rose-300 border-rose-500/40 bg-rose-950/40',           dot: 'bg-rose-400' },
};

const AGENT_STATUS_CFG: Record<string, { color: string }> = {
  idle:      { color: 'text-slate-500' },
  fetching:  { color: 'text-sky-400' },
  attesting: { color: 'text-amber-400' },
  submitted: { color: 'text-emerald-400' },
  slashed:   { color: 'text-rose-400' },
  suspended: { color: 'text-orange-400' },
};

const AGENT_SOURCE: Record<string, string> = {
  Cipher:  'Binance',
  Specter: 'CoinGecko',
  Wraith:  'Chainlink',
  Phantom: 'Coinbase',
};

// ── sub-components ────────────────────────────────────────────────────────────

function PhasePill({ phase }: { phase: string }) {
  const cfg = PHASE_CFG[phase] ?? PHASE_CFG.idle;
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold tracking-widest uppercase',
      cfg.cls,
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dot)} />
      {cfg.label}
    </span>
  );
}

function VoteBadge({ vote }: { vote: boolean | null }) {
  if (vote === null) {
    return (
      <span className="rounded border border-slate-700/50 bg-slate-900 px-2 py-0.5 font-mono text-[10px] text-slate-600">
        ——
      </span>
    );
  }
  return (
    <span className={cn(
      'rounded border px-2.5 py-0.5 font-mono text-[11px] font-bold tracking-widest',
      vote
        ? 'border-emerald-500/40 bg-emerald-950/50 text-emerald-300'
        : 'border-rose-500/40 bg-rose-950/50 text-rose-300',
    )}>
      {vote ? 'YES' : 'NO'}
    </span>
  );
}

function AgentCard({ agent }: { agent: OracleAgentView }) {
  const scfg = AGENT_STATUS_CFG[agent.status] ?? AGENT_STATUS_CFG.idle;
  const isActive = agent.status === 'fetching' || agent.status === 'attesting';
  const isDone = agent.status === 'submitted';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'group relative overflow-hidden rounded-xl border p-4 transition-all duration-500',
        isDone
          ? 'border-emerald-500/25 bg-emerald-950/15 shadow-emerald-500/5 shadow-lg'
          : isActive
            ? 'border-violet-500/30 bg-violet-950/15 shadow-violet-500/10 shadow-lg'
            : 'border-white/6 bg-[#0a0f1e]',
      )}
    >
      {/* animated glow layer */}
      {isActive && (
        <div className="pointer-events-none absolute inset-0 rounded-xl bg-linear-to-br from-violet-500/5 via-transparent to-transparent animate-pulse" />
      )}
      {isDone && (
        <div className="pointer-events-none absolute inset-0 rounded-xl bg-linear-to-br from-emerald-500/5 via-transparent to-transparent" />
      )}

      {/* header row */}
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-white">{agent.name}</span>
            {AGENT_SOURCE[agent.name] && (
              <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-slate-400 uppercase">
                {AGENT_SOURCE[agent.name]}
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[9px] text-slate-700">
            agent #{agent.id}
            {agent.reputationScore != null && (
              <span className="ml-2 text-slate-600">rep {agent.reputationScore}</span>
            )}
          </div>
        </div>
        <VoteBadge vote={agent.vote} />
      </div>

      {/* status row */}
      <div className="relative mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {isActive && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
          )}
          {isDone && (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          )}
          <span className={cn('font-mono text-[11px]', scfg.color)}>
            {agent.status}
          </span>
        </div>
        {agent.attestedAt && (
          <span className="font-mono text-[9px] text-slate-700">
            {new Date(agent.attestedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* CID strip */}
      {agent.storachaCid && agent.storachaCid !== 'not-configured' && (
        <div className="relative mt-2.5 rounded-md border border-white/5 bg-slate-950/80 px-2.5 py-1.5">
          <span className="font-mono text-[9px] text-slate-600 uppercase tracking-wider">storacha </span>
          <span className="font-mono text-[10px] text-slate-400">{shorten(agent.storachaCid, 14, 10)}</span>
        </div>
      )}
    </motion.div>
  );
}

function classifyLog(entry: OracleLogEntry): { color: string; bg: string; prefix: string } {
  const m = entry.message.toLowerCase();
  if (entry.txHash || m.includes('registry') || m.includes('calibration') || m.includes('on-chain')) {
    return { color: 'text-cyan-300', bg: 'text-cyan-700/60', prefix: 'CHAIN' };
  }
  if (m.includes('settlement') || m.includes('claim') || m.includes('payout') || m.includes('relay')) {
    return { color: 'text-amber-300', bg: 'text-amber-700/60', prefix: 'SETTLE' };
  }
  if (m.includes('cid') || m.includes('storacha') || m.includes('filecoin') || m.includes('piece') || m.includes('reputation') || entry.cid) {
    return { color: 'text-violet-300', bg: 'text-violet-700/60', prefix: 'PROOF' };
  }
  if (m.includes('finalized') || m.includes('quorum') || m.includes('resolved')) {
    return { color: 'text-emerald-300', bg: 'text-emerald-700/60', prefix: 'SYS' };
  }
  if (m.includes('error') || m.includes('failed') || m.includes('fail')) {
    return { color: 'text-rose-300', bg: 'text-rose-700/60', prefix: 'ERR' };
  }
  if (entry.agentName) {
    return { color: 'text-blue-300', bg: 'text-blue-700/60', prefix: 'AGENT' };
  }
  return { color: 'text-slate-300', bg: 'text-slate-600', prefix: 'SYS' };
}

function LogRow({ entry }: { entry: OracleLogEntry }) {
  const { color, bg, prefix } = classifyLog(entry);
  return (
    <div className="grid grid-cols-[4rem_1fr] gap-3 border-b border-white/4 py-1.5 text-[11px]">
      <span className={cn('pt-0.5 font-mono font-semibold tracking-widest', bg)}>{prefix}</span>
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn('font-mono leading-relaxed', color)}>{entry.message}</span>
          <span className="shrink-0 font-mono text-[9px] text-slate-700">
            {new Date(entry.ts).toLocaleTimeString()}
          </span>
        </div>
        {(entry.txHash || entry.cid) && (
          <div className="mt-0.5 flex flex-wrap gap-3">
            {entry.txHash && (
              <span className="font-mono text-[9px] text-slate-600">tx:{shorten(entry.txHash, 8, 6)}</span>
            )}
            {entry.cid && (
              <span className="font-mono text-[9px] text-slate-600">cid:{shorten(entry.cid, 12, 8)}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HashRow({
  label, icon: Icon, value, href, copyKey, copied, onCopy,
}: {
  label: string;
  icon: React.ElementType;
  value: string | null | undefined;
  href?: string;
  copyKey: string;
  copied: string | null;
  onCopy: (v: string, k: string) => void;
}) {
  return (
    <div className="rounded-xl border border-white/6 bg-[#0a0f1e] p-3.5">
      <div className="mb-2 flex items-center gap-1.5">
        <Icon className="h-3 w-3 text-slate-600" />
        <span className="font-mono text-[9px] font-semibold tracking-widest text-slate-600 uppercase">{label}</span>
      </div>
      {value ? (
        <div className="flex items-center gap-1.5">
          <span className="flex-1 truncate font-mono text-[11px] text-violet-300">
            {shorten(value, 18, 12)}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            {href && (
              <a href={href} target="_blank" rel="noreferrer" className="rounded p-1.5 hover:bg-white/5">
                <ExternalLink className="h-3 w-3 text-slate-600 hover:text-slate-300" />
              </a>
            )}
            <button onClick={() => onCopy(value, copyKey)} className="rounded p-1.5 hover:bg-white/5">
              {copied === copyKey
                ? <Check className="h-3 w-3 text-emerald-400" />
                : <Copy className="h-3 w-3 text-slate-600 hover:text-slate-300" />}
            </button>
          </div>
        </div>
      ) : (
        <span className="font-mono text-[11px] text-slate-700">— pending</span>
      )}
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export function OracleRoom() {
  const [marketId, setMarketId] = useState('6');
  const [selectedOutcome, setSelectedOutcome] = useState<'YES' | 'NO'>('YES');
  const [session, setSession] = useState<OracleSession | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<'all' | 'agent' | 'proof' | 'settle'>('all');
  const logRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const { copied, copy } = useCopyToClipboard();
  const elapsed = useElapsedTime(session?.startedAt);

  const connectWs = useCallback((id: string) => {
    if (wsRef.current) wsRef.current.close();
    const ws = new WebSocket(wsUrlForMarket(id));
    wsRef.current = ws;
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as WsMessage;
        if (!msg || msg.marketId !== id) return;
        if (msg.type === 'session_init') { setSession(msg.payload); return; }
        setSession((prev) => {
          if (!prev) return prev;
          switch (msg.type) {
            case 'agent_update': {
              const agents = prev.agents.map((a) => a.id === msg.payload.id ? { ...a, ...msg.payload } : a);
              return { ...prev, agents };
            }
            case 'log':
              return { ...prev, log: [...prev.log, msg.payload] };
            case 'quorum_reached':
              return { ...prev, phase: 'quorum_reached', yesVotes: msg.payload.yesVotes, noVotes: msg.payload.noVotes, outcome: msg.payload.outcome };
            case 'finalized':
              return { ...prev, phase: 'finalized', outcome: msg.payload.outcome, finalEvidenceCid: msg.payload.finalEvidenceCid, calibrationTxHash: msg.payload.calibrationTxHash };
            case 'settlement_delivered':
              return { ...prev, flowTxHash: msg.payload.txHash ?? prev.flowTxHash };
            default:
              return prev;
          }
        });
      } catch { /* ignore malformed frames */ }
    };
  }, []);

  const loadSession = useCallback(async () => {
    setLoadingSession(true);
    setError(null);
    const data = await getOracleSession(marketId);
    if (!data) {
      setSession(null);
      setError(`No oracle session found for market ${marketId}`);
      setLoadingSession(false);
      return;
    }
    setSession(data);
    connectWs(marketId);
    setLoadingSession(false);
  }, [marketId, connectWs]);

  const startResolve = useCallback(async () => {
    setResolving(true);
    setError(null);
    try {
      await triggerOracleResolution(marketId, selectedOutcome === 'YES');
      connectWs(marketId);
      const latest = await getOracleSession(marketId);
      if (latest) setSession(latest);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to trigger oracle resolution');
    } finally {
      setResolving(false);
    }
  }, [marketId, selectedOutcome, connectWs]);

  useEffect(() => () => { if (wsRef.current) wsRef.current.close(); }, []);

  // auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [session?.log]);

  const agents = session?.agents ?? [];
  const threshold = quorumThreshold(Math.max(agents.length, 1));
  const yesVotes = session?.yesVotes ?? 0;
  const noVotes = session?.noVotes ?? 0;
  const totalAgents = Math.max(agents.length, 1);
  const yesPct = Math.round((yesVotes / totalAgents) * 100);
  const noPct = Math.round((noVotes / totalAgents) * 100);
  const thresholdPct = Math.round((threshold / totalAgents) * 100);

  const filteredLog = useMemo(() => {
    const all = session?.log ?? [];
    if (logFilter === 'all') return all;
    return all.filter((e) => {
      const { prefix } = classifyLog(e);
      if (logFilter === 'agent') return prefix === 'AGENT';
      if (logFilter === 'proof') return prefix === 'PROOF';
      if (logFilter === 'settle') return prefix === 'SETTLE' || prefix === 'CHAIN';
      return true;
    });
  }, [session?.log, logFilter]);

  const autonomousLogs = useMemo(() =>
    (session?.log ?? []).filter((l) =>
      l.message.includes('background') ||
      l.message.includes('settlement relay') ||
      l.message.includes('FINALIZED') ||
      l.message.includes('Piece CID') ||
      l.message.includes('reputation')
    ), [session]);

  const phase = session?.phase ?? 'idle';
  const isFinalized = phase === 'finalized';
  const isLive = phase === 'collecting' || phase === 'quorum_reached' || phase === 'uploading';

  return (
    <div className="space-y-5">

      {/* ── Command Bar ─────────────────────────────────────────────────────── */}
      <div className={cn(
        'relative overflow-hidden rounded-2xl border bg-[#070c1a] p-5 transition-all duration-700',
        isFinalized
          ? 'border-emerald-500/20 shadow-emerald-500/5 shadow-xl'
          : isLive
            ? 'border-violet-500/20 shadow-violet-500/5 shadow-xl'
            : 'border-white/8',
      )}>
        {/* background glow */}
        <div className={cn(
          'pointer-events-none absolute inset-0 opacity-20',
          isFinalized
            ? 'bg-linear-to-br from-emerald-950 via-transparent to-transparent'
            : 'bg-linear-to-br from-violet-950 via-transparent to-transparent',
        )} />

        <div className="relative flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2.5">
            <div className={cn(
              'flex h-8 w-8 items-center justify-center rounded-lg border',
              isFinalized
                ? 'border-emerald-500/30 bg-emerald-950/50'
                : 'border-violet-500/30 bg-violet-950/50',
            )}>
              <Shield className={cn('h-4 w-4', isFinalized ? 'text-emerald-400' : 'text-violet-400')} />
            </div>
            <div>
              <h1 className="text-base font-bold leading-none text-white">Oracle Room</h1>
              <div className="mt-0.5 font-mono text-[9px] text-slate-600 tracking-widest uppercase">
                Decentralized Resolution Engine
              </div>
            </div>
          </div>

          <PhasePill phase={phase} />

          <span className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-mono',
            wsConnected
              ? 'border-emerald-500/30 bg-emerald-950/40 text-emerald-400'
              : 'border-slate-700/50 bg-slate-900 text-slate-600',
          )}>
            <Radio className={cn('h-2.5 w-2.5', wsConnected && 'animate-pulse')} />
            {wsConnected ? 'live' : 'disconnected'}
          </span>

          {elapsed && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/50 bg-slate-900 px-2.5 py-1 font-mono text-[10px] text-slate-400">
              <Clock className="h-2.5 w-2.5" />
              {elapsed}
            </span>
          )}

          {session?.marketId && (
            <span className="ml-auto rounded border border-white/6 bg-slate-900/80 px-2.5 py-1 font-mono text-[10px] text-slate-400">
              market #{session.marketId}
            </span>
          )}
        </div>

        {/* controls */}
        <div className="relative mt-5 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="font-mono text-[9px] tracking-widest text-slate-600 uppercase">Market ID</label>
            <input
              value={marketId}
              onChange={(e) => setMarketId(e.target.value)}
              className="h-9 w-28 rounded-lg border border-white/8 bg-slate-900 px-3 font-mono text-sm text-white placeholder:text-slate-700 focus:border-violet-500/50 focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="font-mono text-[9px] tracking-widest text-slate-600 uppercase">Outcome</label>
            <select
              value={selectedOutcome}
              onChange={(e) => setSelectedOutcome(e.target.value as 'YES' | 'NO')}
              className="h-9 rounded-lg border border-white/8 bg-slate-900 px-3 font-mono text-sm text-white focus:border-violet-500/50 focus:outline-none"
            >
              <option value="YES">YES</option>
              <option value="NO">NO</option>
            </select>
          </div>
          <button
            onClick={loadSession}
            disabled={loadingSession}
            className="h-9 rounded-lg border border-white/8 bg-slate-800/80 px-4 text-sm text-slate-300 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loadingSession ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Load Session'}
          </button>
          <button
            onClick={startResolve}
            disabled={resolving}
            className={cn(
              'h-9 rounded-lg px-5 text-sm font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-40',
              selectedOutcome === 'YES'
                ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 shadow-emerald-500/20 shadow-md'
                : 'bg-rose-500 text-white hover:bg-rose-400 shadow-rose-500/20 shadow-md',
            )}
          >
            {resolving ? (
              <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Starting…</span>
            ) : (
              <span className="flex items-center gap-1.5"><Zap className="h-3.5 w-3.5" />Trigger Resolve · {selectedOutcome}</span>
            )}
          </button>
        </div>

        {error && (
          <p className="relative mt-3 rounded-lg border border-rose-500/20 bg-rose-950/30 px-3 py-2 text-xs text-rose-400">
            {error}
          </p>
        )}
      </div>

      {/* ── Main Grid ───────────────────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">

          {/* ── Quorum Bar ─────────────────────────────────────────────────── */}
          <div className="rounded-2xl border border-white/6 bg-[#070c1a] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-violet-400" />
                <h2 className="text-sm font-semibold text-white">Quorum Status</h2>
              </div>
              <span className="font-mono text-[10px] text-slate-600">
                threshold {threshold}/{totalAgents} agents
              </span>
            </div>

            {/* vote bar */}
            <div className="relative h-5 w-full overflow-hidden rounded-full bg-slate-900">
              {/* YES fill */}
              <motion.div
                className="absolute inset-y-0 left-0 rounded-l-full bg-linear-to-r from-emerald-500 to-emerald-400"
                initial={{ width: 0 }}
                animate={{ width: `${yesPct}%` }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
              />
              {/* NO fill (from right) */}
              <motion.div
                className="absolute inset-y-0 right-0 rounded-r-full bg-linear-to-l from-rose-500 to-rose-400"
                initial={{ width: 0 }}
                animate={{ width: `${noPct}%` }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
              />
              {/* threshold marker */}
              <div
                className="absolute inset-y-0 w-0.5 bg-white/30"
                style={{ left: `${thresholdPct}%` }}
              />
            </div>

            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1.5 text-xs">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="font-mono text-emerald-300">YES · {yesVotes}</span>
                </span>
                <span className="flex items-center gap-1.5 text-xs">
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                  <span className="font-mono text-rose-300">NO · {noVotes}</span>
                </span>
              </div>

              <AnimatePresence mode="wait">
                {session?.outcome != null && (
                  <motion.div
                    key="outcome"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className={cn(
                      'rounded-lg border px-3 py-1 font-mono text-xs font-bold tracking-widest',
                      session.outcome
                        ? 'border-emerald-500/40 bg-emerald-950/60 text-emerald-300'
                        : 'border-rose-500/40 bg-rose-950/60 text-rose-300',
                    )}
                  >
                    OUTCOME · {session.outcome ? 'YES' : 'NO'}
                  </motion.div>
                )}
                {session?.outcome == null && phase !== 'idle' && (
                  <motion.span key="pending" className="font-mono text-[10px] text-slate-600">
                    awaiting quorum
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* ── Agent Swarm ────────────────────────────────────────────────── */}
          <div className="rounded-2xl border border-white/6 bg-[#070c1a] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Fingerprint className="h-4 w-4 text-violet-400" />
                <h2 className="text-sm font-semibold text-white">Agent Swarm</h2>
              </div>
              <span className="font-mono text-[10px] text-slate-600">
                {agents.filter(a => a.status === 'submitted').length}/{agents.length} submitted
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {agents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
              {agents.length === 0 && (
                <div className="col-span-2 rounded-xl border border-white/5 bg-slate-900/40 px-4 py-10 text-center">
                  <CircleDashed className="mx-auto mb-2 h-6 w-6 text-slate-700" />
                  <p className="text-sm text-slate-600">No session loaded yet.</p>
                  <p className="mt-1 text-[11px] text-slate-700">Load a market session or trigger resolution to begin.</p>
                </div>
              )}
            </div>
          </div>

          {/* ── Live Log ───────────────────────────────────────────────────── */}
          <div className="rounded-2xl border border-white/6 bg-[#070c1a] p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-violet-400" />
                <h2 className="text-sm font-semibold text-white">Event Stream</h2>
                {(session?.log.length ?? 0) > 0 && (
                  <span className="rounded-full border border-white/6 bg-slate-900 px-2 py-0.5 font-mono text-[9px] text-slate-500">
                    {session!.log.length}
                  </span>
                )}
              </div>
              {/* filters */}
              <div className="flex items-center gap-1">
                {(['all', 'agent', 'proof', 'settle'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setLogFilter(f)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 font-mono text-[9px] tracking-wider uppercase transition-colors',
                      logFilter === f
                        ? 'border-violet-500/40 bg-violet-950/50 text-violet-300'
                        : 'border-white/6 bg-slate-900 text-slate-600 hover:text-slate-400',
                    )}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <div
              ref={logRef}
              className="max-h-80 overflow-auto pr-1 scrollbar-none"
            >
              {filteredLog.length === 0 && (
                <div className="py-8 text-center font-mono text-[11px] text-slate-700">
                  — no events yet —
                </div>
              )}
              {filteredLog.slice(-120).map((entry, idx) => (
                <LogRow key={`${entry.ts}-${idx}`} entry={entry} />
              ))}
            </div>
          </div>
        </div>

        {/* ── Right Sidebar ────────────────────────────────────────────────── */}
        <div className="space-y-5">

          {/* ── Proof & Chain Links ─────────────────────────────────────────── */}
          <div className="rounded-2xl border border-white/6 bg-[#070c1a] p-5">
            <div className="mb-4 flex items-center gap-2">
              <Fingerprint className="h-4 w-4 text-violet-400" />
              <h2 className="text-sm font-semibold text-white">Proof & Chain Links</h2>
            </div>
            <div className="space-y-3">
              <HashRow
                label="Piece CID · Filecoin"
                icon={Database}
                value={session?.finalEvidenceCid}
                href={session?.finalEvidenceCid ? `https://filfox.info/en/search/${session.finalEvidenceCid}` : undefined}
                copyKey="cid"
                copied={copied}
                onCopy={copy}
              />
              <HashRow
                label="Calibration Registry TX"
                icon={Database}
                value={session?.calibrationTxHash}
                href={session?.calibrationTxHash ? `${CALIBRATION_EXPLORER_TX_BASE}${session.calibrationTxHash}` : undefined}
                copyKey="calTx"
                copied={copied}
                onCopy={copy}
              />
              <HashRow
                label="Flow Settlement TX"
                icon={Zap}
                value={session?.flowTxHash}
                href={session?.flowTxHash ? `https://evm-testnet.flowscan.io/tx/${session.flowTxHash}` : undefined}
                copyKey="flowTx"
                copied={copied}
                onCopy={copy}
              />
            </div>
          </div>

          {/* ── Settlement Readiness ─────────────────────────────────────────── */}
          <div className="rounded-2xl border border-white/6 bg-[#070c1a] p-5">
            <div className="mb-4 flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-white">Settlement Relay</h2>
            </div>

            <div className={cn(
              'rounded-xl border p-3.5 text-xs transition-all duration-500',
              isFinalized
                ? 'border-emerald-500/25 bg-emerald-950/20 text-emerald-300'
                : 'border-white/6 bg-slate-900/40 text-slate-600',
            )}>
              {isFinalized ? (
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="font-mono text-[11px]">claim endpoint ready</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-slate-700" />
                  <span className="font-mono text-[11px]">awaiting finalization</span>
                </div>
              )}
            </div>

            {/* autonomous actions */}
            <div className="mt-4 space-y-1.5">
              {autonomousLogs.length > 0 ? autonomousLogs.slice(-8).map((l, i) => (
                <div key={`${l.ts}-${i}`} className="flex items-start gap-2 text-[11px]">
                  <span className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400">✓</span>
                  <span className="font-mono text-slate-400 leading-relaxed">{l.message}</span>
                </div>
              )) : (
                <div className="flex items-start gap-2 text-[11px] text-slate-700">
                  <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="font-mono">Post-finalization tasks appear here.</span>
                </div>
              )}
            </div>
          </div>

          {/* ── Session Metadata ─────────────────────────────────────────────── */}
          {session && (
            <div className="rounded-2xl border border-white/6 bg-[#070c1a] p-5">
              <div className="mb-4 flex items-center gap-2">
                <Clock className="h-4 w-4 text-slate-600" />
                <h2 className="text-sm font-semibold text-white">Session Info</h2>
              </div>
              <div className="space-y-2 font-mono text-[10px]">
                <div className="flex justify-between">
                  <span className="text-slate-600">started</span>
                  <span className="text-slate-400">{new Date(session.startedAt).toLocaleString()}</span>
                </div>
                {session.finalizedAt && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">finalized</span>
                    <span className="text-slate-400">{new Date(session.finalizedAt).toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-600">agents</span>
                  <span className="text-slate-400">{agents.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">log entries</span>
                  <span className="text-slate-400">{session.log.length}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
