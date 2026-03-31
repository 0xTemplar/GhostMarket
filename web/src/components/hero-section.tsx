'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  ChevronRight,
  Shield,
  Lock,
  ArrowUpRight,
  Activity,
} from 'lucide-react';

// ─── Platform stats ────────────────────────────────────────────────────────────

const PLATFORM_STATS = [
  { label: 'Active Markets', value: '12'    },
  { label: 'Oracle Agents',  value: '7'     },
  { label: 'Tests Passing',  value: '101'   },
  { label: 'Privacy',        value: '100%'  },
];

// ─── Live ticker data ──────────────────────────────────────────────────────────

const TICKER_ITEMS = [
  { title: 'ETH > $10K', yes: 42, change: -2 },
  { title: 'Fed Rate Cut Q2', yes: 68, change: 1 },
  { title: 'BTC $150K', yes: 31, change: 3 },
  { title: 'OpenAI IPO 2026', yes: 38, change: 0 },
  { title: 'SOL > ETH mcap', yes: 9, change: 2 },
  { title: 'US Recession', yes: 19, change: 1 },
  { title: 'EU AI Act Fine', yes: 24, change: -1 },
  { title: 'Arctic Ice Record', yes: 33, change: -1 },
];

const HERO_CARD_IMAGES = {
  main:
    'https://images.unsplash.com/photo-1642104704074-907c0698cbd9?auto=format&fit=crop&w=1600&q=80',
  crypto:
    'https://images.unsplash.com/photo-1621761191319-c6fb62004040?auto=format&fit=crop&w=1200&q=80',
  portfolio:
    'https://images.unsplash.com/photo-1642790106117-e829e14a795f?auto=format&fit=crop&w=1200&q=80',
} as const;

function RightBlendLayer({
  imageUrl,
  widthClass = 'w-[52%]',
  tintColor = 'rgba(15,23,42,0.22)',
}: {
  imageUrl: string;
  widthClass?: string;
  tintColor?: string;
}) {
  const blendMask =
    'linear-gradient(to left, rgba(0,0,0,1) 48%, rgba(0,0,0,0.88) 63%, rgba(0,0,0,0.34) 82%, rgba(0,0,0,0.06) 94%, transparent 100%)';

  return (
    <div className={`absolute inset-y-0 right-0 ${widthClass} pointer-events-none`}>
      <div
        className="absolute inset-0 opacity-[0.9]"
        style={{
          backgroundImage: `url("${imageUrl}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: 'brightness(0.78) saturate(1.05) contrast(1.03)',
          WebkitMaskImage: blendMask,
          maskImage: blendMask,
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(to left, rgba(2,6,23,0.82) 0%, rgba(2,6,23,0.48) 46%, ${tintColor} 76%, rgba(2,6,23,0.08) 100%)`,
          WebkitMaskImage: blendMask,
          maskImage: blendMask,
        }}
      />
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function HeroSection() {
  return (
    <div className="relative overflow-hidden">
      {/* ── Background layers ── */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(99,102,241,0.18),transparent)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_40%_60%_at_85%_50%,rgba(139,92,246,0.07),transparent)]" />
      <div
        className="absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-8 pb-2">
        {/* ── Hero banner grid ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 h-auto md:h-72">
          {/* Big banner */}
          <Link
            href="/"
            className="md:col-span-2 relative group rounded-2xl overflow-hidden cursor-pointer block h-full min-h-[200px] md:min-h-0"
          >
            <div className="absolute inset-0 bg-linear-to-br from-indigo-600/95 via-indigo-700 to-slate-900 transition-transform duration-700 group-hover:scale-[1.015]" />
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.12),transparent_55%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,rgba(99,102,241,0.3),transparent_60%)]" />
            <RightBlendLayer
              imageUrl={HERO_CARD_IMAGES.main}
              tintColor="rgba(30,41,59,0.2)"
            />

            {/* Rotating decorative rings */}
            {[160, 240, 320].map((size, i) => (
              <motion.div
                key={i}
                className="absolute rounded-full border border-white/4"
                style={{
                  width: size,
                  height: size,
                  right: -size / 3,
                  top: -size / 3,
                }}
                animate={{ rotate: [0, 360] }}
                transition={{
                  duration: 25 + i * 12,
                  repeat: Infinity,
                  ease: 'linear',
                }}
              />
            ))}

            <div className="relative h-full flex flex-col justify-between p-8 z-10">
              <div className="space-y-3 max-w-lg">
                {/* <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4 }}
                >
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-white/10 text-indigo-200 border border-white/15 backdrop-blur-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live on Flow EVM · FHE-Encrypted Execution
                  </span>
                </motion.div> */}

                <motion.h1
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.06 }}
                  className="text-3xl md:text-4xl font-bold text-white tracking-tight leading-tight"
                >
                  Trade on outcomes.{' '}
                  <span className="text-indigo-300">Stay shielded.</span>
                </motion.h1>

                <motion.p
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.12 }}
                  className="text-indigo-200/75 text-sm md:text-base leading-relaxed"
                >
                  Your position size stays private. Resolved by a transparent
                  multi-agent oracle anchored on Filecoin.
                </motion.p>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.18 }}
                className="flex items-end justify-between"
              >
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="bg-white/15 hover:bg-white/25 backdrop-blur-md text-white px-5 py-2.5 rounded-full text-sm font-semibold flex items-center gap-2 border border-white/15 transition-all group/btn shadow-lg">
                    Browse Markets
                    <ChevronRight
                      className="w-4 h-4 group-hover/btn:translate-x-0.5 transition-transform"
                      strokeWidth={2}
                    />
                  </span>
                  <span className="bg-white/5 hover:bg-white/10 text-indigo-200/80 px-4 py-2.5 rounded-full text-sm flex items-center gap-1.5 border border-white/10 transition-all cursor-pointer">
                    <Lock className="w-3.5 h-3.5" strokeWidth={1.5} />
                    How privacy works
                  </span>
                </div>

                {/* Animated shield */}
                <div className="relative shrink-0 opacity-55 group-hover:opacity-85 transition-opacity duration-500">
                  <motion.div
                    className="absolute inset-0 rounded-full bg-indigo-500/25 blur-3xl"
                    animate={{ scale: [1, 1.25, 1] }}
                    transition={{ duration: 4, repeat: Infinity }}
                  />
                  <Shield className="relative w-24 h-24 text-white/15 stroke-1 fill-white/5" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Lock
                      className="w-9 h-9 text-indigo-300/70"
                      strokeWidth={1.5}
                    />
                  </div>
                </div>
              </motion.div>
            </div>
          </Link>

          {/* Side banners */}
          <div className="flex flex-col gap-4 h-full">
            {/* Crypto */}
            <Link
              href="/?cat=crypto"
              className="flex-1 relative rounded-2xl overflow-hidden group cursor-pointer border border-white/5 hover:border-violet-500/30 block min-h-[120px] transition-colors"
            >
              <div className="absolute inset-0 bg-linear-to-br from-violet-700 to-indigo-950 transition-transform duration-500 group-hover:scale-[1.02]" />
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,rgba(139,92,246,0.4),transparent_70%)]" />
              <RightBlendLayer
                widthClass="w-[58%]"
                imageUrl={HERO_CARD_IMAGES.crypto}
                tintColor="rgba(67,56,202,0.22)"
              />
              <div className="relative p-5 h-full flex flex-col justify-between">
                <div>
                  <div className="text-[10px] font-bold text-violet-300/70 uppercase tracking-widest mb-1">
                    Crypto Markets
                  </div>
                  <h3 className="text-xl font-bold text-white tracking-tight">
                    ETH · BTC · SOL
                  </h3>
                  <p className="text-violet-200/60 text-xs mt-1">
                    8 active markets
                  </p>
                </div>
                <div className="flex justify-between items-end">
                  <span className="bg-black/25 hover:bg-black/40 text-xs font-semibold px-3 py-1.5 rounded-full text-white backdrop-blur-sm border border-white/10 transition-colors flex items-center gap-1">
                    Browse <ArrowUpRight className="w-3 h-3" />
                  </span>
                  <span className="text-4xl font-black text-white/5 leading-none select-none tracking-tighter">
                    BTC
                  </span>
                </div>
              </div>
            </Link>

            {/* Portfolio */}
            <Link
              href="/portfolio"
              className="flex-1 relative rounded-2xl overflow-hidden group cursor-pointer border border-white/5 hover:border-emerald-500/30 block min-h-[120px] transition-colors"
            >
              <div className="absolute inset-0 bg-linear-to-br from-emerald-800 to-teal-950 transition-transform duration-500 group-hover:scale-[1.02]" />
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(52,211,153,0.25),transparent_65%)]" />
              <RightBlendLayer
                widthClass="w-[58%]"
                imageUrl={HERO_CARD_IMAGES.portfolio}
                tintColor="rgba(5,150,105,0.2)"
              />
              <div className="relative p-5 h-full flex flex-col justify-between">
                <div>
                  <div className="text-[10px] font-bold text-emerald-300/70 uppercase tracking-widest mb-1">
                    Portfolio
                  </div>
                  <h3 className="text-xl font-bold text-white tracking-tight">
                    +7.01% P&L
                  </h3>
                  <p className="text-emerald-200/60 text-xs mt-1">
                    3 open positions
                  </p>
                </div>
                <div className="flex justify-between items-end">
                  <span className="bg-black/25 hover:bg-black/40 text-xs font-semibold px-3 py-1.5 rounded-full text-white backdrop-blur-sm border border-white/10 transition-colors flex items-center gap-1">
                    Dashboard <ArrowUpRight className="w-3 h-3" />
                  </span>
                  {/* Mini sparkline bars */}
                  <div className="flex items-end gap-0.5">
                    {[3, 5, 4, 6, 5, 7, 6, 8].map((h, i) => (
                      <div
                        key={i}
                        className="w-1.5 rounded-sm bg-emerald-400/35"
                        style={{ height: h * 3 }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </Link>
          </div>
        </div>

        {/* ── Stats strip ── */}
        <div className="mt-4 flex items-center gap-6 border-t border-b border-white/5 py-3.5">
          {PLATFORM_STATS.map((stat, i) => (
            <div key={stat.label} className="flex items-baseline gap-2">
              <span className="text-base font-bold text-white tabular-nums">{stat.value}</span>
              <span className="text-xs text-slate-500">{stat.label}</span>
              {i < PLATFORM_STATS.length - 1 && (
                <span className="ml-4 text-white/8 select-none">|</span>
              )}
            </div>
          ))}
        </div>

        {/* ── Live market ticker ── */}
        <div className="mt-3 relative overflow-hidden rounded-xl bg-slate-900/50 border border-white/5 h-9 flex items-center">
          {/* Edge fades */}
          <div className="absolute left-0 z-10 h-full w-20 bg-linear-to-r from-surface to-transparent pointer-events-none" />
          <div className="absolute right-0 z-10 h-full w-20 bg-linear-to-l from-surface to-transparent pointer-events-none" />
          {/* Label */}
          <div className="absolute left-0 z-20 h-full flex items-center px-3 gap-1 text-[10px] font-bold text-indigo-400 uppercase tracking-widest">
            <Activity className="w-3 h-3" strokeWidth={2} />
            Live
          </div>

          {/* Scrolling content */}
          <motion.div
            className="flex items-center gap-6 pl-16 pr-4"
            animate={{ x: ['0%', '-50%'] }}
            transition={{ duration: 45, repeat: Infinity, ease: 'linear' }}
            style={{ willChange: 'transform' }}
          >
            {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
              <span
                key={i}
                className="flex items-center gap-2 text-xs whitespace-nowrap"
              >
                <span className="text-slate-300 font-medium">{item.title}</span>
                <span
                  className={`font-mono font-semibold ${item.yes >= 50 ? 'text-emerald-400' : 'text-rose-400'}`}
                >
                  {item.yes}¢
                </span>
                {item.change !== 0 && (
                  <span
                    className={`text-[10px] ${item.change > 0 ? 'text-emerald-500' : 'text-rose-500'}`}
                  >
                    {item.change > 0 ? '▲' : '▼'}
                    {Math.abs(item.change)}%
                  </span>
                )}
                <span className="text-white/10 text-base leading-none">·</span>
              </span>
            ))}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
