/**
 * seed-markets.ts
 *
 * Creates the initial set of prediction markets on-chain so the frontend
 * can immediately display real contract state.
 *
 * Usage:
 *   npx hardhat run scripts/seed-markets.ts --network flowTestnet
 *
 * Requires GHOST_MARKET_ADDRESS in .env
 */
import { ethers } from 'hardhat';
import * as dotenv from 'dotenv';
dotenv.config();

// Market definitions that mirror the mock data in the frontend.
// expiryAt is expressed as days from now for readability.
const MARKETS: {
  title: string;
  description: string;
  category: string;
  resolutionSource: string;
  daysFromNow: number;
}[] = [
  {
    title: 'Will ETH trade above $10,000 before April 2026?',
    description:
      'Resolves YES if ETH/USD closes at or above $10,000 on any major exchange (Coinbase, Binance, Kraken) at 23:59 UTC March 31, 2026.',
    category: 'Crypto',
    resolutionSource: 'Chainlink ETH/USD price feed',
    daysFromNow: 22,
  },
  {
    title: 'Will the Fed cut rates in Q2 2026?',
    description:
      'Resolves YES if the Federal Reserve announces at least one 25bp rate cut during Q2 2026 (April–June). Based on FOMC meeting outcomes.',
    category: 'Macro',
    resolutionSource: 'Federal Reserve FOMC statement',
    daysFromNow: 113,
  },
  {
    title: 'Will BTC reach $150K by end of 2026?',
    description:
      'Resolves YES if BTC/USD trades at or above $150,000 on any major spot exchange before December 31, 2026 at 23:59 UTC.',
    category: 'Crypto',
    resolutionSource: 'Chainlink BTC/USD price feed',
    daysFromNow: 296,
  },
  {
    title: 'EU AI Act: major enforcement action before July 2026?',
    description:
      'Resolves YES if the EU AI Act results in at least one major enforcement action or fine exceeding €10M announced before July 1, 2026.',
    category: 'Politics',
    resolutionSource: 'EU Official Journal / Commission press releases',
    daysFromNow: 113,
  },
  {
    title: 'Will OpenAI IPO in 2026?',
    description:
      'Resolves YES if OpenAI completes an initial public offering or direct listing on a US exchange by December 31, 2026.',
    category: 'Tech',
    resolutionSource: 'SEC EDGAR filings',
    daysFromNow: 296,
  },
];

async function main() {
  const [deployer] = await ethers.getSigners();

  const contractAddress = process.env.GHOST_MARKET_ADDRESS;
  if (!contractAddress) {
    throw new Error('GHOST_MARKET_ADDRESS not set in .env');
  }

  const market = await ethers.getContractAt('GhostMarket', contractAddress, deployer);
  console.log(`Seeding markets on GhostMarket @ ${contractAddress}`);
  console.log(`Caller: ${deployer.address}\n`);

  for (const m of MARKETS) {
    const expiryAt = Math.floor(Date.now() / 1000) + m.daysFromNow * 86_400;
    const tx = await market.createMarket(
      m.title,
      m.description,
      m.category,
      m.resolutionSource,
      expiryAt,
    );
    const receipt = await tx.wait();
    const count   = await market.marketCount();
    console.log(`✓ Market #${count} created  (tx: ${receipt?.hash})`);
    console.log(`  "${m.title.slice(0, 60)}..."`);
    console.log(`  Expires: ${new Date(expiryAt * 1000).toUTCString()}\n`);
  }

  console.log(`Done. ${MARKETS.length} markets seeded.`);
  console.log(`\nView on Flowscan: https://evm-testnet.flowscan.io/address/${contractAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
