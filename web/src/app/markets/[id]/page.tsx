'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Shield, ExternalLink,
  Loader2, AlertCircle, RefreshCw, Lock, Unlock,
} from 'lucide-react';
import { mockMarkets } from '@/data/markets';
import type { Market } from '@/types/market';
import { useBetSlip } from '@/components/bet-slip-provider';
import { MarketDetailLeftPanel } from '@/components/market-detail-left-panel';
import {
  formatVolume, formatTraders,
  cn,
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
  GHOST_VAULT_ADDRESS, publicClient, formatUsdc,
} from '@/lib/vault';
import { useFlowAuth, useFlowWalletClient } from '@/lib/flow/provider';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isNumericId(id: string): boolean {
  return /^\d+$/.test(id);
}

const ETHERSCAN = 'https://sepolia.etherscan.io';

// ─── On-chain market actions panel ───────────────────────────────────────────

// USDC has 6 decimals. Format base units to a 2-decimal display string.
function fmtUsdc(baseUnits: string): string {
  return (parseFloat(baseUnits) / 1e6).toFixed(2);
}

/** Plaintext USDC base-units string, or this when the vault value is not decrypted client-side. */
const ENCRYPTED_USDC_FIELD = 'Encrypted';

function parseUsdcBaseUnits(s: string): bigint | null {
  if (s === ENCRYPTED_USDC_FIELD) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function fmtUsdcMaybe(s: string): string {
  if (s === ENCRYPTED_USDC_FIELD) return '—';
  return fmtUsdc(s);
}

function formatLockedCollateral(
  decrypted: bigint | null,
  encryptedField: string,
): string {
  if (decrypted !== null) return formatUsdc(decrypted);
  return fmtUsdcMaybe(encryptedField);
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
    locked: string;       // USDC base units as string, or ENCRYPTED_USDC_FIELD
    lockedHandle: `0x${string}` | null;
    side: string;
    computedPayout: string; // USDC base units as string
    vaultResolved: boolean;
  } | null>(null);
  const [decryptedLockedUsdc, setDecryptedLockedUsdc] = useState<bigint | null>(null);
  const [decryptCollateralLoading, setDecryptCollateralLoading] = useState(false);
  const [decryptCollateralError, setDecryptCollateralError] = useState(false);
  const prevLockedHandleRef = useRef<`0x${string}` | null>(null);
  const [actionState, setActionState] = useState<
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'success'; hash: string; label?: string }
    | { phase: 'error'; msg: string }
  >({ phase: 'idle' });

  const marketIdBytes32 = ('0x' + BigInt(raw.id).toString(16).padStart(64, '0')) as `0x${string}`;

  useEffect(() => {
    setShieldedPos(null);
    prevLockedHandleRef.current = null;
    setDecryptedLockedUsdc(null);
    setDecryptCollateralError(false);
  }, [raw.id]);

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
        const lockActive =
          lockedHandle !== '0x0000000000000000000000000000000000000000000000000000000000000000' &&
          lockedHandle !== '0x';
        const lh: `0x${string}` | null = lockActive ? lockedHandle : null;

        if (hasYes || hasNo || lockActive) {
          if (lh !== prevLockedHandleRef.current) {
            prevLockedHandleRef.current = lh;
            setDecryptedLockedUsdc(null);
            setDecryptCollateralError(false);
          }
          const side = hasYes && hasNo ? 'YES + NO' : hasYes ? 'YES' : hasNo ? 'NO' : '?';
          setShieldedPos({
            hasYes, hasNo,
            locked:         ENCRYPTED_USDC_FIELD,
            lockedHandle:   lh,
            side,
            computedPayout: ENCRYPTED_USDC_FIELD,
            vaultResolved,
          });
        } else {
          setShieldedPos(null);
        }
      } else {
        setShieldedPos(null);
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

  const handleDecryptCollateral = async () => {
    if (!walletClient || !user.evmAddress || !shieldedPos?.lockedHandle) return;
    setDecryptCollateralLoading(true);
    setDecryptCollateralError(false);
    try {
      const { userDecryptHandles } = await import('@/lib/eamm');
      const h = shieldedPos.lockedHandle;
      const results = await userDecryptHandles(
        walletClient,
        [{ handle: h, contractAddress: GHOST_VAULT_ADDRESS }],
        user.evmAddress as `0x${string}`,
      );
      setDecryptedLockedUsdc((results[h] ?? 0n) as bigint);
    } catch {
      setDecryptCollateralError(true);
    } finally {
      setDecryptCollateralLoading(false);
    }
  };

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

  const lockedBn =
    shieldedPos == null
      ? null
      : decryptedLockedUsdc !== null
        ? decryptedLockedUsdc
        : parseUsdcBaseUnits(shieldedPos.locked);
  const payoutBn   = shieldedPos ? parseUsdcBaseUnits(shieldedPos.computedPayout) : null;

  // Shielded position settled: payout credited, lock fully released (needs decrypted lock; otherwise unknown)
  const shieldedSettled =
    shieldedPos !== null &&
    shieldedPos.vaultResolved &&
    lockedBn !== null &&
    lockedBn === 0n;

  // Market resolved but lock still held — treat unknown encrypted lock as still held
  const shieldedPendingSettlement =
    shieldedPos !== null &&
    shieldedPos.vaultResolved &&
    (lockedBn ?? 1n) > 0n;

  const shieldedWon =
    shieldedPendingSettlement &&
    payoutBn !== null &&
    payoutBn > 0n;

  const showEncryptedCollateralRow =
    lockedBn === null || lockedBn > 0n;

  return (
    <div className="rounded-2xl border border-white/5  p-5 space-y-4">
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
                        {fmtUsdcMaybe(shieldedPos.computedPayout)} cUSDC
                      </span>{' '}
                      will be credited to your vault.
                    </p>
                  ) : payoutBn === null && shieldedPendingSettlement ? (
                    <p className="text-xs text-slate-300">
                      Position resolved — settlement in progress (amounts stay private until decrypted).
                    </p>
                  ) : (
                    <p className="text-xs text-rose-300">
                      Position resolved — oracle releasing your lock.
                    </p>
                  )}
                  <div className="flex items-center gap-1.5 text-xs flex-wrap">
                    <span className="text-slate-500">Collateral locked:</span>
                    <span className="font-mono text-amber-400">
                      {formatLockedCollateral(decryptedLockedUsdc, shieldedPos.locked)} USDC
                    </span>
                    {shieldedPos.lockedHandle && decryptedLockedUsdc === null && walletClient && (
                      <button
                        type="button"
                        onClick={handleDecryptCollateral}
                        disabled={decryptCollateralLoading}
                        title="Sign an EIP-712 message — only you can see this amount."
                        className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-0.5 text-[10px] font-medium text-indigo-200 hover:bg-white/5 disabled:opacity-50"
                      >
                        {decryptCollateralLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Unlock className="h-3 w-3" />
                        )}
                        Reveal
                      </button>
                    )}
                    {decryptCollateralError && (
                      <span className="text-rose-400 text-[10px]">Decrypt failed · try again</span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Bet amount is FHE-encrypted on the eAMM — exact size is private.
                  </p>
                  {showEncryptedCollateralRow && (
                    <div className="flex items-center gap-1.5 text-xs flex-wrap">
                      <span className="text-slate-500">Collateral locked:</span>
                      <span className="font-mono text-amber-400">
                        {formatLockedCollateral(decryptedLockedUsdc, shieldedPos.locked)} cUSDC
                      </span>
                      {shieldedPos.lockedHandle && decryptedLockedUsdc === null && walletClient && (
                        <button
                          type="button"
                          onClick={handleDecryptCollateral}
                          disabled={decryptCollateralLoading}
                          title="Sign an EIP-712 message — only you can see this amount."
                          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-0.5 text-[10px] font-medium text-indigo-200 hover:bg-white/5 disabled:opacity-50"
                        >
                          {decryptCollateralLoading ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Unlock className="h-3 w-3" />
                          )}
                          Reveal
                        </button>
                      )}
                      {decryptCollateralError && (
                        <span className="text-rose-400 text-[10px]">Decrypt failed · try again</span>
                      )}
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
  // Bets blocked when a sealed window has expired but not yet been settled.
  const canBet = market.status === 'active' && !marketFullyPriced && !sepoliaClosed && !windowSettling;
  const relatedMarkets = mockMarkets
    .filter((m) => m.category === market.category && m.id !== market.id)
    .slice(0, 3);

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

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left column — Polymarket-style hero, chart, order book, rules */}
          <div className="lg:col-span-2">
            <MarketDetailLeftPanel
              market={market}
              rawMarket={rawMarket}
              yesPct={yesPct}
            />
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
