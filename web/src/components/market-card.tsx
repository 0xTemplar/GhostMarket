'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Users, Clock, Flame } from 'lucide-react';
import type { Market } from '@/types/market';
import { formatVolume, formatTimeRemaining, formatTraders } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { MiniChart } from '@/components/mini-chart';
import { useBetSlip } from '@/components/bet-slip-provider';

interface MarketCardProps {
  market: Market;
  index?: number;
}

export function MarketCard({ market, index = 0 }: MarketCardProps) {
  const { openBetSlip } = useBetSlip();
  const yesPct = Math.round(market.yesPrice * 100);
  const noPct = 100 - yesPct;
  const isPositiveChange = market.change24h >= 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05, ease: 'easeOut' }}
    >
      <Link
        href={`/markets/${market.id}`}
        className="group block rounded-2xl border border-border bg-card p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-all duration-200 hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)] hover:border-border-hover hover:-translate-y-0.5"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default">{market.category}</Badge>
            {market.trending && (
              <Badge variant="trending">
                <Flame className="mr-1 h-3 w-3" />
                Hot
              </Badge>
            )}
          </div>
          <MiniChart
            data={market.priceHistory.slice(-10)}
            positive={isPositiveChange}
            width={64}
            height={28}
          />
        </div>

        <h3 className="font-heading text-[15px] font-semibold leading-snug text-text mb-4 line-clamp-2 group-hover:text-primary transition-colors">
          {market.title}
        </h3>

        <div className="flex gap-2 mb-4">
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openBetSlip(market, 'YES');
            }}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border-2 border-yes/20 bg-yes-soft py-2 text-sm font-semibold text-yes transition-all hover:border-yes/40 hover:bg-yes/10 cursor-pointer"
          >
            Yes {yesPct}¢
          </button>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openBetSlip(market, 'NO');
            }}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border-2 border-no/20 bg-no-soft py-2 text-sm font-semibold text-no transition-all hover:border-no/40 hover:bg-no/10 cursor-pointer"
          >
            No {noPct}¢
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-text-muted">
          <div className="flex items-center gap-3">
            <span className="font-medium text-text-secondary">
              {formatVolume(market.volume)} vol
            </span>
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {formatTraders(market.tradersCount)}
            </span>
          </div>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatTimeRemaining(market.expiryAt)}
          </span>
        </div>
      </Link>
    </motion.div>
  );
}
