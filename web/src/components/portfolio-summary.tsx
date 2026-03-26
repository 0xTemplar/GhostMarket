'use client';

import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown, Layers, Target } from 'lucide-react';
import type { PortfolioStats } from '@/types/market';
import { formatCurrency, formatPercent, cn } from '@/lib/utils';

interface PortfolioSummaryProps {
  stats: PortfolioStats;
}

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.35, ease: 'easeOut' },
  }),
};

export function PortfolioSummary({ stats }: PortfolioSummaryProps) {
  const isPositive = stats.totalPnl >= 0;

  const cards = [
    {
      label: 'Total Value',
      value: formatCurrency(stats.totalValue),
      icon: Layers,
      color: 'text-slate-300',
      bg: 'bg-slate-900 border border-white/8',
    },
    {
      label: 'Total P&L',
      value: `${isPositive ? '+' : ''}${formatCurrency(stats.totalPnl)}`,
      sub: formatPercent(stats.totalPnlPercent),
      icon: isPositive ? TrendingUp : TrendingDown,
      color: isPositive ? 'text-emerald-300' : 'text-rose-300',
      bg: 'bg-slate-900 border border-white/8',
    },
    {
      label: 'Open Positions',
      value: stats.openPositions.toString(),
      icon: Target,
      color: 'text-slate-300',
      bg: 'bg-slate-900 border border-white/8',
    },
    {
      label: 'Cost Basis',
      value: formatCurrency(stats.totalCost),
      icon: Layers,
      color: 'text-slate-300',
      bg: 'bg-slate-900 border border-white/8',
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card, i) => (
        <motion.div
          key={card.label}
          custom={i}
          initial="hidden"
          animate="visible"
          variants={cardVariants}
          className="rounded-2xl border border-white/8 bg-slate-950/85 p-5"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              {card.label}
            </span>
            <div
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg',
                card.bg
              )}
            >
              <card.icon className={cn('h-4 w-4', card.color)} />
            </div>
          </div>
          <div className="text-xl font-bold text-white">
            {card.value}
          </div>
          {card.sub && (
            <div
              className={cn(
                'mt-1 text-sm font-medium',
                isPositive ? 'text-emerald-300' : 'text-rose-300'
              )}
            >
              {card.sub}
            </div>
          )}
        </motion.div>
      ))}
    </div>
  );
}
