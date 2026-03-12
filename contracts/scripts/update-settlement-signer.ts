/**
 * update-settlement-signer.ts
 *
 * Updates GhostVault.settlementSigner on Flow EVM testnet.
 *
 * Run:
 *   npx ts-node scripts/update-settlement-signer.ts
 *
 * Env:
 *   - GHOST_VAULT_ADDRESS        (required)
 *   - FLOW_EVM_RPC or FLOW_RPC_URL (optional; defaults to Flow testnet RPC)
 *   - DEPLOYER_PRIVATE_KEY       (owner key; required)
 *   - LIT_PKP_ETH_ADDRESS / LIT_PKP_ADDRESS / SETTLEMENT_SIGNER_ADDRESS (target signer)
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const GHOST_VAULT_ADDRESS = process.env.GHOST_VAULT_ADDRESS;
const FLOW_EVM_RPC =
  process.env.FLOW_EVM_RPC ??
  process.env.FLOW_RPC_URL ??
  'https://testnet.evm.nodes.onflow.org';

const VAULT_ABI = [
  'function settlementSigner() external view returns (address)',
  'function setSettlementSigner(address next) external',
  'event SettlementSignerUpdated(address indexed previous, address indexed next)',
];

async function main() {
  if (!GHOST_VAULT_ADDRESS) {
    throw new Error('Missing GHOST_VAULT_ADDRESS in env');
  }
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error('Missing DEPLOYER_PRIVATE_KEY in env');
  }

  const flowProvider = new ethers.JsonRpcProvider(FLOW_EVM_RPC);
  const owner        = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, flowProvider);
  const vault        = new ethers.Contract(GHOST_VAULT_ADDRESS, VAULT_ABI, owner);

  const current = await vault.settlementSigner();
  // Priority: explicit signer envs, then owner address fallback.
  const next =
    process.env.LIT_PKP_ETH_ADDRESS ??
    process.env.LIT_PKP_ADDRESS ??
    process.env.SETTLEMENT_SIGNER_ADDRESS ??
    owner.address;

  console.log('GhostVault:          ', GHOST_VAULT_ADDRESS);
  console.log('Owner:               ', owner.address);
  console.log('Current signer:      ', current);
  console.log('New signer:          ', next);

  if (current.toLowerCase() === next.toLowerCase()) {
    console.log('\n✓ settlementSigner already set correctly — no update needed.');
    return;
  }

  const tx = await vault.setSettlementSigner(next);
  console.log('\nTX (Flow EVM):', tx.hash);
  await tx.wait();

  const updated = await vault.settlementSigner();
  console.log('✓ settlementSigner updated to:', updated);
  console.log(`  Flowscan: https://evm-testnet.flowscan.io/tx/${tx.hash}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
