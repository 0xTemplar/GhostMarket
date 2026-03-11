/**
 * GhostVault contract ABI and Flow EVM client utilities.
 *
 * Deployed on Flow EVM Testnet (chain ID 545).
 * Replace GHOST_VAULT_ADDRESS after running:
 *   npx ts-node scripts/deploy-vault-flow.ts
 *
 * Collateral locking flow:
 *   1. lockBetCollateral(walletClient, marketId, amountWei)  — lock on Flow EVM
 *   2. placeEncryptedBet(...)                                — bet on Zama/Sepolia
 *   3. claimPayout via settlement message                    — release lock + credit payout
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  numberToHex,
  type WalletClient,
} from 'viem';
import { defineChain } from 'viem';

export const flowTestnet = defineChain({
  id: 545,
  name: 'Flow EVM Testnet',
  nativeCurrency: { name: 'Flow', symbol: 'FLOW', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet.evm.nodes.onflow.org'] },
  },
  blockExplorers: {
    default: {
      name: 'Flowscan',
      url: 'https://evm-testnet.flowscan.io',
    },
  },
  testnet: true,
});

// Updated after redeployment with collateral locking support (GhostVault v2)
export const GHOST_VAULT_ADDRESS =
  (process.env.NEXT_PUBLIC_GHOST_VAULT_ADDRESS as `0x${string}`) ??
  '0x0000000000000000000000000000000000000000';

export const GHOST_VAULT_ABI = [
  // ─── Write ──────────────────────────────────────────────────────────────────
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    name: 'depositFor',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'lockForBet',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketId', type: 'bytes32' },
      { name: 'amount',   type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'claimPayout',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketId', type: 'bytes32' },
      { name: 'amount',   type: 'uint256' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'expiry',   type: 'uint256' },
      { name: 'sig',      type: 'bytes'   },
    ],
    outputs: [],
  },
  // ─── View ───────────────────────────────────────────────────────────────────
  {
    name: 'getBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getFreeBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'lockedAmounts',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user',     type: 'address' },
      { name: 'marketId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalLocked',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ─── Events ─────────────────────────────────────────────────────────────────
  {
    name: 'Deposited',
    type: 'event',
    inputs: [
      { name: 'user',   type: 'address', indexed: true  },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'Withdrawn',
    type: 'event',
    inputs: [
      { name: 'user',   type: 'address', indexed: true  },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'BetLocked',
    type: 'event',
    inputs: [
      { name: 'user',     type: 'address', indexed: true  },
      { name: 'marketId', type: 'bytes32', indexed: true  },
      { name: 'amount',   type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'BetUnlocked',
    type: 'event',
    inputs: [
      { name: 'user',     type: 'address', indexed: true  },
      { name: 'marketId', type: 'bytes32', indexed: true  },
      { name: 'amount',   type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'PayoutClaimed',
    type: 'event',
    inputs: [
      { name: 'user',     type: 'address', indexed: true  },
      { name: 'marketId', type: 'bytes32', indexed: true  },
      { name: 'amount',   type: 'uint256', indexed: false },
    ],
  },
] as const;

/**
 * Derive the bytes32 vault marketId from a GhostEAMM uint256 marketId.
 * Pads the uint256 to 32 bytes (big-endian), matching abi.encode(uint256).
 */
export function eammMarketIdToBytes32(marketId: number): `0x${string}` {
  return numberToHex(BigInt(marketId), { size: 32 });
}

/**
 * RPC endpoint used for ALL EVM reads and writes on Flow EVM.
 * Set NEXT_PUBLIC_FLOW_EVM_RPC in .env.local to override.
 */
export const FLOW_EVM_RPC =
  process.env.NEXT_PUBLIC_FLOW_EVM_RPC ?? 'https://testnet.evm.nodes.onflow.org';

export const publicClient = createPublicClient({
  chain:     flowTestnet,
  transport: http(FLOW_EVM_RPC),
});

// ─── Read helpers ─────────────────────────────────────────────────────────────

/** Total vault balance (locked + free) in FLOW string. */
export async function readVaultBalance(userAddress: `0x${string}`): Promise<string> {
  if (GHOST_VAULT_ADDRESS === '0x0000000000000000000000000000000000000000') return '0';
  try {
    const raw = await publicClient.readContract({
      address:      GHOST_VAULT_ADDRESS,
      abi:          GHOST_VAULT_ABI,
      functionName: 'getBalance',
      args:         [userAddress],
    });
    return formatEther(raw as bigint);
  } catch {
    return '0';
  }
}

/** Free balance (total − locked) in FLOW string. */
export async function readFreeBalance(userAddress: `0x${string}`): Promise<string> {
  if (GHOST_VAULT_ADDRESS === '0x0000000000000000000000000000000000000000') return '0';
  try {
    const raw = await publicClient.readContract({
      address:      GHOST_VAULT_ADDRESS,
      abi:          GHOST_VAULT_ABI,
      functionName: 'getFreeBalance',
      args:         [userAddress],
    });
    return formatEther(raw as bigint);
  } catch {
    return '0';
  }
}

/** Locked collateral for a specific market, in FLOW string. */
export async function readLockedAmount(
  userAddress: `0x${string}`,
  marketId: number,
): Promise<string> {
  if (GHOST_VAULT_ADDRESS === '0x0000000000000000000000000000000000000000') return '0';
  try {
    const raw = await publicClient.readContract({
      address:      GHOST_VAULT_ADDRESS,
      abi:          GHOST_VAULT_ABI,
      functionName: 'lockedAmounts',
      args:         [userAddress, eammMarketIdToBytes32(marketId)],
    });
    return formatEther(raw as bigint);
  } catch {
    return '0';
  }
}

// ─── Write helpers ────────────────────────────────────────────────────────────

/**
 * Lock collateral on GhostVault (Flow EVM) before placing an encrypted bet
 * on GhostEAMM (Sepolia).  Must be called with a WalletClient connected to
 * Flow EVM (chain ID 545).
 *
 * @param walletClient  viem WalletClient on Flow EVM (from Privy embedded wallet).
 * @param marketId      GhostEAMM uint256 market ID.
 * @param amountWei     Exact stake in wei — must match the encrypted bet amount.
 * @returns             Transaction hash of the lockForBet call on Flow EVM.
 */
export async function lockBetCollateral(
  walletClient: WalletClient,
  marketId:     number,
  amountWei:    bigint,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const marketIdBytes32 = eammMarketIdToBytes32(marketId);

  const { request } = await publicClient.simulateContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'lockForBet',
    args:         [marketIdBytes32, amountWei],
    account,
  });

  return walletClient.writeContract(request);
}

/**
 * Build a viem WalletClient targeting Flow EVM from a Privy EIP-1193 provider.
 */
export function buildFlowWalletClient(provider: unknown): WalletClient {
  return createWalletClient({
    chain:     flowTestnet,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport: (provider as any)._isProvider
      ? http(FLOW_EVM_RPC)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : ({ request }: any) => (provider as any).request({ ...request }),
  });
}

export { parseEther, formatEther };
