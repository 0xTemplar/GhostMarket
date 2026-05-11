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

import { MOCK_USDC_ADDRESS, CUSDC_MOCK_ADDRESS } from './cusdc';
export { MOCK_USDC_ADDRESS, CUSDC_MOCK_ADDRESS };

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
    inputs: [
      { name: 'encAmount', type: 'bytes32' },
      { name: 'proof',     type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'encAmount', type: 'bytes32' },
      { name: 'proof',     type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    name: 'lockForBet',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketId',  type: 'bytes32' },
      { name: 'side',      type: 'bool'    },
      { name: 'encAmount', type: 'bytes32' },
      { name: 'proof',     type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    name: 'claimPayout',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketId', type: 'bytes32' },
      { name: 'amount',   type: 'bytes32' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'expiry',   type: 'uint256' },
      { name: 'sig',      type: 'bytes'   },
    ],
    outputs: [],
  },
  // ── Views ──
  {
    name: 'getBalanceHandle',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    name: 'getFreeBalanceHandles',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'balance', type: 'bytes32' },
      { name: 'locked',  type: 'bytes32' },
    ],
  },
  {
    name: 'getLockedAmountHandle',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user',     type: 'address' },
      { name: 'marketId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
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

export async function readVaultBalanceHandle(userAddress: `0x${string}`): Promise<`0x${string}`> {
  return publicClient.readContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'getBalanceHandle',
    args:         [userAddress],
  }) as Promise<`0x${string}`>;
}

export async function readFreeBalanceHandles(userAddress: `0x${string}`): Promise<[`0x${string}`, `0x${string}`]> {
  return publicClient.readContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'getFreeBalanceHandles',
    args:         [userAddress],
  }) as Promise<[`0x${string}`, `0x${string}`]>;
}

export async function readLockedAmountHandle(
  userAddress: `0x${string}`,
  marketId:    `0x${string}`,
): Promise<`0x${string}`> {
  return publicClient.readContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'getLockedAmountHandle',
    args:         [userAddress, marketId],
  }) as Promise<`0x${string}`>;
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

import { CUSDC_MOCK_ABI } from './cusdc';

// ─── USDC write helper ────────────────────────────────────────────────────────

/**
 * Set GhostVault as an operator on cUSDCMock so it can transfer confidential balances.
 */
export async function setOperatorUsdc(
  walletClient: WalletClient,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      CUSDC_MOCK_ADDRESS,
    abi:          CUSDC_MOCK_ABI,
    functionName: 'setOperator',
    args:         [GHOST_VAULT_ADDRESS, 4294967295], // max uint48
    account,
  });
  return walletClient.writeContract(request);
}

export async function readIsOperator(
  owner:   `0x${string}`,
  spender: `0x${string}`,
): Promise<boolean> {
  return publicClient.readContract({
    address:      CUSDC_MOCK_ADDRESS,
    abi:          CUSDC_MOCK_ABI,
    functionName: 'isOperator',
    args:         [owner, spender],
  }) as Promise<boolean>;
}

// ─── Vault write helpers ──────────────────────────────────────────────────────

/**
 * Deposit cUSDC into GhostVault.
 *
 * Prerequisite: user has set GhostVault as operator on cUSDC.
 */
export async function depositToVault(
  walletClient: WalletClient,
  encAmount:    `0x${string}`,
  proof:        `0x${string}`,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'deposit',
    args:         [encAmount, proof],
    account,
  });
  return walletClient.writeContract(request);
}

export async function withdrawFromVault(
  walletClient: WalletClient,
  encAmount:    `0x${string}`,
  proof:        `0x${string}`,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'withdraw',
    args:         [encAmount, proof],
    account,
  });
  return walletClient.writeContract(request);
}

export async function lockBetCollateral(
  walletClient: WalletClient,
  marketId:     `0x${string}`,
  side:         boolean,
  encAmount:    `0x${string}`,
  proof:        `0x${string}`,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'lockForBet',
    args:         [marketId, side, encAmount, proof],
    account,
  });
  return walletClient.writeContract(request);
}

export async function claimVaultPayout(
  walletClient:    WalletClient,
  marketIdBytes32: `0x${string}`,
  amountHandle:    `0x${string}`,
  nonce:           bigint,
  expiry:          bigint,
  sig:             `0x${string}`,
): Promise<`0x${string}`> {
  const [account] = await walletClient.getAddresses();
  const { request } = await publicClient.simulateContract({
    address:      GHOST_VAULT_ADDRESS,
    abi:          GHOST_VAULT_ABI,
    functionName: 'claimPayout',
    args:         [marketIdBytes32, amountHandle, nonce, expiry, sig],
    account,
  });
  return walletClient.writeContract(request);
}

/**
 * Set operator + deposit in one helper.
 * Broadcasts two transactions if operator is not set; one if it is.
 *
 * @returns Array of tx hashes: [operatorTx?, depositTx]
 */
export async function approveAndDeposit(
  walletClient: WalletClient,
  encAmount:    `0x${string}`,
  proof:        `0x${string}`,
): Promise<`0x${string}`[]> {
  const [account] = await walletClient.getAddresses();
  const isOperator = await readIsOperator(account, GHOST_VAULT_ADDRESS);

  const hashes: `0x${string}`[] = [];

  if (!isOperator) {
    const operatorTx = await setOperatorUsdc(walletClient);
    hashes.push(operatorTx);
    // Wait for operator to be set before depositing.
    await publicClient.waitForTransactionReceipt({ hash: operatorTx });
  }

  const depositTx = await depositToVault(walletClient, encAmount, proof);
  hashes.push(depositTx);
  return hashes;
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
