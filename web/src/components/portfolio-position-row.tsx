'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowUpRight, Clock } from 'lucide-react';
import type { Position } from '@/types/market';
import { formatCurrency, formatPercent, formatTimeRemaining, cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

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
        className="group block rounded-2xl border border-border bg-card p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-all duration-200 hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)] hover:border-border-hover"
      >
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <Badge variant={position.side === 'YES' ? 'yes' : 'no'}>
                {position.side}
              </Badge>
              <Badge variant="default">{position.category}</Badge>
              <span className="flex items-center gap-1 text-xs text-text-muted">
                <Clock className="h-3 w-3" />
                {formatTimeRemaining(position.expiryAt)}
              </span>
            </div>
            <h3 className="font-heading text-[15px] font-semibold text-text truncate group-hover:text-primary transition-colors">
              {position.marketTitle}
            </h3>
          </div>

          <div className="flex items-center gap-6 sm:gap-8 sm:text-right flex-shrink-0">
            <div>
              <div className="text-xs text-text-muted mb-0.5">Avg Entry</div>
              <div className="font-mono text-sm font-medium text-text">
                {Math.round(position.avgPrice * 100)}¢
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-0.5">Current</div>
              <div className="font-mono text-sm font-medium text-text">
                {Math.round(position.currentPrice * 100)}¢
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-0.5">Value</div>
              <div className="font-mono text-sm font-semibold text-text">
                {formatCurrency(position.currentValue)}
              </div>
            </div>
            <div className="min-w-[72px]">
              <div className="text-xs text-text-muted mb-0.5">P&L</div>
              <div
                className={cn(
                  'font-mono text-sm font-semibold',
                  isPositive ? 'text-yes' : 'text-no'
                )}
              >
                {isPositive ? '+' : ''}
                {formatCurrency(position.pnl)}
              </div>
              <div
                className={cn(
                  'font-mono text-xs',
                  isPositive ? 'text-yes' : 'text-no'
                )}
              >
                {formatPercent(position.pnlPercent)}
              </div>
            </div>
            <ArrowUpRight className="h-4 w-4 text-text-muted group-hover:text-primary transition-colors hidden sm:block" />
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
