'use client';

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
  Crypto:   'border-l-violet-500/50',
  Macro:    'border-l-amber-500/50',
  Politics: 'border-l-blue-500/50',
  Sports:   'border-l-green-500/50',
  Tech:     'border-l-cyan-500/50',
  Climate:  'border-l-teal-500/50',
};

function categoryBorder(cat: string) {
  return CATEGORY_BORDER[cat] ?? 'border-l-indigo-500/50';
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
  const numCls = size === 'md' ? 'text-base font-bold' : 'text-sm font-semibold';

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={(e) => { e.preventDefault(); openBetSlip(market, 'YES'); }}
          className="flex-1 flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-emerald-500/8 border border-emerald-500/15 hover:bg-emerald-500/12 hover:border-emerald-500/35 transition-all cursor-pointer"
        >
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Yes</span>
          <span className={`font-mono text-emerald-400 ${numCls}`}>{yesPct}¢</span>
        </button>
        <button
          onClick={(e) => { e.preventDefault(); openBetSlip(market, 'NO'); }}
          className="flex-1 flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-rose-500/8 border border-rose-500/15 hover:bg-rose-500/12 hover:border-rose-500/35 transition-all cursor-pointer"
        >
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">No</span>
          <span className={`font-mono text-rose-400 ${numCls}`}>{noPct}¢</span>
        </button>
      </div>
      {/* Probability split bar */}
      <div className="h-px w-full rounded-full overflow-hidden bg-rose-500/20">
        <div
          className="h-full bg-emerald-500/60 transition-all duration-300"
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
        <div className="flex-1 flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-emerald-500/8 border border-emerald-500/15">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Yes</span>
          <span className="font-mono text-base font-bold text-emerald-400">{yesPct}¢</span>
        </div>
        <div className="flex-1 flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-rose-500/8 border border-rose-500/15">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">No</span>
          <span className="font-mono text-base font-bold text-rose-400">{noPct}¢</span>
        </div>
      </div>
      <div className="h-px w-full rounded-full overflow-hidden bg-rose-500/20">
        <div className="h-full bg-emerald-500/60 transition-all" style={{ width: `${yesPct}%` }} />
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
        <span className="flex items-center gap-1">
          <Activity className="w-3 h-3" strokeWidth={1.5} />
          {formatVolume(market.volume)}
        </span>
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
        className={`group relative block bg-slate-900/60 rounded-xl border-l-2 ${categoryBorder(market.category)} border border-white/5 hover:border-white/10 p-5 transition-all duration-200`}
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
        className={`group block bg-slate-900 border-l-2 ${categoryBorder(market.category)} border border-white/5 rounded-xl p-4 hover:border-white/10 transition-all duration-200`}
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
