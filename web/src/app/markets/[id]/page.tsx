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
        <h2 className="text-xl font-bold text-white mb-2">Market not found</h2>
        <p className="text-slate-500 mb-6">
          This market doesn&apos;t exist or has been removed.
        </p>
        <Link href="/">
          <button className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-white/10 bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Back to Markets
          </button>
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
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-white transition-colors mb-6 group"
        >
          <ArrowLeft className="h-4 w-4 group-hover:-translate-x-0.5 transition-transform" />
          Back to Markets
        </Link>

        <div className="flex items-start gap-4 mb-4">
          {market.image && (
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl overflow-hidden shrink-0 border border-white/10 bg-slate-800">
              <img
                src={market.image}
                alt=""
                className="w-full h-full object-cover"
              />
            </div>
          )}
          <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-500/10 text-indigo-400">
            {market.category}
          </span>
          <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white/5 text-slate-400 capitalize">
            {market.status}
          </span>
          {market.trending && (
            <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/10 text-emerald-500">
              <Flame className="inline mr-1 h-3 w-3" />
              Trending
            </span>
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

        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-3 max-w-3xl">
          {market.title}
        </h1>

        <p className="text-slate-400 leading-relaxed max-w-2xl mb-8">
          {market.description}
        </p>
          </div>
        </div>

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

            <div className="rounded-2xl border border-white/5 bg-slate-900 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white">
                  Price History
                </h3>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-yes" />
                    YES
                  </span>
                  <span>30 day</span>
                </div>
              </div>
              <AreaChart data={market.priceHistory} height={220} />
            </div>

            <div className="rounded-2xl border border-white/5 bg-slate-900 p-5">
              <h3 className="text-sm font-semibold text-white mb-4">
                Market Details
              </h3>
              <div className="space-y-3">
                <div className="flex items-start justify-between py-2 border-b border-white/5">
                  <span className="text-sm text-slate-500 flex items-center gap-2">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Resolution Source
                  </span>
                  <span className="text-sm font-medium text-white text-right">
                    {market.resolutionSource}
                  </span>
                </div>
                <div className="flex items-start justify-between py-2 border-b border-border/60">
                  <span className="text-sm text-slate-500 flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5" />
                    Expiry Date
                  </span>
                  <span className="text-sm font-medium text-white">
                    {formatDate(market.expiryAt)}
                  </span>
                </div>
                <div className="flex items-start justify-between py-2 border-b border-border/60">
                  <span className="text-sm text-slate-500 flex items-center gap-2">
                    <BarChart3 className="h-3.5 w-3.5" />
                    Volume
                  </span>
                  <span className="text-sm font-medium text-white">
                    {formatVolume(market.volume)}
                  </span>
                </div>
                <div className="flex items-start justify-between py-2 border-b border-border/60">
                  <span className="text-sm text-slate-500 flex items-center gap-2">
                    <Droplets className="h-3.5 w-3.5" />
                    Liquidity
                  </span>
                  <span className="text-sm font-medium text-white">
                    {formatVolume(market.liquidity)}
                  </span>
                </div>
                <div className="flex items-start justify-between py-2">
                  <span className="text-sm text-slate-500 flex items-center gap-2">
                    <Users className="h-3.5 w-3.5" />
                    Traders
                  </span>
                  <span className="text-sm font-medium text-white">
                    {market.tradersCount.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-1">
            <div className="sticky top-24">
              <div className="rounded-2xl border border-white/5 bg-slate-900 p-5">
                <h3 className="text-sm font-semibold text-white mb-4">
                  Trade
                </h3>

                <div className="grid grid-cols-2 gap-3 mb-5">
                  <div className="rounded-xl border-2 border-emerald-500/20 bg-emerald-500/10 p-4 text-center">
                    <div className="text-xs font-medium text-emerald-400/70 uppercase tracking-wide mb-1">
                      Yes
                    </div>
                    <div className="font-mono text-2xl font-bold text-emerald-500">
                      {yesPct}¢
                    </div>
                  </div>
                  <div className="rounded-xl border-2 border-rose-500/20 bg-rose-500/10 p-4 text-center">
                    <div className="text-xs font-medium text-rose-400/70 uppercase tracking-wide mb-1">
                      No
                    </div>
                    <div className="font-mono text-2xl font-bold text-rose-500">
                      {noPct}¢
                    </div>
                  </div>
                </div>

                <div className="w-full h-2 rounded-full bg-rose-500/15 mb-5 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-500/80 transition-all"
                    style={{ width: `${yesPct}%` }}
                  />
                </div>

                <div className="space-y-2">
                  <button
                    onClick={() => openBetSlip(market, 'YES')}
                    className="w-full h-12 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white font-semibold flex items-center justify-center gap-2 transition-colors"
                  >
                    <Shield className="h-4 w-4" />
                    Buy Yes — {yesPct}¢
                  </button>
                  <button
                    onClick={() => openBetSlip(market, 'NO')}
                    className="w-full h-12 rounded-lg bg-rose-500 hover:bg-rose-400 text-white font-semibold flex items-center justify-center gap-2 transition-colors"
                  >
                    <Shield className="h-4 w-4" />
                    Buy No — {noPct}¢
                  </button>
                </div>

                <div className="mt-4 flex items-start gap-2 rounded-lg bg-indigo-500/10 p-3">
                  <Shield className="h-4 w-4 text-indigo-400 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-indigo-300 leading-relaxed">
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
