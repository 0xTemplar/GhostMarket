/**
 * resolve-ghost-eamm.ts
 *
 * Manually call GhostEAMM.resolveMarket() on Sepolia.
 * Use this to unblock the Lit settlement flow when a market has been
 * finalized by the oracle swarm but not yet resolved on-chain.
 *
 * Usage:
 *   npx ts-node oracle/scripts/resolve-ghost-eamm.ts <marketId> <outcome>
 *
 * Examples:
 *   npx ts-node oracle/scripts/resolve-ghost-eamm.ts 1 true    # YES won
 *   npx ts-node oracle/scripts/resolve-ghost-eamm.ts 1 false   # NO won
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const SEPOLIA_RPC_URL     = process.env.SEPOLIA_RPC_URL            ?? 'https://rpc.sepolia.org';
// EAMM_RESOLVER_PRIVATE_KEY is the GhostEAMM owner/resolver key (deployer).
// Falls back to SEPOLIA_PRIVATE_KEY but that wallet must be resolver or owner.
const SEPOLIA_PRIVATE_KEY = process.env.EAMM_RESOLVER_PRIVATE_KEY
                         ?? process.env.SEPOLIA_PRIVATE_KEY
                         ?? '';
const GHOST_EAMM_ADDRESS  = process.env.GHOST_EAMM_ADDRESS  ?? '';

const EAMM_ABI = [
  'function resolveMarket(uint256 marketId, bool outcome) external',
  'function getMarketMeta(uint256 marketId) external view returns (uint8 status, bool outcome, uint64 expiryAt)',
];

async function main() {
  const [, , marketIdArg, outcomeArg] = process.argv;

  if (!marketIdArg || outcomeArg === undefined) {
    console.error('Usage: npx ts-node oracle/scripts/resolve-ghost-eamm.ts <marketId> <true|false>');
    process.exit(1);
  }

  const marketId = BigInt(marketIdArg);
  const outcome  = outcomeArg.toLowerCase() === 'true';

  if (!SEPOLIA_PRIVATE_KEY) {
    console.error('SEPOLIA_PRIVATE_KEY not set in oracle/.env');
    process.exit(1);
  }
  if (!GHOST_EAMM_ADDRESS) {
    console.error('GHOST_EAMM_ADDRESS not set in oracle/.env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(SEPOLIA_PRIVATE_KEY, provider);
  const eamm     = new ethers.Contract(GHOST_EAMM_ADDRESS, EAMM_ABI, wallet);

  console.log(`GhostEAMM:   ${GHOST_EAMM_ADDRESS}`);
  console.log(`Resolver:    ${wallet.address}`);
  console.log(`Market ID:   ${marketId}`);
  console.log(`Outcome:     ${outcome ? 'YES' : 'NO'}`);
  console.log('');

  // Read current status
  const [currentStatus, currentOutcome] = await eamm.getMarketMeta(marketId) as [number, boolean, bigint];
  const STATUS_LABELS: Record<number, string> = { 0: 'Active', 1: 'Resolved', 2: 'Cancelled' };
  console.log(`Current status: ${STATUS_LABELS[Number(currentStatus)] ?? currentStatus}`);

  if (Number(currentStatus) === 1) {
    console.log(`Market ${marketId} is already Resolved (outcome=${currentOutcome}) — nothing to do.`);
    console.log('You can now call: curl -s -X POST http://localhost:8080/oracle/settle/<marketId> ...');
    process.exit(0);
  }

  if (Number(currentStatus) === 2) {
    console.error(`Market ${marketId} is Cancelled — cannot resolve.`);
    process.exit(1);
  }

  console.log(`Sending resolveMarket(${marketId}, ${outcome})…`);
  const tx = await eamm.resolveMarket(marketId, outcome);
  console.log(`TX submitted: ${tx.hash}`);
  console.log(`Waiting for confirmation…`);

  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);
  console.log(`Etherscan: https://sepolia.etherscan.io/tx/${tx.hash}`);
  console.log('');
  console.log('Market is now Resolved on Sepolia.');
  console.log('The Lit Action can now verify and sign the settlement.');
  console.log('');
  console.log('Next step:');
  console.log(`  curl -s -X POST http://localhost:8080/oracle/settle/${marketIdArg} \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"userAddress":"<your_wallet>"}' | jq .`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
