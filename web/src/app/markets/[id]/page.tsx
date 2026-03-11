'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Clock, Users, BarChart3, Droplets, Shield, ExternalLink,
  Flame, TrendingUp, TrendingDown, Loader2, AlertCircle, RefreshCw, Lock,
} from 'lucide-react';
import { mockMarkets } from '@/data/markets';
import type { Market } from '@/types/market';
import { StatPill } from '@/components/stat-pill';
import { AreaChart } from '@/components/area-chart';
import { useBetSlip } from '@/components/bet-slip-provider';
import {
  formatVolume, formatDate, formatTimeRemaining, formatTraders,
  formatPercent, cn,
} from '@/lib/utils';
import {
  readMarket, toFrontendMarket, type OnChainMarket,
  claimWinnings, claimRefund, readUserPosition, readIsRefundEligible,
} from '@/lib/flow/market';
import {
  readEammPositionHandles, readEammMarketMeta, isEammDeployed,
} from '@/lib/flow/eamm';
import { readLockedAmount } from '@/lib/flow/vault';
import { useFlowAuth, useFlowWalletClient } from '@/lib/flow/provider';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isNumericId(id: string): boolean {
  return /^\d+$/.test(id);
}

const FLOWSCAN = 'https://evm-testnet.flowscan.io';

// ─── On-chain market actions panel ───────────────────────────────────────────

function OnChainActions({
  market,
  raw,
}: {
  market: Market;
  raw: OnChainMarket;
}) {
  const { user } = useFlowAuth();
  const walletClient = useFlowWalletClient();
  const [posLoading, setPosLoading] = useState(false);
  const [userPos, setUserPos] = useState<{ yes: string; no: string; claimed: boolean } | null>(null);
  const [refundEligible, setRefundEligible] = useState(false);
  const [shieldedPos, setShieldedPos] = useState<{
    hasYes: boolean;
    hasNo: boolean;
    locked: string;   // FLOW locked as collateral in GhostVault
    side: string;     // 'YES' | 'NO' | 'YES + NO'
  } | null>(null);
  const [actionState, setActionState] = useState<
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'success'; hash: string }
    | { phase: 'error'; msg: string }
  >({ phase: 'idle' });

  const loadPosition = useCallback(async () => {
    if (!user.evmAddress) return;
    setPosLoading(true);
    try {
      const addr = user.evmAddress as `0x${string}`;
      const zero = '0x' + '0'.repeat(64);

      const [pos, eligible, handles, locked] = await Promise.all([
        readUserPosition(raw.id, addr),
        readIsRefundEligible(raw.id),
        isEammDeployed()
          ? readEammPositionHandles(raw.id, addr).catch(() => null)
          : Promise.resolve(null),
        isEammDeployed()
          ? readLockedAmount(addr, raw.id)
          : Promise.resolve('0'),
      ]);

      if (pos) {
        setUserPos({
          yes: pos.yesAmount > 0n
            ? `YES: ${(Number(pos.yesAmount) / 1e18).toFixed(4)} FLOW`
            : '',
          no: pos.noAmount > 0n
            ? `NO: ${(Number(pos.noAmount) / 1e18).toFixed(4)} FLOW`
            : '',
          claimed: pos.claimed,
        });
      }

      if (handles) {
        const hasYes = handles.yesHandle !== zero;
        const hasNo  = handles.noHandle  !== zero;
        if (hasYes || hasNo) {
          const side = hasYes && hasNo ? 'YES + NO' : hasYes ? 'YES' : 'NO';
          setShieldedPos({ hasYes, hasNo, locked, side });
        }
      }

      setRefundEligible(eligible);
    } finally {
      setPosLoading(false);
    }
  }, [user.evmAddress, raw.id]);

  useEffect(() => { loadPosition(); }, [loadPosition]);

  const handleClaim = async () => {
    if (!walletClient) return;
    setActionState({ phase: 'loading' });
    try {
      const hash =
        raw.status === 1
          ? await claimWinnings(walletClient, raw.id)
          : await claimRefund(walletClient, raw.id);

      const { publicClient } = await import('@/lib/flow/vault');
      await publicClient.waitForTransactionReceipt({ hash });
      setActionState({ phase: 'success', hash });
      await loadPosition();
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message.includes('User rejected')
            ? 'Rejected.'
            : err.message.slice(0, 120)
          : 'Failed.';
      setActionState({ phase: 'error', msg });
    }
  };

  if (!user.loggedIn) return null;

  const canClaim =
    !userPos?.claimed &&
    (raw.status === 1 || refundEligible) &&
    (userPos?.yes || userPos?.no);

  return (
    <div className="rounded-2xl border border-white/5 bg-slate-900 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-white">Your Position</h3>

      {posLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : userPos?.yes || userPos?.no || shieldedPos ? (
        <div className="space-y-3">
          {/* Public on-chain position */}
          {(userPos?.yes || userPos?.no) && (
            <div className="space-y-2">
              {userPos!.yes && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-slate-300 font-mono">{userPos!.yes}</span>
                </div>
              )}
              {userPos!.no && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                  <span className="text-slate-300 font-mono">{userPos!.no}</span>
                </div>
              )}
              {userPos!.claimed && (
                <p className="text-xs text-emerald-400">✓ Claimed</p>
              )}
            </div>
          )}

          {/* Shielded position on GhostEAMM */}
          {shieldedPos && (
            <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <Lock className="h-3.5 w-3.5 text-indigo-400" />
                <span className="text-xs font-semibold text-indigo-400 uppercase tracking-wide">
                  Shielded ({shieldedPos.side})
                </span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Bet amount is FHE-encrypted on the eAMM — exact size is private.
              </p>
              {parseFloat(shieldedPos.locked) > 0 && (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500">Collateral locked:</span>
                  <span className="font-mono text-amber-400">{parseFloat(shieldedPos.locked).toFixed(4)} FLOW</span>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No position yet.</p>
      )}

      {canClaim && (
        <div className="pt-2 border-t border-white/5">
          {actionState.phase === 'success' ? (
            <div className="space-y-2">
              <p className="text-sm text-emerald-400">✓ Claimed successfully</p>
              <a
                href={`${FLOWSCAN}/tx/${actionState.hash}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View on Flowscan
              </a>
            </div>
          ) : actionState.phase === 'error' ? (
            <div className="space-y-2">
              <p className="text-xs text-rose-400">{actionState.msg}</p>
              <button
                onClick={() => setActionState({ phase: 'idle' })}
                className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            </div>
          ) : (
            <button
              onClick={handleClaim}
              disabled={actionState.phase === 'loading'}
              className="w-full h-10 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              {actionState.phase === 'loading' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Processing…
                </>
              ) : raw.status === 1 ? (
                'Claim Winnings'
              ) : (
                'Claim Refund'
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MarketDetailPage() {
  const params     = useParams();
  const id         = typeof params.id === 'string' ? params.id : '';
  const { openBetSlip } = useBetSlip();

  const [market,    setMarket]    = useState<Market | null>(null);
  const [rawMarket, setRawMarket] = useState<OnChainMarket | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      if (isNumericId(id)) {
        // On-chain market — read from contract
        try {
          const raw = await readMarket(Number(id));
          if (cancelled) return;
          if (!raw) {
            setError('Market not found on-chain.');
          } else {
            setRawMarket(raw);
            setMarket(toFrontendMarket(raw));
          }
        } catch {
          if (!cancelled) setError('Failed to load market data.');
        }
      } else {
        // Mock market
        const found = mockMarkets.find((m) => m.id === id);
        if (!cancelled) {
          if (found) setMarket(found);
          else setError('Market not found.');
        }
      }
      if (!cancelled) setLoading(false);
    };

    load();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-40">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  if (error || !market) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-20 text-center">
        <AlertCircle className="mx-auto mb-4 h-10 w-10 text-slate-600" />
        <h2 className="text-xl font-bold text-white mb-2">Market not found</h2>
        <p className="text-slate-500 mb-6">{error ?? 'This market does not exist or has been removed.'}</p>
        <Link href="/">
          <button className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-white/10 bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Back to Markets
          </button>
        </Link>
      </div>
    );
  }

  const yesPct  = Math.round(market.yesPrice * 100);
  const noPct   = 100 - yesPct;
  const isPositiveChange = market.change24h >= 0;
  const statusMap: Record<string, string> = {
    active: 'Active', resolved: 'Resolved', disputed: 'Disputed', pending: 'Pending',
  };
  const canBet = market.status === 'active';

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
              <img src={market.image} alt="" className="w-full h-full object-cover" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-500/10 text-indigo-400">
                {market.category}
              </span>
              <span className={cn(
                'px-2.5 py-1 rounded-lg text-xs font-medium capitalize',
                market.status === 'active'   ? 'bg-emerald-500/10 text-emerald-400' :
                market.status === 'resolved' ? 'bg-slate-700 text-slate-300' :
                market.status === 'disputed' ? 'bg-amber-500/10 text-amber-400' :
                'bg-white/5 text-slate-400'
              )}>
                {statusMap[market.status] ?? market.status}
              </span>
              {rawMarket && (
                <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white/5 text-slate-400">
                  Market #{rawMarket.id}
                </span>
              )}
              {market.trending && (
                <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-orange-500/10 text-orange-400">
                  <Flame className="inline mr-1 h-3 w-3" />
                  Trending
                </span>
              )}
              {market.change24h !== 0 && (
                <div className={cn(
                  'flex items-center gap-1 text-xs font-medium',
                  isPositiveChange ? 'text-yes' : 'text-no'
                )}>
                  {isPositiveChange
                    ? <TrendingUp className="h-3 w-3" />
                    : <TrendingDown className="h-3 w-3" />}
                  {formatPercent(market.change24h)} 24h
                </div>
              )}
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
          {/* Left column */}
          <div className="lg:col-span-2 space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatPill label="Volume"   value={formatVolume(market.volume)} />
              <StatPill label="Liquidity" value={formatVolume(market.liquidity)} />
              <StatPill label="Traders"  value={rawMarket ? '—' : formatTraders(market.tradersCount)} />
              <StatPill label="Time Left" value={formatTimeRemaining(market.expiryAt)} />
            </div>

            <div className="rounded-2xl border border-white/5 bg-slate-900 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white">Price History</h3>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-yes" />
                    YES
                  </span>
                  {rawMarket
                    ? <span className="text-slate-600 italic">Live from contract</span>
                    : <span>30 day</span>
                  }
                </div>
              </div>
              <AreaChart data={market.priceHistory} height={220} />
            </div>

            <div className="rounded-2xl border border-white/5 bg-slate-900 p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Market Details</h3>
              <div className="space-y-3">
                <div className="flex items-start justify-between py-2 border-b border-white/5">
                  <span className="text-sm text-slate-500 flex items-center gap-2">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Resolution Source
                  </span>
                  <span className="text-sm font-medium text-white text-right max-w-[60%]">
                    {market.resolutionSource}
                  </span>
                </div>
                <div className="flex items-start justify-between py-2 border-b border-white/5">
                  <span className="text-sm text-slate-500 flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5" />
                    Expiry Date
                  </span>
                  <span className="text-sm font-medium text-white">
                    {formatDate(market.expiryAt)}
                  </span>
                </div>
                <div className="flex items-start justify-between py-2 border-b border-white/5">
                  <span className="text-sm text-slate-500 flex items-center gap-2">
                    <BarChart3 className="h-3.5 w-3.5" />
                    Total Pooled
                  </span>
                  <span className="text-sm font-medium text-white">
                    {rawMarket
                      ? `${(Number(rawMarket.yesPool + rawMarket.noPool) / 1e18).toFixed(4)} FLOW`
                      : formatVolume(market.volume)
                    }
                  </span>
                </div>
                {rawMarket && (
                  <div className="flex items-start justify-between py-2 border-b border-white/5">
                    <span className="text-sm text-slate-500 flex items-center gap-2">
                      <Droplets className="h-3.5 w-3.5" />
                      YES / NO Pool
                    </span>
                    <span className="text-sm font-medium text-white font-mono">
                      {(Number(rawMarket.yesPool) / 1e18).toFixed(4)} /&nbsp;
                      {(Number(rawMarket.noPool)  / 1e18).toFixed(4)} FLOW
                    </span>
                  </div>
                )}
                {rawMarket && (
                  <div className="flex items-start justify-between py-2">
                    <span className="text-sm text-slate-500 flex items-center gap-2">
                      <Users className="h-3.5 w-3.5" />
                      Creator
                    </span>
                    <a
                      href={`${FLOWSCAN}/address/${rawMarket.creator}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-indigo-400 hover:text-indigo-300 font-mono transition-colors"
                    >
                      {`${rawMarket.creator.slice(0, 6)}…${rawMarket.creator.slice(-4)}`}
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="lg:col-span-1">
            <div className="sticky top-24 space-y-4">
              {/* Trade panel */}
              <div className="rounded-2xl border border-white/5 bg-slate-900 p-5">
                <h3 className="text-sm font-semibold text-white mb-4">Trade</h3>

                <div className="grid grid-cols-2 gap-3 mb-5">
                  <div className="rounded-xl border-2 border-emerald-500/20 bg-emerald-500/10 p-4 text-center">
                    <div className="text-xs font-medium text-emerald-400/70 uppercase tracking-wide mb-1">Yes</div>
                    <div className="font-mono text-2xl font-bold text-emerald-500">{yesPct}¢</div>
                  </div>
                  <div className="rounded-xl border-2 border-rose-500/20 bg-rose-500/10 p-4 text-center">
                    <div className="text-xs font-medium text-rose-400/70 uppercase tracking-wide mb-1">No</div>
                    <div className="font-mono text-2xl font-bold text-rose-500">{noPct}¢</div>
                  </div>
                </div>

                <div className="w-full h-2 rounded-full bg-rose-500/15 mb-5 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-500/80 transition-all duration-500"
                    style={{ width: `${yesPct}%` }}
                  />
                </div>

                {canBet ? (
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
                ) : (
                  <div className="rounded-lg border border-white/10 bg-slate-800 p-4 text-center">
                    <p className="text-sm text-slate-400">
                      {market.status === 'resolved'
                        ? `Market resolved — ${rawMarket?.outcome ? 'YES' : 'NO'} won.`
                        : 'This market is no longer accepting orders.'}
                    </p>
                  </div>
                )}

                <div className="mt-4 flex items-start gap-2 rounded-lg bg-indigo-500/10 p-3">
                  <Shield className="h-4 w-4 text-indigo-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-indigo-300 leading-relaxed">
                    Orders are shielded — position size and intent are FHE-encrypted before execution on the eAMM.
                  </p>
                </div>
              </div>

              {/* User position + claim panel (on-chain only) */}
              {rawMarket && <OnChainActions market={market} raw={rawMarket} />}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
