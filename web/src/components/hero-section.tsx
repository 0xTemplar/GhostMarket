'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ChevronRight, Shield } from 'lucide-react';

export function HeroSection() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 h-auto md:h-80 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
      {/* Big Banner */}
      <Link
        href="/"
        className="md:col-span-2 relative group rounded-2xl overflow-hidden cursor-pointer shadow-lg shadow-indigo-900/10 block h-full min-h-[200px] md:min-h-0"
      >
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-600 via-indigo-700 to-slate-900 transition-transform duration-700 group-hover:scale-[1.02]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(255,255,255,0.08)_0%,transparent_60%)]" />

        <div className="relative h-full flex flex-col justify-between p-8 z-10">
          <div className="space-y-2 max-w-md">
            <h1 className="text-3xl font-semibold text-white tracking-tight drop-shadow-md">
              Shielded Prediction Markets
            </h1>
            <p className="text-indigo-200 text-lg">
              Trade on outcomes. Your position size and intent stay private.
            </p>
          </div>

          <div className="flex items-end justify-between">
            <span className="bg-white/10 hover:bg-white/20 backdrop-blur-md text-white px-5 py-2.5 rounded-full text-sm font-medium flex items-center gap-2 border border-white/10 transition-all group/btn">
              Browse Markets
              <ChevronRight
                className="w-4 h-4 group-hover/btn:translate-x-0.5 transition-transform"
                strokeWidth={1.5}
              />
            </span>
            <div className="opacity-80 group-hover:opacity-100 transition-opacity transform translate-y-4 translate-x-4">
              <Shield className="w-32 h-32 text-white stroke-1 fill-white/10" />
            </div>
          </div>
        </div>
      </Link>

      {/* Small Banners */}
      <div className="flex flex-col gap-4 h-full">
        <Link
          href="/?cat=crypto"
          className="flex-1 relative rounded-2xl overflow-hidden group cursor-pointer border border-white/5 block min-h-[120px]"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-violet-600 to-indigo-900 transition-transform duration-500 group-hover:scale-[1.02]" />
          <div className="relative p-5 h-full flex flex-col justify-between">
            <div>
              <h3 className="text-lg font-medium text-white tracking-tight">
                2026 Crypto
              </h3>
              <p className="text-violet-200 text-sm mt-1">
                ETH, BTC & more
              </p>
            </div>
            <div className="flex justify-between items-end">
              <span className="bg-black/20 hover:bg-black/30 text-xs font-medium px-3 py-1.5 rounded-full text-white backdrop-blur-sm border border-white/10 transition-colors flex items-center gap-1">
                Markets
                <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
              </span>
              <span className="text-4xl font-bold text-white/20">2026</span>
            </div>
          </div>
        </Link>

        <Link
          href="/portfolio"
          className="flex-1 relative rounded-2xl overflow-hidden group cursor-pointer border border-white/5 block min-h-[120px]"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-rose-600 to-red-900 transition-transform duration-500 group-hover:scale-[1.02]" />
          <div className="relative p-5 h-full flex flex-col justify-between">
            <div>
              <h3 className="text-lg font-medium text-white tracking-tight">
                Portfolio
              </h3>
              <p className="text-rose-200 text-sm mt-1">
                Track positions & P&L
              </p>
            </div>
            <div className="flex justify-between items-end">
              <span className="bg-black/20 hover:bg-black/30 text-xs font-medium px-3 py-1.5 rounded-full text-white backdrop-blur-sm border border-white/10 transition-colors flex items-center gap-1">
                Dashboard
                <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
              </span>
              <div className="w-12 h-12 bg-rose-500 rounded-full opacity-50 blur-xl" />
            </div>
          </div>
        </Link>
      </div>
    </div>
  );
}
