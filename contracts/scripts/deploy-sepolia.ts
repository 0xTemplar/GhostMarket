/**
 * deploy-sepolia.ts
 *
 * **Preferred way to refresh Sepolia** after any change to GhostEAMM, GhostMarket,
 * or how they are wired. Deploying a new EAMM alone without updating GhostMarket’s
 * `eamm` pointer leaves metadata and encrypted state on different contracts — always
 * either run this full flow or call `GhostMarket.setEamm` immediately after a partial
 * EAMM redeploy (see `scripts/redeploy-eamm.ts`).
 *
 * Deploys all GhostMarket contracts to Ethereum Sepolia in order:
 *   1. Collateral USDC — **by default** Zama’s protocol mock underlying on Sepolia
 *      (`0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF`, public `mint`, 6 decimals; see
 *      https://docs.zama.org/protocol/protocol-apps/addresses/testnet/sepolia).
 *      Set `USE_ZAMA_SEPOLIA_MOCK_USDC=0` to deploy a fresh repo `MockUSDC.sol` instead
 *      (isolated addresses, not the Zama-listed token).
 *   2. GhostEAMM    — FHE-encrypted AMM (Zama FHEVM coprocessor)
 *   3. GhostVault  — USDC custody + EIP-712 oracle-signed settlement
 *   4. GhostMarket — Public market metadata registry (constructor wires `eamm`)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-sepolia.ts --network sepolia
 *
 * Required env vars (contracts/.env):
 *   DEPLOYER_PRIVATE_KEY          — deployer wallet (also becomes MockUSDC owner)
 *   ORACLE_PRIVATE_KEY            — oracle wallet (initial EAMM manager/resolver;
 *                                   GhostMarket is wired as manager+resolver next)
 *   SEPOLIA_RPC_URL               — Alchemy / Infura Sepolia endpoint
 *
 * After deployment — update **all** of these in one pass (no mixed old/new addresses):
 *   contracts/.env    — MOCK_USDC_ADDRESS, GHOST_EAMM_ADDRESS, GHOST_VAULT_ADDRESS,
 *                       GHOST_MARKET_ADDRESS
 *   oracle/.env       — same four (oracle reads EAMM / vault / market as needed)
 *   web/.env.local    — NEXT_PUBLIC_* for each contract + NEXT_PUBLIC_SEPOLIA_RPC_URL
 *
 * When using Zama’s mock underlying, also set **`CUSDC_MOCK_ADDRESS`** (and
 * `NEXT_PUBLIC_CUSDC_MOCK_ADDRESS`) to Zama’s **`cUSDCMock`** so the web stack
 * matches the confidential wrapper for that underlying (same docs page).
 *
 * Then restart `oracle` and `web` dev servers so they reload env.
 *
 * Seeding (optional, after deploy):
 *   npx hardhat run scripts/seed-usdc.ts --network sepolia
 *   (mints USDC to seeder wallet and calls GhostVault.depositFor to pre-fund markets)
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';

/** Zama protocol — Sepolia mock underlying USDC (public mint, 1M cap per call). */
const ZAMA_SEPOLIA_MOCK_USDC_UNDERLYING =
  '0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF';

/** Zama protocol — Confidential USDC (Mock) wrapper for the underlying above. */
const ZAMA_SEPOLIA_CUSDC_MOCK = '0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639';

// 1 million USDC minted to the deployer for seeding / testing.
const SEED_AMOUNT = ethers.parseUnits('1000000', 6);

/** Use Zama’s canonical mock USDC unless explicitly disabled (`0` / `false`). */
function useZamaSepoliaMockUsdc(): boolean {
  const v = (process.env.USE_ZAMA_SEPOLIA_MOCK_USDC ?? '1').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

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

  // ── 1. Collateral USDC (Zama canonical mock underlying, or fresh MockUSDC) ─
  let usdcAddress: string;

  if (useZamaSepoliaMockUsdc()) {
    usdcAddress = ZAMA_SEPOLIA_MOCK_USDC_UNDERLYING;
    console.log('Using Zama protocol mock USDC (Sepolia underlying for cUSDCMock)');
    console.log(`  Docs: https://docs.zama.org/protocol/protocol-apps/addresses/testnet/sepolia`);
    console.log(`  Underlying: ${usdcAddress}`);
    const mintable = new ethers.Contract(
      usdcAddress,
      ['function mint(address to, uint256 amount) external'],
      deployer,
    );
    const mintTx = await mintable.mint(deployer.address, SEED_AMOUNT);
    await mintTx.wait();
    console.log(`  Minted 1,000,000 USDC (6 decimals) to ${deployer.address}\n`);
  } else {
    console.log('Deploying local MockUSDC.sol (USE_ZAMA_SEPOLIA_MOCK_USDC=0)…');
    const MockUSDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await MockUSDC.deploy(deployer.address);
    await usdc.waitForDeployment();
    usdcAddress = await usdc.getAddress();
    console.log(`MockUSDC deployed   : ${usdcAddress}`);
    console.log(`  Etherscan: https://sepolia.etherscan.io/address/${usdcAddress}`);
    const mintTx = await usdc.mint(deployer.address, SEED_AMOUNT);
    await mintTx.wait();
    console.log(`  Minted 1,000,000 USDC to ${deployer.address}\n`);
  }

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
    usdcAddress,   // collateral (Zama mock underlying or freshly deployed MockUSDC)
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
  console.log('Copy the block below into contracts/.env and oracle/.env (replace old values):');
  console.log('');
  console.log(`MOCK_USDC_ADDRESS=${usdcAddress}`);
  if (useZamaSepoliaMockUsdc()) {
    console.log(`CUSDC_MOCK_ADDRESS=${ZAMA_SEPOLIA_CUSDC_MOCK}`);
  }
  console.log(`GHOST_EAMM_ADDRESS=${eammAddress}`);
  console.log(`GHOST_VAULT_ADDRESS=${vaultAddress}`);
  console.log(`GHOST_MARKET_ADDRESS=${marketAddress}`);
  console.log('');
  console.log('Copy into web/.env.local:');
  console.log('');
  console.log(`NEXT_PUBLIC_MOCK_USDC_ADDRESS=${usdcAddress}`);
  if (useZamaSepoliaMockUsdc()) {
    console.log(`NEXT_PUBLIC_CUSDC_MOCK_ADDRESS=${ZAMA_SEPOLIA_CUSDC_MOCK}`);
  }
  console.log(`NEXT_PUBLIC_GHOST_EAMM_ADDRESS=${eammAddress}`);
  console.log(`NEXT_PUBLIC_GHOST_VAULT_ADDRESS=${vaultAddress}`);
  console.log(`NEXT_PUBLIC_GHOST_MARKET_ADDRESS=${marketAddress}`);
  const rpc = process.env.SEPOLIA_RPC_URL ?? '';
  if (rpc) console.log(`NEXT_PUBLIC_SEPOLIA_RPC_URL=${rpc}`);
  console.log('');
  console.log('Checklist:');
  console.log('  [ ] Paste addresses into contracts/.env, oracle/.env, web/.env.local');
  console.log('  [ ] Restart oracle (`npm run dev` in oracle/) and web dev server');
  console.log('  [ ] Optional: npx hardhat run scripts/seed-usdc.ts --network sepolia');
  console.log('  [ ] Demo: npx hardhat run scripts/demo-sealed-window.ts --network sepolia');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
