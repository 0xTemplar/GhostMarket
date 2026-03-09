import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with:', deployer.address);
  console.log('Balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'FLOW');

  /**
   * settlementSigner is the address whose private key the Lit Action
   * (or backend relayer) will use to sign attested payout messages in Phase 6.
   * For testnet you can use the deployer address as a placeholder.
   */
  const settlementSigner = process.env.SETTLEMENT_SIGNER_ADDRESS ?? deployer.address;

  const GhostVault = await ethers.getContractFactory('GhostVault');
  const vault = await GhostVault.deploy(settlementSigner);
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  console.log('\nGhostVault deployed to:', address);
  console.log('\nSet this in your frontend .env:');
  console.log(`NEXT_PUBLIC_GHOST_VAULT_ADDRESS=${address}`);
  console.log('\nSet this in your backend .env:');
  console.log(`GHOST_VAULT_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
