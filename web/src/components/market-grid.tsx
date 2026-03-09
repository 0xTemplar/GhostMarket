import type { Market } from '@/types/market';
import { MarketCard } from '@/components/market-card';

interface MarketGridProps {
  markets: Market[];
}

export function MarketGrid({ markets }: MarketGridProps) {
  if (markets.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center">
        <p className="text-text-muted text-sm">
          No markets found matching your filters.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {markets.map((market, i) => (
        <MarketCard key={market.id} market={market} index={i} />
      ))}
    </div>
  );
}
