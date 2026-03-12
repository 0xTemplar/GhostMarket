'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Shield, ArrowRight, Check, Loader2, AlertCircle, ExternalLink, Lock,
} from 'lucide-react';
import type { Market } from '@/types/market';
import { cn } from '@/lib/utils';
import { useWallets } from '@privy-io/react-auth';
import { useFlowAuth, useFlowWalletClient } from '@/lib/flow/provider';
import { placeBet } from '@/lib/flow/market';
import { registerCanonicalBetTxHash } from '@/lib/oracle-client';
import {
  encryptBetInput,
  placeEncryptedBet,
  buildZamaWalletClient,
  resetFhevmInstance,
  toWei,
  isEammDeployed,
  GHOST_EAMM_ADDRESS,
} from '@/lib/flow/eamm';
import { lockBetCollateral, readLockedAmount } from '@/lib/flow/vault';

interface BetSlipProps {
  market: Market;
  side: 'YES' | 'NO';
  onSideChange: (side: 'YES' | 'NO') => void;
  onClose: () => void;
}

type TxState =
  | { phase: 'idle' }
  | { phase: 'locking' }                       // locking collateral on Flow EVM
  | { phase: 'encrypting' }                    // encrypting amount with fhevmjs
  | { phase: 'signing' }                       // awaiting wallet sig for placeBet
  | { phase: 'pending'; hash: string }
  | { phase: 'success'; hash: string; shielded?: boolean }
  | { phase: 'error'; message: string };

/** True when the market ID is a uint256 on-chain ID (e.g. '1', '2'). */
function isOnChainMarket(id: string): boolean {
  return /^\d+$/.test(id);
}

const FLOWSCAN_BASE  = 'https://evm-testnet.flowscan.io';
// GhostEAMM runs on Ethereum Sepolia — link to Etherscan Sepolia
const SEPOLIASCAN_BASE = 'https://sepolia.etherscan.io';

function shortenHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

export function BetSlip({ market, side, onSideChange, onClose }: BetSlipProps) {
  const [amount, setAmount]       = useState('');
  const [txState, setTxState]     = useState<TxState>({ phase: 'idle' });
  const [mounted, setMounted]     = useState(false);
  // shieldedMode: true = route through GhostEAMM (Zama fhevm), false = GhostMarket (Flow EVM)
  const [shieldedMode, setShieldedMode] = useState(isEammDeployed());

  const { user, login, isLoading } = useFlowAuth();
  const walletClient = useFlowWalletClient();
  const { wallets } = useWallets();

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

  // ─── Shielded path (eAMM on Zama / Ethereum Sepolia) ───────────────────────
  //
  // Two-layer flow:
  //   Layer 1 (Flow EVM) — lock collateral in GhostVault so the stake cannot
  //                         be withdrawn before settlement.
  //   Layer 2 (Zama)     — encrypt the bet amount and submit to GhostEAMM so
  //                         position size is invisible to other participants.
  const handleShieldedSubmit = async () => {
    const amountWei = toWei(amount);

    // ── Layer 1: lock collateral on Flow EVM ──────────────────────────────────
    // Skip if a lock already exists (e.g. a previous attempt locked successfully
    // but the Sepolia step failed — the user is retrying the same market).
    setTxState({ phase: 'locking' });
    try {
      if (!walletClient) throw new Error('Flow EVM wallet not ready. Please wait and try again.');

      const userAddress = (user.evmAddress ?? '') as `0x${string}`;
      const { publicClient: flowPublicClient } = await import('@/lib/flow/vault');

      const alreadyLocked = userAddress
        ? await readLockedAmount(userAddress, Number(market.id))
        : '0';

      if (parseFloat(alreadyLocked) === 0) {
        const lockHash = await lockBetCollateral(walletClient, Number(market.id), amountWei);
        await flowPublicClient.waitForTransactionReceipt({ hash: lockHash });
      }
      // If already locked: skip the tx and proceed to the Sepolia step.
    } catch (err: unknown) {
      let message = 'Collateral lock failed.';
      if (err instanceof Error) {
        const raw = err.message;
        const lower = raw.toLowerCase();
        if (raw.includes('User rejected')) {
          message = 'Lock cancelled.';
        } else if (
          raw.includes('InsufficientBalance') ||
          raw.includes('0xcf479181')
        ) {
          message = 'Insufficient free vault balance to lock this bet amount. Deposit more FLOW in Vault or lower the stake.';
        } else if (
          raw.includes('BetAlreadyLocked') ||
          raw.includes('0xac396183')
        ) {
          // Race-safe fallback: if lock was already created in a prior attempt,
          // continue to encrypted Sepolia bet flow on next submit.
          message = 'Collateral is already locked for this market. You can submit the shielded bet now.';
        } else if (lower.includes('zeroamount') || raw.includes('0x1f2a2005')) {
          message = 'Bet amount must be greater than zero.';
        } else {
          message = raw.slice(0, 160);
        }
      }
      setTxState({ phase: 'error', message });
      return;
    }

    // ── Layer 2: encrypt + submit to GhostEAMM on Sepolia ────────────────────
    setTxState({ phase: 'encrypting' });
    try {
      // Get the Privy embedded wallet and switch it to Sepolia (11155111).
      // We must NOT use window.ethereum — that's the injected MetaMask/browser
      // wallet, which is a different key from the Privy embedded wallet the user
      // is actually logged in with.
      const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
      if (!embeddedWallet) throw new Error('Privy embedded wallet not found. Try logging out and back in.');

      await embeddedWallet.switchChain(11155111);
      const provider = await embeddedWallet.getEthereumProvider();

      const userAddress = (user.evmAddress ?? embeddedWallet.address) as `0x${string}`;

      // Encrypt the bet amount client-side — plaintext never leaves the browser.
      const encrypted = await encryptBetInput(provider, GHOST_EAMM_ADDRESS, userAddress, amountWei);

      // Sign + submit to GhostEAMM on Ethereum Sepolia.
      setTxState({ phase: 'signing' });
      const zamaWallet = buildZamaWalletClient(provider);
      const hash = await placeEncryptedBet(zamaWallet, Number(market.id), side === 'YES', encrypted);

      setTxState({ phase: 'pending', hash });

      // Poll for confirmation on Sepolia.
      const { zamaPublicClient } = await import('@/lib/flow/eamm');
      await zamaPublicClient.waitForTransactionReceipt({ hash });

      // Non-blocking metadata write: gives oracle deterministic lookup for
      // both safe and strict settlement flows.
      void registerCanonicalBetTxHash(Number(market.id), userAddress, hash);

      setTxState({ phase: 'success', hash, shielded: true });
    } catch (err: unknown) {
      // Reset the fhevm singleton so the next retry re-initialises the SDK
      // rather than reusing a potentially broken or stale instance.
      resetFhevmInstance();
      let message = 'Encrypted bet failed.';
      if (err instanceof Error) {
        if (err.message.includes('User rejected')) {
          message = 'Transaction rejected.';
        } else if (err.message.includes('0x4cba20ef')) {
          message = 'This market is not yet registered on GhostEAMM. Run sync-markets-to-eamm.ts to mirror it to Sepolia.';
        } else if (err.message.includes('0x5404ee68')) {
          message = 'Market is not active — it may be resolved or cancelled.';
        } else if (err.message.includes('0xc13cc0ca')) {
          message = 'Market has expired and no longer accepts bets.';
        } else {
          message = err.message.slice(0, 160);
        }
      }
      setTxState({ phase: 'error', message });
    }
  };

  // ─── Public path (GhostMarket on Flow EVM) ─────────────────────────────────
  const handlePublicSubmit = async () => {
    if (!walletClient) {
      setTxState({ phase: 'error', message: 'Wallet not ready. Try again.' });
      return;
    }
    setTxState({ phase: 'signing' });
    try {
      const hash = await placeBet(walletClient, Number(market.id), side, amount);
      setTxState({ phase: 'pending', hash });
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    if (!user.loggedIn) { login(); return; }
    if (!onChain) { setTxState({ phase: 'success', hash: '0xmock' }); return; }
    if (shieldedMode && isEammDeployed()) {
      await handleShieldedSubmit();
    } else {
      await handlePublicSubmit();
    }
  };

  const quickAmounts = [1, 5, 10, 25];
  const isBusy   = txState.phase === 'locking' || txState.phase === 'encrypting' || txState.phase === 'signing' || txState.phase === 'pending';
  const currency = onChain ? 'FLOW' : '$';
  const scanBase = txState.phase === 'success' && txState.shielded ? SEPOLIASCAN_BASE : FLOWSCAN_BASE;

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
                {onChain && shieldedMode && isEammDeployed() && (
                  <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-400 border border-indigo-500/20 flex items-center gap-1">
                    <Lock className="h-2.5 w-2.5" />
                    Shielded
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
                    {txState.phase === 'success' && txState.shielded
                      ? `Collateral locked on Flow EVM · ${side} position encrypted on Zama fhevm. Position size is hidden from all participants.`
                      : `Your ${side} position on this market has been recorded on Flow EVM.`}
                  </p>
                  {txState.hash && txState.hash !== '0xmock' && (
                    <a
                      href={`${scanBase}/tx/${txState.hash}`}
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
                      href={`${shieldedMode && isEammDeployed() ? SEPOLIASCAN_BASE : FLOWSCAN_BASE}/tx/${txState.hash}`}
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

                  {/* Shielded / public mode toggle */}
                  {txState.phase === 'idle' && onChain && isEammDeployed() && (
                    <div className="flex items-center justify-between rounded-xl border border-white/5 bg-slate-800/50 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Lock className="h-3.5 w-3.5 text-indigo-400" />
                        <span className="text-xs font-medium text-slate-300">Shielded execution</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShieldedMode((v) => !v)}
                        className={cn(
                          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none',
                          shieldedMode ? 'bg-indigo-500' : 'bg-slate-600',
                        )}
                        role="switch"
                        aria-checked={shieldedMode}
                      >
                        <span
                          className={cn(
                            'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                            shieldedMode ? 'translate-x-4' : 'translate-x-0',
                          )}
                        />
                      </button>
                    </div>
                  )}

                  {/* Privacy note */}
                  {txState.phase === 'idle' && (
                    <div className="flex items-start gap-2 rounded-lg bg-indigo-500/10 p-3">
                      <Shield className="h-4 w-4 text-indigo-400 mt-0.5 shrink-0" />
                      <p className="text-xs text-indigo-300 leading-relaxed">
                        {onChain && shieldedMode && isEammDeployed()
                          ? 'Two-step: stake is locked on Flow EVM as collateral, then amount is encrypted with FHE before submission. Position size is invisible to all other market participants.'
                          : onChain
                          ? 'Executing on Flow EVM (public). Enable Shielded mode to lock collateral and hide your bet size.'
                          : 'Shielded by default — order size and intent are encrypted before execution.'}
                      </p>
                    </div>
                  )}

                  {/* Locking collateral notice */}
                  {txState.phase === 'locking' && (
                    <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
                      <Loader2 className="h-4 w-4 text-amber-400 animate-spin shrink-0" />
                      <span className="text-xs text-amber-300">
                        Locking collateral on Flow EVM…
                      </span>
                    </div>
                  )}

                  {/* Encrypting state notice */}
                  {txState.phase === 'encrypting' && (
                    <div className="flex items-center gap-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 p-3">
                      <Loader2 className="h-4 w-4 text-indigo-400 animate-spin shrink-0" />
                      <span className="text-xs text-indigo-300">
                        Encrypting amount with fhevmjs…
                      </span>
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
                      {txState.phase === 'locking' ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Locking collateral…
                        </>
                      ) : txState.phase === 'encrypting' ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Encrypting…
                        </>
                      ) : txState.phase === 'signing' ? (
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
                          {onChain && shieldedMode && isEammDeployed() ? (
                            <Lock className="h-4 w-4" />
                          ) : (
                            <ArrowRight className="h-4 w-4" />
                          )}
                          {onChain && shieldedMode && isEammDeployed()
                            ? 'Place Shielded Order'
                            : onChain
                            ? 'Place Order'
                            : 'Place Shielded Order'}
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
