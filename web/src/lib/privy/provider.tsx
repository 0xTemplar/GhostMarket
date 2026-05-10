'use client';

import { type ReactNode } from 'react';
import { PrivyProvider }  from '@privy-io/react-auth';
import { GhostProvider }  from '@/lib/privy/ghost-provider';

/**
 * Ethereum Sepolia — the only chain used by GhostMarket.
 * All contracts (GhostEAMM, GhostVault, GhostMarket) live here.
 */
const ethereumSepolia = {
  id:   11155111,
  name: 'Ethereum Sepolia',
  network: 'sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org'],
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
        loginMethods: ['email', 'google'],
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'users-without-wallets',
          },
        },
        defaultChain:    ethereumSepolia,
        supportedChains: [ethereumSepolia],
        appearance: {
          theme:         'dark',
          accentColor:   '#6366f1',
          logo:          `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/icon.png`,
          landingHeader: 'Sign in to GhostMarket',
          loginMessage:  'No wallet needed — just your email or passkey.',
        },
      }}
    >
      {/* GhostProvider reads from usePrivy() — must be inside PrivyProvider */}
      <GhostProvider>{children}</GhostProvider>
    </PrivyProvider>
  );
}
