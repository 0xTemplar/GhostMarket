/**
 * Send test FLOW from the deployer wallet to any address.
 * Usage:
 *   RECIPIENT=0x... AMOUNT=10 npx hardhat run scripts/fund-wallet.ts --network flowTestnet
 */
import { ethers } from 'hardhat';

async function main() {
  const recipient = process.env.RECIPIENT;
  const amount = process.env.AMOUNT ?? '10';

  if (!recipient) {
    console.error('Set RECIPIENT=0x... env var');
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  console.log('Sending from:', deployer.address);
  console.log('Sending to:  ', recipient);
  console.log('Amount:      ', amount, 'FLOW');

  const tx = await deployer.sendTransaction({
    to: recipient,
    value: ethers.parseEther(amount),
  });
  await tx.wait();
  console.log('Done. tx:', tx.hash);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
