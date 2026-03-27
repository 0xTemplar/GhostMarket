/**
 * seed-markets.ts
 *
 * Seeds 10 markets on GhostMarket (Flow EVM) with an 80/20 mix:
 *   - 8 Crypto markets
 *   - 2 Non-crypto markets (Macro / Politics)
 *
 * Immediately mirrors newly created markets to GhostEAMM on Sepolia.
 *
 * Optionally seeds initial liquidity by placing YES + NO bets from the
 * seeder wallet immediately after each market is created, giving the UI
 * a live order book from the first block.
 *
 * Usage:
 *   npx ts-node scripts/seed-markets.ts
 *
 * Required env:
 *   GHOST_MARKET_ADDRESS
 *   FLOW_RPC_URL (optional, defaults to Flow testnet RPC)
 *   GHOST_EAMM_ADDRESS
 *   SEPOLIA_RPC_URL
 *   FLOW_MARKET_CREATOR_PRIVATE_KEY (or EAMM_RESOLVER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY)
 *   DEPLOYER_PRIVATE_KEY (or EAMM_RESOLVER_PRIVATE_KEY) for eAMM sync
 *
 * Optional env (liquidity seeding):
 *   SEED_LIQUIDITY=true          — enable initial buy seeding (default: false)
 *   SEED_LIQUIDITY_ETH=0.05      — total FLOW per market split across YES+NO (default: 0.05)
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

// Market definitions that mirror the mock data in the frontend.
// expiryAt is expressed as days from now for readability.
// yesBias: percentage of the seed liquidity pool allocated to the YES side (0–100).
//   Reflects realistic market sentiment so the UI shows a meaningful implied price
//   from block 0 rather than a 50/50 coin flip.
const MARKETS: {
  title: string;
  description: string;
  category: string;
  resolutionSource: string;
  daysFromNow: number;
  yesBias: number;
}[] = [
  {
    title: 'Will ETH trade above $6,500 before Jan 2027?',
    description:
      'Resolves YES if ETH/USD trades at or above $6,500 on major spot exchanges before Jan 1, 2027.',
    category: 'Crypto',
    resolutionSource: 'Chainlink ETH/USD price feed',
    daysFromNow: 280,
    yesBias: 62, // moderate bull — plausible but not a slam dunk
  },
  {
    title: 'Will BTC trade above $150,000 before Jan 2027?',
    description:
      'Resolves YES if BTC/USD trades at or above $150,000 on major exchanges before Jan 1, 2027.',
    category: 'Crypto',
    resolutionSource: 'Chainlink BTC/USD price feed',
    daysFromNow: 280,
    yesBias: 58, // bullish but halving premium already priced in
  },
  {
    title: 'Will SOL trade above $500 before Jan 2027?',
    description:
      'Resolves YES if SOL/USD trades at or above $500 before Jan 1, 2027.',
    category: 'Crypto',
    resolutionSource: 'CoinGecko + exchange VWAP',
    daysFromNow: 280,
    yesBias: 55,
  },
  {
    title: 'Will XRP trade above $5 before Jan 2027?',
    description:
      'Resolves YES if XRP/USD trades at or above $5 before Jan 1, 2027.',
    category: 'Crypto',
    resolutionSource: 'Coinbase/Binance market data',
    daysFromNow: 280,
    yesBias: 48, // market is split — regulatory overhang
  },
  {
    title: 'Will DOGE trade above $1 before Jan 2027?',
    description:
      'Resolves YES if DOGE/USD trades at or above $1 on major exchanges before Jan 1, 2027.',
    category: 'Crypto',
    resolutionSource: 'CoinGecko aggregate ticker',
    daysFromNow: 280,
    yesBias: 42, // sentiment-driven, meme risk — leans NO
  },
  {
    title: 'Will TON market cap enter top 5 before Jan 2027?',
    description:
      'Resolves YES if TON enters the top-5 crypto assets by market cap at any daily close before Jan 1, 2027.',
    category: 'Crypto',
    resolutionSource: 'CoinGecko market-cap rankings',
    daysFromNow: 280,
    yesBias: 38, // long shot against entrenched top-5
  },
  {
    title: 'Will a Spot ADA ETF be approved in the US before Jan 2027?',
    description:
      'Resolves YES if the SEC approves at least one spot ADA ETF before Jan 1, 2027.',
    category: 'Crypto',
    resolutionSource: 'SEC filings and approval notices',
    daysFromNow: 280,
    yesBias: 30, // SEC pace makes this unlikely in timeframe
  },
  {
    title: 'Will Base TVL exceed $25B before Jan 2027?',
    description:
      'Resolves YES if Base total value locked exceeds $25B before Jan 1, 2027.',
    category: 'Crypto',
    resolutionSource: 'DefiLlama TVL',
    daysFromNow: 280,
    yesBias: 65, // strong growth trajectory
  },
  {
    title: 'Will the Fed cut rates by at least 50 bps in 2026?',
    description:
      'Resolves YES if cumulative Fed Funds rate cuts in 2026 are at least 50 basis points.',
    category: 'Macro',
    resolutionSource: 'FOMC official statements',
    daysFromNow: 280,
    yesBias: 52, // near-coin-flip, dot-plot uncertain
  },
  {
    title: 'Will the EU AI Act see a >€50M fine before Jan 2027?',
    description:
      'Resolves YES if any disclosed EU AI Act fine exceeds €50M before Jan 1, 2027.',
    category: 'Politics',
    resolutionSource: 'EU Commission enforcement releases',
    daysFromNow: 280,
    yesBias: 35, // enforcement timeline usually lags
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return the two individual bet sizes (YES, NO) for a given total + bias. */
function splitLiquidity(
  totalWei: bigint,
  yesBias: number,
): { yesWei: bigint; noWei: bigint } {
  const yesWei = (totalWei * BigInt(yesBias)) / 100n;
  const noWei  = totalWei - yesWei;
  return { yesWei, noWei };
}

/** Format a wei amount as a compact ETH string (e.g. "0.0325 FLOW"). */
function fmt(wei: bigint): string {
  return `${ethers.formatEther(wei)} FLOW`;
}

/** Compute the parimutuel implied YES price as a percentage string. */
function impliedYes(yesWei: bigint, noWei: bigint): string {
  const total = yesWei + noWei;
  if (total === 0n) return 'n/a';
  return ((Number(yesWei) / Number(total)) * 100).toFixed(1) + '%';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const flowRpc = process.env.FLOW_RPC_URL ?? 'https://testnet.evm.nodes.onflow.org';
  const contractAddress = process.env.GHOST_MARKET_ADDRESS;
  if (!contractAddress) {
    throw new Error('GHOST_MARKET_ADDRESS not set in .env');
  }

  const eammAddress = process.env.GHOST_EAMM_ADDRESS;
  const sepoliaRpc  = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
  const flowKey =
    process.env.FLOW_MARKET_CREATOR_PRIVATE_KEY ??
    process.env.EAMM_RESOLVER_PRIVATE_KEY ??
    process.env.DEPLOYER_PRIVATE_KEY ??
    '';
  const sepoliaKey  =
    process.env.EAMM_RESOLVER_PRIVATE_KEY ??
    process.env.DEPLOYER_PRIVATE_KEY ??
    '';

  if (!flowKey) {
    throw new Error('FLOW_MARKET_CREATOR_PRIVATE_KEY (or fallback key) not set in .env');
  }
  if (!eammAddress) {
    throw new Error('GHOST_EAMM_ADDRESS not set in .env');
  }
  if (!sepoliaKey) {
    throw new Error('DEPLOYER_PRIVATE_KEY (or EAMM_RESOLVER_PRIVATE_KEY) not set in .env');
  }

  // Liquidity seeding config
  const seedLiquidity = process.env.SEED_LIQUIDITY === 'true';
  const seedTotalEth  = process.env.SEED_LIQUIDITY_ETH ?? '0.05';
  const seedTotalWei  = ethers.parseEther(seedTotalEth);

  const flowProvider = new ethers.JsonRpcProvider(flowRpc, undefined, { polling: true, pollingInterval: 3_000 });

  // Fetch current fee data and enforce a floor so bets never undercut the
  // network's minimum accepted gas price (Flow testnet requires ~16 gwei).
  const GAS_FLOOR = ethers.parseUnits('20', 'gwei');
  const feeData   = await flowProvider.getFeeData();
  const gasPrice  =
    feeData.gasPrice && feeData.gasPrice > GAS_FLOOR
      ? feeData.gasPrice
      : GAS_FLOOR;
  const flowSigner   = new ethers.Wallet(flowKey, flowProvider);
  const market = new ethers.Contract(
    contractAddress,
    [
      'function createMarket(string title, string description, string category, string resolutionSource, uint64 expiryAt) returns (uint256)',
      'function marketCount() view returns (uint256)',
      'function placeBet(uint256 marketId, bool side) external payable',
    ],
    flowSigner,
  );

  const sepoliaProvider = new ethers.JsonRpcProvider(sepoliaRpc);
  const sepoliaSigner   = new ethers.Wallet(sepoliaKey, sepoliaProvider);
  const eamm = new ethers.Contract(
    eammAddress,
    [
      'function getMarketMeta(uint256 marketId) view returns (uint8 status, bool outcome, uint64 expiryAt)',
      'function createMarket(uint256 marketId, uint64 expiryAt)',
    ],
    sepoliaSigner,
  );

  console.log(`Seeding markets on GhostMarket @ ${contractAddress}`);
  console.log(`Flow signer: ${flowSigner.address}`);
  console.log(`Sync target GhostEAMM @ ${eammAddress}`);
  console.log(`EAMM signer: ${sepoliaSigner.address}`);
  if (seedLiquidity) {
    console.log(`Liquidity seeding: ON  (${seedTotalEth} FLOW per market, split by yesBias)`);
  } else {
    console.log(`Liquidity seeding: OFF (set SEED_LIQUIDITY=true to enable)`);
  }
  console.log();

  let synced = 0;
  let totalSeeded = 0n;

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
    const count   = await market.marketCount() as bigint;
    console.log(`✓ Market #${count.toString()} created  (tx: ${receipt?.hash})`);
    console.log(`  "${m.title.slice(0, 60)}..."`);
    console.log(`  Expires: ${new Date(expiryAt * 1000).toUTCString()}`);

    // ── Liquidity seeding ──────────────────────────────────────────────────
    if (seedLiquidity) {
      const { yesWei, noWei } = splitLiquidity(seedTotalWei, m.yesBias);

      const yesTx = await market.placeBet(count, true, { value: yesWei, gasPrice });
      await yesTx.wait();

      const noTx = await market.placeBet(count, false, { value: noWei, gasPrice });
      await noTx.wait();

      totalSeeded += yesWei + noWei;
      console.log(
        `  ↳ seeded  YES ${fmt(yesWei)}  NO ${fmt(noWei)}` +
        `  →  implied YES ${impliedYes(yesWei, noWei)}`,
      );
    }

    console.log();

    // ── eAMM mirror ────────────────────────────────────────────────────────
    const marketId = count;
    let existsOnEamm = false;
    try {
      await eamm.getMarketMeta(marketId);
      existsOnEamm = true;
    } catch {
      existsOnEamm = false;
    }

    if (existsOnEamm) {
      console.log(`  ↳ eAMM already has market #${marketId}, skipping sync\n`);
      continue;
    }

    const syncTx = await eamm.createMarket(marketId, expiryAt);
    const syncReceipt = await syncTx.wait();
    console.log(`  ↳ synced to eAMM (tx: ${syncReceipt?.hash})\n`);
    synced++;
  }

  console.log(`Done. ${MARKETS.length} markets seeded, ${synced} synced to eAMM.`);
  if (seedLiquidity) {
    console.log(`Total liquidity injected: ${fmt(totalSeeded)}`);
  }
  console.log(`\nView on Flowscan: https://evm-testnet.flowscan.io/address/${contractAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
