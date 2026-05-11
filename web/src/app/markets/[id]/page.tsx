'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, useCallback, useRef } from 'react';
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
  readMarket, type FrontendMarket,
} from '@/lib/market';
import {
  readEammPositionHandles, readEammMarketMeta, isEammDeployed,
  readActiveWindow, subscribePriceRevealed, subscribeSealedWindowOpened,
  type SealedWindowInfo, type PriceRevealedEvent,
} from '@/lib/eamm';
import { SealedCountdown } from '@/components/sealed-countdown';
import {
  readLockedAmountHandle, readIsMarketResolved,
  GHOST_VAULT_ADDRESS, publicClient,
} from '@/lib/vault';
import { useFlowAuth, useFlowWalletClient } from '@/lib/flow/provider';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isNumericId(id: string): boolean {
  return /^\d+$/.test(id);
}

type ActivityItem = {
  user: string;
  side: 'YES' | 'NO';
  priceCents: number;
  amount: string;
  minsAgo: number;
};

const ETHERSCAN = 'https://sepolia.etherscan.io';

function buildRecentActivity(market: Market): ActivityItem[] {
  const yesPct = Math.round(market.yesPrice * 100);
  const baseTrade = Math.max(40, Math.round(market.liquidity / 12000));
  const users = ['0x7a3f…', '0x9c1a…', 'alexa', 'mori', '0x5b2d…', 'taro'];
  const minuteOffsets = [2, 5, 9, 13, 18, 26];

  return minuteOffsets.map((minsAgo, i) => {
    const swing = (i % 3) - 1; // -1, 0, +1
    const side: 'YES' | 'NO' = i % 2 === 0 ? 'YES' : 'NO';
    const priceCents = side === 'YES'
      ? Math.min(99, Math.max(1, yesPct + swing))
      : Math.min(99, Math.max(1, 100 - yesPct + swing));

    return {
      user: users[i % users.length],
      side,
      priceCents,
      amount: `$${(baseTrade + i * 12).toLocaleString()}`,
      minsAgo,
    };
  });
}

// ─── On-chain market actions panel ───────────────────────────────────────────

// USDC has 6 decimals. Format base units to a 2-decimal display string.
function fmtUsdc(baseUnits: string): string {
  return (parseFloat(baseUnits) / 1e6).toFixed(2);
}

function OnChainActions({
  raw,
}: {
  market: Market;
  raw: FrontendMarket;
}) {
  const { user } = useFlowAuth();
  const walletClient = useFlowWalletClient();
  const [posLoading, setPosLoading] = useState(false);
  const [shieldedPos, setShieldedPos] = useState<{
    hasYes: boolean; hasNo: boolean;
    locked: string;       // USDC base units as string
    side: string;
    computedPayout: string; // USDC base units as string
    vaultResolved: boolean;
  } | null>(null);
  const [actionState, setActionState] = useState<
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'success'; hash: string; label?: string }
    | { phase: 'error'; msg: string }
  >({ phase: 'idle' });

  const marketIdBytes32 = ('0x' + BigInt(raw.id).toString(16).padStart(64, '0')) as `0x${string}`;

  const loadPosition = useCallback(async () => {
    if (!user.evmAddress) return;
    setPosLoading(true);
    try {
      const addr = user.evmAddress as `0x${string}`;
      const zero = '0x' + '0'.repeat(64);

      const [handles, lockedHandle, vaultResolved] = await Promise.all([
        isEammDeployed()
          ? readEammPositionHandles(raw.id, addr).catch(() => null)
          : Promise.resolve(null),
        isEammDeployed() ? readLockedAmountHandle(addr, marketIdBytes32) : Promise.resolve('0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`),
        isEammDeployed() ? readIsMarketResolved(marketIdBytes32) : Promise.resolve(false),
      ]);

      if (handles) {
        const hasYes = handles.yesHandle !== zero;
        const hasNo  = handles.noHandle  !== zero;
        if (hasYes || hasNo || (lockedHandle !== '0x0000000000000000000000000000000000000000000000000000000000000000' && lockedHandle !== '0x')) {
          const side = hasYes && hasNo ? 'YES + NO' : hasYes ? 'YES' : hasNo ? 'NO' : '?';
          setShieldedPos({
            hasYes, hasNo,
            locked:         "Encrypted",
            side,
            computedPayout: "Encrypted",
            vaultResolved,
          });
        }
      }
    } finally {
      setPosLoading(false);
    }
  }, [user.evmAddress, raw.id, marketIdBytes32]);

  useEffect(() => {
    loadPosition();
    const interval = setInterval(loadPosition, 15_000);
    return () => clearInterval(interval);
  }, [loadPosition]);

  const handleWithdraw = async (usdcBaseUnits: string) => {
    if (!walletClient || !user.evmAddress) return;
    setActionState({ phase: 'loading' });
    try {
      const { withdrawFromVault } = await import('@/lib/vault');
      const { encryptBetInput } = await import('@/lib/eamm');
      // We can't use hooks here easily, but we can get the provider from walletClient
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const provider = (walletClient as any).transport;
      const encrypted = await encryptBetInput(provider, GHOST_VAULT_ADDRESS, user.evmAddress as `0x${string}`, BigInt(usdcBaseUnits));

      const hash = await withdrawFromVault(walletClient, encrypted.handle, encrypted.inputProof);
      await publicClient.waitForTransactionReceipt({ hash });
      setActionState({ phase: 'success', hash, label: 'Withdrawn to wallet' });
      await loadPosition();
    } catch (err: unknown) {
      const msg = err instanceof Error
        ? err.message.includes('User rejected') ? 'Rejected.' : err.message.slice(0, 120)
        : 'Failed.';
      setActionState({ phase: 'error', msg });
    }
  };

  if (!user.loggedIn) return null;

  // Shielded position settled: payout credited, lock fully released
  const shieldedSettled =
    shieldedPos !== null &&
    shieldedPos.vaultResolved &&
    BigInt(shieldedPos.locked) === 0n;

  // Shielded position awaiting settlement: market resolved but lock still held
  const shieldedPendingSettlement =
    shieldedPos !== null &&
    shieldedPos.vaultResolved &&
    BigInt(shieldedPos.locked) > 0n;

  const shieldedWon =
    shieldedPendingSettlement &&
    BigInt(shieldedPos!.computedPayout) > 0n;

  return (
    <div className="rounded-2xl border border-white/5 bg-slate-900 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Your Position</h3>
        <button
          onClick={loadPosition}
          className="text-slate-600 hover:text-slate-400 transition-colors"
          title="Refresh position"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {posLoading && !shieldedPos ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : shieldedPos ? (
        <div className="space-y-3">
          {/* Active shielded position */}
          {!shieldedSettled && (
            <div className={cn(
              'rounded-lg border p-3 space-y-1.5',
              shieldedPendingSettlement && shieldedWon
                ? 'border-emerald-500/20 bg-emerald-500/5'
                : shieldedPendingSettlement
                ? 'border-rose-500/20 bg-rose-500/5'
                : 'border-indigo-500/20 bg-indigo-500/5',
            )}>
              <div className="flex items-center gap-2">
                <Lock className="h-3.5 w-3.5 text-indigo-400" />
                <span className="text-xs font-semibold text-indigo-400 uppercase tracking-wide">
                  Shielded {shieldedPos.side !== '?' ? `(${shieldedPos.side})` : ''}
                </span>
              </div>

              {shieldedPendingSettlement ? (
                <>
                  {shieldedWon ? (
                    <p className="text-xs text-emerald-300 font-medium">
                      You won! Oracle settling — payout{' '}
                      <span className="font-mono font-bold">
                        {fmtUsdc(shieldedPos.computedPayout)} USDC
                      </span>{' '}
                      will be credited to your vault.
                    </p>
                  ) : (
                    <p className="text-xs text-rose-300">
                      Position resolved — oracle releasing your lock.
                    </p>
                  )}
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-slate-500">Collateral locked:</span>
                    <span className="font-mono text-amber-400">
                      {fmtUsdc(shieldedPos.locked)} USDC
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Bet amount is FHE-encrypted on the eAMM — exact size is private.
                  </p>
                  {BigInt(shieldedPos.locked) > 0n && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-slate-500">Collateral locked:</span>
                      <span className="font-mono text-amber-400">
                        {fmtUsdc(shieldedPos.locked)} USDC
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Settled: lock released, show withdraw CTA */}
          {shieldedSettled && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="text-xs font-semibold text-emerald-300">Position Settled</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Your payout has been credited to your vault balance.
                Withdraw to send USDC to your wallet.
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No position yet.</p>
      )}

      {/* Action buttons */}
      <div className="pt-2 border-t border-white/5 space-y-2">
        {actionState.phase === 'success' ? (
          <div className="space-y-2">
            <p className="text-sm text-emerald-400">✓ {actionState.label ?? 'Done'}</p>
            <a
              href={`${ETHERSCAN}/tx/${actionState.hash}`}
              target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View on Etherscan
            </a>
          </div>
        ) : actionState.phase === 'error' ? (
          <div className="space-y-2">
            <p className="text-xs text-rose-400">{actionState.msg}</p>
            <button
              onClick={() => setActionState({ phase: 'idle' })}
              className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1"
            >
              <RefreshCw className="h-3 w-3" /> Retry
            </button>
          </div>
        ) : actionState.phase === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Processing…
          </div>
        ) : (
          <>
            {/* Withdraw settled payout from vault to wallet */}
            {shieldedSettled && (
              <button
                onClick={() => handleWithdraw(shieldedPos?.computedPayout ?? '0')}
                className="w-full h-10 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
              >
                Withdraw to Wallet
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MarketDetailPage() {
  const params     = useParams();
  const id         = typeof params.id === 'string' ? params.id : '';
  const { openBetSlip } = useBetSlip();

  const [market,    setMarket]    = useState<Market | null>(null);
  const [rawMarket, setRawMarket] = useState<FrontendMarket | null>(null);
  const [eammMeta, setEammMeta]   = useState<{ status: number; outcome: boolean; expiryAt: number } | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  // ── Sealed-bid window state ──────────────────────────────────────────────────
  const [activeWindow,    setActiveWindow]    = useState<SealedWindowInfo | null>(null);
  const [revealedEvent,   setRevealedEvent]   = useState<PriceRevealedEvent | null>(null);
  const [windowSettling,  setWindowSettling]  = useState(false);
  // Snapshot prices captured at window-open time (frozen in UI during window).
  const snapshotRef = useRef<{ yes: number; no: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      if (isNumericId(id)) {
        // On-chain market — read from contract
        try {
          const [raw, meta] = await Promise.all([
            readMarket(Number(id)),
            isEammDeployed() ? readEammMarketMeta(Number(id)).catch(() => null) : Promise.resolve(null),
          ]);
          if (cancelled) return;
          if (!raw) {
            setError('Market not found on-chain.');
          } else {
            setRawMarket(raw);
            setEammMeta(meta);
            setMarket({
              id:               String(raw.id),
              title:            raw.title,
              description:      raw.description,
              category:         raw.category as Market['category'],
              resolutionSource: raw.resolutionSource ?? '',
              status:           raw.status === 0 ? 'active' : raw.status === 1 ? 'resolved' : 'cancelled',
              expiryAt:         new Date(raw.expiryAt * 1000).toISOString(),
              createdAt:        new Date().toISOString(),
              yesPrice:         raw.yesPrice ?? 0.5,
              noPrice:          raw.noPrice ?? 0.5,
              volume:           0,
              liquidity:        0,
              tradersCount:     0,
              priceHistory:     [],
              change24h:        0,
              trending:         false,
            });
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

  // ── Sealed-window polling + event subscriptions ─────────────────────────────
  useEffect(() => {
    if (!isNumericId(id) || !isEammDeployed()) return;
    const marketId = Number(id);

    let cancelled = false;

    // Initial fetch
    (async () => {
      try {
        const win = await readActiveWindow(marketId);
        if (!cancelled) setActiveWindow(win);
      } catch { /* non-fatal */ }
    })();

    // Poll every 5 s for window state changes (window opens / settling starts)
    const pollId = setInterval(async () => {
      try {
        const win = await readActiveWindow(marketId);
        if (!cancelled) setActiveWindow(win);
      } catch { /* non-fatal */ }
    }, 5_000);

    // Subscribe to new windows opening so we capture the snapshot price.
    const unsubOpen = subscribeSealedWindowOpened(marketId, () => {
      if (cancelled) return;
      // Capture current market prices as the "frozen" snapshot.
      setMarket((prev) => {
        if (prev) {
          snapshotRef.current = {
            yes: Math.round(prev.yesPrice * 100),
            no:  Math.round(prev.noPrice  * 100),
          };
        }
        return prev;
      });
      // Refresh the active window object.
      readActiveWindow(marketId)
        .then((w) => { if (!cancelled) setActiveWindow(w); })
        .catch(() => undefined);
    });

    // Subscribe to price reveals.
    const unsubReveal = subscribePriceRevealed(marketId, (ev) => {
      if (!cancelled) {
        setRevealedEvent(ev);
        setWindowSettling(false);
        setActiveWindow(null);
      }
    });

    return () => {
      cancelled = true;
      clearInterval(pollId);
      unsubOpen();
      unsubReveal();
    };
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
  const marketFullyPriced = market.yesPrice >= 0.999 || market.noPrice >= 0.999;
  const sepoliaClosed = eammMeta ? eammMeta.status !== 0 : false;
  const isPositiveChange = market.change24h >= 0;
  const statusMap: Record<string, string> = {
    active: 'Active', resolved: 'Resolved', disputed: 'Disputed', pending: 'Pending',
  };
  // Bets blocked when a sealed window has expired but not yet been settled.
  const canBet = market.status === 'active' && !marketFullyPriced && !sepoliaClosed && !windowSettling;
  const recentActivity = buildRecentActivity(market);
  const relatedMarkets = mockMarkets
    .filter((m) => m.category === market.category && m.id !== market.id)
    .slice(0, 3);
  const buyPressure = Math.round((market.yesPrice / (market.yesPrice + market.noPrice)) * 100);

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
              {rawMarket ? (
                <>
                  <StatPill label="Volume"    value="Encrypted" />
                  <StatPill label="Liquidity" value="Encrypted" />
                  <StatPill label="Traders"   value="—" />
                  <StatPill label="Time Left" value={formatTimeRemaining(market.expiryAt)} />
                </>
              ) : (
                <>
                  <StatPill label="Volume"    value={formatVolume(market.volume)} />
                  <StatPill label="Liquidity" value={formatVolume(market.liquidity)} />
                  <StatPill label="Traders"   value={formatTraders(market.tradersCount)} />
                  <StatPill label="Time Left" value={formatTimeRemaining(market.expiryAt)} />
                </>
              )}
            </div>

            {(market.priceHistory?.length ?? 0) >= 2 && (
            <div className="rounded-2xl border border-white/5 bg-slate-900 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white">Price History</h3>
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
            )}

            <div className="rounded-2xl border border-white/8 bg-slate-950/85 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white">Market Activity</h3>
                <span className="text-[11px] text-slate-500">Recent fills</span>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2.5">
                  {recentActivity.map((item, i) => (
                    <div
                      key={`${item.user}-${i}`}
                      className="flex items-center justify-between rounded-lg border border-white/8 bg-slate-900/90 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-slate-400">{item.user}</span>
                          <span className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide',
                            item.side === 'YES'
                              ? 'bg-emerald-500/10 text-emerald-300'
                              : 'bg-rose-500/10 text-rose-300'
                          )}>
                            {item.side}
                          </span>
                          <span className="text-slate-500">{item.priceCents}¢</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {item.minsAgo}m ago
                        </div>
                      </div>
                      <div className="text-sm font-mono text-slate-300">{item.amount}</div>
                    </div>
                  ))}
                </div>

                <div className="space-y-3">
                  <div className="rounded-lg border border-white/8 bg-slate-900/90 px-3.5 py-3">
                    <div className="text-[11px] text-slate-500 mb-1">Buy pressure</div>
                    <div className="text-xl font-bold text-white">{buyPressure}% YES</div>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-emerald-400/80"
                        style={{ width: `${buyPressure}%` }}
                      />
                    </div>
                  </div>

                  <div className="rounded-lg border border-white/8 bg-slate-900/90 px-3.5 py-3">
                    <div className="text-[11px] text-slate-500 mb-1">Avg fill size</div>
                    <div className="text-xl font-bold text-white">
                      ${(Math.round((market.volume / Math.max(market.tradersCount, 1)) * 10) / 10).toLocaleString()}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1">Approximate per trader participation</div>
                  </div>

                  <div className="rounded-lg border border-white/8 bg-slate-900/90 px-3.5 py-3">
                    <div className="text-[11px] text-slate-500 mb-1">Volatility (24h)</div>
                    <div className={cn(
                      'text-xl font-bold',
                      isPositiveChange ? 'text-emerald-300' : 'text-rose-300'
                    )}>
                      {formatPercent(market.change24h)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1">Price move vs previous 24h window</div>
                  </div>
                </div>
              </div>
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
                      ? `— USDC (FHE-encrypted)`
                      : formatVolume(market.volume)
                    }
                  </span>
                </div>
                {rawMarket && (
                  <div className="flex items-start justify-between py-2 border-b border-white/5">
                    <span className="text-sm text-slate-500 flex items-center gap-2">
                      <Droplets className="h-3.5 w-3.5" />
                      Pool
                    </span>
                    <span className="text-sm font-medium text-white font-mono">
                      FHE-encrypted
                    </span>
                  </div>
                )}
                {rawMarket?.creator && (
                  <div className="flex items-start justify-between py-2">
                    <span className="text-sm text-slate-500 flex items-center gap-2">
                      <Users className="h-3.5 w-3.5" />
                      Creator
                    </span>
                    <a
                      href={`${ETHERSCAN}/address/${rawMarket.creator}`}
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
                    className="h-full rounded-full bg-linear-to-r from-emerald-500 to-emerald-500/80 transition-all duration-500"
                    style={{ width: `${yesPct}%` }}
                  />
                </div>

                {/* Sealed-window overlay */}
                {(activeWindow || revealedEvent) && (
                  <div className="mb-4">
                    <SealedCountdown
                      window={activeWindow}
                      revealed={revealedEvent}
                      snapshotYes={snapshotRef.current?.yes ?? yesPct}
                      snapshotNo={snapshotRef.current?.no  ?? noPct}
                      onWindowExpired={() => setWindowSettling(true)}
                    />
                  </div>
                )}

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
                    <div className="space-y-1">
                      <p className="text-sm text-slate-400">
                        {market.status === 'resolved'
                          ? `Market resolved — ${rawMarket?.outcome ? 'YES' : 'NO'} won.`
                          : windowSettling
                          ? 'Bets paused — oracle is settling the sealed window.'
                          : sepoliaClosed
                          ? 'This market is closed on Sepolia and no longer accepts orders.'
                          : marketFullyPriced
                          ? 'This market is fully priced at 0/100c, so no meaningful upside remains.'
                          : 'This market is no longer accepting orders.'}
                      </p>
                      {market.status === 'resolved' && isEammDeployed() && (
                        <p className="text-xs text-slate-500 leading-relaxed">
                          Shielded bets are settled autonomously by the oracle.
                          Check your position below — payouts are credited to your vault balance.
                        </p>
                      )}
                    </div>
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

              <div className="rounded-2xl border border-white/8 bg-slate-950/85 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-white">Related Markets</h3>
                  <span className="text-[11px] text-slate-500">{market.category}</span>
                </div>
                <div className="space-y-2.5">
                  {relatedMarkets.length > 0 ? relatedMarkets.map((item) => (
                    <Link
                      key={item.id}
                      href={`/markets/${item.id}`}
                      className="block rounded-lg border border-white/8 bg-slate-900/90 p-3 hover:border-white/14 transition-colors"
                    >
                      <div className="text-sm text-white line-clamp-2 leading-snug mb-2">{item.title}</div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-500">YES {Math.round(item.yesPrice * 100)}¢</span>
                        <span className="text-slate-500">Vol {formatVolume(item.volume)}</span>
                      </div>
                    </Link>
                  )) : (
                    <p className="text-sm text-slate-500">No related markets yet.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
