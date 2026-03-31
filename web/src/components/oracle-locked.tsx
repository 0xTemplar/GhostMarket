'use client';

import { motion } from 'framer-motion';
import { ShieldAlert, Lock } from 'lucide-react';

export function OracleLocked() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="flex flex-col items-center gap-6 text-center"
      >
        {/* Icon stack */}
        <div className="relative flex items-center justify-center">
          <div className="absolute h-24 w-24 rounded-full bg-red-500/10 blur-2xl" />
          <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-red-500/20 bg-slate-950/80">
            <ShieldAlert className="h-8 w-8 text-red-400" />
            <span className="absolute -bottom-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 ring-1 ring-slate-800">
              <Lock className="h-2.5 w-2.5 text-slate-400" />
            </span>
          </div>
        </div>

        {/* Text */}
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-white">
            Oracle Room — Restricted
          </h1>
          <p className="max-w-sm text-sm leading-relaxed text-slate-400">
            This area is currently limited to internal operators.
            <br />
            Oracle swarm controls are not publicly available at this time.
          </p>
        </div>

        {/* Status badge */}
        <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-4 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
          <span className="text-xs font-medium text-slate-400 uppercase tracking-widest">
            Admin only
          </span>
        </div>
      </motion.div>
    </div>
  );
}
