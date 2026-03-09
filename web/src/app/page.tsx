'use client';

import { useState, useMemo, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { HeroSection } from '@/components/hero-section';
import { FilterBar } from '@/components/filter-bar';
import { SortControl, type SortOption } from '@/components/sort-control';
import { MarketCard } from '@/components/market-card';
import { Sidebar } from '@/components/sidebar';
import { mockMarkets } from '@/data/markets';

function HomeContent() {
  const searchParams = useSearchParams();
  const catFromUrl = searchParams.get('cat');
  const [category, setCategory] = useState(catFromUrl ? capitalize(catFromUrl) : 'All');
  const [sort, setSort] = useState<SortOption>('trending');

  useEffect(() => {
    if (catFromUrl) setCategory(capitalize(catFromUrl));
  }, [catFromUrl]);

  const filtered = useMemo(() => {
    let markets = [...mockMarkets];

    if (category !== 'All') {
      const catMap: Record<string, string> = {
        'For You': 'All',
        Politics: 'Politics',
        Sports: 'Sports',
        Crypto: 'Crypto',
        Macro: 'Macro',
        Tech: 'Tech',
        Climate: 'Climate',
      };
      const target = catMap[category] ?? category;
      if (target !== 'All') {
        markets = markets.filter((m) => m.category === target);
      }
    }

    switch (sort) {
      case 'volume':
        markets.sort((a, b) => b.volume - a.volume);
        break;
      case 'newest':
        markets.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        break;
      case 'ending-soon':
        markets.sort(
          (a, b) =>
            new Date(a.expiryAt).getTime() - new Date(b.expiryAt).getTime()
        );
        break;
      case 'trending':
      default:
        markets.sort((a, b) => {
          if (a.trending !== b.trending) return a.trending ? -1 : 1;
          return b.volume - a.volume;
        });
    }

    return markets;
  }, [category, sort]);

  return (
    <>
      <HeroSection />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
          {/* Left Column */}
          <div className="xl:col-span-9 space-y-8">
            {/* Filters & Controls */}
            <div className="flex flex-col md:flex-row items-center justify-between gap-4 py-2">
              <FilterBar selected={category} onChange={setCategory} />
              <SortControl value={sort} onChange={setSort} />
            </div>

            {/* Markets Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {filtered.map((market, i) => (
                <MarketCard
                  key={market.id}
                  market={market}
                  index={i}
                  variant={i === 0 ? 'highlight' : 'compact'}
                />
              ))}
            </div>

            {filtered.length === 0 && (
              <div className="rounded-2xl border border-white/5 bg-slate-900 p-12 text-center">
                <p className="text-slate-500">No markets found.</p>
              </div>
            )}
          </div>

          {/* Right Sidebar */}
          <div className="xl:col-span-3">
            <Sidebar />
          </div>
        </div>
      </div>
    </>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export default function HomePage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 animate-pulse">Loading...</div>}>
      <HomeContent />
    </Suspense>
  );
}
