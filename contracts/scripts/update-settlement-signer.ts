/**
 * update-settlement-signer.ts
 *
 * Updates GhostVault.settlementSigner to the deployer address so that
 * simulate-settlement.ts (and eventually the real Lit PKP) can call
 * claimPayout() with a valid signature.
 *
 * Run (standalone — does NOT use Hardhat, fhevm plugin not involved):
 *   npx ts-node scripts/update-settlement-signer.ts
 *
 * In production: set LIT_PKP_ADDRESS in .env to the Lit PKP address.
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const GHOST_VAULT_ADDRESS = '0xAf470490b2462DC7359605B8e5D731CbB7816B55';
const FLOW_EVM_RPC        = 'https://testnet.evm.nodes.onflow.org';

const VAULT_ABI = [
  'function settlementSigner() external view returns (address)',
  'function setSettlementSigner(address next) external',
  'event SettlementSignerUpdated(address indexed previous, address indexed next)',
];

async function main() {
  const flowProvider = new ethers.JsonRpcProvider(FLOW_EVM_RPC);
  const owner        = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, flowProvider);
  const vault        = new ethers.Contract(GHOST_VAULT_ADDRESS, VAULT_ABI, owner);

  const current = await vault.settlementSigner();
  // For testnet: settlement signer = deployer (same key signs from Sepolia).
  // For production: set this to the Lit PKP address.
  const next    = process.env.LIT_PKP_ADDRESS ?? owner.address;

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
