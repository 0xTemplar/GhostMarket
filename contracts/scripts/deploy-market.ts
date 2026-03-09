import { ethers } from 'hardhat';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying GhostMarket with:', deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Balance:', ethers.formatEther(balance), 'FLOW');

  // Resolver defaults to deployer; swap for a dedicated EOA in production.
  const resolver = process.env.RESOLVER_ADDRESS ?? deployer.address;
  // Treasury defaults to deployer; swap for a multisig in production.
  const treasury = process.env.TREASURY_ADDRESS ?? deployer.address;

  const Factory = await ethers.getContractFactory('GhostMarket');
  const market  = await Factory.deploy(resolver, treasury);
  await market.waitForDeployment();

  const address = await market.getAddress();
  console.log('\nGhostMarket deployed to:', address);
  console.log(
    '\nAdd to web/.env.local:\n' +
    `  NEXT_PUBLIC_GHOST_MARKET_ADDRESS=${address}\n` +
    '\nAdd to api/.env:\n' +
    `  GHOST_MARKET_ADDRESS=${address}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
