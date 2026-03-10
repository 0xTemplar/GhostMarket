'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Activity, MessageCircle, Star, ArrowRight, Zap, TrendingUp, TrendingDown } from 'lucide-react';
import type { Market } from '@/types/market';
import { formatVolume, formatTimeRemaining } from '@/lib/utils';
import { useBetSlip } from '@/components/bet-slip-provider';
import { MiniChart } from '@/components/mini-chart';

interface MarketCardProps {
  market: Market;
  index?: number;
  variant?: 'highlight' | 'compact';
}

/** True when the market ID is a uint256 on-chain ID (1, 2, 3 …). */
function isLiveMarket(id: string): boolean {
  return /^\d+$/.test(id);
}

// ─── Category accent colours ──────────────────────────────────────────────────
// All class strings must appear literally so Tailwind includes them in the build.

type CategoryKey = 'Crypto' | 'Macro' | 'Politics' | 'Sports' | 'Tech' | 'Climate' | string;

interface CategoryStyle {
  border: string;        // card left border
  glow: string;          // hover glow overlay
  badge: string;         // category label bg + text
  dot: string;           // small accent dot
  chartPositive: boolean;
}

const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  Crypto:   { border: 'border-l-violet-500/70',  glow: 'from-violet-500/10',  badge: 'bg-violet-500/10 text-violet-400',  dot: 'bg-violet-500',  chartPositive: true  },
  Macro:    { border: 'border-l-amber-500/70',   glow: 'from-amber-500/10',   badge: 'bg-amber-500/10  text-amber-400',   dot: 'bg-amber-500',   chartPositive: true  },
  Politics: { border: 'border-l-blue-500/70',    glow: 'from-blue-500/10',    badge: 'bg-blue-500/10   text-blue-400',    dot: 'bg-blue-500',    chartPositive: false },
  Sports:   { border: 'border-l-green-500/70',   glow: 'from-green-500/10',   badge: 'bg-green-500/10  text-green-400',   dot: 'bg-green-500',   chartPositive: true  },
  Tech:     { border: 'border-l-cyan-500/70',    glow: 'from-cyan-500/10',    badge: 'bg-cyan-500/10   text-cyan-400',    dot: 'bg-cyan-500',    chartPositive: true  },
  Climate:  { border: 'border-l-teal-500/70',    glow: 'from-teal-500/10',    badge: 'bg-teal-500/10   text-teal-400',    dot: 'bg-teal-500',    chartPositive: false },
};

function getCategoryStyle(category: CategoryKey): CategoryStyle {
  return CATEGORY_STYLES[category] ?? {
    border: 'border-l-indigo-500/70',
    glow: 'from-indigo-500/10',
    badge: 'bg-indigo-500/10 text-indigo-400',
    dot: 'bg-indigo-500',
    chartPositive: true,
  };
}

// ─── Circular progress ring ───────────────────────────────────────────────────

function CircularProgress({
  value,
  color,
  size = 80,
  showChange,
}: {
  value: number;
  color: 'yes' | 'no';
  size?: number;
  showChange?: number;
}) {
  const pct        = Math.round(value * 100);
  const strokeColor = color === 'yes' ? 'text-emerald-500' : 'text-rose-500';
  const dashArray  = `${pct}, 100`;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
        <path
          className="text-slate-700"
          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
          fill="none" stroke="currentColor" strokeWidth="3"
        />
        <path
          className={strokeColor}
          strokeDasharray={dashArray}
          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
          fill="none" stroke="currentColor" strokeWidth="3"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold text-white">{pct}%</span>
        {showChange !== undefined && (
          <span className={`text-[10px] ${showChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {showChange >= 0 ? '+' : ''}{(showChange * 100).toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Shared price bar for live markets (non-interactive) ──────────────────────

function LivePriceDisplay({ market }: { market: Market }) {
  const yesPct = Math.round(market.yesPrice * 100);
  const noPct  = 100 - yesPct;

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <div className="flex-1 rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-center">
          <div className="text-xs font-medium text-emerald-400/70 uppercase tracking-wide mb-0.5">Yes</div>
          <div className="font-mono text-xl font-bold text-emerald-500">{yesPct}¢</div>
        </div>
        <div className="flex-1 rounded-xl bg-rose-500/10 border border-rose-500/20 px-4 py-3 text-center">
          <div className="text-xs font-medium text-rose-400/70 uppercase tracking-wide mb-0.5">No</div>
          <div className="font-mono text-xl font-bold text-rose-500">{noPct}¢</div>
        </div>
      </div>

      {/* Pool bar */}
      <div className="w-full h-1.5 rounded-full bg-rose-500/15 overflow-hidden">
        <div
          className="h-full rounded-full bg-linear-to-r from-emerald-500 to-emerald-400 transition-all"
          style={{ width: `${yesPct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Highlight (first card) ────────────────────────────────────────────────────

function HighlightCard({ market, index }: { market: Market; index: number }) {
  const { openBetSlip } = useBetSlip();
  const live      = isLiveMarket(market.id);
  const yesPct    = Math.round(market.yesPrice * 100);
  const noPct     = 100 - yesPct;
  const catStyle  = getCategoryStyle(market.category);
  const isUp      = (market.change24h ?? 0) >= 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05 }}
    >
      <Link
        href={`/markets/${market.id}`}
        className={`group relative block bg-slate-900/50 rounded-2xl border-l-4 ${catStyle.border} border border-white/5 hover:border-white/10 p-5 transition-all duration-300`}
      >
        {/* Category glow overlay on hover */}
        <div className={`absolute inset-0 rounded-2xl bg-linear-to-br ${catStyle.glow} to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none`} />
        {/* Indigo glow edge */}
        <div className="absolute -inset-0.5 bg-linear-to-r from-indigo-500/0 via-indigo-500/0 to-indigo-500/0 group-hover:from-indigo-500/10 group-hover:via-indigo-500/5 rounded-2xl blur opacity-0 group-hover:opacity-100 transition duration-300 pointer-events-none" />

        <div className="relative space-y-5">
          {/* Header */}
          <div className="flex gap-4">
            <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center overflow-hidden shrink-0 border border-white/5">
              {market.image ? (
                <img src={market.image} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-indigo-400 font-bold text-sm">
                  {market.category.slice(0, 2)}
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                {live && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                    <Zap className="h-2.5 w-2.5" />
                    Live
                  </span>
                )}
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${catStyle.badge}`}>
                  {market.category}
                </span>
              </div>
              <h3 className="text-xl font-semibold text-white tracking-tight leading-tight">
                {market.title}
              </h3>
            </div>
          </div>

          {/* Prices */}
          {live ? (
            <LivePriceDisplay market={market} />
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={(e) => { e.preventDefault(); openBetSlip(market, 'YES'); }}
                className="bg-slate-800/50 rounded-xl p-4 flex flex-col items-center justify-center border border-white/5 hover:border-emerald-500/30 transition-colors cursor-pointer relative overflow-hidden"
              >
                <div className="absolute inset-x-0 bottom-0 h-1 bg-emerald-500/20">
                  <div className="h-full bg-emerald-500" style={{ width: `${yesPct}%` }} />
                </div>
                <CircularProgress value={market.yesPrice} color="yes" size={80} showChange={market.change24h} />
                <span className="text-emerald-400 font-semibold text-lg mt-2">Yes</span>
              </button>

              <button
                onClick={(e) => { e.preventDefault(); openBetSlip(market, 'NO'); }}
                className="bg-slate-800/50 rounded-xl p-4 flex flex-col items-center justify-center border border-white/5 hover:border-rose-500/30 transition-colors cursor-pointer relative overflow-hidden"
              >
                <div className="absolute inset-x-0 bottom-0 h-1 bg-rose-500/20">
                  <div className="h-full bg-rose-500" style={{ width: `${noPct}%` }} />
                </div>
                <CircularProgress value={market.noPrice} color="no" size={80} />
                <span className="text-rose-400 font-semibold text-lg mt-2">No</span>
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="flex justify-between items-center pt-2 border-t border-white/5">
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1">
                <Activity className="w-3 h-3" strokeWidth={1.5} />
                {formatVolume(market.volume)} Vol
              </span>
              {market.trending && (
                <span className="text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded text-[10px] font-semibold">
                  Trending
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              {/* Sparkline */}
              {market.priceHistory && market.priceHistory.length >= 2 && (
                <MiniChart
                  data={market.priceHistory}
                  positive={isUp}
                  width={64}
                  height={28}
                />
              )}
              {/* 24h change */}
              {market.change24h !== undefined && (
                <span className={`flex items-center gap-0.5 text-xs font-medium ${isUp ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {isUp ? <TrendingUp className="w-3 h-3" strokeWidth={2} /> : <TrendingDown className="w-3 h-3" strokeWidth={2} />}
                  {isUp ? '+' : ''}{(market.change24h * 100).toFixed(1)}%
                </span>
              )}
              {live ? (
                <span className="flex items-center gap-1 text-indigo-400 group-hover:text-indigo-300 transition-colors font-medium text-xs">
                  View <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                </span>
              ) : (
                <div className="flex gap-3 text-xs text-slate-500">
                  <span className="flex items-center gap-1">
                    <MessageCircle className="w-3 h-3" strokeWidth={1.5} />
                    {market.tradersCount}
                  </span>
                  <Star className="w-3 h-3 hover:text-amber-400 cursor-pointer" strokeWidth={1.5} />
                </div>
              )}
            </div>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

// ─── Compact card ─────────────────────────────────────────────────────────────

function CompactCard({ market, index }: { market: Market; index: number }) {
  const { openBetSlip } = useBetSlip();
  const live      = isLiveMarket(market.id);
  const yesPct    = Math.round(market.yesPrice * 100);
  const noPct     = 100 - yesPct;
  const catStyle  = getCategoryStyle(market.category);
  const isUp      = (market.change24h ?? 0) >= 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05 }}
    >
      <Link
        href={`/markets/${market.id}`}
        className={`group block bg-slate-900 border-l-4 ${catStyle.border} border border-white/5 rounded-2xl p-5 hover:border-white/10 transition-all duration-200`}
      >
        {/* Subtle category glow on hover */}
        <div className={`absolute inset-0 rounded-2xl bg-linear-to-br ${catStyle.glow} to-transparent opacity-0 group-hover:opacity-60 transition-opacity duration-300 pointer-events-none`} />

        {/* Header */}
        <div className="flex gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center overflow-hidden shrink-0 border border-white/5">
            {market.image ? (
              <img src={market.image} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-indigo-400 font-bold text-xs">
                {market.category.slice(0, 2)}
              </span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              {live && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                  <Zap className="h-2.5 w-2.5" />
                  Live
                </span>
              )}
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${catStyle.badge}`}>
                {market.category}
              </span>
            </div>
            <h3 className="text-sm font-semibold text-white tracking-tight leading-tight line-clamp-2">
              {market.title}
            </h3>
          </div>
        </div>

        {/* Prices */}
        {live ? (
          <div className="mb-4">
            <LivePriceDisplay market={market} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 mb-4">
            <button
              onClick={(e) => { e.preventDefault(); openBetSlip(market, 'YES'); }}
              className="bg-slate-800/30 rounded-lg p-3 flex flex-col items-center border border-white/5 hover:bg-slate-800/60 hover:border-emerald-500/20 transition-all cursor-pointer"
            >
              <CircularProgress value={market.yesPrice} color="yes" size={56} />
              <span className="text-emerald-400 font-semibold text-sm mt-1">Yes</span>
            </button>
            <button
              onClick={(e) => { e.preventDefault(); openBetSlip(market, 'NO'); }}
              className="bg-slate-800/30 rounded-lg p-3 flex flex-col items-center border border-white/5 hover:bg-slate-800/60 hover:border-rose-500/20 transition-all cursor-pointer"
            >
              <CircularProgress value={market.noPrice} color="no" size={56} />
              <span className="text-rose-400 font-semibold text-sm mt-1">No</span>
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-between items-center pt-3 border-t border-white/5">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Activity className="w-3 h-3" strokeWidth={1.5} />
            <span>{formatVolume(market.volume)}</span>
          </div>

          <div className="flex items-center gap-2">
            {/* Sparkline */}
            {market.priceHistory && market.priceHistory.length >= 2 && (
              <MiniChart
                data={market.priceHistory}
                positive={isUp}
                width={52}
                height={24}
              />
            )}
            {live ? (
              <span className="flex items-center gap-1 text-indigo-400 group-hover:text-indigo-300 transition-colors font-medium text-xs">
                {formatTimeRemaining(market.expiryAt)} left
                <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
              </span>
            ) : (
              <div className="flex gap-2 text-xs text-slate-500">
                {market.change24h !== undefined && (
                  <span className={`font-medium ${isUp ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {isUp ? '+' : ''}{(market.change24h * 100).toFixed(1)}%
                  </span>
                )}
                <Star className="w-3 h-3 hover:text-amber-400 cursor-pointer" strokeWidth={1.5} />
              </div>
            )}
          </div>
        </div>
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
