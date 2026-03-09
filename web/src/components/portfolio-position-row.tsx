'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowUpRight, Clock } from 'lucide-react';
import type { Position } from '@/types/market';
import { formatCurrency, formatPercent, formatTimeRemaining, cn } from '@/lib/utils';
interface PortfolioPositionRowProps {
  position: Position;
  index?: number;
}

export function PortfolioPositionRow({
  position,
  index = 0,
}: PortfolioPositionRowProps) {
  const isPositive = position.pnl >= 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.3, ease: 'easeOut' }}
    >
      <Link
        href={`/markets/${position.marketId}`}
        className="group block rounded-2xl border border-white/5 bg-slate-900 p-5 transition-all duration-200 hover:border-white/10"
      >
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                  position.side === 'YES'
                    ? 'bg-emerald-500/10 text-emerald-500'
                    : 'bg-rose-500/10 text-rose-500'
                }`}
              >
                {position.side}
              </span>
              <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white/5 text-slate-400">
                {position.category}
              </span>
              <span className="flex items-center gap-1 text-xs text-slate-500">
                <Clock className="h-3 w-3" />
                {formatTimeRemaining(position.expiryAt)}
              </span>
            </div>
            <h3 className="text-[15px] font-semibold text-white truncate group-hover:text-indigo-400 transition-colors">
              {position.marketTitle}
            </h3>
          </div>

          <div className="flex items-center gap-6 sm:gap-8 sm:text-right flex-shrink-0">
            <div>
              <div className="text-xs text-slate-500 mb-0.5">Avg Entry</div>
              <div className="font-mono text-sm font-medium text-white">
                {Math.round(position.avgPrice * 100)}¢
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-0.5">Current</div>
              <div className="font-mono text-sm font-medium text-white">
                {Math.round(position.currentPrice * 100)}¢
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-0.5">Value</div>
              <div className="font-mono text-sm font-semibold text-white">
                {formatCurrency(position.currentValue)}
              </div>
            </div>
            <div className="min-w-[72px]">
              <div className="text-xs text-slate-500 mb-0.5">P&L</div>
              <div
                className={cn(
                  'font-mono text-sm font-semibold',
                  isPositive ? 'text-emerald-500' : 'text-rose-500'
                )}
              >
                {isPositive ? '+' : ''}
                {formatCurrency(position.pnl)}
              </div>
              <div
                className={cn(
                  'font-mono text-xs',
                  isPositive ? 'text-emerald-500' : 'text-rose-500'
                )}
              >
                {formatPercent(position.pnlPercent)}
              </div>
            </div>
            <ArrowUpRight className="h-4 w-4 text-slate-500 group-hover:text-indigo-400 transition-colors hidden sm:block" />
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
