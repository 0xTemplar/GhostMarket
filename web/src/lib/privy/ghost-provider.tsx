'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { usePrivy, useWallets, type ConnectedWallet } from '@privy-io/react-auth';

/**
 * Auth + wallet layer — powered by Privy.
 *
 * Users sign in with email or Google. An embedded EVM wallet is created
 * automatically on first login and targets Ethereum Sepolia (chain 11155111).
 *
 * This provider replaces the old FlowProvider / FlowAuthContext.
 * The hook names are kept compatible (useFlowAuth, useFlowWalletClient)
 * so existing page imports don't all need renaming.
 */

export interface GhostUser {
  addr:        string | null;   // Privy user ID
  loggedIn:    boolean;
  evmAddress:  string | null;   // Privy embedded wallet address
  evmLoading:  boolean;
}

interface GhostAuthContextValue {
  user:      GhostUser;
  login:     () => void;
  logout:    () => void;
  setupCoa:  () => Promise<void>;  // no-op; kept for API compatibility
  isLoading: boolean;
}

const defaultUser: GhostUser = {
  addr:       null,
  loggedIn:   false,
  evmAddress: null,
  evmLoading: true,
};

const GhostAuthContext = createContext<GhostAuthContextValue>({
  user:      defaultUser,
  login:     () => {},
  logout:    () => {},
  setupCoa:  async () => {},
  isLoading: true,
});

function getEmbeddedWallet(wallets: ConnectedWallet[]): ConnectedWallet | undefined {
  return wallets.find((w) => w.walletClientType === 'privy');
}

function GhostAuthProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();

  const embeddedWallet = getEmbeddedWallet(wallets);
  const evmLoading     = !ready || (authenticated && wallets.length === 0);

  const ghostUser: GhostUser = {
    addr:       user?.id ?? null,
    loggedIn:   authenticated,
    evmAddress: embeddedWallet?.address ?? null,
    evmLoading,
  };

  const setupCoa = useCallback(async () => {
    // No-op: Privy creates the embedded wallet automatically on login.
  }, []);

  return (
    <GhostAuthContext.Provider
      value={{ user: ghostUser, login, logout, setupCoa, isLoading: !ready }}
    >
      {children}
    </GhostAuthContext.Provider>
  );
}

export { GhostAuthProvider as GhostProvider };

/** Drop-in replacement for the old useFlowAuth hook. */
export function useFlowAuth() {
  return useContext(GhostAuthContext);
}

/**
 * Returns a viem WalletClient backed by the Privy embedded wallet,
 * targeting Ethereum Sepolia (chain 11155111).
 *
 * Drop-in replacement for the old useFlowWalletClient hook.
 */
export function useFlowWalletClient() {
  const { wallets } = useWallets();
  const [walletClient, setWalletClient] = useState<import('viem').WalletClient | null>(null);

  const embeddedWallet = getEmbeddedWallet(wallets);

  useEffect(() => {
    if (!embeddedWallet) { setWalletClient(null); return; }

    let cancelled = false;

    (async () => {
      await embeddedWallet.switchChain(11155111);
      const provider = await embeddedWallet.getEthereumProvider();
      const [{ createWalletClient, custom }, { sepolia }] = await Promise.all([
        import('viem'),
        import('viem/chains'),
      ]);
      if (cancelled) return;
      const client = createWalletClient({
        account:   embeddedWallet.address as `0x${string}`,
        chain:     sepolia,
        transport: custom(provider),
      });
      setWalletClient(client);
    })();

    return () => { cancelled = true; };
  }, [embeddedWallet?.address]);

  return walletClient;
}
