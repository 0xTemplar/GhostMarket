'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  Code2,
  Link2,
  Bookmark,
  ChevronDown,
  ChevronUp,
  Info,
  Maximize2,
  Settings,
  Clock,
} from 'lucide-react';
import type { Market } from '@/types/market';
import type { FrontendMarket } from '@/lib/market';
import { formatVolume, formatDate, cn } from '@/lib/utils';

type Timeframe = '1H' | '6H' | '1D' | '1W' | '1M' | 'ALL';

export interface MarketDetailLeftPanelProps {
  market: Market;
  rawMarket: FrontendMarket | null;
  yesPct: number;
}

/** Deterministic pseudo-random 0–1 from string (stable chart per market). */
function hash01(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

function buildDummyPctSeries(marketId: string, endPct: number, len = 8): number[] {
  const jitter = hash01(marketId) * 16 - 8;
  const start = Math.max(2, Math.min(98, endPct + jitter));
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    const t = i / (len - 1);
    const wobble = Math.sin((i + hash01(marketId + 'x')) * 1.7) * 4;
    out.push(Math.round(Math.max(0, Math.min(100, start + (endPct - start) * t + wobble))));
  }
  out[len - 1] = endPct;
  return out;
}

function lastNDayLabels(n: number): string[] {
  const labels: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    );
  }
  return labels;
}

function MarketProbabilityChart({
  series,
  xLabels,
}: {
  series: number[];
  xLabels: string[];
}) {
  const w = 640;
  const h = 200;
  const padL = 8;
  const padR = 44;
  const padT = 12;
  const padB = 28;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const minY = 0;
  const maxY = 100;
  const n = series.length;
  const points = series.map((pct, i) => ({
    x: padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW),
    y: padT + innerH - ((pct - minY) / (maxY - minY)) * innerH,
  }));

  const lineD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');

  const yTicks = [0, 25, 50, 75, 100];

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-[200px] select-none"
      preserveAspectRatio="none"
      aria-hidden
    >
      {yTicks.map((tick) => {
        const y = padT + innerH - (tick / 100) * innerH;
        return (
          <g key={tick}>
            <line
              x1={padL}
              y1={y}
              x2={w - padR}
              y2={y}
              stroke="rgba(148,163,184,0.15)"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
            <text
              x={w - 6}
              y={y + 4}
              textAnchor="end"
              className="fill-slate-500"
              style={{ fontSize: 10 }}
            >
              {tick}%
            </text>
          </g>
        );
      })}

      <path
        d={lineD}
        fill="none"
        stroke="#38bdf8"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {xLabels.map((label, i) => {
        const x = padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
        return (
          <text
            key={label}
            x={i === n - 1 ? w - padR - 4 : x}
            y={h - 6}
            textAnchor={i === n - 1 ? 'end' : 'middle'}
            className="fill-slate-500"
            style={{ fontSize: 10 }}
          >
            {label}
          </text>
        );
      })}

      <text
        x={w - padR - 4}
        y={padT + 14}
        textAnchor="end"
        className="fill-slate-600/50"
        style={{ fontSize: 11, fontWeight: 600 }}
      >
        GhostMarket
      </text>
    </svg>
  );
}

export function MarketDetailLeftPanel({
  market,
  rawMarket,
  yesPct,
}: MarketDetailLeftPanelProps) {
  const [timeframe, setTimeframe] = useState<Timeframe>('ALL');
  const [orderBookOpen, setOrderBookOpen] = useState(false);
  const [tab, setTab] = useState<'rules' | 'context'>('rules');
  const [rulesExpanded, setRulesExpanded] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);

  const change24h = market.change24h;
  const trendUp = change24h >= 0;
  const trendPct = Math.abs(Math.round(change24h * 100));

  const series = useMemo(
    () => buildDummyPctSeries(market.id, yesPct, 8),
    [market.id, yesPct],
  );
  const xLabels = useMemo(() => lastNDayLabels(series.length), [series.length]);

  const resolutionDate = formatDate(market.expiryAt);
  const shortRule = useMemo(() => {
    const title = market.title.trim();
    return `This market will resolve to “Yes” if ${title} by ${resolutionDate} (UTC). Otherwise, this market will resolve to “No”.`;
  }, [market.title, resolutionDate]);

  const fullRuleExtra = useMemo(
    () =>
      `The outcome must be clearly verifiable from ${market.resolutionSource || 'public sources'} before the resolution deadline. In the event of ambiguity, the market may be disputed according to platform policy.`,
    [market.resolutionSource],
  );

  const copyPageLink = useCallback(() => {
    if (typeof window === 'undefined') return;
    void navigator.clipboard.writeText(window.location.href);
  }, []);

  const copyMarketSnippet = useCallback(() => {
    const snippet = JSON.stringify(
      {
        id: market.id,
        title: market.title,
        yesPct,
        expiryAt: market.expiryAt,
        onChain: rawMarket?.id,
      },
      null,
      2,
    );
    void navigator.clipboard.writeText(snippet);
  }, [market.id, market.title, market.expiryAt, rawMarket?.id, yesPct]);

  return (
    <div className="space-y-6">
      {/* Header: image + title + actions */}
      <div className="flex gap-4">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-slate-800">
          {market.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={market.image} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-slate-500">
              GM
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-xl font-bold leading-snug tracking-tight text-white sm:text-2xl">
              {market.title}
            </h1>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                title="Copy market JSON"
                onClick={copyMarketSnippet}
                className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300"
              >
                <Code2 className="h-4 w-4" strokeWidth={1.5} />
              </button>
              <button
                type="button"
                title="Copy link"
                onClick={copyPageLink}
                className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300"
              >
                <Link2 className="h-4 w-4" strokeWidth={1.5} />
              </button>
              <button
                type="button"
                title="Bookmark"
                onClick={() => setBookmarked((b) => !b)}
                className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300"
              >
                <Bookmark
                  className={cn('h-4 w-4', bookmarked && 'fill-amber-400 text-amber-400')}
                  strokeWidth={1.5}
                />
              </button>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="rounded-md bg-white/5 px-2 py-0.5 text-slate-400">
              {market.category}
            </span>
            <span className="capitalize">{market.status}</span>
            {rawMarket && (
              <span className="font-mono text-slate-600">#{rawMarket.id}</span>
            )}
          </div>
        </div>
      </div>

      {/* Chance + trend */}
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-3xl font-semibold text-sky-400 sm:text-4xl">
          {yesPct}% chance
        </span>
        {trendPct > 0 && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-sm font-medium',
              trendUp ? 'text-emerald-400' : 'text-rose-400',
            )}
          >
            {trendUp ? '▲' : '▼'} {trendPct}%
          </span>
        )}
      </div>

      {/* Chart card */}
      <div className="overflow-hidden rounded-2xl border border-white/8 bg-slate-950/80">
        <div className="relative px-3 pt-3 sm:px-4">
          <MarketProbabilityChart series={series} xLabels={xLabels} />
        </div>
        <div className="flex flex-col gap-3 border-t border-white/5 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>
              <span className="text-slate-400">
                {rawMarket ? 'Encrypted Vol.' : `${formatVolume(market.volume)} Vol.`}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 shrink-0 opacity-70" strokeWidth={1.5} />
              {resolutionDate}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
            <div className="flex flex-wrap gap-1">
              {(['1H', '6H', '1D', '1W', '1M', 'ALL'] as const).map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => setTimeframe(tf)}
                  className={cn(
                    'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                    timeframe === tf
                      ? 'bg-white/10 text-white'
                      : 'text-slate-500 hover:text-slate-300',
                  )}
                >
                  {tf}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                title="Expand"
                className="rounded-lg p-1.5 text-slate-600 hover:bg-white/5 hover:text-slate-400"
              >
                <Maximize2 className="h-4 w-4" strokeWidth={1.5} />
              </button>
              <button
                type="button"
                title="Chart settings"
                className="rounded-lg p-1.5 text-slate-600 hover:bg-white/5 hover:text-slate-400"
              >
                <Settings className="h-4 w-4" strokeWidth={1.5} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Order book (collapsible) */}
      <div className="overflow-hidden rounded-xl border border-white/8 bg-slate-900/60">
        <button
          type="button"
          onClick={() => setOrderBookOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium text-white transition-colors hover:bg-white/5"
        >
          <span className="flex items-center gap-2">
            Order Book
            <Info className="h-3.5 w-3.5 text-slate-500" strokeWidth={1.5} />
          </span>
          {orderBookOpen ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={1.5} />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={1.5} />
          )}
        </button>
        {orderBookOpen && (
          <div className="border-t border-white/5 px-4 py-3 text-xs text-slate-500">
            <p className="mb-3 text-slate-400">
              Depth is illustrative on this demo — live order flow routes through the shielded eAMM.
            </p>
            <div className="grid grid-cols-2 gap-4 font-mono">
              <div>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-rose-400/80">
                  Asks
                </div>
                <div className="space-y-1 opacity-80">
                  <div className="flex justify-between">
                    <span>{Math.min(99, yesPct + 3)}¢</span>
                    <span className="text-slate-600">$12.4k</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{Math.min(99, yesPct + 5)}¢</span>
                    <span className="text-slate-600">$8.1k</span>
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-emerald-400/80">
                  Bids
                </div>
                <div className="space-y-1 opacity-80">
                  <div className="flex justify-between">
                    <span>{Math.max(1, yesPct - 2)}¢</span>
                    <span className="text-slate-600">$9.8k</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{Math.max(1, yesPct - 4)}¢</span>
                    <span className="text-slate-600">$15.2k</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Rules / Market context */}
      <div className="rounded-2xl border border-white/8 bg-slate-950/80 p-1">
        <div className="flex gap-1 border-b border-white/5 px-2 pt-1 pb-2">
          <button
            type="button"
            onClick={() => setTab('rules')}
            className={cn(
              'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              tab === 'rules' ? 'text-white' : 'text-slate-500 hover:text-slate-300',
            )}
          >
            Rules
          </button>
          <button
            type="button"
            onClick={() => setTab('context')}
            className={cn(
              'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              tab === 'context' ? 'text-white' : 'text-slate-500 hover:text-slate-300',
            )}
          >
            Market Context
          </button>
        </div>
        <div className="px-4 py-4">
          {tab === 'rules' ? (
            <div className="space-y-3 text-sm leading-relaxed text-slate-300">
              <p>{shortRule}</p>
              {rulesExpanded && <p className="text-slate-400">{fullRuleExtra}</p>}
              <button
                type="button"
                onClick={() => setRulesExpanded((e) => !e)}
                className="text-sm font-medium text-sky-400 hover:text-sky-300"
              >
                {rulesExpanded ? 'Show less' : 'Show more'}
              </button>
            </div>
          ) : (
            <div className="space-y-4 text-sm leading-relaxed text-slate-300">
              <p className="text-slate-400">{market.description}</p>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-4 border-b border-white/5 py-2">
                  <dt className="text-slate-500">Resolution source</dt>
                  <dd className="max-w-[60%] text-right text-slate-300">
                    {market.resolutionSource || '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-white/5 py-2">
                  <dt className="text-slate-500">Expiry</dt>
                  <dd className="text-slate-300">{resolutionDate}</dd>
                </div>
                {rawMarket?.creator && (
                  <div className="flex justify-between gap-4 py-2">
                    <dt className="text-slate-500">Creator</dt>
                    <dd>
                      <a
                        href={`https://sepolia.etherscan.io/address/${rawMarket.creator}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-indigo-400 hover:text-indigo-300"
                      >
                        {`${rawMarket.creator.slice(0, 6)}…${rawMarket.creator.slice(-4)}`}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
