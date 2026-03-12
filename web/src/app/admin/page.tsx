'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Shield, Plus, CheckCircle2, XCircle, Loader2, AlertCircle,
  ExternalLink, RefreshCw, Gavel,
} from 'lucide-react';
import { useFlowAuth, useFlowWalletClient } from '@/lib/flow/provider';
import { triggerOracleResolution } from '@/lib/oracle-client';
import {
  readAllMarkets, GHOST_MARKET_ADDRESS, GHOST_MARKET_ABI,
  type OnChainMarket,
} from '@/lib/flow/market';
import { publicClient, flowTestnet } from '@/lib/flow/vault';
import { cn } from '@/lib/utils';

const FLOWSCAN = 'https://evm-testnet.flowscan.io';

const CATEGORIES = ['Crypto', 'Macro', 'Politics', 'Tech', 'Sports', 'Climate'] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isAdmin(evmAddress: string | null): boolean {
  const adminAddress = process.env.NEXT_PUBLIC_ADMIN_ADDRESS?.toLowerCase();
  if (!adminAddress || !evmAddress) return false;
  return evmAddress.toLowerCase() === adminAddress;
}

function toUnixTimestamp(localDatetime: string): number {
  return Math.floor(new Date(localDatetime).getTime() / 1000);
}

type TxState =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'pending'; hash: string }
  | { phase: 'success'; hash: string; marketId?: number }
  | { phase: 'error'; message: string };

type ResolveState =
  | { phase: 'idle' }
  | { phase: 'triggering' }
  | { phase: 'started' }
  | { phase: 'error'; message: string };

// ─── Resolve form ─────────────────────────────────────────────────────────────

function ResolvePanel({
  market,
  onDone,
}: {
  market: OnChainMarket;
  onDone: () => void;
}) {
  const [outcome, setOutcome]   = useState<'YES' | 'NO'>('YES');
  const [resolveState, setResolveState] = useState<ResolveState>({ phase: 'idle' });

  const handleResolve = async () => {
    setResolveState({ phase: 'triggering' });
    try {
      await triggerOracleResolution(market.id, outcome === 'YES');
      setResolveState({ phase: 'started' });
      setTimeout(onDone, 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.slice(0, 160) : 'Failed.';
      setResolveState({ phase: 'error', message: msg });
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-slate-800 p-4 space-y-3">
      <p className="text-xs font-medium text-slate-400 truncate">{market.title}</p>
      {Date.now() / 1000 < market.expiryAt && (
        <p className="text-[11px] text-amber-300">
          Warning: market is not expired yet. Use only for manual override/testing.
        </p>
      )}
      <div className="flex gap-2">
        {(['YES', 'NO'] as const).map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => setOutcome(o)}
            className={cn(
              'flex-1 py-2 rounded-lg text-sm font-semibold transition-all border-2',
              o === 'YES'
                ? outcome === 'YES'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
                  : 'border-white/10 bg-slate-700 text-slate-400 hover:text-white'
                : outcome === 'NO'
                ? 'border-rose-500/30 bg-rose-500/10 text-rose-500'
                : 'border-white/10 bg-slate-700 text-slate-400 hover:text-white'
            )}
          >
            {o}
          </button>
        ))}
      </div>

      {resolveState.phase === 'started' ? (
        <p className="text-xs text-emerald-400 flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Oracle resolution started ({outcome})
        </p>
      ) : resolveState.phase === 'error' ? (
        <p className="text-xs text-rose-400">{resolveState.message}</p>
      ) : (
        <button
          onClick={handleResolve}
          disabled={resolveState.phase === 'triggering'}
          className="w-full h-9 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-900 font-semibold text-sm flex items-center justify-center gap-2 transition-colors"
        >
          {resolveState.phase === 'triggering' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Gavel className="h-4 w-4" />
          )}
          Trigger Oracle Resolve ({outcome})
        </button>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user, isLoading } = useFlowAuth();
  const walletClient = useFlowWalletClient();

  const [markets,       setMarkets]       = useState<OnChainMarket[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [createTx,      setCreateTx]      = useState<TxState>({ phase: 'idle' });
  const [showResolve,   setShowResolve]   = useState<number | null>(null);

  // Form state
  const [title,       setTitle]       = useState('');
  const [description, setDescription] = useState('');
  const [category,    setCategory]    = useState<typeof CATEGORIES[number]>('Crypto');
  const [resolution,  setResolution]  = useState('');
  const [expiryDate,  setExpiryDate]  = useState('');

  const adminOk = isAdmin(user.evmAddress);

  const loadMarkets = useCallback(async () => {
    setMarketsLoading(true);
    try {
      setMarkets(await readAllMarkets());
    } finally {
      setMarketsLoading(false);
    }
  }, []);

  useEffect(() => { loadMarkets(); }, [loadMarkets]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletClient || !GHOST_MARKET_ADDRESS) return;

    const expiryAt = toUnixTimestamp(expiryDate);
    if (expiryAt <= Date.now() / 1000) {
      setCreateTx({ phase: 'error', message: 'Expiry must be in the future.' });
      return;
    }

    setCreateTx({ phase: 'signing' });
    try {
      const [account] = await walletClient.getAddresses();
      const { request } = await publicClient.simulateContract({
        address: GHOST_MARKET_ADDRESS,
        abi: GHOST_MARKET_ABI,
        functionName: 'createMarket',
        args: [title, description, category, resolution, BigInt(expiryAt)],
        account,
        chain: flowTestnet,
      });
      const hash = await walletClient.writeContract(request);
      setCreateTx({ phase: 'pending', hash });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      // Parse MarketCreated event to get new ID
      const createdLog = receipt.logs.find((l) =>
        l.topics[0] === '0x' + 'MarketCreated'.padEnd(64, '0'), // rough check
      );
      const marketId = createdLog?.topics[1]
        ? parseInt(createdLog.topics[1], 16)
        : undefined;

      setCreateTx({ phase: 'success', hash, marketId });
      setTitle('');
      setDescription('');
      setResolution('');
      setExpiryDate('');
      await loadMarkets();
    } catch (err: unknown) {
      const msg = err instanceof Error
        ? err.message.includes('User rejected') ? 'Rejected.' : err.message.slice(0, 160)
        : 'Failed.';
      setCreateTx({ phase: 'error', message: msg });
    }
  };

  if (isLoading || user.evmLoading) {
    return (
      <div className="flex items-center justify-center py-40">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  if (!user.loggedIn) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20 text-center">
        <AlertCircle className="mx-auto mb-4 h-10 w-10 text-slate-600" />
        <h2 className="text-xl font-bold text-white mb-2">Sign in required</h2>
        <p className="text-slate-500">You must be signed in to access the admin panel.</p>
      </div>
    );
  }

  if (!adminOk) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20 text-center">
        <XCircle className="mx-auto mb-4 h-10 w-10 text-rose-600" />
        <h2 className="text-xl font-bold text-white mb-2">Access denied</h2>
        <p className="text-slate-500 text-sm mb-2">
          Connected address:{' '}
          <code className="text-slate-300 font-mono">{user.evmAddress}</code>
        </p>
        <p className="text-slate-600 text-xs">
          Set <code>NEXT_PUBLIC_ADMIN_ADDRESS</code> in <code>.env.local</code> to your deployer wallet.
        </p>
      </div>
    );
  }

  const activeMarkets   = markets.filter((m) => m.status === 0);
  const resolvedMarkets = markets.filter((m) => m.status === 1);
  const isCreateBusy    = createTx.phase === 'signing' || createTx.phase === 'pending';

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="space-y-10"
      >
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
            <Shield className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Market Admin</h1>
            <p className="text-sm text-slate-400 mt-0.5">Create and resolve prediction markets</p>
          </div>
        </div>

        {/* Contract info */}
        {GHOST_MARKET_ADDRESS && (
          <div className="rounded-xl border border-white/5 bg-slate-900 px-5 py-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-slate-500 mb-1">GhostMarket contract</p>
              <p className="font-mono text-sm text-slate-300">{GHOST_MARKET_ADDRESS}</p>
            </div>
            <a
              href={`${FLOWSCAN}/address/${GHOST_MARKET_ADDRESS}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Flowscan <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}

        {/* Create market form */}
        <section>
          <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
            <Plus className="h-5 w-5 text-indigo-400" />
            Create Market
          </h2>

          <form onSubmit={handleCreate} className="rounded-2xl border border-white/5 bg-slate-900 p-6 space-y-5">
            {/* Title */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                Title *
              </label>
              <input
                type="text"
                required
                maxLength={512}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Will ETH reach $20k by end of 2026?"
                className="w-full h-11 rounded-xl border border-white/10 bg-slate-800 px-4 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                Description / Resolution criteria *
              </label>
              <textarea
                required
                maxLength={512}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Resolves YES if ETH/USD trades at or above $20,000 on any major exchange..."
                className="w-full rounded-xl border border-white/10 bg-slate-800 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Category */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                  Category *
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as typeof CATEGORIES[number])}
                  className="w-full h-11 rounded-xl border border-white/10 bg-slate-800 px-4 text-sm text-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              {/* Expiry */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                  Expiry date/time *
                </label>
                <input
                  type="datetime-local"
                  required
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  className="w-full h-11 rounded-xl border border-white/10 bg-slate-800 px-4 text-sm text-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all [color-scheme:dark]"
                />
              </div>
            </div>

            {/* Resolution source */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                Resolution source *
              </label>
              <input
                type="text"
                required
                maxLength={512}
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                placeholder="Chainlink ETH/USD price feed"
                className="w-full h-11 rounded-xl border border-white/10 bg-slate-800 px-4 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all"
              />
            </div>

            {/* Feedback */}
            {createTx.phase === 'error' && (
              <div className="flex items-start gap-2 rounded-lg bg-rose-500/10 border border-rose-500/20 p-3">
                <AlertCircle className="h-4 w-4 text-rose-400 mt-0.5 shrink-0" />
                <p className="text-xs text-rose-300">{createTx.message}</p>
              </div>
            )}
            {createTx.phase === 'success' && (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <div>
                  <p className="text-xs text-emerald-300">
                    Market created{createTx.marketId ? ` as #${createTx.marketId}` : ''}!
                  </p>
                  <a
                    href={`${FLOWSCAN}/tx/${createTx.hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-emerald-400 underline underline-offset-2"
                  >
                    View transaction
                  </a>
                </div>
              </div>
            )}
            {createTx.phase === 'pending' && (
              <div className="flex items-center gap-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 p-3">
                <Loader2 className="h-4 w-4 text-indigo-400 animate-spin shrink-0" />
                <p className="text-xs text-indigo-300">Confirming on-chain…</p>
              </div>
            )}

            <button
              type="submit"
              disabled={isCreateBusy}
              className="w-full h-12 rounded-xl bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              {isCreateBusy ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> {createTx.phase === 'signing' ? 'Awaiting signature…' : 'Confirming…'}</>
              ) : (
                <><Plus className="h-4 w-4" /> Create Market</>
              )}
            </button>
          </form>
        </section>

        {/* Active markets — resolve */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Gavel className="h-5 w-5 text-amber-400" />
              Active Markets ({activeMarkets.length})
            </h2>
            <button
              onClick={loadMarkets}
              disabled={marketsLoading}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', marketsLoading && 'animate-spin')} />
              Refresh
            </button>
          </div>

          {marketsLoading ? (
            <div className="flex items-center justify-center p-10 text-slate-500 gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading markets…
            </div>
          ) : activeMarkets.length === 0 ? (
            <p className="text-sm text-slate-500">No active markets.</p>
          ) : (
            <div className="space-y-3">
              {activeMarkets.map((m) => {
                const expired = Date.now() / 1000 >= m.expiryAt;
                return (
                  <div key={m.id} className="rounded-2xl border border-white/5 bg-slate-900 p-5 space-y-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-mono text-slate-500">#{m.id}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400">
                            {m.category}
                          </span>
                          {expired && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
                              Expired — resolve now
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-medium text-white truncate">{m.title}</p>
                        <p className="text-xs text-slate-500 mt-1">
                          Pool: {(Number(m.yesPool + m.noPool) / 1e18).toFixed(4)} FLOW ·
                          YES {Math.round(m.yesPriceBps / 100)}¢ · Expires{' '}
                          {new Date(m.expiryAt * 1000).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        onClick={() => setShowResolve(showResolve === m.id ? null : m.id)}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/20 transition-colors"
                      >
                        {showResolve === m.id ? 'Cancel' : 'Resolve'}
                      </button>
                    </div>

                    {showResolve === m.id && (
                      <ResolvePanel
                        market={m}
                        onDone={() => {
                          setShowResolve(null);
                          loadMarkets();
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Resolved markets list */}
        {resolvedMarkets.length > 0 && (
          <section>
            <h2 className="text-lg font-bold text-white mb-4">
              Resolved Markets ({resolvedMarkets.length})
            </h2>
            <div className="space-y-2">
              {resolvedMarkets.map((m) => (
                <div
                  key={m.id}
                  className="rounded-xl border border-white/5 bg-slate-900/50 px-5 py-3 flex items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xs font-mono text-slate-500">#{m.id}</span>
                    <p className="text-sm text-slate-300 truncate">{m.title}</p>
                  </div>
                  <span className={cn(
                    'shrink-0 text-xs font-semibold px-2 py-1 rounded-full',
                    m.outcome ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400',
                  )}>
                    {m.outcome ? 'YES' : 'NO'} won
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </motion.div>
    </div>
  );
}
