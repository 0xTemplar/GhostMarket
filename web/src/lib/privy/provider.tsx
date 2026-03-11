'use client';

import { type ReactNode } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { FlowProvider } from '@/lib/flow/provider';

/**
 * Flow EVM testnet chain definition for Privy.
 * Chain ID 545 — https://evm-testnet.flowscan.io
 */
const flowEvmTestnet = {
  id: 545,
  name: 'Flow EVM Testnet',
  network: 'flow-testnet',
  nativeCurrency: { name: 'Flow', symbol: 'FLOW', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_FLOW_EVM_RPC ?? 'https://testnet.evm.nodes.onflow.org',
      ],
    },
    public: {
      http: ['https://testnet.evm.nodes.onflow.org'],
    },
  },
  blockExplorers: {
    default: { name: 'Flowscan', url: 'https://evm-testnet.flowscan.io' },
  },
  testnet: true,
} as const;

/**
 * Ethereum Sepolia — needed for GhostEAMM (Zama fhevm) shielded bet flow.
 * The embedded wallet must be able to switchChain(11155111) before signing
 * the encrypted placeBet transaction.
 */
const ethereumSepolia = {
  id: 11155111,
  name: 'Ethereum Sepolia',
  network: 'sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org',
      ],
    },
    public: {
      http: ['https://rpc.sepolia.org'],
    },
  },
  blockExplorers: {
    default: { name: 'Etherscan', url: 'https://sepolia.etherscan.io' },
  },
  testnet: true,
} as const;

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        // ── Auth methods ────────────────────────────────────────────────────
        loginMethods: ['email', 'google', 'passkey'],

        // ── Embedded wallet ─────────────────────────────────────────────────
        // Creates a Flow EVM wallet automatically on first login.
        // No seed phrase, no extension, no mobile app.
        embeddedWallets: {
          createOnLogin: 'users-without-wallets',
          requireUserPasswordOnCreate: false,
        },

        // ── Chain config ─────────────────────────────────────────────────────
        // Flow EVM (545) is the primary user-facing chain (vault, deposits).
        // Sepolia (11155111) is needed for GhostEAMM shielded bets via Zama.
        defaultChain: flowEvmTestnet,
        supportedChains: [flowEvmTestnet, ethereumSepolia],

        // ── UI ───────────────────────────────────────────────────────────────
        appearance: {
          theme: 'dark',
          accentColor: '#6366f1',
          logo: `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/icon.png`,
          landingHeader: 'Sign in to GhostMarket',
          loginMessage: 'No wallet needed — just your email or passkey.',
        },
      }}
    >
      {/* FlowProvider reads from usePrivy() — must be inside PrivyProvider */}
      <FlowProvider>{children}</FlowProvider>
    </PrivyProvider>
  );
}
