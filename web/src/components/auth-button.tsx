'use client';

import { useState, useRef, useEffect } from 'react';
import { LogOut, Copy, ExternalLink, ChevronDown } from 'lucide-react';
import { useFlowAuth } from '@/lib/flow/provider';
import { cn } from '@/lib/utils';

function shortenAddr(addr: string, chars = 4): string {
  if (addr.startsWith('0x')) {
    return `${addr.slice(0, chars + 2)}…${addr.slice(-chars)}`;
  }
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AuthButton() {
  const { user, login, logout, isLoading } = useFlowAuth();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Show skeleton while Privy rehydrates — avoids "Sign in" flash on navigation
  if (isLoading) {
    return <div className="w-28 h-9 rounded-full bg-white/5 animate-pulse" />;
  }

  if (!user.loggedIn) {
    return (
      <button
        onClick={login}
        className="px-5 py-2 rounded-full text-sm font-semibold whitespace-nowrap bg-indigo-500 hover:bg-indigo-400 text-white transition-all shadow-[0_0_20px_rgba(99,102,241,0.25)] active:scale-95"
      >
        Sign in
      </button>
    );
  }

  const displayAddr = user.evmAddress ?? user.addr ?? '';
  const evmHref = user.evmAddress
    ? `https://sepolia.etherscan.io/address/${user.evmAddress}`
    : undefined;

  function copyAddr() {
    navigator.clipboard.writeText(displayAddr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-fit flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium border transition-all',
          open
            ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300'
            : 'bg-white/5 border-white/10 hover:bg-white/10 text-slate-200',
        )}
      >
        {/* avatar dot */}
        <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
        <span className="font-mono text-[13px] tabular-nums min-w-[7.5rem] text-left">
          {shortenAddr(displayAddr)}
        </span>
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 transition-transform',
            open && 'rotate-180',
          )}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur-md shadow-2xl shadow-black/50 z-50 overflow-hidden">
          {/* Header */}
          <div className="px-4 pt-4 pb-3 border-b border-white/5">
            <p className="text-xs text-slate-500 mb-1">Ethereum Sepolia</p>
            <p className="text-sm font-mono text-slate-200 truncate">
              {displayAddr}
            </p>
          </div>

          <div className="p-2">
            <button
              onClick={copyAddr}
              className="flex items-center gap-3 w-full px-3 py-2 text-sm text-slate-300 hover:bg-white/5 rounded-lg transition-colors"
            >
              <Copy className="w-4 h-4 text-slate-500" strokeWidth={1.5} />
              {copied ? 'Copied!' : 'Copy address'}
            </button>

            {evmHref && (
              <a
                href={evmHref}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 w-full px-3 py-2 text-sm text-slate-300 hover:bg-white/5 rounded-lg transition-colors"
              >
                <ExternalLink
                  className="w-4 h-4 text-slate-500"
                  strokeWidth={1.5}
                />
                View on Etherscan
              </a>
            )}

            <a
              href="/vault"
              className="flex items-center gap-3 w-full px-3 py-2 text-sm text-slate-300 hover:bg-white/5 rounded-lg transition-colors"
            >
              <span className="w-4 h-4 flex items-center justify-center text-slate-500 text-xs font-bold">
                $
              </span>
              Vault & deposits
            </a>

            <div className="my-2 h-px bg-white/5" />

            <button
              onClick={() => {
                logout();
                setOpen(false);
              }}
              className="flex items-center gap-3 w-full px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
            >
              <LogOut className="w-4 h-4" strokeWidth={1.5} />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
