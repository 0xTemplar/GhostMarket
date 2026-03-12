'use client';

import { useState, useMemo, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { HeroSection } from '@/components/hero-section';
import { FilterBar } from '@/components/filter-bar';
import { SortControl, type SortOption } from '@/components/sort-control';
import { MarketCard } from '@/components/market-card';
import { Sidebar } from '@/components/sidebar';
import { mockMarkets } from '@/data/markets';
import type { Market } from '@/types/market';
import {
  readAllMarkets,
  toFrontendMarket,
  isMarketDeployed,
} from '@/lib/flow/market';
import { isEammDeployed, readEammMarketMeta } from '@/lib/flow/eamm';

// ─── Data loading ─────────────────────────────────────────────────────────────

function useMarkets() {
  const [onChain,  setOnChain]  = useState<Market[]>([]);
  const [loading,  setLoading]  = useState(isMarketDeployed());
  const [hydrated, setHydrated] = useState(false);

  const load = useCallback(async () => {
    if (!isMarketDeployed()) {
      setLoading(false);
      return;
    }
    try {
      const raw = await readAllMarkets();
      // Home feed only shows markets that are open on Flow AND not finalized on Sepolia eAMM.
      const flowOpen = raw.filter((m) => m.status === 0);
      const crossChainOpen = isEammDeployed()
        ? (await Promise.all(
            flowOpen.map(async (m) => {
              try {
                const eammMeta = await readEammMarketMeta(m.id);
                // eAMM status: 0 Active | 1 Resolved | 2 Cancelled
                return eammMeta.status === 0;
              } catch {
                // If eAMM lookup fails (market not mirrored / rpc hiccup), keep market visible.
                return true;
              }
            }),
          ))
        : flowOpen.map(() => true);

      const openMarkets = flowOpen.filter((_, i) => crossChainOpen[i]);
      setOnChain(openMarkets.map(toFrontendMarket).filter((m) => m.status === 'active'));
    } catch {
      // silently fall back to mock data
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setHydrated(true);
    load();
  }, [load]);

  /**
   * Merge strategy:
   *  - On-chain markets are shown first (real data, live prices).
   *  - Mock markets that share a title with an on-chain market are suppressed.
   *  - Remaining mock markets fill the listing so it never looks empty during
   *    testnet when only a few on-chain markets exist.
   */
  const markets: Market[] = useMemo(() => {
    if (!hydrated) return mockMarkets.filter((m) => m.status === 'active');

    const onChainTitles = new Set(onChain.map((m) => m.title));
    const filteredMock  = mockMarkets.filter((m) => m.status === 'active' && !onChainTitles.has(m.title));

    return [...onChain, ...filteredMock];
  }, [onChain, hydrated]);

  return { markets, loading, onChainCount: onChain.length };
}

// ─── Main content ─────────────────────────────────────────────────────────────

function HomeContent() {
  const searchParams = useSearchParams();
  const catFromUrl   = searchParams.get('cat');

  const [category, setCategory] = useState(
    catFromUrl ? capitalize(catFromUrl) : 'All',
  );
  const [sort, setSort] = useState<SortOption>('trending');

  useEffect(() => {
    if (catFromUrl) setCategory(capitalize(catFromUrl));
  }, [catFromUrl]);

  const { markets, loading, onChainCount } = useMarkets();

  const filtered = useMemo(() => {
    let list = [...markets];

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
        list = list.filter((m) => m.category === target);
      }
    }

    switch (sort) {
      case 'volume':
        list.sort((a, b) => b.volume - a.volume);
        break;
      case 'newest':
        list.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        break;
      case 'ending-soon':
        list.sort(
          (a, b) =>
            new Date(a.expiryAt).getTime() - new Date(b.expiryAt).getTime(),
        );
        break;
      case 'trending':
      default:
        list.sort((a, b) => {
          if (a.trending !== b.trending) return a.trending ? -1 : 1;
          return b.volume - a.volume;
        });
    }

    return list;
  }, [markets, category, sort]);

  return (
    <>
      <HeroSection />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">

          {/* Left column */}
          <div className="xl:col-span-9 space-y-8">

            {/* Status bar — shows when on-chain markets are loaded */}
            {onChainCount > 0 && (
              <div className="flex items-center gap-2 text-xs text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {onChainCount} live market{onChainCount !== 1 ? 's' : ''} on Flow EVM
              </div>
            )}

            {/* Filters */}
            <div className="flex flex-col md:flex-row items-center justify-between gap-4 py-2">
              <FilterBar selected={category} onChange={setCategory} />
              <SortControl value={sort} onChange={setSort} />
            </div>

            {/* Grid */}
            {loading ? (
              <div className="flex items-center justify-center py-24 gap-3 text-slate-500">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-sm">Loading markets from chain…</span>
              </div>
            ) : (
              <>
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
                    <p className="text-slate-500">No markets in this category.</p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Sidebar */}
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
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex items-center justify-center py-24 gap-3 text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <HomeContent />
    </Suspense>
  );
}
