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
  isMarketDeployed,
} from '@/lib/market';
import { isEammDeployed, readEammMarketMeta } from '@/lib/eamm';

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
      // Filter to active markets (status 0 = Active in GhostMarket.sol).
      const activeMarkets = raw.filter((m) => m.status === 0);

      // Optionally filter by EAMM status (hides markets resolved in the FHE AMM).
      const keep = isEammDeployed()
        ? (await Promise.all(
            activeMarkets.map(async (m) => {
              try {
                const eammMeta = await readEammMarketMeta(m.id);
                return eammMeta.status === 0; // 0 = Active
              } catch {
                return true;
              }
            }),
          ))
        : activeMarkets.map(() => true);

      const openMarkets = activeMarkets.filter((_, i) => keep[i]);
      setOnChain(openMarkets.map((m) => ({
        id:               String(m.id),
        title:            m.title,
        description:      m.description,
        category:         m.category as Market['category'],
        resolutionSource: m.resolutionSource ?? '',
        status:           'active' as const,
        expiryAt:         new Date(m.expiryAt * 1000).toISOString(),
        createdAt:        new Date().toISOString(),
        yesPrice:         m.yesPrice ?? 0.5,
        noPrice:          m.noPrice ?? 0.5,
        // FHE pools are encrypted — these metrics are unavailable on-chain.
        volume:       0,
        liquidity:    0,
        tradersCount: 0,
        priceHistory: [],
        change24h:    0,
        trending:     false,
      })));
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
   *  - Once any on-chain market is loaded, show ONLY on-chain markets.
   *  - Mock markets are shown only while the chain hasn't returned data yet
   *    (pre-hydration or when the contract address isn't configured).
   */
  const markets: Market[] = useMemo(() => {
    if (!hydrated) return mockMarkets.filter((m) => m.status === 'active');
    if (onChain.length > 0) return onChain;
    return mockMarkets.filter((m) => m.status === 'active');
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

    const liveFirst = (a: Market, b: Market) =>
      (b.isLive ? 1 : 0) - (a.isLive ? 1 : 0);

    switch (sort) {
      case 'volume':
        list.sort((a, b) => liveFirst(a, b) || b.volume - a.volume);
        break;
      case 'newest':
        list.sort(
          (a, b) =>
            liveFirst(a, b) ||
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        break;
      case 'ending-soon':
        list.sort(
          (a, b) =>
            liveFirst(a, b) ||
            new Date(a.expiryAt).getTime() - new Date(b.expiryAt).getTime(),
        );
        break;
      case 'trending':
      default:
        list.sort((a, b) => {
          const live = liveFirst(a, b);
          if (live !== 0) return live;
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
                {onChainCount} live market{onChainCount !== 1 ? 's' : ''} 
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
