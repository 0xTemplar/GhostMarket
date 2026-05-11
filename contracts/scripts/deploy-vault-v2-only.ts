import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  const cusdcAddress  = process.env.CUSDC_MOCK_ADDRESS ?? '';
  const oracleKey     = process.env.ORACLE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? '';
  if (!cusdcAddress)  throw new Error('CUSDC_MOCK_ADDRESS not set');
  if (!oracleKey)     throw new Error('ORACLE_PRIVATE_KEY not set');
  const oracleAddress = new ethers.Wallet(oracleKey).address;

  console.log('\nDeploying GhostVaultV2 (deposit fix)...');
  console.log(`Deployer : ${deployer.address}`);
  console.log(`Oracle   : ${oracleAddress}`);
  console.log(`cUSDC    : ${cusdcAddress}\n`);

  const GhostVaultV2 = await ethers.getContractFactory('GhostVaultV2');
  const vault = await GhostVaultV2.deploy(cusdcAddress, oracleAddress);
  await vault.waitForDeployment();
  const addr = await vault.getAddress();

  console.log(`GhostVaultV2: ${addr}`);
  console.log(`Etherscan   : https://sepolia.etherscan.io/address/${addr}`);
  console.log(`\nUpdate in contracts/.env, oracle/.env, web/.env.local:`);
  console.log(`  GHOST_VAULT_ADDRESS=${addr}`);
  console.log(`  NEXT_PUBLIC_GHOST_VAULT_ADDRESS=${addr}`);
}

main().catch(e => { console.error(e); process.exit(1); });
