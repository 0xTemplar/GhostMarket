'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Clock,
  Users,
  BarChart3,
  Droplets,
  Shield,
  ExternalLink,
  Flame,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { mockMarkets } from '@/data/markets';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatPill } from '@/components/stat-pill';
import { AreaChart } from '@/components/area-chart';
import { useBetSlip } from '@/components/bet-slip-provider';
import {
  formatVolume,
  formatDate,
  formatTimeRemaining,
  formatTraders,
  formatPercent,
  cn,
} from '@/lib/utils';

export default function MarketDetailPage() {
  const params = useParams();
  const { openBetSlip } = useBetSlip();
  const market = mockMarkets.find((m) => m.id === params.id);

  if (!market) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-20 text-center">
        <h2 className="font-heading text-xl font-bold text-text mb-2">
          Market not found
        </h2>
        <p className="text-text-muted mb-6">
          This market doesn&apos;t exist or has been removed.
        </p>
        <Link href="/">
          <Button variant="outline">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Markets
          </Button>
        </Link>
      </div>
    );
  }

  const yesPct = Math.round(market.yesPrice * 100);
  const noPct = 100 - yesPct;
  const isPositiveChange = market.change24h >= 0;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
      >
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text transition-colors mb-6 group"
        >
          <ArrowLeft className="h-4 w-4 group-hover:-translate-x-0.5 transition-transform" />
          Back to Markets
        </Link>

        <div className="flex items-center gap-2 flex-wrap mb-3">
          <Badge variant="primary">{market.category}</Badge>
          <Badge
            variant="default"
            className="capitalize"
          >
            {market.status}
          </Badge>
          {market.trending && (
            <Badge variant="trending">
              <Flame className="mr-1 h-3 w-3" />
              Trending
            </Badge>
          )}
          <div
            className={cn(
              'flex items-center gap-1 text-xs font-medium',
              isPositiveChange ? 'text-yes' : 'text-no'
            )}
          >
            {isPositiveChange ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {formatPercent(market.change24h)} 24h
          </div>
        </div>

        <h1 className="font-heading text-2xl sm:text-3xl font-bold tracking-tight text-text mb-3 max-w-3xl">
          {market.title}
        </h1>

        <p className="text-text-secondary leading-relaxed max-w-2xl mb-8">
          {market.description}
        </p>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatPill
                label="Volume"
                value={formatVolume(market.volume)}
              />
              <StatPill
                label="Liquidity"
                value={formatVolume(market.liquidity)}
              />
              <StatPill
                label="Traders"
                value={formatTraders(market.tradersCount)}
              />
              <StatPill
                label="Time Left"
                value={formatTimeRemaining(market.expiryAt)}
              />
            </div>

            <div className="rounded-2xl border border-border bg-card p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-heading text-sm font-semibold text-text">
                  Price History
                </h3>
                <div className="flex items-center gap-4 text-xs text-text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-yes" />
                    YES
                  </span>
                  <span>30 day</span>
                </div>
              </div>
              <AreaChart data={market.priceHistory} height={220} />
            </div>

            <div className="rounded-2xl border border-border bg-card p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              <h3 className="font-heading text-sm font-semibold text-text mb-4">
                Market Details
              </h3>
              <div className="space-y-3">
                <div className="flex items-start justify-between py-2 border-b border-border/60">
                  <span className="text-sm text-text-muted flex items-center gap-2">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Resolution Source
                  </span>
                  <span className="text-sm font-medium text-text text-right">
                    {market.resolutionSource}
                  </span>
                </div>
                <div className="flex items-start justify-between py-2 border-b border-border/60">
                  <span className="text-sm text-text-muted flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5" />
                    Expiry Date
                  </span>
                  <span className="text-sm font-medium text-text">
                    {formatDate(market.expiryAt)}
                  </span>
                </div>
                <div className="flex items-start justify-between py-2 border-b border-border/60">
                  <span className="text-sm text-text-muted flex items-center gap-2">
                    <BarChart3 className="h-3.5 w-3.5" />
                    Volume
                  </span>
                  <span className="text-sm font-medium text-text">
                    {formatVolume(market.volume)}
                  </span>
                </div>
                <div className="flex items-start justify-between py-2 border-b border-border/60">
                  <span className="text-sm text-text-muted flex items-center gap-2">
                    <Droplets className="h-3.5 w-3.5" />
                    Liquidity
                  </span>
                  <span className="text-sm font-medium text-text">
                    {formatVolume(market.liquidity)}
                  </span>
                </div>
                <div className="flex items-start justify-between py-2">
                  <span className="text-sm text-text-muted flex items-center gap-2">
                    <Users className="h-3.5 w-3.5" />
                    Traders
                  </span>
                  <span className="text-sm font-medium text-text">
                    {market.tradersCount.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-1">
            <div className="sticky top-24">
              <div className="rounded-2xl border border-border bg-card p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <h3 className="font-heading text-sm font-semibold text-text mb-4">
                  Trade
                </h3>

                <div className="grid grid-cols-2 gap-3 mb-5">
                  <div className="rounded-xl border-2 border-yes/20 bg-yes-soft p-4 text-center">
                    <div className="text-xs font-medium text-yes/70 uppercase tracking-wide mb-1">
                      Yes
                    </div>
                    <div className="font-mono text-2xl font-bold text-yes">
                      {yesPct}¢
                    </div>
                  </div>
                  <div className="rounded-xl border-2 border-no/20 bg-no-soft p-4 text-center">
                    <div className="text-xs font-medium text-no/70 uppercase tracking-wide mb-1">
                      No
                    </div>
                    <div className="font-mono text-2xl font-bold text-no">
                      {noPct}¢
                    </div>
                  </div>
                </div>

                <div className="w-full h-2 rounded-full bg-no/15 mb-5 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-yes to-yes/80 transition-all"
                    style={{ width: `${yesPct}%` }}
                  />
                </div>

                <div className="space-y-2">
                  <Button
                    variant="yes"
                    size="lg"
                    className="w-full font-heading"
                    onClick={() => openBetSlip(market, 'YES')}
                  >
                    <Shield className="mr-2 h-4 w-4" />
                    Buy Yes — {yesPct}¢
                  </Button>
                  <Button
                    variant="no"
                    size="lg"
                    className="w-full font-heading"
                    onClick={() => openBetSlip(market, 'NO')}
                  >
                    <Shield className="mr-2 h-4 w-4" />
                    Buy No — {noPct}¢
                  </Button>
                </div>

                <div className="mt-4 flex items-start gap-2 rounded-lg bg-primary-soft/50 p-3">
                  <Shield className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-primary/80 leading-relaxed">
                    Orders are shielded — position size and intent are encrypted
                    before execution on the eAMM.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
