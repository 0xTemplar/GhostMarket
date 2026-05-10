'use client';

import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Activity, Star, ArrowRight, Zap } from 'lucide-react';
import type { Market } from '@/types/market';
import { formatVolume, formatTimeRemaining } from '@/lib/utils';
import { useBetSlip } from '@/components/bet-slip-provider';
import { MiniChart } from '@/components/mini-chart';

interface MarketCardProps {
  market: Market;
  index?: number;
  variant?: 'highlight' | 'compact';
}

function isLiveMarket(id: string): boolean {
  return /^\d+$/.test(id);
}

// ─── Category accent — left border only, no bg flood ─────────────────────────

const CATEGORY_BORDER: Record<string, string> = {
  Crypto:   'border-l-violet-400/40',
  Macro:    'border-l-amber-400/40',
  Politics: 'border-l-blue-400/40',
  Sports:   'border-l-green-400/40',
  Tech:     'border-l-cyan-400/40',
  Climate:  'border-l-teal-400/40',
};

function categoryBorder(cat: string) {
  return CATEGORY_BORDER[cat] ?? 'border-l-indigo-500/50';
}

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function MarketMetaStrip({ market }: { market: Market }) {
  const hasVolume   = market.volume > 0;
  const hasLiq      = market.liquidity > 0;
  const hasTraders  = market.tradersCount > 0;

  // FHE markets have no on-chain pool metadata — show encrypted indicator instead.
  if (!hasVolume && !hasLiq && !hasTraders) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
        <span className="w-1 h-1 rounded-full bg-indigo-400/60 shrink-0" />
        <span>FHE encrypted pools</span>
      </div>
    );
  }

  const parts: React.ReactNode[] = [];
  if (hasVolume)  parts.push(<span key="vol">Vol {formatVolume(market.volume)}</span>);
  if (hasLiq)     parts.push(<span key="liq">Liq {formatVolume(market.liquidity)}</span>);
  if (hasTraders) parts.push(<span key="traders">{formatCount(market.tradersCount)} traders</span>);

  return (
    <div className="flex items-center gap-3 text-[11px] text-slate-400">
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-white/10">|</span>}
          {p}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Flat YES / NO price buttons ─────────────────────────────────────────────

function PriceButtons({
  market,
  size = 'md',
}: {
  market: Market;
  size?: 'md' | 'sm';
}) {
  const { openBetSlip } = useBetSlip();
  const yesPct = Math.round(market.yesPrice * 100);
  const noPct  = 100 - yesPct;
  const numCls = size === 'md' ? 'text-xl font-bold tracking-tight' : 'text-lg font-bold tracking-tight';
  const quoteCls = size === 'md' ? 'text-[10px]' : 'text-[10px]';

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={(e) => { e.preventDefault(); openBetSlip(market, 'YES'); }}
          className="flex-1 rounded-lg bg-slate-900/90 border border-emerald-400/18 hover:border-emerald-300/28 transition-colors cursor-pointer px-3 py-2.5"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-bold text-emerald-300/80 uppercase tracking-[0.14em]">YES</span>
            <span className={`font-mono text-emerald-300 tabular-nums ${numCls}`}>{yesPct}¢</span>
          </div>
          <div className={`${quoteCls} mt-0.5 text-slate-500`}>{yesPct}% implied</div>
        </button>
        <button
          onClick={(e) => { e.preventDefault(); openBetSlip(market, 'NO'); }}
          className="flex-1 rounded-lg bg-slate-900/90 border border-rose-400/18 hover:border-rose-300/28 transition-colors cursor-pointer px-3 py-2.5"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-bold text-rose-300/80 uppercase tracking-[0.14em]">NO</span>
            <span className={`font-mono text-rose-300 tabular-nums ${numCls}`}>{noPct}¢</span>
          </div>
          <div className={`${quoteCls} mt-0.5 text-slate-500`}>{noPct}% implied</div>
        </button>
      </div>
      {/* Probability split bar */}
      <div className="h-0.5 w-full rounded-full overflow-hidden bg-slate-700/45">
        <div
          className="h-full bg-emerald-400/75 transition-all duration-300"
          style={{ width: `${yesPct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Live price display (on-chain markets, non-interactive) ──────────────────

function LivePriceDisplay({ market }: { market: Market }) {
  const yesPct = Math.round(market.yesPrice * 100);
  const noPct  = 100 - yesPct;

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="flex-1 rounded-lg bg-slate-900/90 border border-emerald-400/18 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-bold text-emerald-300/80 uppercase tracking-[0.14em]">YES</span>
            <span className="font-mono text-xl font-bold tracking-tight text-emerald-300 tabular-nums">{yesPct}¢</span>
          </div>
          <div className="text-[10px] mt-0.5 text-slate-500">{yesPct}% implied</div>
        </div>
        <div className="flex-1 rounded-lg bg-slate-900/90 border border-rose-400/18 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-bold text-rose-300/80 uppercase tracking-[0.14em]">NO</span>
            <span className="font-mono text-xl font-bold tracking-tight text-rose-300 tabular-nums">{noPct}¢</span>
          </div>
          <div className="text-[10px] mt-0.5 text-slate-500">{noPct}% implied</div>
        </div>
      </div>
      <div className="h-0.5 w-full rounded-full overflow-hidden bg-slate-700/45">
        <div className="h-full bg-emerald-400/75 transition-all" style={{ width: `${yesPct}%` }} />
      </div>
    </div>
  );
}

// ─── Shared card meta footer ──────────────────────────────────────────────────

function CardFooter({
  market,
  live,
  showSparkline = true,
}: {
  market: Market;
  live: boolean;
  showSparkline?: boolean;
}) {
  const isUp = (market.change24h ?? 0) >= 0;

  return (
    <div className="flex justify-between items-center pt-3 border-t border-white/5">
      <div className="flex items-center gap-3 text-xs text-slate-500">
        {market.volume > 0 && (
          <span className="flex items-center gap-1">
            <Activity className="w-3 h-3" strokeWidth={1.5} />
            {formatVolume(market.volume)}
          </span>
        )}
        {market.trending && (
          <span className="text-slate-400 font-medium">Trending</span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {showSparkline && market.priceHistory && market.priceHistory.length >= 2 && (
          <MiniChart
            data={market.priceHistory}
            positive={isUp}
            width={56}
            height={24}
          />
        )}

        {market.change24h !== undefined && (
          <span className={`text-xs font-mono font-medium tabular-nums ${isUp ? 'text-emerald-400' : 'text-rose-400'}`}>
            {isUp ? '+' : ''}{(market.change24h * 100).toFixed(1)}%
          </span>
        )}

        {live ? (
          <span className="flex items-center gap-1 text-slate-400 group-hover:text-white transition-colors text-xs">
            {formatTimeRemaining(market.expiryAt)} left
            <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
          </span>
        ) : (
          <Star className="w-3.5 h-3.5 text-slate-600 hover:text-amber-400 cursor-pointer transition-colors" strokeWidth={1.5} />
        )}
      </div>
    </div>
  );
}

// ─── Highlight card (first / featured) ───────────────────────────────────────

function HighlightCard({ market, index }: { market: Market; index: number }) {
  const live = isLiveMarket(market.id);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05 }}
    >
      <Link
        href={`/markets/${market.id}`}
        className={`group relative block bg-slate-950/70 rounded-xl border-l-2 ${categoryBorder(market.category)} border border-white/8 hover:border-white/14 hover:-translate-y-0.5 p-5 transition-all duration-200`}
      >
        <div className="space-y-4">
          {/* Header */}
          <div className="flex gap-3.5">
            <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center overflow-hidden shrink-0 border border-white/5">
              {market.image ? (
                <img src={market.image} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-slate-400 font-semibold text-xs">
                  {market.category.slice(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                {live && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/15">
                    <Zap className="h-2.5 w-2.5" />
                    Live
                  </span>
                )}
                <span className="text-xs text-slate-500">{market.category}</span>
              </div>
              <h3 className="text-lg font-semibold text-white leading-snug tracking-tight">
                {market.title}
              </h3>
            </div>
          </div>

          <MarketMetaStrip market={market} />

          {/* Price display */}
          {live ? (
            <LivePriceDisplay market={market} />
          ) : (
            <PriceButtons market={market} size="md" />
          )}

          <CardFooter market={market} live={live} showSparkline />
        </div>
      </Link>
    </motion.div>
  );
}

// ─── Compact card ─────────────────────────────────────────────────────────────

function CompactCard({ market, index }: { market: Market; index: number }) {
  const live = isLiveMarket(market.id);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05 }}
    >
      <Link
        href={`/markets/${market.id}`}
        className={`group block bg-slate-950/85 border-l-2 ${categoryBorder(market.category)} border border-white/8 rounded-xl p-4 hover:border-white/14 hover:-translate-y-0.5 transition-all duration-200`}
      >
        {/* Header */}
        <div className="flex gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center overflow-hidden shrink-0 border border-white/5">
            {market.image ? (
              <img src={market.image} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-slate-400 font-semibold text-[10px]">
                {market.category.slice(0, 2).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              {live && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/15">
                  <Zap className="h-2.5 w-2.5" />
                  Live
                </span>
              )}
              <span className="text-xs text-slate-500">{market.category}</span>
            </div>
            <h3 className="text-sm font-semibold text-white leading-snug tracking-tight line-clamp-2">
              {market.title}
            </h3>
          </div>
        </div>

        <div className="mb-3"><MarketMetaStrip market={market} /></div>

        {/* Price display */}
        <div className="mb-4">
          {live ? (
            <LivePriceDisplay market={market} />
          ) : (
            <PriceButtons market={market} size="sm" />
          )}
        </div>

        <CardFooter market={market} live={live} showSparkline />
      </Link>
    </motion.div>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function MarketCard({ market, index = 0, variant = 'compact' }: MarketCardProps) {
  if (variant === 'highlight') {
    return <HighlightCard market={market} index={index} />;
  }
  return <CompactCard market={market} index={index} />;
}
