/**
 * redeploy-eamm.ts
 *
 * **Incremental EAMM upgrade only.** Prefer a full Sepolia deploy when you can:
 *
 *   npx hardhat run scripts/deploy-sepolia.ts --network sepolia
 *
 * That deploys MockUSDC, GhostEAMM, GhostVault, and GhostMarket together so
 * `GhostMarket.eamm` always matches `GHOST_EAMM_ADDRESS` in your env.
 *
 * This script is for when you must replace GhostEAMM alone:
 *   1. Deploys a new GhostEAMM (e.g. ACL fix in `settleSealedWindow`).
 *   2. Sets marketManager + resolver to the existing GhostMarket.
 *   3. Calls `GhostMarket.setEamm(newEamm)` so `createMarket` / sealed windows
 *      hit the same contract your env points at.
 *
 * Then update contracts/.env, oracle/.env, web/.env.local with the new
 * GHOST_EAMM_ADDRESS / NEXT_PUBLIC_GHOST_EAMM_ADDRESS.
 *
 * Usage:
 *   npx hardhat run scripts/redeploy-eamm.ts --network sepolia
 */

import { ethers } from 'hardhat';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Redeploying GhostEAMM with account:', deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Account balance:', ethers.formatEther(balance), 'ETH\n');

  const marketAddress = process.env.GHOST_MARKET_ADDRESS;
  if (!marketAddress) throw new Error('GHOST_MARKET_ADDRESS not set in contracts/.env');

  // Deploy fresh GhostEAMM — initial resolver/manager set to deployer;
  // we'll re-wire to GhostMarket right after.
  console.log('Deploying GhostEAMM...');
  const GhostEAMM = await ethers.getContractFactory('GhostEAMM');
  const eamm = await GhostEAMM.deploy(
    deployer.address, // marketManager (temp — overwritten below)
    deployer.address, // resolver      (temp — overwritten below)
  );
  await eamm.waitForDeployment();
  const eammAddress = await eamm.getAddress();
  console.log(`GhostEAMM deployed: ${eammAddress}`);
  console.log(`  https://sepolia.etherscan.io/address/${eammAddress}\n`);

  // Re-wire GhostMarket as manager + resolver (same as original deploy).
  console.log('Wiring GhostEAMM → GhostMarket...');
  const tx1 = await eamm.setMarketManager(marketAddress);
  await tx1.wait();
  console.log(`  setMarketManager(${marketAddress}) ✓`);

  const tx2 = await eamm.setResolver(marketAddress);
  await tx2.wait();
  console.log(`  setResolver(${marketAddress}) ✓`);

  const ghostMarketAbi = ['function setEamm(address _eamm) external'];
  const market = new ethers.Contract(marketAddress, ghostMarketAbi, deployer);
  const tx3 = await market.setEamm(eammAddress);
  await tx3.wait();
  console.log(`  GhostMarket.setEamm(${eammAddress}) ✓\n`);

  console.log('=== Done — update your env files ===');
  console.log(`GHOST_EAMM_ADDRESS=${eammAddress}`);
  console.log(`NEXT_PUBLIC_GHOST_EAMM_ADDRESS=${eammAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
