/**
 * sync-markets-to-eamm.ts
 *
 * Reads every active market from GhostMarket.sol (Flow EVM) and registers
 * any that are missing on GhostEAMM.sol (Ethereum Sepolia).
 *
 * Must be run by the marketManager / owner of GhostEAMM — regular wallets
 * cannot call createMarket.
 *
 * Usage:
 *   npx ts-node scripts/sync-markets-to-eamm.ts
 *
 * Required in contracts/.env:
 *   DEPLOYER_PRIVATE_KEY      — wallet that owns / is marketManager on GhostEAMM
 *   SEPOLIA_RPC_URL           — Alchemy / Infura Sepolia endpoint
 *   GHOST_MARKET_ADDRESS      — GhostMarket.sol on Flow EVM
 *   GHOST_EAMM_ADDRESS        — GhostEAMM.sol on Sepolia
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const FLOW_EVM_RPC        = 'https://testnet.evm.nodes.onflow.org';
const SEPOLIA_RPC         = process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org';
const DEPLOYER_KEY        = process.env.DEPLOYER_PRIVATE_KEY ?? '';
const GHOST_MARKET_ADDR   = (process.env.GHOST_MARKET_ADDRESS ?? '') as string;
const GHOST_EAMM_ADDR     = (process.env.GHOST_EAMM_ADDRESS   ?? '') as string;

// ─── Minimal ABIs ─────────────────────────────────────────────────────────────

const GHOST_MARKET_ABI = [
  'function getAllMarketIds() view returns (uint256[])',
  'function markets(uint256) view returns (string title, string description, string category, string resolutionSource, uint64 expiryAt, uint8 status, uint256 yesPool, uint256 noPool, bool outcome, address creator)',
];

const GHOST_EAMM_ABI = [
  'function getMarketMeta(uint256 marketId) view returns (uint8 status, bool outcome, uint64 expiryAt)',
  'function createMarket(uint256 marketId, uint64 expiryAt)',
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!DEPLOYER_KEY)      throw new Error('DEPLOYER_PRIVATE_KEY not set');
  if (!GHOST_MARKET_ADDR) throw new Error('GHOST_MARKET_ADDRESS not set');
  if (!GHOST_EAMM_ADDR)   throw new Error('GHOST_EAMM_ADDRESS not set');

  // Flow EVM — read-only
  const flowProvider   = new ethers.JsonRpcProvider(FLOW_EVM_RPC);
  const ghostMarket    = new ethers.Contract(GHOST_MARKET_ADDR, GHOST_MARKET_ABI, flowProvider);

  // Sepolia — read + write
  const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const signer          = new ethers.Wallet(DEPLOYER_KEY, sepoliaProvider);
  const ghostEamm       = new ethers.Contract(GHOST_EAMM_ADDR, GHOST_EAMM_ABI, signer);

  console.log('Deployer :', signer.address);
  console.log('GhostMarket (Flow EVM) :', GHOST_MARKET_ADDR);
  console.log('GhostEAMM  (Sepolia)   :', GHOST_EAMM_ADDR);
  console.log('');

  // ── Fetch all market IDs from Flow EVM ──────────────────────────────────────
  const ids: bigint[] = await ghostMarket.getAllMarketIds();
  console.log(`Found ${ids.length} market(s) on GhostMarket.sol`);

  if (ids.length === 0) {
    console.log('Nothing to sync.');
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const id of ids) {
    const marketId = Number(id);

    // Read market data from Flow EVM
    const m = await ghostMarket.markets(id);
    const title    = m.title as string;
    const expiryAt = Number(m.expiryAt as bigint);
    const status   = Number(m.status as bigint);

    // Skip resolved / cancelled markets — no point registering them
    if (status !== 0) {
      console.log(`  [${marketId}] "${title}" — skipped (status=${status}, not Active)`);
      skipped++;
      continue;
    }

    // Skip markets that have already expired
    if (expiryAt < Math.floor(Date.now() / 1000)) {
      console.log(`  [${marketId}] "${title}" — skipped (expired)`);
      skipped++;
      continue;
    }

    // Check if already registered on GhostEAMM
    let existsOnEamm = false;
    try {
      await ghostEamm.getMarketMeta(id);
      existsOnEamm = true;
    } catch {
      // MarketNotFound — needs to be created
    }

    if (existsOnEamm) {
      console.log(`  [${marketId}] "${title}" — already on GhostEAMM ✓`);
      skipped++;
      continue;
    }

    // Register on GhostEAMM
    console.log(`  [${marketId}] "${title}" — registering on GhostEAMM (expiry ${new Date(expiryAt * 1000).toISOString()})…`);
    try {
      const tx = await ghostEamm.createMarket(id, expiryAt);
      const receipt = await tx.wait();
      console.log(`             ✅ created — tx ${receipt.hash}`);
      created++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`             ❌ failed: ${msg.slice(0, 120)}`);
    }
  }

  console.log('');
  console.log(`Done — ${created} created, ${skipped} skipped.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
