'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Shield, ArrowRight, Check } from 'lucide-react';
import type { Market } from '@/types/market';
import { Button } from '@/components/ui/button';
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
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col bg-card shadow-2xl border-l border-border"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" />
                <h2 className="font-heading text-base font-semibold">
                  Place Order
                </h2>
              </div>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-text-muted hover:bg-elevated hover:text-text transition-colors cursor-pointer"
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
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-yes-soft">
                    <Check className="h-8 w-8 text-yes" />
                  </div>
                  <h3 className="font-heading text-lg font-bold text-text">
                    Order Submitted
                  </h3>
                  <p className="mt-2 text-sm text-text-muted max-w-xs">
                    Your shielded order has been submitted. Position size and
                    intent are encrypted.
                  </p>
                </motion.div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-5">
                  <div>
                    <p className="text-sm font-medium text-text line-clamp-2 leading-relaxed">
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
                            ? 'border-yes bg-yes-soft text-yes shadow-sm'
                            : 'border-border bg-card text-text-muted hover:border-border-hover'
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
                            ? 'border-no bg-no-soft text-no shadow-sm'
                            : 'border-border bg-card text-text-muted hover:border-border-hover'
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
                        className="font-mono h-12 w-full rounded-xl border border-border bg-elevated/50 pl-8 pr-4 text-lg text-text placeholder:text-text-muted/60 focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none transition-all"
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
                              ? 'bg-primary-soft text-primary border border-primary/20'
                              : 'bg-elevated text-text-secondary hover:bg-muted-bg border border-transparent'
                          )}
                        >
                          ${qa}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl bg-elevated/70 p-4 space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-text-muted">Price per share</span>
                      <span className="font-mono font-medium text-text">
                        {Math.round(price * 100)}¢
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-text-muted">Shares</span>
                      <span className="font-mono font-medium text-text">
                        {isValid ? shares.toFixed(1) : '—'}
                      </span>
                    </div>
                    <div className="border-t border-border pt-3 flex justify-between text-sm">
                      <span className="text-text-muted">Est. payout</span>
                      <span className="font-mono font-semibold text-text">
                        {isValid ? `$${potentialPayout.toFixed(2)}` : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-text-muted">Est. profit</span>
                      <span
                        className={cn(
                          'font-mono font-semibold',
                          potentialProfit >= 0 ? 'text-yes' : 'text-no'
                        )}
                      >
                        {isValid
                          ? `${potentialProfit >= 0 ? '+' : ''}$${potentialProfit.toFixed(2)}`
                          : '—'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-start gap-2 rounded-lg bg-primary-soft/50 p-3">
                    <Shield className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-primary/80 leading-relaxed">
                      Shielded by default — order size and intent are encrypted
                      before execution.
                    </p>
                  </div>

                  <Button
                    type="submit"
                    disabled={!isValid}
                    size="lg"
                    className="w-full font-heading font-semibold text-base"
                  >
                    Place Shielded Order
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </form>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
