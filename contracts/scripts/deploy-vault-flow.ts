/**
 * Standalone GhostVault deployment script for Flow EVM Testnet.
 * Uses ethers directly — bypasses @fhevm/hardhat-plugin which only
 * supports hardhat/localhost/sepolia/mainnet.
 *
 * Usage:
 *   npx ts-node scripts/deploy-vault-flow.ts
 *
 * Requires in contracts/.env:
 *   DEPLOYER_PRIVATE_KEY=0x...
 *   SETTLEMENT_SIGNER_ADDRESS=0x...   (optional — defaults to deployer)
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const FLOW_EVM_RPC   = 'https://testnet.evm.nodes.onflow.org';
const DEPLOYER_KEY   = process.env.DEPLOYER_PRIVATE_KEY ?? '';
const SETTLEMENT_ADDR = process.env.SETTLEMENT_SIGNER_ADDRESS ?? '';

async function main() {
  if (!DEPLOYER_KEY) {
    throw new Error('DEPLOYER_PRIVATE_KEY not set in contracts/.env');
  }

  const provider = new ethers.JsonRpcProvider(FLOW_EVM_RPC);
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

  const network = await provider.getNetwork();
  const balance = await provider.getBalance(deployer.address);

  console.log('Network  :', network.name, `(chainId ${network.chainId})`);
  console.log('Deployer :', deployer.address);
  console.log('Balance  :', ethers.formatEther(balance), 'FLOW');
  console.log('');

  const settlementSigner = SETTLEMENT_ADDR || deployer.address;
  console.log('Settlement signer:', settlementSigner);

  // Load compiled artifact
  const artifactPath = path.resolve(
    __dirname,
    '../artifacts/contracts/GhostVault.sol/GhostVault.json',
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  console.log('\nDeploying GhostVault…');
  const vault = await factory.deploy(settlementSigner);
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  const deployTx = vault.deploymentTransaction();

  console.log('\n✅ GhostVault deployed to:', address);
  console.log('   Tx hash            :', deployTx?.hash ?? 'unknown');
  console.log('   Flowscan           :', `https://evm-testnet.flowscan.io/address/${address}`);

  console.log('\n── Update your environment ──────────────────────────────────────');
  console.log(`NEXT_PUBLIC_GHOST_VAULT_ADDRESS=${address}`);
  console.log(`GHOST_VAULT_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
