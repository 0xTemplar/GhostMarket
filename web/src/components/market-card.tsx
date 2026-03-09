'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Activity, MessageCircle, Star } from 'lucide-react';
import type { Market } from '@/types/market';
import { formatVolume } from '@/lib/utils';
import { useBetSlip } from '@/components/bet-slip-provider';

interface MarketCardProps {
  market: Market;
  index?: number;
  variant?: 'highlight' | 'compact';
}

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
  const pct = Math.round(value * 100);
  const strokeColor = color === 'yes' ? 'text-emerald-500' : 'text-rose-500';
  const dashArray = `${pct}, 100`;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
        <path
          className="text-slate-700"
          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        />
        <path
          className={strokeColor}
          strokeDasharray={dashArray}
          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold text-white">{pct}%</span>
        {showChange !== undefined && (
          <span
            className={`text-[10px] ${
              showChange >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {showChange >= 0 ? '+' : ''}
            {(showChange * 100).toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}

export function MarketCard({
  market,
  index = 0,
  variant = 'compact',
}: MarketCardProps) {
  const { openBetSlip } = useBetSlip();
  const yesPct = Math.round(market.yesPrice * 100);
  const noPct = 100 - yesPct;

  if (variant === 'highlight') {
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
          <div className="absolute -inset-0.5 bg-gradient-to-r from-indigo-500 to-cyan-500 rounded-2xl opacity-10 group-hover:opacity-20 blur transition duration-300 pointer-events-none" />

          <div className="relative space-y-5">
            <div className="flex gap-4">
              <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center overflow-hidden shrink-0 border border-white/5">
                {market.image ? (
                  <img
                    src={market.image}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-indigo-400 font-bold text-sm">
                    {market.category.slice(0, 2)}
                  </span>
                )}
              </div>
              <div className="min-w-0">
                <h3 className="text-xl font-semibold text-white tracking-tight leading-tight">
                  {market.title}
                </h3>
                <p className="text-slate-500 text-sm mt-1">{market.category}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={(e) => {
                  e.preventDefault();
                  openBetSlip(market, 'YES');
                }}
                className="bg-slate-800/50 rounded-xl p-4 flex flex-col items-center justify-center border border-white/5 hover:border-emerald-500/30 transition-colors cursor-pointer relative overflow-hidden group/opt"
              >
                <div className="absolute inset-x-0 bottom-0 h-1 bg-emerald-500/20">
                  <div
                    className="h-full bg-emerald-500"
                    style={{ width: `${yesPct}%` }}
                  />
                </div>
                <CircularProgress
                  value={market.yesPrice}
                  color="yes"
                  size={80}
                  showChange={market.change24h}
                />
                <span className="text-emerald-400 font-semibold text-lg mt-2">
                  Yes
                </span>
              </button>

              <button
                onClick={(e) => {
                  e.preventDefault();
                  openBetSlip(market, 'NO');
                }}
                className="bg-slate-800/50 rounded-xl p-4 flex flex-col items-center justify-center border border-white/5 hover:border-rose-500/30 transition-colors cursor-pointer relative overflow-hidden group/opt"
              >
                <div className="absolute inset-x-0 bottom-0 h-1 bg-rose-500/20">
                  <div
                    className="h-full bg-rose-500"
                    style={{ width: `${noPct}%` }}
                  />
                </div>
                <CircularProgress value={market.noPrice} color="no" size={80} />
                <span className="text-rose-400 font-semibold text-lg mt-2">
                  No
                </span>
              </button>
            </div>

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
              <div className="flex gap-3">
                <span className="flex items-center gap-1">
                  <MessageCircle className="w-3 h-3" strokeWidth={1.5} />
                  {market.tradersCount}
                </span>
                <Star
                  className="w-3 h-3 hover:text-amber-400 cursor-pointer"
                  strokeWidth={1.5}
                />
              </div>
            </div>
          </div>
        </Link>
      </motion.div>
    );
  }

  // Compact variant
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
        <div className="flex gap-3 mb-5">
          <div className="w-12 h-12 rounded-lg bg-slate-800 flex items-center justify-center overflow-hidden shrink-0 border border-white/5">
            {market.image ? (
              <img
                src={market.image}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-indigo-400 font-bold text-sm">
                {market.category.slice(0, 2)}
              </span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-white tracking-tight leading-tight line-clamp-2">
              {market.title}
            </h3>
            <p className="text-slate-500 text-xs mt-1">{market.category}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={(e) => {
              e.preventDefault();
              openBetSlip(market, 'YES');
            }}
            className="bg-slate-800/30 rounded-lg p-3 flex flex-col items-center border border-white/5 hover:bg-slate-800/50 transition-all cursor-pointer"
          >
            <CircularProgress value={market.yesPrice} color="yes" size={56} />
            <span className="text-emerald-400 font-semibold text-sm mt-1">
              Yes
            </span>
          </button>

          <button
            onClick={(e) => {
              e.preventDefault();
              openBetSlip(market, 'NO');
            }}
            className="bg-slate-800/30 rounded-lg p-3 flex flex-col items-center border border-white/5 hover:bg-slate-800/50 transition-all cursor-pointer"
          >
            <CircularProgress value={market.noPrice} color="no" size={56} />
            <span className="text-rose-400 font-semibold text-sm mt-1">No</span>
          </button>
        </div>

        <div className="flex justify-between items-center text-xs text-slate-500 mt-4 pt-3 border-t border-white/5">
          <span className="flex items-center gap-1">
            <Activity className="w-3 h-3" strokeWidth={1.5} />
            {formatVolume(market.volume)}
          </span>
          <div className="flex gap-3">
            <span className="flex items-center gap-1">
              <MessageCircle className="w-3 h-3" strokeWidth={1.5} />
              {market.tradersCount}
            </span>
            <Star className="w-3 h-3" strokeWidth={1.5} />
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
