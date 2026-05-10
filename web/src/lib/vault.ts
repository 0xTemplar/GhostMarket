/**
 * vault.ts — GhostVault + MockUSDC helpers for Ethereum Sepolia.
 *
 * Collateral is USDC (6 decimals): 1 USDC = 1_000_000 base units.
 *
 * Deposit flow:
 *   1. approveUsdc(walletClient, amount)   — user approves GhostVault to spend USDC
 *   2. depositToVault(walletClient, amount) — GhostVault.deposit() pulls tokens in
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseUnits,
  formatUnits,
  type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';

// ─── USDC constants ───────────────────────────────────────────────────────────

export const USDC_DECIMALS = 6;

/** Parse a human-readable USDC string (e.g. "10.50") to base units. */
export function parseUsdc(amount: string): bigint {
  return parseUnits(amount, USDC_DECIMALS);
}

/** Format USDC base units to a 2-decimal string (e.g. 10_500_000n → "10.50"). */
export function formatUsdc(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}

// ─── Contract addresses ───────────────────────────────────────────────────────

export const GHOST_VAULT_ADDRESS = (
  process.env.NEXT_PUBLIC_GHOST_VAULT_ADDRESS ?? ''
) as `0x${string}`;

export const MOCK_USDC_ADDRESS = (
  process.env.NEXT_PUBLIC_MOCK_USDC_ADDRESS ?? ''
) as `0x${string}`;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export const GHOST_VAULT_ABI = [
  // ── Write ──
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'depositFor',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'user',   type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
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
      { name: 'side',     type: 'bool'    },
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
  // ── Views ──
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
    name: 'computeExpectedPayout',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user',     type: 'address' },
      { name: 'marketId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isResolved',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'settlementSigner',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'collateral',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

// ─── Public client (read-only, Sepolia) ───────────────────────────────────────

export const publicClient = createPublicClient({
  chain:     sepolia,
  transport: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org'),
});

// ─── USDC read helpers ────────────────────────────────────────────────────────

export async function readUsdcBalance(userAddress: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address:      MOCK_USDC_ADDRESS,
    abi:          ERC20_ABI,
    functionName: 'balanceOf',
    args:         [userAddress],
  }) as Promise<bigint>;
}

export async function readUsdcAllowance(
  owner:   `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return publicClient.readContract({
    address:      MOCK_USDC_ADDRESS,
    abi:          ERC20_ABI,
    functionName: 'allowance',
    args:         [owner, spender],
  }) as Promise<bigint>;
}

// ─── Vault read helpers ───────────────────────────────────────────────────────

export async function readVaultBalance(userAddress: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'getBalance',
    args:         [userAddress],
  }) as Promise<bigint>;
}

export async function readFreeBalance(userAddress: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'getFreeBalance',
    args:         [userAddress],
  }) as Promise<bigint>;
}

export async function readLockedAmount(
  userAddress: `0x${string}`,
  marketId:    `0x${string}`,
): Promise<bigint> {
  return publicClient.readContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'lockedAmounts',
    args:         [userAddress, marketId],
  }) as Promise<bigint>;
}

export async function readComputedPayout(
  userAddress: `0x${string}`,
  marketId:    `0x${string}`,
): Promise<bigint> {
  return publicClient.readContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'computeExpectedPayout',
    args:         [userAddress, marketId],
  }) as Promise<bigint>;
}

export async function readIsMarketResolved(marketId: `0x${string}`): Promise<boolean> {
  return publicClient.readContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'isResolved',
    args:         [marketId],
  }) as Promise<boolean>;
}

export async function readSettlementSigner(): Promise<`0x${string}`> {
  return publicClient.readContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'settlementSigner',
  }) as Promise<`0x${string}`>;
}

// ─── USDC write helper ────────────────────────────────────────────────────────

/**
 * Approve GhostVault to spend `amount` USDC on behalf of the user.
 * Must be called before depositToVault if allowance < amount.
 */
export async function approveUsdc(
  walletClient: WalletClient,
  amount:       bigint,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      MOCK_USDC_ADDRESS,
    abi:          ERC20_ABI,
    functionName: 'approve',
    args:         [GHOST_VAULT_ADDRESS, amount],
    account,
  });
  return walletClient.writeContract(request);
}

// ─── Vault write helpers ──────────────────────────────────────────────────────

/**
 * Deposit USDC into GhostVault.
 *
 * Prerequisite: user has approved GhostVault for at least `amount`.
 * Use approveUsdc() first if needed (check readUsdcAllowance).
 *
 * @param amount USDC in base units (use parseUsdc("10") for 10 USDC).
 */
export async function depositToVault(
  walletClient: WalletClient,
  amount:       bigint,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'deposit',
    args:         [amount],
    account,
  });
  return walletClient.writeContract(request);
}

/**
 * Approve + deposit in one helper — handles the allowance check automatically.
 * Broadcasts two transactions if approval is needed; one if allowance is sufficient.
 *
 * @returns Array of tx hashes: [approveTx?, depositTx]
 */
export async function approveAndDeposit(
  walletClient: WalletClient,
  amount:       bigint,
): Promise<`0x${string}`[]> {
  const [account] = await walletClient.getAddresses();
  const allowance = await readUsdcAllowance(account, GHOST_VAULT_ADDRESS);

  const hashes: `0x${string}`[] = [];

  if (allowance < amount) {
    const approveTx = await approveUsdc(walletClient, amount);
    hashes.push(approveTx);
    // Wait for approval to be mined before depositing.
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  const depositTx = await depositToVault(walletClient, amount);
  hashes.push(depositTx);
  return hashes;
}

export async function withdrawFromVault(
  walletClient: WalletClient,
  amount:       bigint,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'withdraw',
    args:         [amount],
    account,
  });
  return walletClient.writeContract(request);
}

export async function lockBetCollateral(
  walletClient: WalletClient,
  marketId:     `0x${string}`,
  amount:       bigint,
  side:         boolean,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'lockForBet',
    args:         [marketId, amount, side],
    account,
  });
  return walletClient.writeContract(request);
}

export async function claimVaultPayout(
  walletClient:    WalletClient,
  marketIdBytes32: `0x${string}`,
  amount:          bigint,
  nonce:           bigint,
  expiry:          bigint,
  sig:             `0x${string}`,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'claimPayout',
    args:         [marketIdBytes32, amount, nonce, expiry, sig],
    account,
  });
  return walletClient.writeContract(request);
}

// ─── Convenience ──────────────────────────────────────────────────────────────

export function buildSepoliaWalletClient(provider: unknown): WalletClient {
  return createWalletClient({
    chain:     sepolia,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport: custom(provider as any),
  });
}

/** True if GhostVault address is configured. */
export function isVaultDeployed(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GHOST_VAULT_ADDRESS);
}
