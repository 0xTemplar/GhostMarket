'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Shield, ArrowRight, Check } from 'lucide-react';
import type { Market } from '@/types/market';
import { cn } from '@/lib/utils';

interface BetSlipProps {
  market: Market;
  side: 'YES' | 'NO';
  onSideChange: (side: 'YES' | 'NO') => void;
  onClose: () => void;
}

export function BetSlip({ market, side, onSideChange, onClose }: BetSlipProps) {
  const [amount, setAmount] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const price = side === 'YES' ? market.yesPrice : market.noPrice;
  const parsedAmount = parseFloat(amount) || 0;
  const shares = parsedAmount > 0 ? parsedAmount / price : 0;
  const potentialPayout = shares;
  const potentialProfit = potentialPayout - parsedAmount;
  const isValid = parsedAmount > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    setSubmitted(true);
    setTimeout(() => {
      onClose();
    }, 2000);
  };

  const quickAmounts = [10, 25, 50, 100];

  return (
    <AnimatePresence>
      {mounted && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm"
            onClick={onClose}
          />

          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col bg-slate-900 shadow-2xl border-l border-white/10"
          >
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-indigo-400" />
                <h2 className="text-base font-semibold text-white">
                  Place Order
                </h2>
              </div>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {submitted ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex flex-col items-center justify-center py-16 text-center"
                >
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
                    <Check className="h-8 w-8 text-emerald-500" />
                  </div>
                  <h3 className="text-lg font-bold text-white">
                    Order Submitted
                  </h3>
                  <p className="mt-2 text-sm text-slate-500 max-w-xs">
                    Your shielded order has been submitted. Position size and
                    intent are encrypted.
                  </p>
                </motion.div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-5">
                  <div>
                    <p className="text-sm font-medium text-white line-clamp-2 leading-relaxed">
                      {market.title}
                    </p>
                  </div>

                  <div>
                    <label className="mb-2 block text-xs font-medium text-text-muted uppercase tracking-wide">
                      Outcome
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => onSideChange('YES')}
                        className={cn(
                          'flex-1 rounded-xl border-2 py-3 text-sm font-semibold transition-all cursor-pointer',
                          side === 'YES'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500 shadow-sm'
                            : 'border-white/10 bg-slate-800 text-slate-500 hover:border-white/20 hover:text-white'
                        )}
                      >
                        YES — {Math.round(market.yesPrice * 100)}¢
                      </button>
                      <button
                        type="button"
                        onClick={() => onSideChange('NO')}
                        className={cn(
                          'flex-1 rounded-xl border-2 py-3 text-sm font-semibold transition-all cursor-pointer',
                          side === 'NO'
                            ? 'border-rose-500/30 bg-rose-500/10 text-rose-500 shadow-sm'
                            : 'border-white/10 bg-slate-800 text-slate-500 hover:border-white/20 hover:text-white'
                        )}
                      >
                        NO — {Math.round(market.noPrice * 100)}¢
                      </button>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="bet-amount"
                      className="mb-2 block text-xs font-medium text-text-muted uppercase tracking-wide"
                    >
                      Amount
                    </label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-text-muted font-medium">
                        $
                      </span>
                      <input
                        id="bet-amount"
                        type="number"
                        min="1"
                        step="1"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.00"
                        className="font-mono h-12 w-full rounded-xl border border-white/10 bg-slate-800 pl-8 pr-4 text-lg text-white placeholder:text-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all"
                        autoFocus
                      />
                    </div>
                    <div className="mt-2 flex gap-2">
                      {quickAmounts.map((qa) => (
                        <button
                          key={qa}
                          type="button"
                          onClick={() => setAmount(qa.toString())}
                          className={cn(
                            'flex-1 rounded-lg py-1.5 text-xs font-medium transition-all cursor-pointer',
                            amount === qa.toString()
                              ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                              : 'bg-slate-800 text-slate-400 hover:bg-slate-700 border border-transparent'
                          )}
                        >
                          ${qa}
                        </button>
                      ))}
                    </div>
                  </div>

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
                        {isValid ? shares.toFixed(1) : '—'}
                      </span>
                    </div>
                    <div className="border-t border-white/5 pt-3 flex justify-between text-sm">
                      <span className="text-slate-500">Est. payout</span>
                      <span className="font-mono font-semibold text-white">
                        {isValid ? `$${potentialPayout.toFixed(2)}` : '—'}
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
                          ? `${potentialProfit >= 0 ? '+' : ''}$${potentialProfit.toFixed(2)}`
                          : '—'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-start gap-2 rounded-lg bg-indigo-500/10 p-3">
                    <Shield className="h-4 w-4 text-indigo-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-indigo-300 leading-relaxed">
                      Shielded by default — order size and intent are encrypted
                      before execution.
                    </p>
                  </div>

                  <button
                    type="submit"
                    disabled={!isValid}
                    className="w-full h-12 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold flex items-center justify-center gap-2 transition-colors"
                  >
                    Place Shielded Order
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </form>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
