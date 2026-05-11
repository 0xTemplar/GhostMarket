'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Zap,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  ExternalLink,
  X,
  Info,
} from 'lucide-react';
import { useFlowAuth, useFlowWalletClient, usePrivyProvider } from '@/lib/privy/ghost-provider';
import {
  readUsdcBalance,
  readFreeBalanceHandles,
  readIsOperator,
  setOperatorUsdc,
  depositToVault,
  withdrawFromVault,
  parseUsdc,
  formatUsdc,
  GHOST_VAULT_ADDRESS,
  MOCK_USDC_ADDRESS,
  publicClient,
} from '@/lib/vault';

type TxStatus = 'idle' | 'approving' | 'depositing' | 'pending' | 'success' | 'error';

interface TxState {
  status: TxStatus;
  hashes?: string[];
  error?: string;
}

const NOT_DEPLOYED = !GHOST_VAULT_ADDRESS || GHOST_VAULT_ADDRESS === '0x';
const USDC_NOT_SET  = !MOCK_USDC_ADDRESS  || MOCK_USDC_ADDRESS  === '0x';

const ZERO_HANDLE = `0x${'0'.repeat(64)}` as `0x${string}`;

export default function VaultPage() {
  const { user, login, isLoading } = useFlowAuth();
  const walletClient  = useFlowWalletClient();
  const privyProvider = usePrivyProvider();

  // Plaintext balances — null means "not yet decrypted"
  const [vaultBalance, setVaultBalance]   = useState<bigint | null>(null);
  const [freeBalance,  setFreeBalance]    = useState<bigint | null>(null);
  const [walletUsdc,   setWalletUsdc]     = useState<bigint | null>(null);

  // Encrypted handles returned by the vault contract
  const [balanceHandle,     setBalanceHandle]     = useState<`0x${string}` | null>(null);
  const [totalLockedHandle, setTotalLockedHandle] = useState<`0x${string}` | null>(null);

  // Gateway decryption state
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState(false);

  const [depositAmount,  setDepositAmount]  = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [depositTx,      setDepositTx]      = useState<TxState>({ status: 'idle' });
  const [withdrawTx,     setWithdrawTx]     = useState<TxState>({ status: 'idle' });
  const [settlementBanner, setSettlementBanner] = useState<{ delta: bigint } | null>(null);

  const prevFreeRef       = useRef<bigint | null>(null);
  const suppressBannerRef = useRef(false);

  // ── Step 1: fetch wallet USDC balance + vault ciphertext handles ─────────────
  const fetchBalances = useCallback(async () => {
    if (!user.evmAddress) return;
    const addr = user.evmAddress as `0x${string}`;

    const [wallet, [bal, locked]] = await Promise.all([
      readUsdcBalance(addr),
      readFreeBalanceHandles(addr),
    ]);
    setWalletUsdc(wallet);

    if (bal === ZERO_HANDLE) {
      // No deposits yet — balance is definitively 0, nothing to decrypt.
      setVaultBalance(0n);
      setFreeBalance(0n);
      setBalanceHandle(null);
      setTotalLockedHandle(null);
    } else {
      // Store the handles; the decryption effect will fire automatically.
      setBalanceHandle(bal);
      setTotalLockedHandle(locked !== ZERO_HANDLE ? locked : null);
      // Reset previously decrypted values so the UI shows "decrypting" state.
      setVaultBalance(null);
      setFreeBalance(null);
      setDecryptError(false);
    }

    suppressBannerRef.current = false;
  }, [user.evmAddress]);

  useEffect(() => {
    fetchBalances();
    const id = setInterval(() => fetchBalances(), 30_000);
    return () => clearInterval(id);
  }, [fetchBalances]);

  // ── Step 2: gateway-decrypt handles whenever they change ─────────────────────
  const runDecrypt = useCallback(async () => {
    if (!balanceHandle || !walletClient || !user.evmAddress) return;

    setIsDecrypting(true);
    setDecryptError(false);

    try {
      const { userDecryptHandles } = await import('@/lib/eamm');

      const pairs: Array<{ handle: `0x${string}`; contractAddress: `0x${string}` }> = [
        { handle: balanceHandle, contractAddress: GHOST_VAULT_ADDRESS },
      ];
      if (totalLockedHandle) {
        pairs.push({ handle: totalLockedHandle, contractAddress: GHOST_VAULT_ADDRESS });
      }

      const results = await userDecryptHandles(
        walletClient,
        pairs,
        user.evmAddress as `0x${string}`,
      );

      const total  = (results[balanceHandle]     ?? 0n) as bigint;
      const locked = totalLockedHandle
        ? (results[totalLockedHandle] ?? 0n) as bigint
        : 0n;

      const prev = prevFreeRef.current;
      const free = total - locked;

      // Settlement banner: fire if free balance increased since last read.
      if (prev !== null && !suppressBannerRef.current && free > prev) {
        setSettlementBanner({ delta: free - prev });
      }
      suppressBannerRef.current = false;
      prevFreeRef.current       = free;

      setVaultBalance(total);
      setFreeBalance(free);
    } catch {
      // User dismissed the signature request or gateway error.
      setDecryptError(true);
    } finally {
      setIsDecrypting(false);
    }
  }, [balanceHandle, totalLockedHandle, walletClient, user.evmAddress]);

  useEffect(() => {
    if (balanceHandle && walletClient) runDecrypt();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balanceHandle, totalLockedHandle, walletClient]);

  const lockedAmount = useMemo(
    () => vaultBalance !== null && freeBalance !== null ? vaultBalance - freeBalance : null,
    [vaultBalance, freeBalance],
  );

  // ── Deposit ────────────────────────────────────────────────────────────────
  async function handleDeposit() {
    if (!depositAmount || !user.evmAddress || !walletClient) return;
    const amount = parseUsdc(depositAmount);
    if (amount === 0n) return;

    const hashes: string[] = [];
    try {
      // Step 1 — check operator status and set if needed
      const isOperator = await readIsOperator(
        user.evmAddress as `0x${string}`,
        GHOST_VAULT_ADDRESS,
      );
      if (!isOperator) {
        setDepositTx({ status: 'approving' });
        const approveTx = await setOperatorUsdc(walletClient);
        hashes.push(approveTx);
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      // Step 2 — encrypt amount
      setDepositTx({ status: 'depositing' });
      if (!privyProvider) throw new Error('Wallet provider not ready');
      const { encryptBetInput } = await import('@/lib/eamm');
      const encrypted = await encryptBetInput(privyProvider, GHOST_VAULT_ADDRESS, user.evmAddress as `0x${string}`, amount);

      // Step 3 — deposit
      const depositTxHash = await depositToVault(walletClient, encrypted.handle, encrypted.inputProof);
      hashes.push(depositTxHash);
      await publicClient.waitForTransactionReceipt({ hash: depositTxHash });

      setDepositTx({ status: 'success', hashes });
      setDepositAmount('');
      suppressBannerRef.current = true;
      await fetchBalances();
    } catch (e: unknown) {
      setDepositTx({ status: 'error', hashes, error: (e as Error).message });
    }
  }

  // ── Withdraw ───────────────────────────────────────────────────────────────
  async function handleWithdraw() {
    if (!withdrawAmount || !user.evmAddress || !walletClient) return;
    const amount = parseUsdc(withdrawAmount);
    if (amount === 0n) return;

    setWithdrawTx({ status: 'pending' });
    try {
      if (!privyProvider) throw new Error('Wallet provider not ready');
      const { encryptBetInput } = await import('@/lib/eamm');
      const encrypted = await encryptBetInput(privyProvider, GHOST_VAULT_ADDRESS, user.evmAddress as `0x${string}`, amount);

      const hash = await withdrawFromVault(walletClient, encrypted.handle, encrypted.inputProof);
      await publicClient.waitForTransactionReceipt({ hash });
      setWithdrawTx({ status: 'success', hashes: [hash] });
      setWithdrawAmount('');
      suppressBannerRef.current = true;
      await fetchBalances();
    } catch (e: unknown) {
      setWithdrawTx({ status: 'error', error: (e as Error).message });
    }
  }

  // ── Loading / auth gates ───────────────────────────────────────────────────
  if (isLoading) {
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
            No wallet needed — use email, passkeys, or social login.
          </p>
          <button
            onClick={login}
            className="w-full py-3 rounded-xl text-sm font-semibold bg-indigo-500 hover:bg-indigo-400 text-white transition-all"
          >
            Sign in
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
        <p className="text-slate-400 text-sm mt-1">Your USDC custody account on Ethereum Sepolia</p>
      </div>

      {/* Contract config warnings */}
      {(NOT_DEPLOYED || USDC_NOT_SET) && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={1.5} />
          <span>
            {NOT_DEPLOYED && (
              <>
                GhostVault address missing. Set{' '}
                <code className="font-mono text-xs bg-white/10 px-1 py-0.5 rounded">
                  NEXT_PUBLIC_GHOST_VAULT_ADDRESS
                </code>
                {' '}in <code className="font-mono text-xs bg-white/10 px-1 py-0.5 rounded">web/.env.local</code>.{' '}
              </>
            )}
            {USDC_NOT_SET && (
              <>
                MockUSDC address missing. Set{' '}
                <code className="font-mono text-xs bg-white/10 px-1 py-0.5 rounded">
                  NEXT_PUBLIC_MOCK_USDC_ADDRESS
                </code>.
              </>
            )}
          </span>
        </div>
      )}

      {/* Settlement notification banner */}
      {settlementBanner && (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" strokeWidth={1.5} />
          <p className="flex-1 text-sm text-emerald-300">
            <span className="font-semibold font-mono">
              +{formatUsdc(settlementBanner.delta)} USDC
            </span>{' '}
            credited to your vault — likely from a market settlement payout.
          </p>
          <button onClick={() => setSettlementBanner(null)} className="text-emerald-600 hover:text-emerald-400">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Balance card */}
      <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6">
        <p className="text-xs text-slate-500 uppercase tracking-widest mb-1">Available balance</p>
        <div className="flex items-end gap-3 min-h-11">
          {freeBalance !== null ? (
            <>
              <span className="text-4xl font-bold text-white tabular-nums">
                {Number(formatUsdc(freeBalance)).toFixed(2)}
              </span>
              <span className="text-slate-400 mb-1 text-lg">USDC</span>
            </>
          ) : isDecrypting ? (
            <span className="flex items-center gap-2 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
              Decrypting via Zama gateway…
            </span>
          ) : decryptError && balanceHandle ? (
            <button
              onClick={runDecrypt}
              className="flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              <ShieldCheck className="w-4 h-4" strokeWidth={1.5} />
              Reveal balance (sign to decrypt)
            </button>
          ) : (
            <span className="text-slate-500 text-sm">—</span>
          )}
        </div>

        {/* Locked collateral */}
        {lockedAmount !== null && lockedAmount > 0n && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/15 bg-amber-500/5 px-3 py-2">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            <span className="text-xs text-amber-300/80">
              <span className="font-mono font-semibold text-amber-300">
                {Number(formatUsdc(lockedAmount)).toFixed(2)} USDC
              </span>
              {' '}locked as collateral for active bets
            </span>
          </div>
        )}

        {/* Wallet USDC balance */}
        {walletUsdc !== null && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-slate-700/50 bg-slate-800/40 px-3 py-2">
            <Info className="w-3.5 h-3.5 text-slate-500 shrink-0" strokeWidth={1.5} />
            <span className="text-xs text-slate-500">
              Wallet USDC:{' '}
              <span className="font-mono text-slate-400">
                {Number(formatUsdc(walletUsdc)).toFixed(2)} USDC
              </span>
            </span>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Ethereum Sepolia (chain 11155111)
          </span>
          {user.evmAddress && (
            <a
              href={`https://sepolia.etherscan.io/address/${user.evmAddress}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 hover:text-slate-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
              View on Etherscan
            </a>
          )}
        </div>
      </div>

      {/* Gasless badge */}
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Zap className="w-3.5 h-3.5 text-indigo-400" strokeWidth={1.5} />
        <span>Sign in with email or Google — no seed phrase required.</span>
      </div>

      {/* Deposit */}
      <UsdcActionCard
        title="Deposit"
        description="Add USDC to your vault to place shielded bets. Approve once, then deposit."
        icon={<ArrowDownToLine className="w-5 h-5" strokeWidth={1.5} />}
        color="indigo"
        amount={depositAmount}
        onAmountChange={setDepositAmount}
        onSubmit={handleDeposit}
        tx={depositTx}
        onReset={() => setDepositTx({ status: 'idle' })}
        submitLabel={
          depositTx.status === 'approving' ? 'Approving…'
          : depositTx.status === 'depositing' ? 'Depositing…'
          : 'Deposit'
        }
        placeholder="0.00"
      />

      {/* Withdraw */}
      <UsdcActionCard
        title="Withdraw"
        description="Move USDC from your vault back to your wallet."
        icon={<ArrowUpFromLine className="w-5 h-5" strokeWidth={1.5} />}
        color="slate"
        amount={withdrawAmount}
        onAmountChange={setWithdrawAmount}
        onSubmit={handleWithdraw}
        tx={withdrawTx}
        onReset={() => setWithdrawTx({ status: 'idle' })}
        submitLabel="Withdraw"
        placeholder="0.00"
        disabled={freeBalance === null || freeBalance === 0n}
      />
    </div>
  );
}

// ─── ActionCard ───────────────────────────────────────────────────────────────

interface UsdcActionCardProps {
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

function UsdcActionCard({
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
}: UsdcActionCardProps) {
  const accent = color === 'indigo' ? 'indigo' : 'slate';
  const isPending = tx.status === 'approving' || tx.status === 'depositing' || tx.status === 'pending';

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

      {/* Approve progress indicator */}
      {tx.status === 'approving' && (
        <div className="flex items-center gap-2 text-xs text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-3 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          Step 1 of 2 — approving USDC spend…
        </div>
      )}
      {tx.status === 'depositing' && (
        <div className="flex items-center gap-2 text-xs text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-3 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          Step 2 of 2 — depositing USDC to vault…
        </div>
      )}

      {tx.status === 'success' ? (
        <div className="flex items-start gap-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4 text-sm text-emerald-300">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={1.5} />
          <div className="space-y-1">
            <p>Transaction confirmed!</p>
            {tx.hashes?.map((h) => (
              <a
                key={h}
                href={`https://sepolia.etherscan.io/tx/${h}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-emerald-400 underline underline-offset-2"
              >
                View on Etherscan <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
              </a>
            ))}
          </div>
          <button onClick={onReset} className="ml-auto text-xs text-slate-500 hover:text-slate-300">✕</button>
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
              disabled={disabled || isPending}
              className="w-full bg-slate-800/60 border border-white/10 rounded-xl py-3 px-4 pr-16 text-sm focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-all placeholder:text-slate-600 disabled:opacity-40"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-medium">
              USDC
            </span>
          </div>
          <button
            onClick={onSubmit}
            disabled={!amount || disabled || isPending}
            className={`flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
              accent === 'indigo'
                ? 'bg-indigo-500 hover:bg-indigo-400 text-white shadow-[0_0_15px_rgba(99,102,241,0.2)]'
                : 'bg-white/10 hover:bg-white/15 text-slate-200'
            }`}
          >
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitLabel}
          </button>
        </div>
      )}
    </div>
  );
}
