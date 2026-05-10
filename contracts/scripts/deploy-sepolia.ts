/**
 * deploy-sepolia.ts
 *
 * Deploys all GhostMarket contracts to Ethereum Sepolia in order:
 *   1. MockUSDC     — mintable ERC20 (name: "USD Coin", symbol: "USDC", 6 dec)
 *   2. GhostEAMM   — FHE-encrypted AMM (Zama FHEVM coprocessor)
 *   3. GhostVault  — USDC custody + EIP-712 oracle-signed settlement
 *   4. GhostMarket — Public market metadata registry
 *
 * Usage:
 *   npx hardhat run scripts/deploy-sepolia.ts --network sepolia
 *
 * Required env vars (.env):
 *   DEPLOYER_PRIVATE_KEY          — deployer wallet (also becomes MockUSDC owner)
 *   ORACLE_PRIVATE_KEY            — oracle wallet (becomes marketManager, resolver,
 *                                   settlementSigner, and vault outcomeReporter)
 *   SEPOLIA_RPC_URL               — Alchemy / Infura Sepolia endpoint
 *
 * After deployment, copy the printed addresses to:
 *   oracle/.env       — GHOST_EAMM_ADDRESS, GHOST_VAULT_ADDRESS, GHOST_MARKET_ADDRESS
 *   web/.env.local    — NEXT_PUBLIC_GHOST_EAMM_ADDRESS, etc.
 *
 * Seeding markets (after deploy):
 *   npx hardhat run scripts/seed-usdc.ts --network sepolia
 *   (mints USDC to seeder wallet and calls GhostVault.depositFor to pre-fund markets)
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';

// 1 million USDC minted to the deployer for seeding / testing.
const SEED_AMOUNT = ethers.parseUnits('1000000', 6);

async function main() {
  const [deployer] = await ethers.getSigners();

  const oracleKey = process.env.ORACLE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? '';
  if (!oracleKey) throw new Error('ORACLE_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY not set');

  const oracleWallet  = new ethers.Wallet(oracleKey);
  const oracleAddress = oracleWallet.address;

  console.log('\n=== GhostMarket — Sepolia Deployment ===');
  console.log(`Deployer : ${deployer.address}`);
  console.log(`Oracle   : ${oracleAddress}`);
  console.log(`Network  : ${hre.network.name} (chainId ${hre.network.config.chainId})\n`);

  // ── 1. MockUSDC ────────────────────────────────────────────────────────────
  console.log('Deploying MockUSDC...');
  const MockUSDC = await ethers.getContractFactory('MockUSDC');
  const usdc = await MockUSDC.deploy(deployer.address);
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log(`MockUSDC deployed   : ${usdcAddress}`);
  console.log(`  Etherscan: https://sepolia.etherscan.io/address/${usdcAddress}`);

  // Mint seed supply to deployer so markets can be funded immediately.
  const mintTx = await usdc.mint(deployer.address, SEED_AMOUNT);
  await mintTx.wait();
  console.log(`  Minted 1,000,000 USDC to ${deployer.address}\n`);

  // ── 2. GhostEAMM ───────────────────────────────────────────────────────────
  console.log('Deploying GhostEAMM...');
  const GhostEAMM = await ethers.getContractFactory('GhostEAMM');
  const eamm = await GhostEAMM.deploy(
    oracleAddress, // marketManager
    oracleAddress, // resolver
  );
  await eamm.waitForDeployment();
  const eammAddress = await eamm.getAddress();
  console.log(`GhostEAMM deployed  : ${eammAddress}`);
  console.log(`  Etherscan: https://sepolia.etherscan.io/address/${eammAddress}\n`);

  // ── 3. GhostVault ──────────────────────────────────────────────────────────
  console.log('Deploying GhostVault...');
  const GhostVault = await ethers.getContractFactory('GhostVault');
  const vault = await GhostVault.deploy(
    usdcAddress,   // collateral token (MockUSDC)
    oracleAddress, // settlementSigner = oracle wallet
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`GhostVault deployed : ${vaultAddress}`);
  console.log(`  Etherscan: https://sepolia.etherscan.io/address/${vaultAddress}\n`);

  // ── 4. GhostMarket ─────────────────────────────────────────────────────────
  console.log('Deploying GhostMarket...');
  const GhostMarket = await ethers.getContractFactory('GhostMarket');
  const market = await GhostMarket.deploy(
    oracleAddress, // resolver
    eammAddress,   // GhostEAMM — forwarded to on every lifecycle call
  );
  await market.waitForDeployment();
  const marketAddress = await market.getAddress();
  console.log(`GhostMarket deployed: ${marketAddress}`);
  console.log(`  Etherscan: https://sepolia.etherscan.io/address/${marketAddress}\n`);

  // ── 5. Wire GhostEAMM to accept GhostMarket as its manager + resolver ─────
  // GhostMarket is now the single entry point:
  //   createMarket()  → eamm.createMarket()   (requires marketManager role)
  //   resolveMarket() → eamm.resolveMarket()  (requires resolver role)
  //   cancelMarket()  → eamm.cancelMarket()   (requires resolver role)
  console.log('Wiring GhostEAMM → GhostMarket...');
  const tx1 = await eamm.setMarketManager(marketAddress);
  await tx1.wait();
  console.log(`  setMarketManager(${marketAddress}) ✓`);
  const tx2 = await eamm.setResolver(marketAddress);
  await tx2.wait();
  console.log(`  setResolver(${marketAddress}) ✓\n`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('=== Deployment complete ===\n');
  console.log('Add to oracle/.env and contracts/.env:');
  console.log(`  MOCK_USDC_ADDRESS=${usdcAddress}`);
  console.log(`  GHOST_EAMM_ADDRESS=${eammAddress}`);
  console.log(`  GHOST_VAULT_ADDRESS=${vaultAddress}`);
  console.log(`  GHOST_MARKET_ADDRESS=${marketAddress}`);
  console.log('');
  console.log('Add to web/.env.local:');
  console.log(`  NEXT_PUBLIC_MOCK_USDC_ADDRESS=${usdcAddress}`);
  console.log(`  NEXT_PUBLIC_GHOST_EAMM_ADDRESS=${eammAddress}`);
  console.log(`  NEXT_PUBLIC_GHOST_VAULT_ADDRESS=${vaultAddress}`);
  console.log(`  NEXT_PUBLIC_GHOST_MARKET_ADDRESS=${marketAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
