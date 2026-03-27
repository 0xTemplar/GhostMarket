/**
 * setup.ts — One-time CLI helper for the Cadence adapter.
 *
 * Run: npx tsx scripts/setup.ts
 *
 * What it does:
 *   1. Validates that all required env vars are set.
 *   2. Prints the COA EVM address so you can call GhostVault.transferOwnership().
 *   3. Reminds you of the remaining manual steps (deploy contract, run
 *      setup-handler.cdc via Flow CLI).
 *
 * Note: this script does NOT submit the setup-handler.cdc transaction — that
 * must be done via the Flow CLI because it requires a Cadence account with
 * an already-deployed GhostVaultResolverHandler contract:
 *
 *   flow transactions send transactions/setup-handler.cdc \
 *     --signer oracle-account \
 *     --network testnet
 */

import * as fcl from '@onflow/fcl';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const CADENCE_ACCOUNT_ADDRESS = process.env.CADENCE_ACCOUNT_ADDRESS ?? '';
const CADENCE_PRIVATE_KEY     = process.env.CADENCE_PRIVATE_KEY     ?? '';
const FLOW_ACCESS_NODE        = process.env.FLOW_ACCESS_NODE        ?? 'https://rest-testnet.onflow.org';

async function main() {
  console.log('\n=== GhostMarket Cadence Adapter — Setup Check ===\n');

  // ── 1. Validate env vars ──────────────────────────────────────────────────
  const required = [
    'CADENCE_ACCOUNT_ADDRESS',
    'CADENCE_PRIVATE_KEY',
    'GHOST_VAULT_ADDRESS',
    'GHOST_MARKET_ADDRESS',
    'FLOW_RPC_URL',
  ];

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error('❌  Missing required env vars:', missing.join(', '));
    console.error('    Copy .env.example to .env and fill in the values.\n');
    process.exit(1);
  }

  console.log('✅  All required env vars are set.\n');

  // ── 2. Fetch COA EVM address ──────────────────────────────────────────────
  // Use the EVM contract address directly to avoid FCL alias resolution issues
  // in Node.js environments. On Flow testnet the EVM contract lives at the
  // service account address (same as FlowTransactionScheduler).
  const EVM_CONTRACT_ADDR =
    process.env.EVM_CONTRACT_ADDR ?? '0x8c5303eaa26202d6';

  fcl.config({
    'flow.network':   'testnet',
    'accessNode.api': FLOW_ACCESS_NODE,
  });

  console.log('Fetching COA EVM address for account:', CADENCE_ACCOUNT_ADDRESS);

  try {
    const coaAddress = await fcl.query({
      // Use explicit address import instead of import "EVM" to avoid FCL
      // alias placeholder resolution in Node.js environments.
      cadence: `
        import EVM from ${EVM_CONTRACT_ADDR}
        access(all) fun main(addr: Address): String {
          let account = getAuthAccount<auth(Storage) &Account>(addr)
          let coa = account.storage.borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("COA not found")
          return coa.address().toString()
        }
      `,
      args: (arg: typeof fcl.arg, t: typeof fcl.t) => [
        arg(CADENCE_ACCOUNT_ADDRESS, t.Address),
      ],
    });

    console.log('\n✅  COA EVM address: 0x' + (coaAddress as string));
    console.log('\n👉  Next step: call GhostVault.transferOwnership("0x' + (coaAddress as string) + '")');
    console.log('    from the current GhostVault owner account.\n');
  } catch {
    console.log('ℹ️   COA not found — run setup-handler.cdc via Flow CLI first:\n');
    console.log('    flow transactions send transactions/setup-handler.cdc \\');
    console.log('      --signer oracle-account \\');
    console.log('      --network testnet\n');
  }

  // ── 3. Remaining steps ────────────────────────────────────────────────────
  console.log('Remaining setup steps:');
  console.log('  1. Deploy contracts/GhostVaultResolverHandler.cdc via Flow CLI');
  console.log('     flow project deploy --network testnet');
  console.log('  2. Run transactions/setup-handler.cdc (creates COA + handler)');
  console.log('     flow transactions send transactions/setup-handler.cdc --signer oracle-account --network testnet');
  console.log('  3. Get COA EVM address: flow scripts execute scripts/get-coa-address.cdc --network testnet');
  console.log('  4. Call GhostVault.transferOwnership(<coa-evm-address>) from current owner');
  console.log('  5. Set CADENCE_HANDLER_CONTRACT_ADDRESS in .env');
  console.log('  6. Start adapter: npm run dev\n');

  // ── 4. Validate Cadence key derivable from private key ────────────────────
  if (CADENCE_PRIVATE_KEY) {
    try {
      const normalizedKey = CADENCE_PRIVATE_KEY.startsWith('0x')
        ? CADENCE_PRIVATE_KEY
        : '0x' + CADENCE_PRIVATE_KEY;
      const wallet = new ethers.Wallet(normalizedKey);
      console.log('✅  Private key is valid secp256k1 key.');
      console.log('    Derived Ethereum address (for reference):', wallet.address);
      console.log('    (Your Flow account address is separate — set CADENCE_ACCOUNT_ADDRESS)\n');
    } catch {
      console.error('❌  CADENCE_PRIVATE_KEY is not a valid secp256k1 private key.\n');
    }
  }
}

main().catch((err) => {
  console.error('Setup error:', err);
  process.exit(1);
});
