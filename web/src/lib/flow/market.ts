/**
 * GhostMarket contract ABI and Flow EVM client utilities.
 *
 * Reading data:
 *  - readAllMarkets()           Fetches every market from the contract.
 *  - readUserPosition()         Fetches a user's YES/NO stake + claimed flag.
 *  - readYesPrice()             Returns implied probability in basis points (0–10000).
 *
 * Writing data (requires a viem WalletClient from useFlowWalletClient):
 *  - placeBet()                 Sends FLOW and registers a YES/NO position.
 *  - claimWinnings()            Withdraws payout after resolution.
 *  - claimRefund()              Withdraws stake from cancelled / grace-expired market.
 *
 * Market ID strategy:
 *  On-chain markets use uint256 IDs (1, 2, 3 …). The frontend URL is
 *  /markets/<id>. Mock market URLs (e.g. /markets/eth-10k-2026) continue to
 *  work as static previews until real on-chain markets are created.
 *
 * Status enum (mirrors contract):
 *  0 = Active | 1 = Resolved | 2 = Disputed | 3 = Cancelled
 */

import { publicClient, flowTestnet, parseEther, formatEther } from './vault';
import type { WalletClient } from 'viem';
import type { Market } from '@/types/market';

// ─── Address ──────────────────────────────────────────────────────────────────

export const GHOST_MARKET_ADDRESS =
  (process.env.NEXT_PUBLIC_GHOST_MARKET_ADDRESS as `0x${string}`) ?? null;

export function isMarketDeployed(): boolean {
  return !!GHOST_MARKET_ADDRESS;
}

// ─── ABI ──────────────────────────────────────────────────────────────────────

export const GHOST_MARKET_ABI = [
  // ── State getters ────────────────────────────────────────────────────────────
  {
    name: 'marketCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'markets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [
      { name: 'title',            type: 'string' },
      { name: 'description',      type: 'string' },
      { name: 'category',         type: 'string' },
      { name: 'resolutionSource', type: 'string' },
      { name: 'expiryAt',         type: 'uint64' },
      { name: 'status',           type: 'uint8' },
      { name: 'yesPool',          type: 'uint256' },
      { name: 'noPool',           type: 'uint256' },
      { name: 'outcome',          type: 'bool' },
      { name: 'creator',          type: 'address' },
    ],
  },
  {
    name: 'getAllMarketIds',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'ids', type: 'uint256[]' }],
  },
  {
    name: 'yesPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'noPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getUserPosition',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'user',     type: 'address' },
    ],
    outputs: [
      { name: 'yes',     type: 'uint256' },
      { name: 'no',      type: 'uint256' },
      { name: 'claimed', type: 'bool' },
    ],
  },
  {
    name: 'isRefundEligible',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'feeBps',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ── Writes ───────────────────────────────────────────────────────────────────
  {
    name: 'placeBet',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'side',     type: 'bool' },
    ],
    outputs: [],
  },
  {
    name: 'claimWinnings',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'claimRefund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
  },
  // ── Admin ────────────────────────────────────────────────────────────────────
  {
    name: 'createMarket',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'title',            type: 'string' },
      { name: 'description',      type: 'string' },
      { name: 'category',         type: 'string' },
      { name: 'resolutionSource', type: 'string' },
      { name: 'expiryAt',         type: 'uint64' },
    ],
    outputs: [{ name: 'marketId', type: 'uint256' }],
  },
  {
    name: 'resolveMarket',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'outcome',  type: 'bool' },
    ],
    outputs: [],
  },
  {
    name: 'cancelMarket',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
  },
  // ── Events ───────────────────────────────────────────────────────────────────
  {
    name: 'MarketCreated',
    type: 'event',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'title',    type: 'string',  indexed: false },
      { name: 'category', type: 'string',  indexed: false },
      { name: 'expiryAt', type: 'uint64',  indexed: false },
    ],
  },
  {
    name: 'BetPlaced',
    type: 'event',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'user',     type: 'address', indexed: true },
      { name: 'side',     type: 'bool',    indexed: false },
      { name: 'amount',   type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'MarketResolved',
    type: 'event',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'outcome',  type: 'bool',    indexed: false },
    ],
  },
  {
    name: 'WinningsClaimed',
    type: 'event',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'user',     type: 'address', indexed: true },
      { name: 'payout',   type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'RefundClaimed',
    type: 'event',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'user',     type: 'address', indexed: true },
      { name: 'amount',   type: 'uint256', indexed: false },
    ],
  },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export const MarketStatusLabel = ['active', 'resolved', 'disputed', 'pending'] as const;

export interface OnChainMarket {
  id: number;
  title: string;
  description: string;
  category: string;
  resolutionSource: string;
  expiryAt: number;      // unix seconds
  status: 0 | 1 | 2 | 3;
  yesPool: bigint;       // wei
  noPool: bigint;        // wei
  outcome: boolean;
  creator: string;
  yesPriceBps: number;   // 0–10000 (e.g. 6500 = 65%)
  noPriceBps: number;
}

export interface UserPosition {
  marketId: number;
  yesAmount: bigint;     // wei
  noAmount: bigint;      // wei
  claimed: boolean;
  /** Total FLOW staked (display) */
  totalFlow: string;
  /** Which side the user is dominant on */
  dominantSide: 'YES' | 'NO' | null;
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

/** Fetches a single market by ID. Returns null if the contract is not deployed. */
export async function readMarket(marketId: number): Promise<OnChainMarket | null> {
  if (!GHOST_MARKET_ADDRESS) return null;
  try {
    const [raw, yesBps] = await Promise.all([
      publicClient.readContract({
        address: GHOST_MARKET_ADDRESS,
        abi: GHOST_MARKET_ABI,
        functionName: 'markets',
        args: [BigInt(marketId)],
      }),
      publicClient.readContract({
        address: GHOST_MARKET_ADDRESS,
        abi: GHOST_MARKET_ABI,
        functionName: 'yesPrice',
        args: [BigInt(marketId)],
      }),
    ]);

    const [title, description, category, resolutionSource, expiryAt, status, yesPool, noPool, outcome, creator] = raw as [
      string, string, string, string, bigint, number, bigint, bigint, boolean, string
    ];

    const yesPriceBps = Number(yesBps);
    return {
      id: marketId,
      title,
      description,
      category,
      resolutionSource,
      expiryAt: Number(expiryAt),
      status: status as 0 | 1 | 2 | 3,
      yesPool,
      noPool,
      outcome,
      creator,
      yesPriceBps,
      noPriceBps: 10_000 - yesPriceBps,
    };
  } catch {
    return null;
  }
}

/** Fetches every on-chain market. Returns empty array if contract is not deployed. */
export async function readAllMarkets(): Promise<OnChainMarket[]> {
  if (!GHOST_MARKET_ADDRESS) return [];
  try {
    const ids = await publicClient.readContract({
      address: GHOST_MARKET_ADDRESS,
      abi: GHOST_MARKET_ABI,
      functionName: 'getAllMarketIds',
    }) as bigint[];

    if (ids.length === 0) return [];

    const markets = await Promise.all(ids.map((id) => readMarket(Number(id))));
    return markets.filter(Boolean) as OnChainMarket[];
  } catch {
    return [];
  }
}

/** Reads a user's position in a given market. */
export async function readUserPosition(
  marketId: number,
  userAddress: `0x${string}`,
): Promise<UserPosition | null> {
  if (!GHOST_MARKET_ADDRESS) return null;
  try {
    const [yes, no, claimed] = await publicClient.readContract({
      address: GHOST_MARKET_ADDRESS,
      abi: GHOST_MARKET_ABI,
      functionName: 'getUserPosition',
      args: [BigInt(marketId), userAddress],
    }) as [bigint, bigint, boolean];

    const totalFlow = formatEther(yes + no);
    const zero = BigInt(0);
    const dominantSide = yes > no ? 'YES' : no > yes ? 'NO' : yes > zero ? 'YES' : null;

    return { marketId, yesAmount: yes, noAmount: no, claimed, totalFlow, dominantSide };
  } catch {
    return null;
  }
}

/** Returns true if the market can be refunded (cancelled or grace expired). */
export async function readIsRefundEligible(marketId: number): Promise<boolean> {
  if (!GHOST_MARKET_ADDRESS) return false;
  try {
    return await publicClient.readContract({
      address: GHOST_MARKET_ADDRESS,
      abi: GHOST_MARKET_ABI,
      functionName: 'isRefundEligible',
      args: [BigInt(marketId)],
    }) as boolean;
  } catch {
    return false;
  }
}

// ─── Write helpers ────────────────────────────────────────────────────────────

/**
 * Places a YES or NO bet on a market.
 *
 * @param walletClient  Viem WalletClient from useFlowWalletClient().
 * @param marketId      On-chain market ID.
 * @param side          'YES' | 'NO'
 * @param amountFlow    Amount in FLOW (e.g. '1.5').
 */
export async function placeBet(
  walletClient: WalletClient,
  marketId: number,
  side: 'YES' | 'NO',
  amountFlow: string,
): Promise<`0x${string}`> {
  if (!GHOST_MARKET_ADDRESS) throw new Error('GhostMarket not deployed');

  const [account] = await walletClient.getAddresses();
  const value = parseEther(amountFlow);

  const { request } = await publicClient.simulateContract({
    address: GHOST_MARKET_ADDRESS,
    abi: GHOST_MARKET_ABI,
    functionName: 'placeBet',
    args: [BigInt(marketId), side === 'YES'],
    value,
    account,
    chain: flowTestnet,
  });

  return walletClient.writeContract(request);
}

/**
 * Claims winnings for a resolved market.
 */
export async function claimWinnings(
  walletClient: WalletClient,
  marketId: number,
): Promise<`0x${string}`> {
  if (!GHOST_MARKET_ADDRESS) throw new Error('GhostMarket not deployed');

  const [account] = await walletClient.getAddresses();

  const { request } = await publicClient.simulateContract({
    address: GHOST_MARKET_ADDRESS,
    abi: GHOST_MARKET_ABI,
    functionName: 'claimWinnings',
    args: [BigInt(marketId)],
    account,
    chain: flowTestnet,
  });

  return walletClient.writeContract(request);
}

/**
 * Claims a refund when the market is cancelled or the resolution grace
 * period has passed without the resolver acting.
 */
export async function claimRefund(
  walletClient: WalletClient,
  marketId: number,
): Promise<`0x${string}`> {
  if (!GHOST_MARKET_ADDRESS) throw new Error('GhostMarket not deployed');

  const [account] = await walletClient.getAddresses();

  const { request } = await publicClient.simulateContract({
    address: GHOST_MARKET_ADDRESS,
    abi: GHOST_MARKET_ABI,
    functionName: 'claimRefund',
    args: [BigInt(marketId)],
    account,
    chain: flowTestnet,
  });

  return walletClient.writeContract(request);
}

// ─── Converters ───────────────────────────────────────────────────────────────

/**
 * Converts an on-chain market to the UI's Market type so existing
 * components work without modification.
 *
 * volume / liquidity are approximated from pool sizes (1 FLOW ≈ $1 for now;
 * swap in a price oracle in Phase 6).
 */
export function toFrontendMarket(m: OnChainMarket): Market {
  const totalWei  = m.yesPool + m.noPool;
  const totalFlow = parseFloat(formatEther(totalWei));

  // Status mapping
  const statusMap: Record<number, Market['status']> = {
    0: 'active',
    1: 'resolved',
    2: 'disputed',
    3: 'pending',
  };

  const yesPrice = m.yesPriceBps / 10_000;
  const noPrice  = m.noPriceBps  / 10_000;

  return {
    id: String(m.id),   // on-chain IDs are numbers; UI uses string IDs
    isLive: true,
    title: m.title,
    description: m.description,
    category: m.category as Market['category'],
    resolutionSource: m.resolutionSource,
    expiryAt: new Date(m.expiryAt * 1000).toISOString(),
    status: statusMap[m.status] ?? 'active',
    yesPrice,
    noPrice,
    volume: totalFlow,
    liquidity: totalFlow * 0.7,   // approximation until AMM depth calc is added
    tradersCount: 0,              // requires off-chain indexing (Phase 5)
    priceHistory: [yesPrice],     // real history requires event indexing (Phase 5)
    change24h: 0,
    trending: totalFlow > 100,
    createdAt: new Date().toISOString(),
  };
}

export { formatEther, parseEther };
