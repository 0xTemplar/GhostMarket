'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Zap,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  ExternalLink,
} from 'lucide-react';
import { useFlowAuth, useFlowWalletClient } from '@/lib/flow/provider';
import {
  readVaultBalance,
  GHOST_VAULT_ADDRESS,
  GHOST_VAULT_ABI,
  publicClient,
  parseEther,
} from '@/lib/flow/vault';

type TxStatus = 'idle' | 'pending' | 'success' | 'error';

interface TxState {
  status: TxStatus;
  hash?: string;
  error?: string;
}

const NOT_DEPLOYED = GHOST_VAULT_ADDRESS === '0x0000000000000000000000000000000000000000';

export default function VaultPage() {
  const { user, login, setupCoa, isLoading } = useFlowAuth();
  const walletClient = useFlowWalletClient();
  const [balance, setBalance] = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [depositTx, setDepositTx] = useState<TxState>({ status: 'idle' });
  const [withdrawTx, setWithdrawTx] = useState<TxState>({ status: 'idle' });

  const fetchBalance = useCallback(async () => {
    if (!user.evmAddress) return;
    const b = await readVaultBalance(user.evmAddress as `0x${string}`);
    setBalance(b);
  }, [user.evmAddress]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  async function handleDeposit() {
    if (!depositAmount || !user.evmAddress || !walletClient) return;
    setDepositTx({ status: 'pending' });
    try {
      // User's Privy embedded wallet signs and sends deposit() directly.
      // Gas is covered by Flow EVM's negligible fees (~$0.0001) or a
      // sponsored gateway if NEXT_PUBLIC_FLOW_EVM_RPC is set.
      const hash = await walletClient.writeContract({
        address: GHOST_VAULT_ADDRESS,
        abi: GHOST_VAULT_ABI,
        functionName: 'deposit',
        value: parseEther(depositAmount),
        account: user.evmAddress as `0x${string}`,
        chain: undefined,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setDepositTx({ status: 'success', hash });
      setDepositAmount('');
      await fetchBalance();
    } catch (e: unknown) {
      setDepositTx({ status: 'error', error: (e as Error).message });
    }
  }

  async function handleWithdraw() {
    if (!withdrawAmount || !user.evmAddress || !walletClient) return;
    setWithdrawTx({ status: 'pending' });
    try {
      const hash = await walletClient.writeContract({
        address: GHOST_VAULT_ADDRESS,
        abi: GHOST_VAULT_ABI,
        functionName: 'withdraw',
        args: [parseEther(withdrawAmount)],
        account: user.evmAddress as `0x${string}`,
        chain: undefined,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setWithdrawTx({ status: 'success', hash });
      setWithdrawAmount('');
      await fetchBalance();
    } catch (e: unknown) {
      setWithdrawTx({ status: 'error', error: (e as Error).message });
    }
  }

  if (isLoading || user.evmLoading) {
    return (
      <div className="min-h-[calc(100vh-7rem)] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user.loggedIn) {
    return (
      <div className="min-h-[calc(100vh-7rem)] flex items-center justify-center px-4">
        <div className="max-w-sm w-full rounded-2xl border border-white/10 bg-slate-900/60 p-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 flex items-center justify-center mx-auto mb-5">
            <ShieldCheck className="w-7 h-7 text-indigo-400" strokeWidth={1.5} />
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">Sign in to access your vault</h2>
          <p className="text-slate-400 text-sm mb-6">
            No wallet needed. Use email, passkeys, or social login — powered by Flow.
          </p>
          <button
            onClick={login}
            className="w-full py-3 rounded-xl text-sm font-semibold bg-indigo-500 hover:bg-indigo-400 text-white transition-all"
          >
            Sign in with Flow
          </button>
        </div>
      </div>
    );
  }

  // New users: Cadence account exists but no COA (EVM address) yet.
  // One-time setup transaction creates the COA — fully handled by the wallet.
  if (!user.evmAddress && !user.evmLoading) {
    return (
      <div className="min-h-[calc(100vh-7rem)] flex items-center justify-center px-4">
        <div className="max-w-sm w-full rounded-2xl border border-white/10 bg-slate-900/60 p-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 flex items-center justify-center mx-auto mb-5">
            <Zap className="w-7 h-7 text-indigo-400" strokeWidth={1.5} />
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">Activate your EVM account</h2>
          <p className="text-slate-400 text-sm mb-2">
            One-time setup to create your Flow EVM address. This is a single on-chain
            transaction — no seed phrase, no cost beyond the tiny one-time fee.
          </p>
          <p className="text-slate-500 text-xs mb-6">
            This links your Flow account to an EVM address so the vault can hold your funds.
          </p>
          <button
            onClick={async () => {
              try { await setupCoa(); } catch (e) { console.error(e); }
            }}
            className="w-full py-3 rounded-xl text-sm font-semibold bg-indigo-500 hover:bg-indigo-400 text-white transition-all"
          >
            Activate EVM account
          </button>
        </div>
      </div>
    );
  }


  return (
    <div className="max-w-2xl mx-auto px-4 py-10 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-white">Vault</h1>
        <p className="text-slate-400 text-sm mt-1">
          Your gasless custody account on Flow EVM
        </p>
      </div>

      {/* Contract notice */}
      {NOT_DEPLOYED && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={1.5} />
          <span>
            GhostVault contract not yet deployed. Deploy with{' '}
            <code className="font-mono text-xs bg-white/10 px-1 py-0.5 rounded">
              forge script script/Deploy.s.sol
            </code>{' '}
            and set <code className="font-mono text-xs bg-white/10 px-1 py-0.5 rounded">NEXT_PUBLIC_GHOST_VAULT_ADDRESS</code> in your env.
          </span>
        </div>
      )}

      {/* Balance card */}
      <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6">
        <p className="text-xs text-slate-500 uppercase tracking-widest mb-1">Vault balance</p>
        <div className="flex items-end gap-3">
          <span className="text-4xl font-bold text-white tabular-nums">
            {balance === null ? (
              <Loader2 className="w-8 h-8 animate-spin text-slate-600 inline" />
            ) : (
              Number(balance).toFixed(4)
            )}
          </span>
          <span className="text-slate-400 mb-1 text-lg">FLOW</span>
        </div>

        <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Flow EVM Testnet (chain 545)
          </span>
          {user.evmAddress && (
            <a
              href={`https://evm-testnet.flowscan.io/address/${user.evmAddress}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 hover:text-slate-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
              View on Flowscan
            </a>
          )}
        </div>
      </div>

      {/* Gasless badge */}
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Zap className="w-3.5 h-3.5 text-indigo-400" strokeWidth={1.5} />
        <span>
          Transactions are relayed gaslessly — you never need FLOW for fees.
        </span>
      </div>

      {/* Deposit */}
      <ActionCard
        title="Deposit"
        description="Add FLOW to your vault to place shielded bets."
        icon={<ArrowDownToLine className="w-5 h-5" strokeWidth={1.5} />}
        color="indigo"
        amount={depositAmount}
        onAmountChange={setDepositAmount}
        onSubmit={handleDeposit}
        tx={depositTx}
        onReset={() => setDepositTx({ status: 'idle' })}
        submitLabel="Deposit"
        placeholder="0.0"
      />

      {/* Withdraw */}
      <ActionCard
        title="Withdraw"
        description="Move FLOW from your vault back to your account."
        icon={<ArrowUpFromLine className="w-5 h-5" strokeWidth={1.5} />}
        color="slate"
        amount={withdrawAmount}
        onAmountChange={setWithdrawAmount}
        onSubmit={handleWithdraw}
        tx={withdrawTx}
        onReset={() => setWithdrawTx({ status: 'idle' })}
        submitLabel="Withdraw"
        placeholder="0.0"
        disabled={balance === '0' || balance === null}
      />
    </div>
  );
}

interface ActionCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  color: 'indigo' | 'slate';
  amount: string;
  onAmountChange: (v: string) => void;
  onSubmit: () => void;
  tx: TxState;
  onReset: () => void;
  submitLabel: string;
  placeholder: string;
  disabled?: boolean;
}

function ActionCard({
  title,
  description,
  icon,
  color,
  amount,
  onAmountChange,
  onSubmit,
  tx,
  onReset,
  submitLabel,
  placeholder,
  disabled,
}: ActionCardProps) {
  const accent = color === 'indigo' ? 'indigo' : 'slate';

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div
          className={`w-9 h-9 rounded-xl flex items-center justify-center ${
            accent === 'indigo' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-white/5 text-slate-400'
          }`}
        >
          {icon}
        </div>
        <div>
          <p className="text-sm font-medium text-white">{title}</p>
          <p className="text-xs text-slate-500">{description}</p>
        </div>
      </div>

      {tx.status === 'success' ? (
        <div className="flex items-start gap-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4 text-sm text-emerald-300">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={1.5} />
          <div className="space-y-1">
            <p>Transaction submitted!</p>
            {tx.hash && (
              <a
                href={`https://evm-testnet.flowscan.io/tx/${tx.hash}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-emerald-400 underline underline-offset-2"
              >
                View on Flowscan <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
              </a>
            )}
          </div>
          <button onClick={onReset} className="ml-auto text-xs text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>
      ) : tx.status === 'error' ? (
        <div className="flex items-start gap-3 rounded-xl bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={1.5} />
          <p className="flex-1">{tx.error}</p>
          <button onClick={onReset} className="text-xs text-slate-500 hover:text-slate-300">✕</button>
        </div>
      ) : (
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => onAmountChange(e.target.value)}
              placeholder={placeholder}
              disabled={disabled || tx.status === 'pending'}
              className="w-full bg-slate-800/60 border border-white/10 rounded-xl py-3 px-4 pr-16 text-sm focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-all placeholder:text-slate-600 disabled:opacity-40"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-medium">
              FLOW
            </span>
          </div>
          <button
            onClick={onSubmit}
            disabled={!amount || disabled || tx.status === 'pending'}
            className={`flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
              accent === 'indigo'
                ? 'bg-indigo-500 hover:bg-indigo-400 text-white shadow-[0_0_15px_rgba(99,102,241,0.2)]'
                : 'bg-white/10 hover:bg-white/15 text-slate-200'
            }`}
          >
            {tx.status === 'pending' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : null}
            {submitLabel}
          </button>
        </div>
      )}
    </div>
  );
}

// Used only to satisfy parseEther import at build time (no-op)
void parseEther;
