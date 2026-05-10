/**
 * seed-markets.ts
 *
 * Seeds 10 markets on Ethereum Sepolia by calling GhostMarket.createMarket().
 *
 * Because GhostMarket is wired as the marketManager + resolver of GhostEAMM,
 * every createMarket() call atomically:
 *   1. Stores metadata in GhostMarket.sol
 *   2. Initialises encrypted pools in GhostEAMM.sol
 *
 * No separate sync step. No dual-chain round trips. One tx per market.
 *
 * Usage:
 *   npx hardhat run scripts/seed-markets.ts --network sepolia
 *
 * Required env (contracts/.env):
 *   DEPLOYER_PRIVATE_KEY
 *   SEPOLIA_RPC_URL
 *   GHOST_MARKET_ADDRESS
 */

import { ethers } from 'hardhat';

// ── Market definitions ────────────────────────────────────────────────────────
//
// 8 Crypto + 1 Macro + 1 Politics — mirrors the frontend mock data.
// daysFromNow: market expiry relative to today (readable, no hardcoded timestamps)
// yesBias: implied YES probability as percentage — shown as a comment for reference
//          (not used on-chain; just informs how the UI will look at launch)

const MARKETS: {
  title:            string;
  description:      string;
  category:         string;
  resolutionSource: string;
  daysFromNow:      number;
  yesBias:          number;
}[] = [
  {
    title:            'Will ETH trade above $6,500 before Jan 2027?',
    description:      'Resolves YES if ETH/USD trades at or above $6,500 on major spot exchanges (Coinbase, Binance, Kraken) before Jan 1 2027 00:00 UTC.',
    category:         'Crypto',
    resolutionSource: 'Chainlink ETH/USD price feed',
    daysFromNow:      280,
    yesBias:          62,
  },
  {
    title:            'Will BTC trade above $150,000 before Jan 2027?',
    description:      'Resolves YES if BTC/USD trades at or above $150,000 on any major exchange before Jan 1 2027 00:00 UTC.',
    category:         'Crypto',
    resolutionSource: 'Chainlink BTC/USD price feed',
    daysFromNow:      280,
    yesBias:          58,
  },
  {
    title:            'Will SOL trade above $500 before Jan 2027?',
    description:      'Resolves YES if SOL/USD trades at or above $500 before Jan 1 2027 00:00 UTC.',
    category:         'Crypto',
    resolutionSource: 'CoinGecko + exchange VWAP',
    daysFromNow:      280,
    yesBias:          55,
  },
  {
    title:            'Will XRP trade above $5 before Jan 2027?',
    description:      'Resolves YES if XRP/USD trades at or above $5 on major exchanges before Jan 1 2027 00:00 UTC.',
    category:         'Crypto',
    resolutionSource: 'Coinbase / Binance market data',
    daysFromNow:      280,
    yesBias:          48,
  },
  {
    title:            'Will DOGE trade above $1 before Jan 2027?',
    description:      'Resolves YES if DOGE/USD trades at or above $1 on major exchanges before Jan 1 2027 00:00 UTC.',
    category:         'Crypto',
    resolutionSource: 'CoinGecko aggregate ticker',
    daysFromNow:      280,
    yesBias:          42,
  },
  {
    title:            'Will TON market cap enter top 5 before Jan 2027?',
    description:      'Resolves YES if TON enters the top-5 crypto assets by market cap at any daily close before Jan 1 2027.',
    category:         'Crypto',
    resolutionSource: 'CoinGecko market-cap rankings',
    daysFromNow:      280,
    yesBias:          38,
  },
  {
    title:            'Will a spot ADA ETF be approved in the US before Jan 2027?',
    description:      'Resolves YES if the SEC approves at least one spot ADA ETF before Jan 1 2027.',
    category:         'Crypto',
    resolutionSource: 'SEC filings and approval notices',
    daysFromNow:      280,
    yesBias:          30,
  },
  {
    title:            'Will Base TVL exceed $25B before Jan 2027?',
    description:      'Resolves YES if Base (Coinbase L2) total value locked exceeds $25 billion at any daily snapshot before Jan 1 2027.',
    category:         'Crypto',
    resolutionSource: 'DefiLlama TVL',
    daysFromNow:      280,
    yesBias:          65,
  },
  {
    title:            'Will the Fed cut rates by at least 50 bps in 2026?',
    description:      'Resolves YES if cumulative FOMC rate cuts in calendar year 2026 total at least 50 basis points.',
    category:         'Macro',
    resolutionSource: 'FOMC official statements',
    daysFromNow:      250,
    yesBias:          52,
  },
  {
    title:            'Will the EU AI Act see a fine above €50M before Jan 2027?',
    description:      'Resolves YES if any publicly disclosed EU AI Act enforcement action results in a fine exceeding €50 million before Jan 1 2027.',
    category:         'Politics',
    resolutionSource: 'EU Commission enforcement releases',
    daysFromNow:      280,
    yesBias:          35,
  },
];

// ── ABI — only the functions we need ─────────────────────────────────────────

const GHOST_MARKET_ABI = [
  'function createMarket(string title, string description, string category, string resolutionSource, uint64 expiryAt) returns (uint256)',
  'function marketCount() view returns (uint256)',
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();

  const marketAddress = process.env.GHOST_MARKET_ADDRESS;
  if (!marketAddress) throw new Error('GHOST_MARKET_ADDRESS not set in contracts/.env');

  const ghostMarket = new ethers.Contract(marketAddress, GHOST_MARKET_ABI, deployer);

  const startCount = Number(await ghostMarket.marketCount());

  console.log('\n=== GhostMarket — Seed 10 Markets ===');
  console.log(`Signer         : ${deployer.address}`);
  console.log(`GhostMarket    : ${marketAddress}`);
  console.log(`Markets before : ${startCount}`);
  console.log(`\nNote: each createMarket() call atomically creates`);
  console.log(`the market in both GhostMarket AND GhostEAMM.\n`);

  for (const m of MARKETS) {
    const expiryAt = Math.floor(Date.now() / 1000) + m.daysFromNow * 86_400;

    const tx = await ghostMarket.createMarket(
      m.title,
      m.description,
      m.category,
      m.resolutionSource,
      expiryAt,
    );
    const receipt = await tx.wait();

    const marketId = Number(await ghostMarket.marketCount());
    const expiryDate = new Date(expiryAt * 1000).toISOString().slice(0, 10);

    console.log(`✓ Market #${marketId}  [${m.category}]  implied YES ≈ ${m.yesBias}%`);
    console.log(`  "${m.title}"`);
    console.log(`  Expires : ${expiryDate}`);
    console.log(`  Tx      : https://sepolia.etherscan.io/tx/${receipt?.hash}`);
    console.log();
  }

  const endCount = Number(await ghostMarket.marketCount());
  console.log(`=== Done. ${endCount - startCount} markets created (total: ${endCount}) ===`);
  console.log(`\nView contract: https://sepolia.etherscan.io/address/${marketAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
