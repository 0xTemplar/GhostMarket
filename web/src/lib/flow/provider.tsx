'use client';

// Re-export from canonical location for backward compatibility.
// New code should import from @/lib/privy/ghost-provider directly.
export {
  GhostProvider as FlowProvider,
  useFlowAuth,
  useFlowWalletClient,
} from '@/lib/privy/ghost-provider';
export type { GhostUser as FlowUser } from '@/lib/privy/ghost-provider';
