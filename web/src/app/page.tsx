'use client';

import { useState, useMemo } from 'react';
import { HeroSection } from '@/components/hero-section';
import { SearchInput } from '@/components/search-input';
import { FilterBar } from '@/components/filter-bar';
import { SortControl, type SortOption } from '@/components/sort-control';
import { MarketGrid } from '@/components/market-grid';
import { mockMarkets } from '@/data/markets';

export default function HomePage() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [sort, setSort] = useState<SortOption>('trending');

  const filtered = useMemo(() => {
    let markets = [...mockMarkets];

    if (search.trim()) {
      const q = search.toLowerCase();
      markets = markets.filter(
        (m) =>
          m.title.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.category.toLowerCase().includes(q)
      );
    }

    if (category !== 'All') {
      markets = markets.filter((m) => m.category === category);
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
  }, [search, category, sort]);

  return (
    <>
      <HeroSection />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
          <SearchInput
            value={search}
            onChange={setSearch}
            className="flex-1 max-w-md"
          />
          <SortControl value={sort} onChange={setSort} />
        </div>

        <div className="mb-6">
          <FilterBar selected={category} onChange={setCategory} />
        </div>

        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-lg font-bold text-text">
            {category === 'All' ? 'All Markets' : category}
          </h2>
          <span className="text-sm text-text-muted">
            {filtered.length} market{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        <MarketGrid markets={filtered} />
      </div>
    </>
  );
}
