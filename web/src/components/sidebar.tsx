'use client';

import Link from 'next/link';
import { Wallet, Star, ChevronRight, TrendingUp, Users, BarChart2, Shield } from 'lucide-react';

// ─── Platform stats ────────────────────────────────────────────────────────────

const PLATFORM_STATS = [
  { label: '24h Volume',  value: '$1.4M',  icon: TrendingUp, color: 'text-indigo-400',  bg: 'bg-indigo-500/10'  },
  { label: 'Traders',     value: '18.4K',  icon: Users,      color: 'text-violet-400',  bg: 'bg-violet-500/10'  },
  { label: 'Markets',     value: '47',     icon: BarChart2,  color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  { label: 'Shielded',    value: '100%',   icon: Shield,     color: 'text-cyan-400',    bg: 'bg-cyan-500/10'    },
];

// ─── Trending topics ───────────────────────────────────────────────────────────

const trendingTopics = [
  { label: 'Crypto',   href: '/?cat=crypto',   color: 'hover:border-violet-500/40 hover:text-violet-300' },
  { label: 'Macro',    href: '/?cat=macro',    color: 'hover:border-amber-500/40  hover:text-amber-300'  },
  { label: 'Politics', href: '/?cat=politics', color: 'hover:border-blue-500/40   hover:text-blue-300'   },
  { label: 'Tech',     href: '/?cat=tech',     color: 'hover:border-cyan-500/40   hover:text-cyan-300'   },
  { label: 'Sports',   href: '/?cat=sports',   color: 'hover:border-green-500/40  hover:text-green-300'  },
  { label: 'Climate',  href: '/?cat=climate',  color: 'hover:border-teal-500/40   hover:text-teal-300'   },
  { label: 'Bitcoin',  href: '/?cat=crypto',   color: 'hover:border-violet-500/40 hover:text-violet-300' },
  { label: 'ETH',      href: '/?cat=crypto',   color: 'hover:border-violet-500/40 hover:text-violet-300' },
];

// ─── Recent activity ──────────────────────────────────────────────────────────

const recentActivity = [
  {
    market: 'Will ETH trade above $10,000 before April 2026?',
    user: '0x7a3f…',
    side: 'Yes' as const,
    price: '42¢',
    amount: '$120',
    minsAgo: 1,
  },
  {
    market: 'Will the Fed cut rates in Q2 2026?',
    user: 'fmichael',
    side: 'No' as const,
    price: '32¢',
    amount: '$85',
    minsAgo: 3,
  },
  {
    market: 'Will BTC reach $150K by end of 2026?',
    user: '0x9c1a…',
    side: 'Yes' as const,
    price: '31¢',
    amount: '$200',
    minsAgo: 7,
  },
];

// ─── Component ─────────────────────────────────────────────────────────────────

export function Sidebar() {
  return (
    <div className="space-y-5">

      {/* ── Platform stats ── */}
      <div className="bg-slate-900 rounded-2xl p-5 border border-white/5">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-white text-sm">Platform</h3>
          <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {PLATFORM_STATS.map((stat) => (
            <div
              key={stat.label}
              className="bg-slate-800/50 rounded-xl p-3 border border-white/5 hover:border-white/10 transition-colors"
            >
              <div className={`${stat.bg} w-7 h-7 rounded-lg flex items-center justify-center mb-2`}>
                <stat.icon className={`w-3.5 h-3.5 ${stat.color}`} strokeWidth={1.5} />
              </div>
              <div className={`text-base font-bold leading-tight ${stat.color}`}>{stat.value}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{stat.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Portfolio widget ── */}
      <div className="bg-slate-900 rounded-2xl p-5 border border-white/5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg text-indigo-400">
              <Wallet className="w-5 h-5" strokeWidth={1.5} />
            </div>
            <div>
              <h3 className="font-medium text-white text-sm">Portfolio</h3>
              <p className="text-xs text-slate-500 mt-0.5">Deposit to start trading</p>
            </div>
          </div>
        </div>
        <Link
          href="/portfolio"
          className="w-full bg-slate-800 hover:bg-slate-700/80 text-white py-2.5 rounded-xl text-sm font-medium transition-colors border border-white/5 hover:border-white/10 flex items-center justify-between px-4 group"
        >
          <span>View Portfolio</span>
          <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-white transition-colors" strokeWidth={1.5} />
        </Link>
      </div>

      {/* ── Watchlist widget ── */}
      <div className="bg-slate-900 rounded-2xl p-5 border border-white/5">
        <div className="flex items-start gap-3 mb-2">
          <div className="p-2 bg-amber-500/10 rounded-lg text-amber-500">
            <Star className="w-5 h-5" strokeWidth={1.5} />
          </div>
          <div>
            <h3 className="font-medium text-white text-sm">Watchlist</h3>
            <p className="text-xs text-slate-500 mt-0.5 max-w-[200px]">
              Click ★ on any market to add it
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Link href="/" className="text-xs font-medium text-slate-400 hover:text-white flex items-center gap-1 transition-colors">
            Trending <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
          </Link>
        </div>
      </div>

      {/* ── Trending Topics ── */}
      <div className="bg-slate-900 rounded-2xl p-5 border border-white/5">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-medium text-white text-sm">Trending Topics</h3>
          <Link href="/" className="text-xs text-slate-500 hover:text-white transition-colors">See all</Link>
        </div>
        <div className="flex flex-wrap gap-2">
          {trendingTopics.map((topic) => (
            <Link
              key={topic.label}
              href={topic.href}
              className={`bg-slate-800/70 text-xs px-3 py-1.5 rounded-lg text-slate-400 border border-white/5 transition-all duration-200 ${topic.color}`}
            >
              {topic.label}
            </Link>
          ))}
        </div>
      </div>

      {/* ── Recent Activity ── */}
      <div className="bg-slate-900 rounded-2xl p-5 border border-white/5">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-medium text-white text-sm">Recent Activity</h3>
          <span className="flex items-center gap-1 text-[10px] text-slate-500">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
            Live feed
          </span>
        </div>
        <div className="space-y-4">
          {recentActivity.map((item, i) => (
            <div key={i} className="flex gap-3 items-start group">
              <div className="w-7 h-7 rounded-full bg-slate-800 shrink-0 border border-white/5 flex items-center justify-center text-[10px] font-bold text-slate-500">
                {item.user.slice(0, 2).toUpperCase()}
              </div>
              <div className="text-xs min-w-0 flex-1">
                <p className="text-slate-300 line-clamp-1 leading-tight group-hover:text-white transition-colors">
                  {item.market}
                </p>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  <span className="text-indigo-400">{item.user}</span>
                  <span className="text-slate-600">bought</span>
                  <span className={item.side === 'Yes' ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                    {item.side}
                  </span>
                  <span className="text-slate-500">at {item.price}</span>
                  <span className="text-slate-600 font-medium">{item.amount}</span>
                  <span className="text-slate-700 ml-auto">{item.minsAgo}m ago</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 pt-3 border-t border-white/5">
          <Link href="/" className="text-xs text-slate-500 hover:text-white flex items-center gap-1 justify-center transition-colors">
            View all activity <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
          </Link>
        </div>
      </div>

    </div>
  );
}
