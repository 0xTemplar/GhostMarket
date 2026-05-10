/**
 * market.ts — GhostMarket contract helpers for Ethereum Sepolia.
 *
 * Reads GhostMarket contract state on Ethereum Sepolia.
 * GhostMarket is now deployed on Sepolia alongside GhostEAMM and GhostVault.
 */

import { http, createPublicClient, type WalletClient } from 'viem';
import { sepolia } from 'viem/chains';

// ─── Contract config ──────────────────────────────────────────────────────────

export const GHOST_MARKET_ADDRESS = (
  process.env.NEXT_PUBLIC_GHOST_MARKET_ADDRESS ?? ''
) as `0x${string}`;

export const GHOST_MARKET_ABI = [
  // Write
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
  // Views
  {
    name: 'markets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [
      { name: 'title',            type: 'string' },
      { name: 'description',      type: 'string' },
      { name: 'category',         type: 'string' },
      { name: 'resolutionSource', type: 'string' },
      { name: 'expiryAt',         type: 'uint64' },
      { name: 'status',           type: 'uint8'  },
      { name: 'outcome',          type: 'bool'   },
      { name: 'creator',          type: 'address'},
    ],
  },
  {
    name: 'marketCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getAllMarketIds',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'ids', type: 'uint256[]' }],
  },
  // Events
  {
    name: 'MarketCreated',
    type: 'event',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true  },
      { name: 'title',    type: 'string',  indexed: false },
      { name: 'category', type: 'string',  indexed: false },
      { name: 'expiryAt', type: 'uint64',  indexed: false },
    ],
  },
  {
    name: 'MarketResolved',
    type: 'event',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true  },
      { name: 'outcome',  type: 'bool',    indexed: false },
    ],
  },
] as const;

// ─── Status enum ──────────────────────────────────────────────────────────────

export enum MarketStatus {
  Active    = 0,
  Resolved  = 1,
  Cancelled = 2,
}

// ─── Frontend market shape ────────────────────────────────────────────────────

export interface FrontendMarket {
  id:               number;
  title:            string;
  description:      string;
  category:         string;
  resolutionSource: string;
  expiryAt:         number;   // unix seconds
  status:           MarketStatus;
  outcome:          boolean;
  creator:          string;
  // Derived display fields — 0-1 fraction (e.g. 0.62 = 62¢).
  // Undefined for FHE markets (pools are encrypted). Callers should fall back to 0.5.
  yesPrice?:        number;
  noPrice?:         number;
}

// ─── Public client (Sepolia) ──────────────────────────────────────────────────

export const publicClient = createPublicClient({
  chain:     sepolia,
  transport: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org'),
});

// ─── Read helpers ─────────────────────────────────────────────────────────────

export async function readMarket(marketId: number): Promise<FrontendMarket | null> {
  if (!GHOST_MARKET_ADDRESS) return null;
  try {
    const raw = await publicClient.readContract({
      address:      GHOST_MARKET_ADDRESS,
      abi:          GHOST_MARKET_ABI,
      functionName: 'markets',
      args:         [BigInt(marketId)],
    }) as [string, string, string, string, bigint, number, boolean, string];

    return toFrontendMarket(marketId, raw);
  } catch {
    return null;
  }
}

export async function readAllMarkets(): Promise<FrontendMarket[]> {
  if (!GHOST_MARKET_ADDRESS) return [];
  try {
    const ids = await publicClient.readContract({
      address:      GHOST_MARKET_ADDRESS,
      abi:          GHOST_MARKET_ABI,
      functionName: 'getAllMarketIds',
    }) as bigint[];

    const results = await Promise.allSettled(
      ids.map((id) => readMarket(Number(id))),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<FrontendMarket> => r.status === 'fulfilled' && r.value !== null)
      .map((r) => r.value);
  } catch {
    return [];
  }
}

/** True if GhostMarket address is configured. */
export function isMarketDeployed(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GHOST_MARKET_ADDRESS);
}

// ─── Write helpers ────────────────────────────────────────────────────────────

export async function createMarket(
  walletClient:     WalletClient,
  title:            string,
  description:      string,
  category:         string,
  resolutionSource: string,
  expiryAt:         number,  // unix seconds
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      GHOST_MARKET_ADDRESS,
    abi:          GHOST_MARKET_ABI,
    functionName: 'createMarket',
    args:         [title, description, category, resolutionSource, BigInt(expiryAt)],
    account,
  });
  return walletClient.writeContract(request);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function toFrontendMarket(
  id:  number,
  raw: [string, string, string, string, bigint, number, boolean, string],
): FrontendMarket {
  const [title, description, category, resolutionSource, expiryAt, status, outcome, creator] = raw;
  return {
    id,
    title,
    description,
    category,
    resolutionSource,
    expiryAt: Number(expiryAt),
    status:   status as MarketStatus,
    outcome,
    creator,
  };
}
