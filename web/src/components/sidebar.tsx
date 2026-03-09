'use client';

import Link from 'next/link';
import { Wallet, Star, ChevronRight } from 'lucide-react';

const trendingTopics = [
  'Crypto',
  'Macro',
  'Politics',
  'Tech',
  'Sports',
  'Climate',
  'Bitcoin',
  'ETH',
];

const recentActivity = [
  {
    market: 'Will ETH trade above $10,000 before April 2026?',
    user: '0x7a3f...',
    side: 'Yes',
    price: '42¢',
    amount: '$120',
  },
  {
    market: 'Will the Fed cut rates in Q2 2026?',
    user: 'fmichael',
    side: 'No',
    price: '32¢',
    amount: '$85',
  },
];

export function Sidebar() {
  return (
    <div className="space-y-6">
      {/* Portfolio Widget */}
      <div className="bg-slate-900 rounded-2xl p-5 border border-white/5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg text-indigo-400">
              <Wallet className="w-5 h-5" strokeWidth={1.5} />
            </div>
            <div>
              <h3 className="font-medium text-white">Portfolio</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Deposit to start trading
              </p>
            </div>
          </div>
        </div>
        <Link
          href="/portfolio"
          className="w-full bg-slate-800 hover:bg-slate-700 text-white py-2 rounded-lg text-sm font-medium transition-colors border border-white/5 flex items-center justify-between px-4 group"
        >
          <span>View Portfolio</span>
          <ChevronRight
            className="w-4 h-4 text-slate-500 group-hover:text-white transition-colors"
            strokeWidth={1.5}
          />
        </Link>
      </div>

      {/* Watchlist Widget */}
      <div className="bg-slate-900 rounded-2xl p-5 border border-white/5">
        <div className="flex items-start gap-3 mb-2">
          <div className="p-2 bg-amber-500/10 rounded-lg text-amber-500">
            <Star className="w-5 h-5" strokeWidth={1.5} />
          </div>
          <div>
            <h3 className="font-medium text-white">Watchlist</h3>
            <p className="text-xs text-slate-500 mt-0.5 max-w-[200px]">
              Click the star on any market to add it
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Link
            href="/"
            className="text-xs font-medium text-slate-400 hover:text-white flex items-center gap-1"
          >
            Trending
            <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
          </Link>
        </div>
      </div>

      {/* Trending Topics */}
      <div className="bg-slate-900 rounded-2xl p-5 border border-white/5">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-medium text-white">Trending Topics</h3>
          <Link href="/" className="text-xs text-slate-500 hover:text-white">
            See all
          </Link>
        </div>
        <div className="flex flex-wrap gap-2">
          {trendingTopics.map((topic) => (
            <Link
              key={topic}
              href={`/?cat=${topic.toLowerCase()}`}
              className="bg-slate-800 hover:bg-slate-700 text-xs px-3 py-1.5 rounded-md text-slate-300 cursor-pointer border border-white/5 transition-colors"
            >
              {topic}
            </Link>
          ))}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="bg-slate-900 rounded-2xl p-5 border border-white/5">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-medium text-white">Recent Activity</h3>
          <Link href="/" className="text-xs text-slate-500 hover:text-white">
            See all
          </Link>
        </div>
        <div className="space-y-4">
          {recentActivity.map((item, i) => (
            <div key={i} className="flex gap-3 items-start">
              <div className="w-8 h-8 rounded-full bg-slate-800 shrink-0" />
              <div className="text-sm min-w-0">
                <p className="text-slate-300 line-clamp-1">{item.market}</p>
                <p className="text-slate-500 text-xs mt-0.5">
                  <span className="text-indigo-400">{item.user}</span> bought{' '}
                  <span
                    className={
                      item.side === 'Yes' ? 'text-emerald-400' : 'text-rose-400'
                    }
                  >
                    {item.side}
                  </span>{' '}
                  at {item.price}{' '}
                  <span className="text-slate-600">{item.amount}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
