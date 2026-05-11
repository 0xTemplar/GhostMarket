/**
 * deploy-v2.ts
 *
 * Deploys the Phase 0 + Phase 1 contract stack to Ethereum Sepolia:
 *
 *   1. GhostEAMM v2   — same AMM logic + sealed-bid window support
 *   2. GhostVaultV2   — confidential cUSDC vault (ERC-7984)
 *   3. GhostMarket    — metadata registry, wired to new GhostEAMM
 *
 * MockUSDC and cUSDCMock are already deployed on Sepolia — this script
 * reads their addresses from .env and skips redeployment.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-v2.ts --network sepolia
 *
 * Required env (contracts/.env):
 *   DEPLOYER_PRIVATE_KEY
 *   ORACLE_PRIVATE_KEY
 *   SEPOLIA_RPC_URL
 *   MOCK_USDC_ADDRESS          — existing MockUSDC (underlying ERC-20)
 *   CUSDC_MOCK_ADDRESS         — existing cUSDCMock (ERC-7984 wrapper)
 *
 * After deployment, update:
 *   contracts/.env             — GHOST_EAMM_ADDRESS, GHOST_VAULT_ADDRESS, GHOST_MARKET_ADDRESS
 *   oracle/.env                — same three addresses
 *   web/.env.local             — NEXT_PUBLIC_GHOST_EAMM_ADDRESS, etc.
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();

  const oracleKey = process.env.ORACLE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? '';
  if (!oracleKey) throw new Error('ORACLE_PRIVATE_KEY not set in contracts/.env');

  const cusdcAddress = process.env.CUSDC_MOCK_ADDRESS ?? '';
  if (!cusdcAddress) throw new Error('CUSDC_MOCK_ADDRESS not set — run this after cUSDCMock is deployed');

  const oracleAddress = new ethers.Wallet(oracleKey).address;

  console.log('\n=== GhostMarket v2 — Sepolia Deployment ===');
  console.log(`Deployer  : ${deployer.address}`);
  console.log(`Oracle    : ${oracleAddress}`);
  console.log(`Network   : ${hre.network.name} (chainId ${hre.network.config.chainId})`);
  console.log(`cUSDC     : ${cusdcAddress} (existing — not redeployed)`);
  console.log(`MockUSDC  : ${process.env.MOCK_USDC_ADDRESS ?? '(not set)'} (existing — not redeployed)\n`);

  // ── 1. GhostEAMM (with sealed-bid window support) ─────────────────────────
  console.log('1/3  Deploying GhostEAMM…');
  const GhostEAMM = await ethers.getContractFactory('GhostEAMM');
  const eamm = await GhostEAMM.deploy(
    oracleAddress, // marketManager — will be replaced by GhostMarket address below
    oracleAddress, // resolver      — oracle wallet keeps this role permanently
  );
  await eamm.waitForDeployment();
  const eammAddress = await eamm.getAddress();
  console.log(`     GhostEAMM  : ${eammAddress}`);
  console.log(`     Etherscan  : https://sepolia.etherscan.io/address/${eammAddress}\n`);

  // ── 2. GhostVaultV2 (confidential cUSDC) ─────────────────────────────────
  console.log('2/3  Deploying GhostVaultV2…');
  const GhostVaultV2 = await ethers.getContractFactory('GhostVaultV2');
  const vault = await GhostVaultV2.deploy(
    cusdcAddress,  // collateral — cUSDCMock (ERC-7984)
    oracleAddress, // settlementSigner — oracle wallet
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`     GhostVaultV2: ${vaultAddress}`);
  console.log(`     Etherscan   : https://sepolia.etherscan.io/address/${vaultAddress}\n`);

  // ── 3. GhostMarket (metadata registry) ───────────────────────────────────
  console.log('3/3  Deploying GhostMarket…');
  const GhostMarket = await ethers.getContractFactory('GhostMarket');
  const market = await GhostMarket.deploy(
    oracleAddress, // resolver
    eammAddress,   // GhostEAMM — every lifecycle call forwarded here
  );
  await market.waitForDeployment();
  const marketAddress = await market.getAddress();
  console.log(`     GhostMarket : ${marketAddress}`);
  console.log(`     Etherscan   : https://sepolia.etherscan.io/address/${marketAddress}\n`);

  // ── 4. Wire GhostEAMM → GhostMarket as manager ───────────────────────────
  console.log('Wiring: setMarketManager(GhostMarket)…');
  const tx1 = await eamm.setMarketManager(marketAddress);
  await tx1.wait();
  console.log(`  setMarketManager(${marketAddress}) ✓`);

  // Oracle keeps the resolver role on GhostEAMM directly (needed for
  // settleSealedWindow and publishWindowPrice which bypass GhostMarket).
  // GhostMarket also needs resolver access for resolveMarket / cancelMarket.
  console.log('Wiring: setResolver(GhostMarket)…');
  const tx2 = await eamm.setResolver(marketAddress);
  await tx2.wait();
  console.log(`  setResolver(${marketAddress}) ✓\n`);

  // NOTE: The oracle wallet must retain the ability to call settleSealedWindow
  // and publishWindowPrice directly.  GhostEAMM's onlyResolverOrOwner modifier
  // allows the deployer (owner) to do this.  If the deployer ≠ oracle, grant
  // oracle the resolver role back after GhostMarket is set, or keep deployer
  // as a trusted admin.  For testnet both keys are the same so no action needed.

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              DEPLOYMENT COMPLETE — copy these values        ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  contracts/.env and oracle/.env:                            ║');
  console.log(`║    GHOST_EAMM_ADDRESS=${eammAddress.padEnd(40)}║`);
  console.log(`║    GHOST_VAULT_ADDRESS=${vaultAddress.padEnd(39)}║`);
  console.log(`║    GHOST_MARKET_ADDRESS=${marketAddress.padEnd(38)}║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  web/.env.local:                                            ║');
  console.log(`║    NEXT_PUBLIC_GHOST_EAMM_ADDRESS=${eammAddress.padEnd(28)}║`);
  console.log(`║    NEXT_PUBLIC_GHOST_VAULT_ADDRESS=${vaultAddress.padEnd(27)}║`);
  console.log(`║    NEXT_PUBLIC_GHOST_MARKET_ADDRESS=${marketAddress.padEnd(26)}║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Keep unchanged (existing deployments):                     ║');
  console.log(`║    MOCK_USDC_ADDRESS=${(process.env.MOCK_USDC_ADDRESS ?? '').padEnd(41)}║`);
  console.log(`║    CUSDC_MOCK_ADDRESS=${(cusdcAddress).padEnd(40)}║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Next steps:                                                ║');
  console.log('║    1. Update .env files with addresses above                ║');
  console.log('║    2. Seed markets: npx hardhat run scripts/seed-markets.ts ║');
  console.log('║    3. Demo window:  npx hardhat run scripts/demo-sealed-window.ts ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
