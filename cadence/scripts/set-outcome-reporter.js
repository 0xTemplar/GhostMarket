"use strict";
/**
 * set-outcome-reporter.ts
 *
 * Calls GhostVault.setOutcomeReporter(coaEvmAddress) from the current owner.
 * This grants the Cadence COA the right to call reportOutcome() alongside
 * the existing oracle private-key path — no ownership transfer, no disruption.
 *
 * Both paths work simultaneously:
 *   - vault-reporter.ts (VAULT_OWNER_PRIVATE_KEY)  ← existing, unchanged
 *   - Cadence COA via FlowTransactionScheduler     ← new, autonomous
 *
 * Usage: npx tsx scripts/set-outcome-reporter.ts
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ethers_1 = require("ethers");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const FLOW_RPC_URL = process.env.FLOW_RPC_URL ?? 'https://testnet.evm.nodes.onflow.org';
const GHOST_VAULT_ADDRESS = process.env.GHOST_VAULT_ADDRESS ?? '';
const VAULT_OWNER_KEY = process.env.VAULT_OWNER_PRIVATE_KEY ?? '';
const COA_EVM_ADDRESS = process.env.COA_EVM_ADDRESS ?? '0x0000000000000000000000026fededbe9c416779';
const ABI = [
    'function owner() view returns (address)',
    'function outcomeReporter() view returns (address)',
    'function setOutcomeReporter(address reporter) external',
];
async function main() {
    if (!GHOST_VAULT_ADDRESS || !VAULT_OWNER_KEY) {
        console.error('❌  Set GHOST_VAULT_ADDRESS and VAULT_OWNER_PRIVATE_KEY in .env');
        process.exit(1);
    }
    const provider = new ethers_1.ethers.JsonRpcProvider(FLOW_RPC_URL);
    const wallet = new ethers_1.ethers.Wallet(VAULT_OWNER_KEY, provider);
    const vault = new ethers_1.ethers.Contract(GHOST_VAULT_ADDRESS, ABI, wallet);
    const currentOwner = await vault.owner();
    const currentReporter = await vault.outcomeReporter();
    console.log('GhostVault       :', GHOST_VAULT_ADDRESS);
    console.log('Current owner    :', currentOwner);
    console.log('Current reporter :', currentReporter === ethers_1.ethers.ZeroAddress ? '(none)' : currentReporter);
    console.log('Your address     :', wallet.address);
    console.log('COA address      :', COA_EVM_ADDRESS);
    if (currentOwner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.error('\n❌  Your key is not the current owner');
        process.exit(1);
    }
    if (currentReporter.toLowerCase() === COA_EVM_ADDRESS.toLowerCase()) {
        console.log('\n✅  COA is already set as outcomeReporter — nothing to do.');
        return;
    }
    console.log('\nCalling setOutcomeReporter...');
    const tx = await vault.setOutcomeReporter(COA_EVM_ADDRESS);
    console.log('TX submitted     :', tx.hash);
    const receipt = await tx.wait();
    console.log('✅  Confirmed in block', receipt.blockNumber);
    console.log('\nBoth paths now active:');
    console.log('  vault-reporter.ts (VAULT_OWNER_PRIVATE_KEY) → unchanged');
    console.log('  Cadence COA (FlowTransactionScheduler)      → authorized');
}
main().catch((e) => { console.error(e); process.exit(1); });
