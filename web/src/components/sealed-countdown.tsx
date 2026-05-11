'use client';

/**
 * SealedCountdown — overlay shown on a market card / page when a sealed-bid
 * window is active.
 *
 * Three visual states:
 *
 *  1. ACTIVE    — window is open, bets still accepted, countdown ticking.
 *                 Price strip is frozen (snapshot price shown with a "?" badge).
 *
 *  2. SETTLING  — window has expired, oracle is settling (10–30 s gap).
 *                 Bets blocked.  Shows a pulsing "Settling…" indicator.
 *
 *  3. REVEALED  — PriceRevealed event received.  Shows the new price for a
 *                 few seconds with a flash animation, then resets.
 */

import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Lock, Zap } from 'lucide-react';
import type { SealedWindowInfo, PriceRevealedEvent } from '@/lib/eamm';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SealedCountdownProps {
  /** The currently active sealed window, or null if none. */
  window:        SealedWindowInfo | null;
  /** Latest PriceRevealed event, or null if not yet revealed. */
  revealed:      PriceRevealedEvent | null;
  /** Pre-window YES price (0–100). Shown frozen during the window. */
  snapshotYes:   number | null;
  /** Pre-window NO price (0–100). */
  snapshotNo:    number | null;
  /** Called when the component detects the window has expired locally. */
  onWindowExpired?: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return '0:00';
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function impliedPrice(yes: bigint, no: bigint): { yes: number; no: number } {
  const total = yes + no;
  if (total === 0n) return { yes: 50, no: 50 };
  const yesPct = Math.round((Number(yes) / Number(total)) * 100);
  return { yes: yesPct, no: 100 - yesPct };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SealedCountdown({
  window:    win,
  revealed,
  snapshotYes,
  snapshotNo,
  onWindowExpired,
}: SealedCountdownProps) {
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [phase, setPhase]             = useState<'active' | 'settling' | 'revealed'>('active');
  const [showReveal, setShowReveal]   = useState(false);
  const expiredRef                    = useRef(false);

  // Countdown ticker
  useEffect(() => {
    if (!win) return;

    const tick = () => {
      const now  = Math.floor(Date.now() / 1000);
      const left = win.endsAt - now;

      if (left > 0) {
        setSecondsLeft(left);
        setPhase('active');
        expiredRef.current = false;
      } else if (!expiredRef.current) {
        expiredRef.current = true;
        setSecondsLeft(0);
        setPhase('settling');
        onWindowExpired?.();
      }
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [win, onWindowExpired]);

  // React to PriceRevealed
  useEffect(() => {
    if (!revealed) return;
    setPhase('revealed');
    setShowReveal(true);
    const id = setTimeout(() => setShowReveal(false), 5000);
    return () => clearTimeout(id);
  }, [revealed]);

  if (!win && !revealed) return null;

  // ── REVEALED flash ─────────────────────────────────────────────────────────
  if (phase === 'revealed' && revealed && showReveal) {
    const prices = impliedPrice(revealed.yesTotal, revealed.noTotal);
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-center gap-3 animate-pulse-once">
        <Zap className="w-4 h-4 text-emerald-400 shrink-0" strokeWidth={1.5} />
        <div className="flex-1">
          <p className="text-xs font-semibold text-emerald-300 uppercase tracking-widest mb-1">
            Price revealed
          </p>
          <div className="flex gap-4 text-sm font-mono">
            <span className="text-emerald-300">YES <strong>{prices.yes}¢</strong></span>
            <span className="text-red-300">NO <strong>{prices.no}¢</strong></span>
          </div>
        </div>
        <Eye className="w-4 h-4 text-emerald-500 shrink-0" strokeWidth={1.5} />
      </div>
    );
  }

  // ── SETTLING state ─────────────────────────────────────────────────────────
  if (phase === 'settling') {
    return (
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
        <div className="flex-1">
          <p className="text-xs font-semibold text-amber-300 uppercase tracking-widest">
            Window closed — settling
          </p>
          <p className="text-xs text-amber-300/60 mt-0.5">
            Oracle is decrypting pool totals via Zama gateway…
          </p>
        </div>
        <Lock className="w-4 h-4 text-amber-500/50 shrink-0" strokeWidth={1.5} />
      </div>
    );
  }

  // ── ACTIVE window ──────────────────────────────────────────────────────────
  return (
    <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/8 px-4 py-3 space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <EyeOff className="w-4 h-4 text-indigo-400 shrink-0" strokeWidth={1.5} />
          <span className="text-xs font-semibold text-indigo-300 uppercase tracking-widest">
            Sealed-bid window
          </span>
        </div>
        <span className="text-xl font-mono font-bold text-indigo-200 tabular-nums">
          {formatCountdown(secondsLeft)}
        </span>
      </div>

      {/* Frozen price */}
      {snapshotYes !== null && snapshotNo !== null && (
        <div className="flex gap-3 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/50" />
            <span className="text-slate-400 text-xs">YES</span>
            <span className="font-mono text-slate-300 text-xs">{snapshotYes}¢</span>
            <span className="text-slate-600 text-xs">frozen</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400/50" />
            <span className="text-slate-400 text-xs">NO</span>
            <span className="font-mono text-slate-300 text-xs">{snapshotNo}¢</span>
            <span className="text-slate-600 text-xs">frozen</span>
          </div>
        </div>
      )}

      {/* Blind bet notice */}
      <p className="text-xs text-indigo-300/60">
        Bets are accepted but prices are hidden until the window closes.
        No front-running possible — even the oracle can&apos;t read the pools yet.
      </p>
    </div>
  );
}
