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
 * Auth layer — powered by Privy.
 *
 * Privy handles walletless onboarding (email, passkeys, Google) and creates
 * an embedded EVM wallet for every user automatically on first login.
 * That wallet address IS the user's EVM address on Flow EVM — no Cadence
 * account or COA needed.
 *
 * FCL is still available for Cadence-specific work (oracle transactions,
 * scheduled execution via Cadence in Phase 5+), but the auth and EVM wallet
 * layer is entirely Privy.
 *
 * Gasless: point NEXT_PUBLIC_FLOW_EVM_RPC at your sponsored gateway.
 * See: https://developers.flow.com/blockchain-development-tutorials/gasless-transactions/sponsored-transactions-evm-endpoint
 */

export interface FlowUser {
  /** Privy user ID (used as the stable identity for the session) */
  addr: string | null;
  loggedIn: boolean;
  /** EVM address from the Privy embedded wallet — ready to use with Flow EVM */
  evmAddress: string | null;
  evmLoading: boolean;
}

interface FlowAuthContextValue {
  user: FlowUser;
  login: () => void;
  logout: () => void;
  /** No-op with Privy — the embedded wallet is created automatically on login */
  setupCoa: () => Promise<void>;
  isLoading: boolean;
}

const defaultUser: FlowUser = {
  addr: null,
  loggedIn: false,
  evmAddress: null,
  evmLoading: true,
};

const FlowAuthContext = createContext<FlowAuthContextValue>({
  user: defaultUser,
  login: () => {},
  logout: () => {},
  setupCoa: async () => {},
  isLoading: true,
});

function getEmbeddedWallet(wallets: ConnectedWallet[]): ConnectedWallet | undefined {
  return wallets.find((w) => w.walletClientType === 'privy');
}

// ─── Inner provider (must be inside <PrivyProvider>) ─────────────────────────

function FlowAuthProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();

  const embeddedWallet = getEmbeddedWallet(wallets);

  /**
   * evmLoading stays true while:
   * 1. Privy hasn't finished rehydrating from localStorage (!ready)
   * 2. User is authenticated but the wallets list hasn't populated yet
   *    (useWallets returns [] for ~500ms after ready=true on first load)
   *
   * This prevents the "Activate EVM account" screen from flashing
   * incorrectly on users who already have an embedded wallet.
   */
  const evmLoading = !ready || (authenticated && wallets.length === 0);

  const flowUser: FlowUser = {
    addr: user?.id ?? null,
    loggedIn: authenticated,
    evmAddress: embeddedWallet?.address ?? null,
    evmLoading,
  };

  const setupCoa = useCallback(async () => {
    // No-op: Privy creates the embedded EVM wallet automatically on login.
    // Kept in the interface for compatibility with the vault page.
  }, []);

  return (
    <FlowAuthContext.Provider
      value={{
        user: flowUser,
        login,
        logout,
        setupCoa,
        isLoading: !ready,
      }}
    >
      {children}
    </FlowAuthContext.Provider>
  );
}

// ─── Public exports ───────────────────────────────────────────────────────────

export { FlowAuthProvider as FlowProvider };

export function useFlowAuth() {
  return useContext(FlowAuthContext);
}

/**
 * Returns a viem WalletClient backed by the Privy embedded wallet.
 * Switch it to Flow EVM testnet (chain 545) and use it for all vault writes.
 * Route through NEXT_PUBLIC_FLOW_EVM_RPC for gasless sponsored transactions.
 */
export function useFlowWalletClient() {
  const { wallets } = useWallets();
  const [walletClient, setWalletClient] = useState<import('viem').WalletClient | null>(null);

  const embeddedWallet = getEmbeddedWallet(wallets);

  useEffect(() => {
    if (!embeddedWallet) {
      setWalletClient(null);
      return;
    }

    let cancelled = false;

    (async () => {
      // Ensure the embedded wallet is on Flow EVM testnet before getting the provider
      await embeddedWallet.switchChain(545);
      const provider = await embeddedWallet.getEthereumProvider();

      const [{ createWalletClient, custom }, { flowTestnet }] = await Promise.all([
        import('viem'),
        import('@/lib/flow/vault'),
      ]);

      if (cancelled) return;

      const client = createWalletClient({
        account: embeddedWallet.address as `0x${string}`,
        chain: flowTestnet,
        transport: custom(provider),
      });
      setWalletClient(client);
    })();

    return () => {
      cancelled = true;
    };
  }, [embeddedWallet?.address]);

  return walletClient;
}
