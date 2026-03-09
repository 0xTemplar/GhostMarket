import * as fcl from '@onflow/fcl';

/**
 * FCL configuration — Flow testnet.
 *
 * Auth notes (FCL 1.21.x):
 *  - discovery.wallet.method: 'TAB/RPC' opens auth in a new browser tab.
 *    This is the most reliable option — no popup blockers, no iframe CORS.
 *  - In the wallet picker, choose "Flow Wallet" (supports email + passkeys).
 *    Do NOT pick Blocto — broken with FCL 1.21.x.
 *
 * Required env vars — web/.env.local:
 *   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID  — from https://cloud.walletconnect.com
 *   NEXT_PUBLIC_APP_URL                   — http://localhost:3000 in dev
 *   NEXT_PUBLIC_GHOST_VAULT_ADDRESS       — set after deploying GhostVault
 *   NEXT_PUBLIC_FLOW_EVM_RPC              — override for sponsored gateway
 */

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';
const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

fcl.config({
  // ── App identity ──────────────────────────────────────────────────────────
  'app.detail.title': 'GhostMarket',
  'app.detail.description': 'Confidential prediction markets on Flow',
  'app.detail.icon': `${APP_URL}/icon.png`,
  'app.detail.url': APP_URL,

  // ── Flow testnet ──────────────────────────────────────────────────────────
  'accessNode.api': 'https://rest-testnet.onflow.org',
  'flow.network': 'testnet',

  // ── Wallet discovery ──────────────────────────────────────────────────────
  // TAB/RPC opens in a new browser tab — avoids popup blockers and blank
  // overlay issues. Flow Wallet (email + passkeys) works reliably here.
  'discovery.wallet': 'https://fcl-discovery.onflow.org/testnet/authn',
  'discovery.wallet.method': 'TAB/RPC',

  // ── WalletConnect ─────────────────────────────────────────────────────────
  'walletconnect.projectId': WC_PROJECT_ID,
  ...(WC_PROJECT_ID ? {} : { 'walletconnect.disableNotifications': true }),
});
