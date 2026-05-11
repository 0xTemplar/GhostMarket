/**
 * demo-sealed-window.ts
 *
 * Creates a showcase market in GhostMarket + GhostEAMM, then immediately
 * opens a 30-second sealed-bid window on it.
 *
 * Designed for live demos:
 *   1. Run this script ≈ 30–60 seconds before the demo moment.
 *   2. The oracle watcher auto-settles the window and emits PriceRevealed.
 *   3. The frontend animates the reveal in real time.
 *
 * Usage:
 *   npx hardhat run scripts/demo-sealed-window.ts --network sepolia
 *
 * Required env (contracts/.env):
 *   DEPLOYER_PRIVATE_KEY
 *   SEPOLIA_RPC_URL
 *   GHOST_MARKET_ADDRESS
 *   GHOST_EAMM_ADDRESS
 *
 * Optional env:
 *   DEMO_WINDOW_SECS  — window duration in seconds (default: 30, minimum: 30)
 *   DEMO_MARKET_ID    — reuse an existing market ID instead of creating a new one
 */

import { ethers } from 'hardhat';

const GHOST_MARKET_ABI = [
  'function createMarket(string calldata title, string calldata description, string calldata category, string calldata resolutionSource, uint256 expiryAt) external returns (uint256 marketId)',
  'function getMarket(uint256 id) external view returns (tuple(uint256 id, address creator, string title, string description, string category, string resolutionSource, uint256 expiryAt, uint8 status, bool outcome))',
];

const GHOST_EAMM_ABI = [
  'function openSealedWindow(uint256 marketId, uint64 durationSecs) external',
  'function getSealedWindowCount(uint256 marketId) external view returns (uint256)',
  'function getActiveWindowIdx(uint256 marketId) external view returns (uint256)',
];

async function main() {
  const [deployer] = await ethers.getSigners();

  const ghostMarketAddress = process.env.GHOST_MARKET_ADDRESS ?? '';
  const ghostEammAddress   = process.env.GHOST_EAMM_ADDRESS   ?? '';
  const windowSecs         = BigInt(process.env.DEMO_WINDOW_SECS ?? '30');
  const existingMarketId   = process.env.DEMO_MARKET_ID ? BigInt(process.env.DEMO_MARKET_ID) : null;

  if (!ghostMarketAddress) throw new Error('GHOST_MARKET_ADDRESS not set in contracts/.env');
  if (!ghostEammAddress)   throw new Error('GHOST_EAMM_ADDRESS not set in contracts/.env');
  if (windowSecs < 30n)    throw new Error('DEMO_WINDOW_SECS must be ≥ 30');

  const ghostMarket = new ethers.Contract(ghostMarketAddress, GHOST_MARKET_ABI, deployer);
  const ghostEamm   = new ethers.Contract(ghostEammAddress,   GHOST_EAMM_ABI,   deployer);

  let marketId: bigint;

  if (existingMarketId !== null) {
    marketId = existingMarketId;
    console.log(`\n─── Reusing existing market ${marketId} ───`);
  } else {
    // ── Step 1: create a showcase market ──────────────────────────────────────

    const expiryAt = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600); // 7 days

    console.log(`\n─── Creating showcase market (deployer: ${deployer.address}) ───`);

    const tx = await ghostMarket.createMarket(
      'Will BTC trade above $120,000 before Jan 2027?',
      'Showcase market for the GhostMarket sealed-bid window demo. ' +
        'Tracks BTC/USD spot price against the $120k threshold.',
      'Crypto',
      'CoinGecko BTC/USD spot price at market expiry',
      expiryAt,
    );
    const receipt = await tx.wait();
    console.log(`createMarket TX: https://sepolia.etherscan.io/tx/${tx.hash}`);

    // Parse the MarketCreated event to get the ID.
    const ghostMarketInterface = new ethers.Interface([
      'event MarketCreated(uint256 indexed id, address indexed creator, string title)',
    ]);
    const log = receipt.logs
      .map((l: { topics: string[]; data: string }) => {
        try { return ghostMarketInterface.parseLog(l); } catch { return null; }
      })
      .find((l: ReturnType<typeof ghostMarketInterface.parseLog> | null) => l?.name === 'MarketCreated');

    if (!log) throw new Error('Could not parse MarketCreated event');
    marketId = BigInt(log.args.id);
    console.log(`Market created — ID: ${marketId}`);
  }

  // ── Step 2: open a sealed window ──────────────────────────────────────────

  console.log(`\n─── Opening ${windowSecs}s sealed-bid window on market ${marketId} ───`);

  const windowTx = await ghostEamm.openSealedWindow(marketId, windowSecs);
  await windowTx.wait();
  console.log(`openSealedWindow TX: https://sepolia.etherscan.io/tx/${windowTx.hash}`);

  const windowCount = await ghostEamm.getSealedWindowCount(marketId);
  const activeIdx   = await ghostEamm.getActiveWindowIdx(marketId);

  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║        DEMO SEALED WINDOW OPEN        ║`);
  console.log(`╠═══════════════════════════════════════╣`);
  console.log(`║  Market ID:   ${String(marketId).padEnd(24)}║`);
  console.log(`║  Window idx:  ${String(activeIdx).padEnd(24)}║`);
  console.log(`║  Window secs: ${String(windowSecs).padEnd(24)}║`);
  console.log(`║  Total windows: ${String(windowCount).padEnd(22)}║`);
  console.log(`╠═══════════════════════════════════════╣`);
  console.log(`║  The oracle watcher will auto-settle  ║`);
  console.log(`║  and emit PriceRevealed in ${String(windowSecs + 10n)}s. ║`);
  console.log(`╚═══════════════════════════════════════╝`);

  console.log(`\nAdd to WATCHED_MARKETS env: ${marketId}`);
  console.log(`Frontend URL: /markets/${marketId}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
