'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  ArrowRight, Ghost, Loader2, Clock, ArrowUpRight,
  RefreshCw, Shield, Lock, Eye, EyeOff, Zap, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { mockPositions, mockPortfolioStats } from '@/data/markets';
import { PortfolioSummary } from '@/components/portfolio-summary';
import { PortfolioPositionRow } from '@/components/portfolio-position-row';
import { useFlowAuth, useFlowWalletClient } from '@/lib/flow/provider';
import {
  readAllMarkets, readUserPosition, isMarketDeployed,
  type OnChainMarket,
} from '@/lib/flow/market';
import {
  readEammMarketMeta, readEammPositionHandles, isEammDeployed,
  type EammMarketMeta, type PositionHandles,
} from '@/lib/flow/eamm';
import {
  readLockedAmount,
  claimVaultPayout,
  eammMarketIdToBytes32,
  readSettlementSigner,
} from '@/lib/flow/vault';
import { formatTimeRemaining, cn } from '@/lib/utils';
import { requestSettlement, type SettlementClaim } from '@/lib/oracle-client';

// ─── Shielded eAMM position type ─────────────────────────────────────────────

interface ShieldedPosition {
  marketId:      number;
  marketTitle:   string;        // from GhostMarket.sol (public)
  yesHandle:     `0x${string}`; // opaque — encrypted by fhevm
  noHandle:      `0x${string}`; // opaque — encrypted by fhevm
  meta:          EammMarketMeta;
  lockedCollateral: string;     // FLOW locked in GhostVault for this market
  revealed:      boolean;       // true after user-authorised gateway decryption
  revealedYes:   string | null; // plaintext FLOW after reveal
  revealedNo:    string | null;
}

// ─── Claim state per position ─────────────────────────────────────────────────

type ClaimPhase =
  | 'idle'
  | 'requesting'    // fetching settlement sig from oracle
  | 'submitting'    // submitting claimPayout() tx on Flow EVM
  | 'success'
  | 'error';

interface ClaimState {
  phase:   ClaimPhase;
  txHash:  string | null;
  payout:  string | null;   // formatted FLOW
  error:   string | null;
}

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

// ─── Shielded position card ───────────────────────────────────────────────────

const EAMM_STATUS: Record<number, string> = { 0: 'Active', 1: 'Resolved', 2: 'Cancelled' };
const EAMM_STATUS_STYLE: Record<number, string> = {
  0: 'bg-emerald-500/10 text-emerald-400',
  1: 'bg-slate-700 text-slate-300',
  2: 'bg-rose-500/10 text-rose-400',
};

function ShieldedPositionRow({
  pos,
  index,
  onReveal,
  onClaim,
  claimState,
}: {
  pos:        ShieldedPosition;
  index:      number;
  onReveal:   (marketId: number) => void;
  onClaim:    (marketId: number) => void;
  claimState: ClaimState;
}) {
  const hasYes    = pos.yesHandle !== '0x' + '0'.repeat(64);
  const hasNo     = pos.noHandle  !== '0x' + '0'.repeat(64);
  const resolved  = pos.meta.status === 1;
  const hasLocked = parseFloat(pos.lockedCollateral) > 0;

  const FLOWSCAN = 'https://evm-testnet.flowscan.io/tx/';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.3, ease: 'easeOut' }}
      className="rounded-2xl border border-indigo-500/10 bg-slate-900 p-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {hasYes && (
              <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/10 text-emerald-500">YES</span>
            )}
            {hasNo && (
              <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-rose-500/10 text-rose-500">NO</span>
            )}
            <span className={cn('px-2.5 py-1 rounded-lg text-xs font-medium', EAMM_STATUS_STYLE[pos.meta.status])}>
              {EAMM_STATUS[pos.meta.status]}
            </span>
            <span className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/15">
              <Lock className="h-2.5 w-2.5" />
              Shielded
            </span>
            {resolved && hasLocked && claimState.phase === 'idle' && (
              <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 animate-pulse">
                Claim available
              </span>
            )}
            {claimState.phase === 'success' && (
              <span className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/10 text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                Claimed
              </span>
            )}
            <span className="flex items-center gap-1 text-xs text-slate-500">
              <Clock className="h-3 w-3" />
              {formatTimeRemaining(new Date(pos.meta.expiryAt * 1000).toISOString())}
            </span>
          </div>
          <h3 className="text-[15px] font-semibold text-white truncate">
            {pos.marketTitle}
          </h3>
        </div>

        <div className="flex items-center gap-4 sm:gap-6 sm:text-right shrink-0 flex-wrap justify-end">
          {/* Locked collateral — visible (user's own custody record) */}
          {hasLocked && (
            <div>
              <div className="text-xs text-slate-500 mb-0.5">Collateral</div>
              <div className="font-mono text-sm font-semibold text-amber-400">
                {parseFloat(pos.lockedCollateral).toFixed(4)} FLOW
              </div>
            </div>
          )}

          {/* Claimed payout */}
          {claimState.phase === 'success' && claimState.payout && (
            <div>
              <div className="text-xs text-slate-500 mb-0.5">Payout</div>
              <div className="font-mono text-sm font-semibold text-emerald-400">
                {claimState.payout} FLOW
              </div>
            </div>
          )}

          {/* Amount — shielded by default */}
          <div>
            <div className="text-xs text-slate-500 mb-0.5">Bet size</div>
            {pos.revealed ? (
              <div className="font-mono text-sm font-semibold text-white">
                {pos.revealedYes && `${pos.revealedYes} YES`}
                {pos.revealedNo  && ` ${pos.revealedNo} NO`}
              </div>
            ) : (
              <div className="font-mono text-sm font-semibold text-slate-400 tracking-widest">
                ••••••
              </div>
            )}
          </div>

          {/* Reveal / hide toggle */}
          <button
            onClick={() => onReveal(pos.marketId)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white hover:border-indigo-500/30 transition-colors"
          >
            {pos.revealed
              ? <><EyeOff className="h-3.5 w-3.5" /> Hide</>
              : <><Eye  className="h-3.5 w-3.5" /> Reveal</>}
          </button>

          {/* Claim payout button — shown when market is resolved and lock exists */}
          {resolved && hasLocked && claimState.phase !== 'success' && (
            <button
              onClick={() => onClaim(pos.marketId)}
              disabled={claimState.phase === 'requesting' || claimState.phase === 'submitting'}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all',
                claimState.phase === 'error'
                  ? 'border border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20'
                  : 'border border-indigo-500/30 bg-indigo-500 hover:bg-indigo-400 text-white',
                (claimState.phase === 'requesting' || claimState.phase === 'submitting') && 'opacity-70 cursor-wait',
              )}
            >
              {claimState.phase === 'requesting' && (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Signing…</>
              )}
              {claimState.phase === 'submitting' && (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Claiming…</>
              )}
              {claimState.phase === 'error' && (
                <><AlertCircle className="h-3.5 w-3.5" /> Retry</>
              )}
              {claimState.phase === 'idle' && (
                <><Zap className="h-3.5 w-3.5" /> Claim</>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Claim error */}
      {claimState.phase === 'error' && claimState.error && (
        <p className="mt-3 text-[11px] text-rose-400 border-t border-rose-500/10 pt-3">
          {claimState.error}
        </p>
      )}

      {/* Success: tx link */}
      {claimState.phase === 'success' && claimState.txHash && (
        <p className="mt-3 text-[11px] text-emerald-400 border-t border-emerald-500/10 pt-3 flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3 shrink-0" />
          Payout claimed.{' '}
          <a
            href={`${FLOWSCAN}${claimState.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-emerald-300 transition-colors"
          >
            View on Flowscan →
          </a>
        </p>
      )}

      {pos.revealed && claimState.phase !== 'success' && (
        <p className="mt-3 text-[11px] text-slate-500 border-t border-white/5 pt-3">
          Revealed via Zama gateway decryption. Only you can see this value.
        </p>
      )}
      {hasLocked && claimState.phase === 'idle' && (
        <p className="mt-3 text-[11px] text-amber-500/60 border-t border-white/5 pt-3">
          {parseFloat(pos.lockedCollateral).toFixed(4)} FLOW locked as collateral on Flow EVM —
          {resolved ? ' market resolved, claim your payout above.' : ' released at settlement.'}
        </p>
      )}
    </motion.div>
  );
}

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
  const walletClient = useFlowWalletClient();

  const [onChainPositions, setOnChainPositions]     = useState<OnChainPosition[]>([]);
  const [loadingChain, setLoadingChain]             = useState(false);
  const [chainError,   setChainError]               = useState<string | null>(null);

  const [shieldedPositions, setShieldedPositions]   = useState<ShieldedPosition[]>([]);
  const [loadingShielded, setLoadingShielded]       = useState(false);

  // claimStates[marketId] → ClaimState
  const [claimStates, setClaimStates] = useState<Record<number, ClaimState>>({});

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

  // ─── Shielded (eAMM) position fetcher ──────────────────────────────────────

  const fetchShieldedPositions = useCallback(async () => {
    if (!user.evmAddress || !isEammDeployed()) return;
    setLoadingShielded(true);
    try {
      // Re-use the same market list from GhostMarket.sol so titles are available.
      const markets = await readAllMarkets();
      const results: ShieldedPosition[] = [];

      await Promise.all(
        markets.map(async (market) => {
          try {
            const handles = await readEammPositionHandles(
              market.id,
              user.evmAddress as `0x${string}`,
            );
            const zero = '0x' + '0'.repeat(64);
            if (handles.yesHandle === zero && handles.noHandle === zero) return;
            const [meta, lockedCollateral] = await Promise.all([
              readEammMarketMeta(market.id),
              readLockedAmount(user.evmAddress as `0x${string}`, market.id),
            ]);
            results.push({
              marketId:         market.id,
              marketTitle:      market.title,
              yesHandle:        handles.yesHandle,
              noHandle:         handles.noHandle,
              meta,
              lockedCollateral,
              revealed:         false,
              revealedYes:      null,
              revealedNo:       null,
            });
          } catch {
            // Market may not exist on eAMM yet — skip silently.
          }
        }),
      );

      setShieldedPositions(results);
    } catch (err) {
      console.error('Failed to load shielded positions', err);
    } finally {
      setLoadingShielded(false);
    }
  }, [user.evmAddress]);

  /**
   * Toggle the reveal state for a shielded position.
   *
   * In Phase 4 this simply flips the `revealed` flag and shows placeholder
   * text.  In Phase 6 the gateway decryption request will go through the
   * Zama re-encryption gateway using fhevmjs `decrypt` + the user's
   * EIP-712 signature.
   */
  const handleReveal = useCallback((marketId: number) => {
    setShieldedPositions((prev) =>
      prev.map((p) =>
        p.marketId !== marketId
          ? p
          : p.revealed
          ? { ...p, revealed: false }
          : {
              ...p,
              revealed:    true,
              // Phase 6: replace these with real gateway-decrypted values.
              revealedYes: p.yesHandle !== '0x' + '0'.repeat(64) ? '(decrypting…)' : null,
              revealedNo:  p.noHandle  !== '0x' + '0'.repeat(64) ? '(decrypting…)' : null,
            },
      ),
    );
  }, []);

  /**
   * Claim payout for a resolved shielded market (Phase 6).
   *
   * 1. Request a signed settlement claim from the oracle service.
   * 2. Submit GhostVault.claimPayout() on Flow EVM with the oracle signature.
   * 3. Show success + Flowscan link.
   */
  const handleClaim = useCallback(async (marketId: number) => {
    if (!user.evmAddress || !walletClient) return;

    const defaultState: ClaimState = { phase: 'idle', txHash: null, payout: null, error: null };
    const setPhase = (patch: Partial<ClaimState>) =>
      setClaimStates(prev => ({
        ...prev,
        [marketId]: { ...defaultState, ...prev[marketId], ...patch },
      }));

    try {
      setPhase({ phase: 'requesting', error: null });

      // Ask oracle for the signed settlement message
      const claim = await requestSettlement(marketId.toString(), user.evmAddress);

      const onChainSigner = await readSettlementSigner();
      if (onChainSigner && onChainSigner.toLowerCase() !== claim.signerAddress.toLowerCase()) {
        throw new Error(
          `Settlement signer mismatch: vault trusts ${onChainSigner}, oracle signed with ${claim.signerAddress}. ` +
          'Ask admin to update GhostVault.settlementSigner.',
        );
      }

      setPhase({ phase: 'submitting' });

      // Submit claimPayout() to GhostVault on Flow EVM
      const txHash = await claimVaultPayout(
        walletClient,
        eammMarketIdToBytes32(marketId),
        claim.payout,
        claim.nonce,
        claim.expiry,
        claim.sig,
      );

      const payoutFlow = (Number(BigInt(claim.payout)) / 1e18).toFixed(4);

      setPhase({ phase: 'success', txHash, payout: payoutFlow });
    } catch (err) {
      const message = (err as Error).message ?? 'Claim failed';
      setPhase({ phase: 'error', error: message });
    }
  }, [user.evmAddress, walletClient]);

  useEffect(() => {
    fetchOnChainPositions();
    fetchShieldedPositions();
  }, [fetchOnChainPositions, fetchShieldedPositions]);

  if (isLoading || user.evmLoading) {
    return (
      <div className="flex items-center justify-center py-40">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  const hasOnChain  = onChainPositions.length > 0;
  const hasShielded = shieldedPositions.length > 0;
  const hasMock     = mockPositions.length > 0;
  const hasAny      = hasOnChain || hasShielded || hasMock;

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

        {/* ── Shielded (eAMM) positions ── */}
        {user.loggedIn && isEammDeployed() && (
          <section className="mb-10">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Lock className="h-4 w-4 text-indigo-400" />
                Shielded Positions
                <span className="text-xs font-normal text-slate-500 ml-1">via Zama fhevm</span>
              </h2>
              <button
                onClick={fetchShieldedPositions}
                disabled={loadingShielded}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors disabled:opacity-50"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loadingShielded && 'animate-spin')} />
                Refresh
              </button>
            </div>

            {loadingShielded ? (
              <div className="rounded-2xl border border-white/5 bg-slate-900 p-10 flex items-center justify-center gap-3 text-slate-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Reading encrypted positions…</span>
              </div>
            ) : hasShielded ? (
              <div className="space-y-3">
                {shieldedPositions.map((pos, i) => (
                  <ShieldedPositionRow
                    key={pos.marketId}
                    pos={pos}
                    index={i}
                    onReveal={handleReveal}
                    onClaim={handleClaim}
                    claimState={claimStates[pos.marketId] ?? { phase: 'idle', txHash: null, payout: null, error: null }}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-indigo-500/10 bg-slate-900/50 p-8 text-center">
                <Lock className="h-6 w-6 text-indigo-500/40 mx-auto mb-2" />
                <p className="text-sm text-slate-500">
                  No shielded positions yet.{' '}
                  <Link href="/" className="text-indigo-400 hover:text-indigo-300 transition-colors">
                    Place a shielded bet →
                  </Link>
                </p>
              </div>
            )}
          </section>
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
