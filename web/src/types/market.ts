export type MarketStatus = 'active' | 'resolved' | 'disputed' | 'pending';

export type MarketCategory =
  | 'Crypto'
  | 'Macro'
  | 'Politics'
  | 'Tech'
  | 'Sports'
  | 'Climate';

export interface Market {
  id: string;
  title: string;
  description: string;
  category: MarketCategory;
  image?: string;
  resolutionSource: string;
  expiryAt: string;
  status: MarketStatus;
  yesPrice: number;
  noPrice: number;
  volume: number;
  liquidity: number;
  tradersCount: number;
  priceHistory: number[];
  change24h: number;
  trending: boolean;
  createdAt: string;
}

export interface Position {
  id: string;
  marketId: string;
  marketTitle: string;
  side: 'YES' | 'NO';
  shares: number;
  avgPrice: number;
  currentPrice: number;
  currentValue: number;
  costBasis: number;
  pnl: number;
  pnlPercent: number;
  status: MarketStatus;
  expiryAt: string;
  category: MarketCategory;
}

export interface PortfolioStats {
  totalValue: number;
  totalCost: number;
  totalPnl: number;
  totalPnlPercent: number;
  openPositions: number;
  resolvedPositions: number;
}
