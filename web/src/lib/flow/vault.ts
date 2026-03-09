/**
 * GhostVault contract ABI and Flow EVM client utilities.
 *
 * Deployed on Flow EVM Testnet (chain ID 545).
 * Replace GHOST_VAULT_ADDRESS after running `npx hardhat run scripts/deploy.ts --network flowTestnet`.
 *
 * Gasless architecture:
 *   Transactions are routed through a custom EVM Gateway running with GAS_PRICE=0.
 *   The gateway's Service Account covers all Cadence tx fees — users pay nothing.
 *   Set NEXT_PUBLIC_FLOW_EVM_RPC to your sponsored gateway URL; it defaults to the
 *   public Flow EVM testnet endpoint (still very cheap at ~$0.0001/tx).
 *
 *   Sponsored gateway setup: https://developers.flow.com/blockchain-development-tutorials/gasless-transactions/sponsored-transactions-evm-endpoint
 */
import { createPublicClient, http, parseEther, formatEther } from 'viem';
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

// Set after deployment — see contracts/README.md
export const GHOST_VAULT_ADDRESS =
  (process.env.NEXT_PUBLIC_GHOST_VAULT_ADDRESS as `0x${string}`) ??
  '0x0000000000000000000000000000000000000000';

export const GHOST_VAULT_ABI = [
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
    name: 'claimPayout',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'expiry', type: 'uint256' },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'getBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'Deposited',
    type: 'event',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'Withdrawn',
    type: 'event',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'PayoutClaimed',
    type: 'event',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'marketId', type: 'bytes32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

/**
 * RPC endpoint used for ALL EVM reads and writes.
 *
 * - Development / default: public Flow EVM testnet node
 * - Production gasless:    your custom EVM Gateway with GAS_PRICE=0
 *
 * Set NEXT_PUBLIC_FLOW_EVM_RPC in .env.local to override.
 */
export const FLOW_EVM_RPC =
  process.env.NEXT_PUBLIC_FLOW_EVM_RPC ?? 'https://testnet.evm.nodes.onflow.org';

export const publicClient = createPublicClient({
  chain: flowTestnet,
  transport: http(FLOW_EVM_RPC),
});

export async function readVaultBalance(userAddress: `0x${string}`): Promise<string> {
  if (GHOST_VAULT_ADDRESS === '0x0000000000000000000000000000000000000000') {
    return '0';
  }
  try {
    const raw = await publicClient.readContract({
      address: GHOST_VAULT_ADDRESS,
      abi: GHOST_VAULT_ABI,
      functionName: 'getBalance',
      args: [userAddress],
    });
    return formatEther(raw as bigint);
  } catch {
    return '0';
  }
}

export { parseEther, formatEther };
