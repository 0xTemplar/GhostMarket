/**
 * seed-two-markets.ts
 *
 * Seeds 2 fresh markets on GhostMarket (Flow EVM) and immediately
 * mirrors them to GhostEAMM on Sepolia.
 *
 * Usage:
 *   npx ts-node scripts/seed-two-markets.ts
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Pull env from oracle directory (has all keys + contract addresses)
dotenv.config({ path: path.resolve(__dirname, '../../oracle/.env') });

const MARKETS = [
  {
    title: 'Will the US approve a Solana spot ETF before July 2026?',
    description:
      'Resolves YES if the SEC formally approves at least one spot SOL ETF for US markets before July 1, 2026.',
    category: 'Crypto',
    resolutionSource: 'SEC official approval notices',
    daysFromNow: 96,
  },
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const flowRpc      = process.env.FLOW_RPC_URL ?? 'https://testnet.evm.nodes.onflow.org';
  const sepoliaRpc   = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
  const marketAddr   = process.env.GHOST_MARKET_ADDRESS;
  const eammAddr     = process.env.GHOST_EAMM_ADDRESS;
  const flowKey      =
    process.env.FLOW_MARKET_RESOLVER_PRIVATE_KEY ??
    process.env.EAMM_RESOLVER_PRIVATE_KEY ??
    process.env.SEPOLIA_PRIVATE_KEY ?? '';
  const sepoliaKey   = process.env.EAMM_RESOLVER_PRIVATE_KEY ?? process.env.SEPOLIA_PRIVATE_KEY ?? '';

  if (!marketAddr)  throw new Error('GHOST_MARKET_ADDRESS not set');
  if (!eammAddr)    throw new Error('GHOST_EAMM_ADDRESS not set');
  if (!flowKey)     throw new Error('No flow key found in oracle/.env');
  if (!sepoliaKey)  throw new Error('No sepolia key found in oracle/.env');

  const flowProvider   = new ethers.JsonRpcProvider(flowRpc);
  const flowSigner     = new ethers.Wallet(flowKey, flowProvider);
  const sepoliaProvider = new ethers.JsonRpcProvider(sepoliaRpc);
  const sepoliaSigner  = new ethers.Wallet(sepoliaKey, sepoliaProvider);

  const market = new ethers.Contract(
    marketAddr,
    [
      'function createMarket(string title, string description, string category, string resolutionSource, uint64 expiryAt) returns (uint256)',
      'function marketCount() view returns (uint256)',
    ],
    flowSigner,
  );

  const eamm = new ethers.Contract(
    eammAddr,
    [
      'function getMarketMeta(uint256 marketId) view returns (uint8 status, bool outcome, uint64 expiryAt)',
      'function createMarket(uint256 marketId, uint64 expiryAt)',
    ],
    sepoliaSigner,
  );

  console.log(`\nSeeding 2 markets on GhostMarket @ ${marketAddr}`);
  console.log(`Flow signer : ${flowSigner.address}`);
  console.log(`EAMM signer : ${sepoliaSigner.address}`);
  console.log(`GhostEAMM   : ${eammAddr}\n`);

  for (const m of MARKETS) {
    await sleep(3000);
    const expiryAt = Math.floor(Date.now() / 1000) + m.daysFromNow * 86_400;

    console.log(`Creating: "${m.title}"`);
    const tx      = await market.createMarket(m.title, m.description, m.category, m.resolutionSource, expiryAt);
    const receipt = await tx.wait();
    const count   = await market.marketCount() as bigint;
    const marketId = count;

    console.log(`✓ Market #${marketId} created  (tx: ${receipt?.hash})`);
    console.log(`  Expires: ${new Date(expiryAt * 1000).toUTCString()}`);

    // Mirror to GhostEAMM on Sepolia
    let alreadyOnEamm = false;
    try {
      await eamm.getMarketMeta(marketId);
      alreadyOnEamm = true;
    } catch { /* not found → create */ }

    if (alreadyOnEamm) {
      console.log(`  ↳ eAMM already has market #${marketId}, skipping\n`);
      continue;
    }

    const syncTx      = await eamm.createMarket(marketId, expiryAt);
    const syncReceipt = await syncTx.wait();
    console.log(`  ↳ synced to GhostEAMM  (tx: ${syncReceipt?.hash})\n`);
  }

  console.log(`Done. View on Flowscan:`);
  console.log(`https://evm-testnet.flowscan.io/address/${marketAddr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
