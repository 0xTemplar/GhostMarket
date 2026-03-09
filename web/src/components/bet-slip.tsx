'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Shield, ArrowRight, Check, Loader2, AlertCircle, ExternalLink,
} from 'lucide-react';
import type { Market } from '@/types/market';
import { cn } from '@/lib/utils';
import { useFlowAuth, useFlowWalletClient } from '@/lib/flow/provider';
import { placeBet } from '@/lib/flow/market';

interface BetSlipProps {
  market: Market;
  side: 'YES' | 'NO';
  onSideChange: (side: 'YES' | 'NO') => void;
  onClose: () => void;
}

type TxState =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'pending'; hash: string }
  | { phase: 'success'; hash: string }
  | { phase: 'error'; message: string };

/** True when the market ID is a uint256 on-chain ID (e.g. '1', '2'). */
function isOnChainMarket(id: string): boolean {
  return /^\d+$/.test(id);
}

const FLOWSCAN_BASE = 'https://evm-testnet.flowscan.io';

function shortenHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

export function BetSlip({ market, side, onSideChange, onClose }: BetSlipProps) {
  const [amount, setAmount] = useState('');
  const [txState, setTxState] = useState<TxState>({ phase: 'idle' });
  const [mounted, setMounted] = useState(false);

  const { user, login, isLoading } = useFlowAuth();
  const walletClient = useFlowWalletClient();

  const onChain      = isOnChainMarket(market.id);
  const price        = side === 'YES' ? market.yesPrice : market.noPrice;
  const parsedAmount = parseFloat(amount) || 0;
  const shares       = parsedAmount > 0 ? parsedAmount / price : 0;
  const potentialPayout  = shares;
  const potentialProfit  = potentialPayout - parsedAmount;
  const isValid      = parsedAmount > 0;

  useEffect(() => {
    setMounted(true);
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Reset tx state when side or amount changes
  useEffect(() => {
    if (txState.phase === 'error') setTxState({ phase: 'idle' });
  }, [side, amount]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    // Prompt login if not authenticated
    if (!user.loggedIn) {
      login();
      return;
    }

    // Mock market — no on-chain interaction
    if (!onChain) {
      setTxState({ phase: 'success', hash: '0xmock' });
      return;
    }

    if (!walletClient) {
      setTxState({ phase: 'error', message: 'Wallet not ready. Try again.' });
      return;
    }

    setTxState({ phase: 'signing' });

    try {
      const hash = await placeBet(walletClient, Number(market.id), side, amount);
      setTxState({ phase: 'pending', hash });

      // Poll for confirmation
      const { publicClient } = await import('@/lib/flow/vault');
      await publicClient.waitForTransactionReceipt({ hash });
      setTxState({ phase: 'success', hash });
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? (err.message.includes('User rejected') ? 'Transaction rejected.' : err.message.slice(0, 120))
          : 'Transaction failed.';
      setTxState({ phase: 'error', message });
    }
  };

  const quickAmounts = [1, 5, 10, 25];
  const isBusy = txState.phase === 'signing' || txState.phase === 'pending';
  const currency = onChain ? 'FLOW' : '$';

  return (
    <AnimatePresence>
      {mounted && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col bg-slate-900 shadow-2xl border-l border-white/10"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-indigo-400" />
                <h2 className="text-base font-semibold text-white">Place Order</h2>
                {onChain && (
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
                    Live
                  </span>
                )}
              </div>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5">

              {/* Success state */}
              {(txState.phase === 'success') ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex flex-col items-center justify-center py-16 text-center"
                >
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
                    <Check className="h-8 w-8 text-emerald-500" />
                  </div>
                  <h3 className="text-lg font-bold text-white">Order Confirmed</h3>
                  <p className="mt-2 text-sm text-slate-400 max-w-xs">
                    Your {side} position on this market has been recorded on Flow EVM.
                  </p>
                  {txState.hash && txState.hash !== '0xmock' && (
                    <a
                      href={`${FLOWSCAN_BASE}/tx/${txState.hash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white transition-colors"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {shortenHash(txState.hash)}
                    </a>
                  )}
                  <button
                    onClick={onClose}
                    className="mt-6 text-sm text-slate-500 hover:text-white transition-colors"
                  >
                    Close
                  </button>
                </motion.div>
              ) : (

                <form onSubmit={handleSubmit} className="space-y-5">
                  {/* Market title */}
                  <p className="text-sm font-medium text-white line-clamp-2 leading-relaxed">
                    {market.title}
                  </p>

                  {/* Side selector */}
                  <div>
                    <label className="mb-2 block text-xs font-medium text-text-muted uppercase tracking-wide">
                      Outcome
                    </label>
                    <div className="flex gap-2">
                      {(['YES', 'NO'] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => onSideChange(s)}
                          className={cn(
                            'flex-1 rounded-xl border-2 py-3 text-sm font-semibold transition-all cursor-pointer',
                            s === 'YES'
                              ? side === 'YES'
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500 shadow-sm'
                                : 'border-white/10 bg-slate-800 text-slate-500 hover:border-white/20 hover:text-white'
                              : side === 'NO'
                              ? 'border-rose-500/30 bg-rose-500/10 text-rose-500 shadow-sm'
                              : 'border-white/10 bg-slate-800 text-slate-500 hover:border-white/20 hover:text-white'
                          )}
                        >
                          {s} — {s === 'YES'
                            ? Math.round(market.yesPrice * 100)
                            : Math.round(market.noPrice * 100)}¢
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Amount input */}
                  <div>
                    <label
                      htmlFor="bet-amount"
                      className="mb-2 block text-xs font-medium text-text-muted uppercase tracking-wide"
                    >
                      Amount
                    </label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-text-muted font-medium">
                        {currency}
                      </span>
                      <input
                        id="bet-amount"
                        type="number"
                        min={onChain ? '0.001' : '1'}
                        step="any"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.00"
                        disabled={isBusy}
                        className="font-mono h-12 w-full rounded-xl border border-white/10 bg-slate-800 pl-12 pr-4 text-lg text-white placeholder:text-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all disabled:opacity-50"
                        autoFocus
                      />
                    </div>
                    <div className="mt-2 flex gap-2">
                      {quickAmounts.map((qa) => (
                        <button
                          key={qa}
                          type="button"
                          disabled={isBusy}
                          onClick={() => setAmount(qa.toString())}
                          className={cn(
                            'flex-1 rounded-lg py-1.5 text-xs font-medium transition-all cursor-pointer disabled:opacity-50',
                            amount === qa.toString()
                              ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                              : 'bg-slate-800 text-slate-400 hover:bg-slate-700 border border-transparent'
                          )}
                        >
                          {currency}{qa}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Order summary */}
                  <div className="rounded-xl bg-slate-800/70 p-4 space-y-3 border border-white/5">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Price per share</span>
                      <span className="font-mono font-medium text-white">
                        {Math.round(price * 100)}¢
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Shares</span>
                      <span className="font-mono font-medium text-white">
                        {isValid ? shares.toFixed(2) : '—'}
                      </span>
                    </div>
                    <div className="border-t border-white/5 pt-3 flex justify-between text-sm">
                      <span className="text-slate-500">Est. payout</span>
                      <span className="font-mono font-semibold text-white">
                        {isValid ? `${currency}${potentialPayout.toFixed(2)}` : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Est. profit</span>
                      <span
                        className={cn(
                          'font-mono font-semibold',
                          potentialProfit >= 0 ? 'text-emerald-500' : 'text-rose-500'
                        )}
                      >
                        {isValid
                          ? `${potentialProfit >= 0 ? '+' : ''}${currency}${potentialProfit.toFixed(2)}`
                          : '—'}
                      </span>
                    </div>
                    {onChain && (
                      <div className="flex justify-between text-xs border-t border-white/5 pt-3">
                        <span className="text-slate-500">Protocol fee</span>
                        <span className="text-slate-400">2% on winnings</span>
                      </div>
                    )}
                  </div>

                  {/* Error banner */}
                  {txState.phase === 'error' && (
                    <div className="flex items-start gap-2 rounded-lg bg-rose-500/10 border border-rose-500/20 p-3">
                      <AlertCircle className="h-4 w-4 text-rose-400 mt-0.5 shrink-0" />
                      <p className="text-xs text-rose-300 leading-relaxed">{txState.message}</p>
                    </div>
                  )}

                  {/* Pending tx banner */}
                  {txState.phase === 'pending' && (
                    <a
                      href={`${FLOWSCAN_BASE}/tx/${txState.hash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 p-3"
                    >
                      <Loader2 className="h-4 w-4 text-indigo-400 animate-spin shrink-0" />
                      <span className="text-xs text-indigo-300">
                        Confirming on-chain…{' '}
                        <span className="underline underline-offset-2">{shortenHash(txState.hash)}</span>
                      </span>
                      <ExternalLink className="ml-auto h-3.5 w-3.5 text-indigo-400 shrink-0" />
                    </a>
                  )}

                  {/* Shield note */}
                  {txState.phase === 'idle' && (
                    <div className="flex items-start gap-2 rounded-lg bg-indigo-500/10 p-3">
                      <Shield className="h-4 w-4 text-indigo-400 mt-0.5 shrink-0" />
                      <p className="text-xs text-indigo-300 leading-relaxed">
                        {onChain
                          ? 'Order executes on Flow EVM. Encrypted execution (eAMM) activates in Phase 4.'
                          : 'Shielded by default — order size and intent are encrypted before execution.'}
                      </p>
                    </div>
                  )}

                  {/* CTA */}
                  {!user.loggedIn && !isLoading ? (
                    <button
                      type="button"
                      onClick={login}
                      className="w-full h-12 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-semibold flex items-center justify-center gap-2 transition-colors"
                    >
                      Sign in to bet
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!isValid || isBusy}
                      className="w-full h-12 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold flex items-center justify-center gap-2 transition-colors"
                    >
                      {txState.phase === 'signing' ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Waiting for signature…
                        </>
                      ) : txState.phase === 'pending' ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Confirming…
                        </>
                      ) : (
                        <>
                          Place {onChain ? 'Order' : 'Shielded Order'}
                          <ArrowRight className="h-4 w-4" />
                        </>
                      )}
                    </button>
                  )}
                </form>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
