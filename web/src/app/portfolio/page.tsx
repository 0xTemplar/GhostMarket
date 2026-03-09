'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  ArrowRight, Ghost, Loader2, ExternalLink, Clock, ArrowUpRight,
  RefreshCw, Shield,
} from 'lucide-react';
import { mockPositions, mockPortfolioStats } from '@/data/markets';
import { PortfolioSummary } from '@/components/portfolio-summary';
import { PortfolioPositionRow } from '@/components/portfolio-position-row';
import { useFlowAuth } from '@/lib/flow/provider';
import {
  readAllMarkets, readUserPosition, isMarketDeployed,
  type OnChainMarket,
} from '@/lib/flow/market';
import { formatTimeRemaining, cn } from '@/lib/utils';

// ─── On-chain position type ───────────────────────────────────────────────────

interface OnChainPosition {
  market: OnChainMarket;
  yesFlow: number;   // FLOW staked on YES
  noFlow: number;    // FLOW staked on NO
  claimed: boolean;
  dominantSide: 'YES' | 'NO' | 'BOTH';
  currentYesPricePct: number; // 0–100
}

const STATUS_LABEL: Record<number, string> = {
  0: 'Active',
  1: 'Resolved',
  2: 'Disputed',
  3: 'Cancelled',
};

const STATUS_STYLE: Record<number, string> = {
  0: 'bg-emerald-500/10 text-emerald-400',
  1: 'bg-slate-700 text-slate-300',
  2: 'bg-amber-500/10 text-amber-400',
  3: 'bg-rose-500/10 text-rose-400',
};

// ─── Individual on-chain position card ───────────────────────────────────────

function OnChainPositionRow({
  pos,
  index,
}: {
  pos: OnChainPosition;
  index: number;
}) {
  const totalFlow = pos.yesFlow + pos.noFlow;
  const expiryIso = new Date(pos.market.expiryAt * 1000).toISOString();
  const resolved  = pos.market.status === 1;
  const won =
    resolved &&
    ((pos.market.outcome && pos.yesFlow > 0) ||
      (!pos.market.outcome && pos.noFlow > 0));

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.3, ease: 'easeOut' }}
    >
      <Link
        href={`/markets/${pos.market.id}`}
        className="group block rounded-2xl border border-white/5 bg-slate-900 p-5 transition-all duration-200 hover:border-white/10"
      >
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {pos.yesFlow > 0 && (
                <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/10 text-emerald-500">
                  YES
                </span>
              )}
              {pos.noFlow > 0 && (
                <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-rose-500/10 text-rose-500">
                  NO
                </span>
              )}
              <span className={cn(
                'px-2.5 py-1 rounded-lg text-xs font-medium',
                STATUS_STYLE[pos.market.status]
              )}>
                {STATUS_LABEL[pos.market.status]}
              </span>
              {resolved && won && !pos.claimed && (
                <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  Claim available
                </span>
              )}
              {pos.claimed && (
                <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-700 text-slate-400">
                  Claimed
                </span>
              )}
              <span className="flex items-center gap-1 text-xs text-slate-500">
                <Clock className="h-3 w-3" />
                {formatTimeRemaining(expiryIso)}
              </span>
            </div>
            <h3 className="text-[15px] font-semibold text-white truncate group-hover:text-indigo-400 transition-colors">
              {pos.market.title}
            </h3>
          </div>

          <div className="flex items-center gap-6 sm:gap-8 sm:text-right shrink-0">
            <div>
              <div className="text-xs text-slate-500 mb-0.5">YES Price</div>
              <div className="font-mono text-sm font-medium text-white">
                {pos.currentYesPricePct}¢
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-0.5">Staked</div>
              <div className="font-mono text-sm font-semibold text-white">
                {totalFlow.toFixed(4)} FLOW
              </div>
            </div>
            {resolved && (
              <div>
                <div className="text-xs text-slate-500 mb-0.5">Outcome</div>
                <div className={cn(
                  'font-mono text-sm font-semibold',
                  won ? 'text-emerald-500' : 'text-rose-500'
                )}>
                  {pos.market.outcome ? 'YES' : 'NO'} won
                </div>
              </div>
            )}
            <ArrowUpRight className="h-4 w-4 text-slate-500 group-hover:text-indigo-400 transition-colors hidden sm:block" />
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PortfolioPage() {
  const { user, isLoading } = useFlowAuth();

  const [onChainPositions, setOnChainPositions] = useState<OnChainPosition[]>([]);
  const [loadingChain, setLoadingChain]         = useState(false);
  const [chainError,   setChainError]           = useState<string | null>(null);

  const fetchOnChainPositions = useCallback(async () => {
    if (!user.evmAddress || !isMarketDeployed()) return;

    setLoadingChain(true);
    setChainError(null);

    try {
      const markets = await readAllMarkets();
      const results: OnChainPosition[] = [];

      await Promise.all(
        markets.map(async (market) => {
          const pos = await readUserPosition(
            market.id,
            user.evmAddress as `0x${string}`,
          );
          if (!pos || (pos.yesAmount === 0n && pos.noAmount === 0n)) return;

          const yesFlow = Number(pos.yesAmount) / 1e18;
          const noFlow  = Number(pos.noAmount)  / 1e18;
          const dominantSide: OnChainPosition['dominantSide'] =
            yesFlow > 0 && noFlow > 0
              ? 'BOTH'
              : yesFlow > 0
              ? 'YES'
              : 'NO';

          results.push({
            market,
            yesFlow,
            noFlow,
            claimed: pos.claimed,
            dominantSide,
            currentYesPricePct: Math.round(market.yesPriceBps / 100),
          });
        }),
      );

      setOnChainPositions(results);
    } catch (err) {
      setChainError('Could not load on-chain positions.');
      console.error(err);
    } finally {
      setLoadingChain(false);
    }
  }, [user.evmAddress]);

  useEffect(() => {
    fetchOnChainPositions();
  }, [fetchOnChainPositions]);

  if (isLoading || user.evmLoading) {
    return (
      <div className="flex items-center justify-center py-40">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  const hasOnChain = onChainPositions.length > 0;
  const hasMock    = mockPositions.length > 0;
  const hasAny     = hasOnChain || hasMock;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Portfolio
          </h1>
          <p className="mt-1.5 text-slate-400 text-sm sm:text-base">
            Your open positions and performance. Exact sizes are shielded.
          </p>
        </div>

        {/* ── Summary (mock only until we have real P&L indexing) ── */}
        {hasMock && (
          <div className="mb-8">
            <PortfolioSummary stats={mockPortfolioStats} />
          </div>
        )}

        {/* ── On-chain positions ── */}
        {user.loggedIn && isMarketDeployed() && (
          <section className="mb-10">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Shield className="h-4 w-4 text-indigo-400" />
                On-Chain Positions
              </h2>
              <button
                onClick={fetchOnChainPositions}
                disabled={loadingChain}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors disabled:opacity-50"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loadingChain && 'animate-spin')} />
                Refresh
              </button>
            </div>

            {loadingChain ? (
              <div className="rounded-2xl border border-white/5 bg-slate-900 p-10 flex items-center justify-center gap-3 text-slate-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Reading on-chain positions…</span>
              </div>
            ) : chainError ? (
              <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-6 text-center text-sm text-rose-400">
                {chainError}
              </div>
            ) : hasOnChain ? (
              <div className="space-y-3">
                {onChainPositions.map((pos, i) => (
                  <OnChainPositionRow key={pos.market.id} pos={pos} index={i} />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900 p-10 text-center">
                <p className="text-sm text-slate-500">
                  No on-chain positions yet.{' '}
                  <Link href="/" className="text-indigo-400 hover:text-indigo-300 transition-colors">
                    Browse live markets →
                  </Link>
                </p>
              </div>
            )}
          </section>
        )}

        {!user.loggedIn && (
          <div className="mb-10 rounded-2xl border border-white/5 bg-slate-900 p-8 text-center">
            <p className="text-slate-400 text-sm mb-1">Sign in to see your on-chain positions.</p>
            <p className="text-slate-600 text-xs">Positions are linked to your embedded wallet address.</p>
          </div>
        )}

        {/* ── Mock positions (Phase 1 demo data) ── */}
        {hasMock && (
          <section>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">
                Demo Positions
              </h2>
              <span className="text-xs px-2 py-1 rounded-full bg-white/5 text-slate-500">
                Phase 1 mock data
              </span>
            </div>
            <div className="space-y-3">
              {mockPositions.map((position, i) => (
                <PortfolioPositionRow key={position.id} position={position} index={i} />
              ))}
            </div>
          </section>
        )}

        {!hasAny && !loadingChain && (
          <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900 p-16 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/10">
              <Ghost className="h-7 w-7 text-indigo-400" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">No positions yet</h3>
            <p className="text-sm text-slate-500 mb-6 max-w-sm mx-auto">
              Browse active markets and place your first shielded prediction to get started.
            </p>
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-full bg-indigo-500 hover:bg-indigo-400 px-5 py-2.5 text-sm font-semibold text-white transition-colors"
            >
              Browse Markets
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        )}
      </motion.div>
    </div>
  );
}
