'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Activity, MessageCircle, Star, ArrowRight, Zap } from 'lucide-react';
import type { Market } from '@/types/market';
import { formatVolume, formatTimeRemaining } from '@/lib/utils';
import { useBetSlip } from '@/components/bet-slip-provider';

interface MarketCardProps {
  market: Market;
  index?: number;
  variant?: 'highlight' | 'compact';
}

/** True when the market ID is a uint256 on-chain ID (1, 2, 3 …). */
function isLiveMarket(id: string): boolean {
  return /^\d+$/.test(id);
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
  const live   = isLiveMarket(market.id);
  const yesPct = Math.round(market.yesPrice * 100);
  const noPct  = 100 - yesPct;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05 }}
    >
      <Link
        href={`/markets/${market.id}`}
        className="group relative block bg-slate-900/50 rounded-2xl border border-indigo-500/30 hover:border-indigo-500/60 p-5 transition-all duration-300"
      >
        <div className="absolute -inset-0.5 bg-linear-to-r from-indigo-500 to-cyan-500 rounded-2xl opacity-10 group-hover:opacity-20 blur transition duration-300 pointer-events-none" />

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
                <span className="text-xs text-slate-500">{market.category}</span>
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
          <div className="flex justify-between items-center text-xs text-slate-500 pt-2 border-t border-white/5">
            <div className="flex gap-4">
              <span className="flex items-center gap-1">
                <Activity className="w-3 h-3" strokeWidth={1.5} />
                {formatVolume(market.volume)} Vol
              </span>
              {market.trending && (
                <span className="text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                  Trending
                </span>
              )}
            </div>
            {live ? (
              <span className="flex items-center gap-1 text-indigo-400 group-hover:text-indigo-300 transition-colors font-medium">
                View market <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
              </span>
            ) : (
              <div className="flex gap-3">
                <span className="flex items-center gap-1">
                  <MessageCircle className="w-3 h-3" strokeWidth={1.5} />
                  {market.tradersCount}
                </span>
                <Star className="w-3 h-3 hover:text-amber-400 cursor-pointer" strokeWidth={1.5} />
              </div>
            )}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

// ─── Compact card ─────────────────────────────────────────────────────────────

function CompactCard({ market, index }: { market: Market; index: number }) {
  const { openBetSlip } = useBetSlip();
  const live   = isLiveMarket(market.id);
  const yesPct = Math.round(market.yesPrice * 100);
  const noPct  = 100 - yesPct;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05 }}
    >
      <Link
        href={`/markets/${market.id}`}
        className="group block bg-slate-900 border border-white/5 rounded-2xl p-5 hover:border-white/10 transition-colors"
      >
        {/* Header */}
        <div className="flex gap-3 mb-4">
          <div className="w-12 h-12 rounded-lg bg-slate-800 flex items-center justify-center overflow-hidden shrink-0 border border-white/5">
            {market.image ? (
              <img src={market.image} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-indigo-400 font-bold text-sm">
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
              <span className="text-slate-500 text-xs">{market.category}</span>
            </div>
            <h3 className="text-base font-semibold text-white tracking-tight leading-tight line-clamp-2">
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
              className="bg-slate-800/30 rounded-lg p-3 flex flex-col items-center border border-white/5 hover:bg-slate-800/50 transition-all cursor-pointer"
            >
              <CircularProgress value={market.yesPrice} color="yes" size={56} />
              <span className="text-emerald-400 font-semibold text-sm mt-1">Yes</span>
            </button>
            <button
              onClick={(e) => { e.preventDefault(); openBetSlip(market, 'NO'); }}
              className="bg-slate-800/30 rounded-lg p-3 flex flex-col items-center border border-white/5 hover:bg-slate-800/50 transition-all cursor-pointer"
            >
              <CircularProgress value={market.noPrice} color="no" size={56} />
              <span className="text-rose-400 font-semibold text-sm mt-1">No</span>
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-between items-center text-xs text-slate-500 pt-3 border-t border-white/5">
          <span className="flex items-center gap-1">
            <Activity className="w-3 h-3" strokeWidth={1.5} />
            {formatVolume(market.volume)}
          </span>
          {live ? (
            <span className="flex items-center gap-1 text-indigo-400 group-hover:text-indigo-300 transition-colors font-medium">
              {formatTimeRemaining(market.expiryAt)} left
              <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
            </span>
          ) : (
            <div className="flex gap-3">
              <span className="flex items-center gap-1">
                <MessageCircle className="w-3 h-3" strokeWidth={1.5} />
                {market.tradersCount}
              </span>
              <Star className="w-3 h-3" strokeWidth={1.5} />
            </div>
          )}
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
