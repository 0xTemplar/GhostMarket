/**
 * fetcher.ts
 *
 * Real public-API data fetching for each oracle agent's primary source.
 *
 * Every fetch is:
 *   - Unauthenticated (public endpoints, no API keys required)
 *   - Timeout-gated at 6 s to never block the resolution loop
 *   - Gracefully degraded — returns null price on failure so the
 *     rest of the pipeline continues normally
 *
 * The fetched price / value is passed into the GPT prompt so agent
 * reasoning is grounded in real market data rather than generic text.
 */

export interface FetchedData {
  source: string;
  sourceUrl: string;
  asset: string;
  price: number | null; // numeric USD (or relevant unit) price, or null
  rawValue: string; // human-readable fetched value for logs
  unit: string; // 'USD', 'USD TVL', 'bps', etc.
  fetchedAt: string; // ISO timestamp
  note?: string; // extra context surfaced in the GPT prompt
}

const FETCH_TIMEOUT_MS = 6_000;

// ── Asset extraction ──────────────────────────────────────────────────────────

/** Pull the primary crypto asset (or category) from a market title. */
export function extractAsset(marketTitle: string): string {
  const upper = marketTitle.toUpperCase();
  const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'TON'] as const;
  for (const a of ASSETS) if (upper.includes(a)) return a;
  if (upper.includes('BASE') && upper.includes('TVL')) return 'BASE_TVL';
  if (upper.includes('FED') || upper.includes('RATE')) return 'MACRO_RATES';
  if (upper.includes('EU') || upper.includes('AI ACT')) return 'POLICY';
  return 'ETH';
}

/** Extract the USD threshold from a market title like "above $6,500" → 6500. */
export function extractThreshold(marketTitle: string): number | null {
  const m = marketTitle.match(/\$([0-9][0-9,]*(?:\.[0-9]+)?)[BbMmKk]?/);
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, ''));
}

// ── Per-exchange fetch helpers ────────────────────────────────────────────────

type SymbolMap = Record<string, string>;

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Binance — https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT
async function fetchBinance(asset: string): Promise<FetchedData> {
  const SYMBOLS: SymbolMap = {
    ETH: 'ETHUSDT',
    BTC: 'BTCUSDT',
    SOL: 'SOLUSDT',
    XRP: 'XRPUSDT',
    DOGE: 'DOGEUSDT',
    ADA: 'ADAUSDT',
    TON: 'TONUSDT',
  };
  const sym = SYMBOLS[asset] ?? 'ETHUSDT';
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`;
  try {
    const res = await fetchWithTimeout(url);
    const data = (await res.json()) as { price?: string };
    const price = data.price ? parseFloat(data.price) : null;
    return {
      source: 'Binance',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price,
      rawValue: price
        ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
        : 'unavailable',
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return {
      source: 'Binance',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price: null,
      rawValue: 'fetch failed',
      fetchedAt: new Date().toISOString(),
    };
  }
}

// CoinGecko — https://api.coingecko.com/api/v3/simple/price
async function fetchCoinGecko(asset: string): Promise<FetchedData> {
  const IDS: SymbolMap = {
    ETH: 'ethereum',
    BTC: 'bitcoin',
    SOL: 'solana',
    XRP: 'ripple',
    DOGE: 'dogecoin',
    ADA: 'cardano',
    TON: 'the-open-network',
  };
  const id = IDS[asset] ?? 'ethereum';
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
  try {
    const res = await fetchWithTimeout(url);
    const data = (await res.json()) as Record<string, { usd?: number }>;
    const price = data[id]?.usd ?? null;
    return {
      source: 'CoinGecko',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price,
      rawValue: price
        ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
        : 'unavailable',
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return {
      source: 'CoinGecko',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price: null,
      rawValue: 'fetch failed',
      fetchedAt: new Date().toISOString(),
    };
  }
}

// CryptoCompare (public, no key) — Chainlink proxy for on-chain vibes
async function fetchCryptoCompare(asset: string): Promise<FetchedData> {
  const sym = asset === 'BTC' ? 'BTC' : asset;
  const url = `https://min-api.cryptocompare.com/data/price?fsym=${sym}&tsyms=USD`;
  try {
    const res = await fetchWithTimeout(url);
    const data = (await res.json()) as { USD?: number };
    const price = data.USD ?? null;
    return {
      source: 'Chainlink (CryptoCompare proxy)',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price,
      rawValue: price
        ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
        : 'unavailable',
      fetchedAt: new Date().toISOString(),
      note: 'CryptoCompare aggregate feed used as on-chain oracle proxy for testnet',
    };
  } catch {
    return {
      source: 'Chainlink (CryptoCompare proxy)',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price: null,
      rawValue: 'fetch failed',
      fetchedAt: new Date().toISOString(),
    };
  }
}

// Coinbase — https://api.coinbase.com/v2/prices/ETH-USD/spot
async function fetchCoinbase(asset: string): Promise<FetchedData> {
  const PAIRS: SymbolMap = {
    ETH: 'ETH-USD',
    BTC: 'BTC-USD',
    SOL: 'SOL-USD',
    XRP: 'XRP-USD',
    DOGE: 'DOGE-USD',
    ADA: 'ADA-USD',
  };
  const pair = PAIRS[asset] ?? 'ETH-USD';
  const url = `https://api.coinbase.com/v2/prices/${pair}/spot`;
  try {
    const res = await fetchWithTimeout(url);
    const data = (await res.json()) as {
      data?: { amount?: string; currency?: string };
    };
    const price = data.data?.amount ? parseFloat(data.data.amount) : null;
    return {
      source: 'Coinbase',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price,
      rawValue: price
        ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
        : 'unavailable',
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return {
      source: 'Coinbase',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price: null,
      rawValue: 'fetch failed',
      fetchedAt: new Date().toISOString(),
    };
  }
}

// Kraken — https://api.kraken.com/0/public/Ticker?pair=ETHUSD
async function fetchKraken(asset: string): Promise<FetchedData> {
  const PAIRS: SymbolMap = {
    ETH: 'ETHUSD',
    BTC: 'XBTUSD',
    SOL: 'SOLUSD',
    XRP: 'XRPUSD',
    DOGE: 'DOGEUSD',
    ADA: 'ADAUSD',
  };
  const pair = PAIRS[asset] ?? 'ETHUSD';
  const url = `https://api.kraken.com/0/public/Ticker?pair=${pair}`;
  try {
    const res = await fetchWithTimeout(url);
    const data = (await res.json()) as {
      result?: Record<string, { c?: string[] }>;
    };
    const result = Object.values(data.result ?? {})[0];
    const price = result?.c?.[0] ? parseFloat(result.c[0]) : null;
    return {
      source: 'Kraken',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price,
      rawValue: price
        ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
        : 'unavailable',
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return {
      source: 'Kraken',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price: null,
      rawValue: 'fetch failed',
      fetchedAt: new Date().toISOString(),
    };
  }
}

// OKX — https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT
async function fetchOKX(asset: string): Promise<FetchedData> {
  const INST: SymbolMap = {
    ETH: 'ETH-USDT',
    BTC: 'BTC-USDT',
    SOL: 'SOL-USDT',
    XRP: 'XRP-USDT',
    DOGE: 'DOGE-USDT',
    ADA: 'ADA-USDT',
    TON: 'TON-USDT',
  };
  const inst = INST[asset] ?? 'ETH-USDT';
  const url = `https://www.okx.com/api/v5/market/ticker?instId=${inst}`;
  try {
    const res = await fetchWithTimeout(url);
    const data = (await res.json()) as { data?: Array<{ last?: string }> };
    const price = data.data?.[0]?.last ? parseFloat(data.data[0].last!) : null;
    return {
      source: 'OKX',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price,
      rawValue: price
        ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
        : 'unavailable',
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return {
      source: 'OKX',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price: null,
      rawValue: 'fetch failed',
      fetchedAt: new Date().toISOString(),
    };
  }
}

// Bybit — https://api.bybit.com/v5/market/tickers?category=spot&symbol=ETHUSDT
async function fetchBybit(asset: string): Promise<FetchedData> {
  const SYMBOLS: SymbolMap = {
    ETH: 'ETHUSDT',
    BTC: 'BTCUSDT',
    SOL: 'SOLUSDT',
    XRP: 'XRPUSDT',
    DOGE: 'DOGEUSDT',
    ADA: 'ADAUSDT',
    TON: 'TONUSDT',
  };
  const sym = SYMBOLS[asset] ?? 'ETHUSDT';
  const url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`;
  try {
    const res = await fetchWithTimeout(url);
    const data = (await res.json()) as {
      result?: { list?: Array<{ lastPrice?: string }> };
    };
    const price = data.result?.list?.[0]?.lastPrice
      ? parseFloat(data.result.list[0].lastPrice!)
      : null;
    return {
      source: 'Bybit',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price,
      rawValue: price
        ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
        : 'unavailable',
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return {
      source: 'Bybit',
      sourceUrl: url,
      asset,
      unit: 'USD',
      price: null,
      rawValue: 'fetch failed',
      fetchedAt: new Date().toISOString(),
    };
  }
}

// DeFiLlama — Base TVL
async function fetchDefiLlamaBase(): Promise<FetchedData> {
  const url = 'https://api.llama.fi/v2/chains';
  try {
    const res = await fetchWithTimeout(url);
    const data = (await res.json()) as Array<{ name?: string; tvl?: number }>;
    const base = data.find((c) => c.name?.toLowerCase() === 'base');
    const tvl = base?.tvl ?? null;
    const tvlB = tvl ? (tvl / 1e9).toFixed(2) : null;
    return {
      source: 'DeFiLlama',
      sourceUrl: url,
      asset: 'BASE_TVL',
      unit: 'USD TVL',
      price: tvl,
      rawValue: tvlB ? `$${tvlB}B` : 'unavailable',
      fetchedAt: new Date().toISOString(),
      note: `Base chain TVL from DeFiLlama: ${tvlB ? '$' + tvlB + 'B' : 'unavailable'}`,
    };
  } catch {
    return {
      source: 'DeFiLlama',
      sourceUrl: url,
      asset: 'BASE_TVL',
      unit: 'USD TVL',
      price: null,
      rawValue: 'fetch failed',
      fetchedAt: new Date().toISOString(),
    };
  }
}

// CMC Markets (public) — Fed Funds rate context via alternative macro signal
async function fetchMacroRates(): Promise<FetchedData> {
  // FRED public endpoint: federal funds effective rate (no key required for this format)
  const url =
    'https://api.stlouisfed.org/fred/series/observations?series_id=FEDFUNDS&sort_order=desc&limit=1&file_type=json&api_key=abcdefghijklmnopqrstuvwxyz123456';
  // Fallback: use a well-known public alternative
  const fallbackUrl =
    'https://api.fiscaldata.treasury.gov/services/api/v1/accounting/od/avg_interest_rates?fields=record_date,avg_interest_rate_amt&filter=security_desc:eq:Federal%20Funds&sort=-record_date&page[size]=1';
  try {
    const res = await fetchWithTimeout(fallbackUrl);
    const data = (await res.json()) as {
      data?: Array<{ avg_interest_rate_amt?: string; record_date?: string }>;
    };
    const latest = data.data?.[0];
    const rate = latest?.avg_interest_rate_amt
      ? parseFloat(latest.avg_interest_rate_amt)
      : null;
    return {
      source: 'US Treasury (FiscalData)',
      sourceUrl: fallbackUrl,
      asset: 'MACRO_RATES',
      unit: 'bps',
      price: rate,
      rawValue: rate ? `${rate.toFixed(2)}%` : 'unavailable',
      fetchedAt: new Date().toISOString(),
      note: `Current federal funds effective rate: ${rate ? rate.toFixed(2) + '%' : 'unavailable'}. Market resolves YES if cumulative 2026 cuts ≥ 50 bps.`,
    };
  } catch {
    return {
      source: 'US Treasury (FiscalData)',
      sourceUrl: fallbackUrl,
      asset: 'MACRO_RATES',
      unit: 'bps',
      price: null,
      rawValue: 'fetch failed',
      fetchedAt: new Date().toISOString(),
      note: 'No live rate data available — reasoning from FOMC forward guidance signals.',
    };
  }
}

function policyFallback(): FetchedData {
  return {
    source: 'EU Commission (no public API)',
    sourceUrl: 'https://digital-strategy.ec.europa.eu/en/policies/ai-act',
    asset: 'POLICY',
    unit: 'EUR fine',
    price: null,
    rawValue: 'no machine-readable feed',
    fetchedAt: new Date().toISOString(),
    note: 'No public API for EU enforcement actions. Reasoning from regulatory calendar, enforcement track record, and disclosed investigation timelines.',
  };
}

// ── Source router ─────────────────────────────────────────────────────────────

/** Fetch data for a given agent source + detected asset. */
export async function fetchSourceData(
  source: string,
  asset: string,
): Promise<FetchedData> {
  if (asset === 'BASE_TVL') return fetchDefiLlamaBase();
  if (asset === 'MACRO_RATES') return fetchMacroRates();
  if (asset === 'POLICY') return policyFallback();

  const src = source.toLowerCase();
  if (src.includes('binance')) return fetchBinance(asset);
  if (src.includes('coingecko')) return fetchCoinGecko(asset);
  if (src.includes('chainlink')) return fetchCryptoCompare(asset);
  if (src.includes('coinbase')) return fetchCoinbase(asset);
  if (src.includes('kraken')) return fetchKraken(asset);
  if (src.includes('okx')) return fetchOKX(asset);
  if (src.includes('bybit')) return fetchBybit(asset);

  // Unknown source — try Binance as a universal fallback
  return fetchBinance(asset);
}
