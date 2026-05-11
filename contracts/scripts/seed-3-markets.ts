/**
 * seed-3-markets.ts
 *
 * Seeds 3 showcase markets for the GhostMarket demo.
 *
 * Usage:
 *   npx hardhat run scripts/seed-3-markets.ts --network sepolia
 *
 * Required env (contracts/.env):
 *   DEPLOYER_PRIVATE_KEY
 *   SEPOLIA_RPC_URL
 *   GHOST_MARKET_ADDRESS
 */

import { ethers } from 'hardhat';

const MARKETS = [
  {
    title:            'Will BTC trade above $120,000 before Jan 2027?',
    description:      'Resolves YES if BTC/USD spot price trades at or above $120,000 on Coinbase, Binance, or Kraken before Jan 1 2027 00:00 UTC.',
    category:         'Crypto',
    resolutionSource: 'CoinGecko BTC/USD spot price',
    daysFromNow:      235,
  },
  {
    title:            'Will ETH trade above $6,500 before Jan 2027?',
    description:      'Resolves YES if ETH/USD trades at or above $6,500 on any major spot exchange before Jan 1 2027 00:00 UTC.',
    category:         'Crypto',
    resolutionSource: 'Chainlink ETH/USD price feed',
    daysFromNow:      235,
  },
  {
    title:            'Will the Fed cut rates by at least 50 bps in 2026?',
    description:      'Resolves YES if cumulative FOMC rate cuts in calendar year 2026 total at least 50 basis points, based on official FOMC statements.',
    category:         'Macro',
    resolutionSource: 'FOMC official statements and CME FedWatch Tool',
    daysFromNow:      235,
  },
];

const GHOST_MARKET_ABI = [
  'function createMarket(string title, string description, string category, string resolutionSource, uint64 expiryAt) returns (uint256)',
  'function marketCount() view returns (uint256)',
];

async function main() {
  const [deployer] = await ethers.getSigners();

  const marketAddress = process.env.GHOST_MARKET_ADDRESS;
  if (!marketAddress) throw new Error('GHOST_MARKET_ADDRESS not set in contracts/.env');

  const ghostMarket = new ethers.Contract(marketAddress, GHOST_MARKET_ABI, deployer);
  const startCount  = Number(await ghostMarket.marketCount());

  console.log('\n=== GhostMarket — Seed 3 Demo Markets ===');
  console.log(`Signer        : ${deployer.address}`);
  console.log(`GhostMarket   : ${marketAddress}`);
  console.log(`Markets before: ${startCount}\n`);

  const ids: number[] = [];

  for (const m of MARKETS) {
    const expiryAt = Math.floor(Date.now() / 1000) + m.daysFromNow * 86_400;

    const tx      = await ghostMarket.createMarket(m.title, m.description, m.category, m.resolutionSource, expiryAt);
    const receipt = await tx.wait();
    const id      = Number(await ghostMarket.marketCount());

    ids.push(id);

    console.log(`✓ Market #${id}  [${m.category}]`);
    console.log(`  "${m.title}"`);
    console.log(`  Expires : ${new Date(expiryAt * 1000).toISOString().slice(0, 10)}`);
    console.log(`  Tx      : https://sepolia.etherscan.io/tx/${receipt?.hash}`);
    console.log();
  }

  console.log(`=== Done. 3 markets created (IDs: ${ids.join(', ')}) ===`);
  console.log(`\nView: https://sepolia.etherscan.io/address/${marketAddress}`);
  console.log(`\nTo open a sealed window on the BTC market (ID ${ids[0]}):`);
  console.log(`  EXISTING_MARKET_ID=${ids[0]} npx hardhat run scripts/demo-sealed-window.ts --network sepolia`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
