"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fcl = __importStar(require("@onflow/fcl"));
const ethers_1 = require("ethers");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const CADENCE_ACCOUNT_ADDRESS = process.env.CADENCE_ACCOUNT_ADDRESS ?? '';
const CADENCE_PRIVATE_KEY = process.env.CADENCE_PRIVATE_KEY ?? '';
const FLOW_ACCESS_NODE = process.env.FLOW_ACCESS_NODE ?? 'https://rest-testnet.onflow.org';
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
    const EVM_CONTRACT_ADDR = process.env.EVM_CONTRACT_ADDR ?? '0x8c5303eaa26202d6';
    fcl.config({
        'flow.network': 'testnet',
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
            args: (arg, t) => [
                arg(CADENCE_ACCOUNT_ADDRESS, t.Address),
            ],
        });
        console.log('\n✅  COA EVM address: 0x' + coaAddress);
        console.log('\n👉  Next step: call GhostVault.transferOwnership("0x' + coaAddress + '")');
        console.log('    from the current GhostVault owner account.\n');
    }
    catch {
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
            const wallet = new ethers_1.ethers.Wallet(normalizedKey);
            console.log('✅  Private key is valid secp256k1 key.');
            console.log('    Derived Ethereum address (for reference):', wallet.address);
            console.log('    (Your Flow account address is separate — set CADENCE_ACCOUNT_ADDRESS)\n');
        }
        catch {
            console.error('❌  CADENCE_PRIVATE_KEY is not a valid secp256k1 private key.\n');
        }
    }
}
main().catch((err) => {
    console.error('Setup error:', err);
    process.exit(1);
});
