/**
 * deploy-eamm.ts
 *
 * Deploys GhostEAMM (encrypted AMM) to Ethereum Sepolia.
 *
 * Zama Protocol runs on Ethereum Sepolia — it is NOT a standalone chain.
 * ZamaEthereumConfig (inherited by GhostEAMM) wires the contract to the
 * Sepolia FHEVM gateway at compile time.
 *
 * Usage:
 *   # Fast mock testing (no real FHE, in-memory):
 *   npx hardhat test --network hardhat
 *
 *   # Deploy to Sepolia (real FHE encryption):
 *   npx hardhat run scripts/deploy-eamm.ts --network sepolia
 *
 *   # Verify FHEVM compatibility after deploy:
 *   npx hardhat fhevm check-fhevm-compatibility --network sepolia --address <addr>
 *
 * Prerequisites:
 *   - SEPOLIA_PRIVATE_KEY set in contracts/.env (funded from https://sepoliafaucet.com)
 *   - SEPOLIA_RPC_URL set (Alchemy / Infura recommended for reliability)
 *   - MARKET_MANAGER_ADDRESS and RESOLVER_ADDRESS set in contracts/.env
 */

import { ethers } from 'hardhat';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying GhostEAMM with account:', deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Account balance:', ethers.formatEther(balance), 'ETH');

  const marketManager = process.env.MARKET_MANAGER_ADDRESS ?? deployer.address;
  const resolver      = process.env.RESOLVER_ADDRESS       ?? deployer.address;

  console.log('\nConstructor args:');
  console.log('  marketManager:', marketManager);
  console.log('  resolver:     ', resolver);

  const GhostEAMM = await ethers.getContractFactory('GhostEAMM');
  const eamm      = await GhostEAMM.deploy(marketManager, resolver);
  await eamm.waitForDeployment();

  const address = await eamm.getAddress();
  console.log('\nGhostEAMM deployed to:', address);
  console.log('\nAdd to contracts/.env:');
  console.log(`  GHOST_EAMM_ADDRESS=${address}`);
  console.log('\nAdd to web/.env.local:');
  console.log(`  NEXT_PUBLIC_GHOST_EAMM_ADDRESS=${address}`);
  console.log(`  NEXT_PUBLIC_SEPOLIA_RPC_URL=${process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org'}`);
  console.log('\nVerify FHEVM compatibility:');
  console.log(`  npx hardhat fhevm check-fhevm-compatibility --network sepolia --address ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
