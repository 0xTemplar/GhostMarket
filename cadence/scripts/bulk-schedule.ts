/**
 * bulk-schedule.ts
 *
 * Reads every active, non-expired market from GhostMarket.sol (Flow EVM) and
 * schedules a Cadence delivery for each via FlowTransactionScheduler.
 *
 * Outcomes are resolved in priority order:
 *   1. OUTCOMES env var:  OUTCOMES="1:true,2:false,3:true"
 *   2. outcomes.json in this directory: { "1": true, "2": false }
 *   3. DEFAULT_OUTCOME env var (default: false / NO wins)
 *
 * Usage:
 *   npx tsx scripts/bulk-schedule.ts
 *   OUTCOMES="1:true,3:false" npx tsx scripts/bulk-schedule.ts
 *   DEFAULT_OUTCOME=true npx tsx scripts/bulk-schedule.ts
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { scheduleVaultDelivery } from '../src/scheduler';

dotenv.config({ path: path.join(__dirname, '../.env') });

// ─── Config ───────────────────────────────────────────────────────────────────

const FLOW_EVM_RPC     = process.env.FLOW_RPC_URL     ?? 'https://testnet.evm.nodes.onflow.org';
const GHOST_MARKET_ADDR = process.env.GHOST_MARKET_ADDRESS ?? '';
const DEFAULT_OUTCOME   = (process.env.DEFAULT_OUTCOME ?? 'false').toLowerCase() === 'true';

const GHOST_MARKET_ABI = [
  'function getAllMarketIds() view returns (uint256[])',
  'function markets(uint256) view returns (string title, string description, string category, string resolutionSource, uint64 expiryAt, uint8 status, uint256 yesPool, uint256 noPool, bool outcome, address creator)',
];

// ─── Load outcome map ─────────────────────────────────────────────────────────

function loadOutcomes(): Record<string, boolean> {
  const map: Record<string, boolean> = {};

  // 1. outcomes.json
  const jsonPath = path.join(__dirname, '../outcomes.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, boolean>;
      Object.assign(map, raw);
      console.log(`Loaded ${Object.keys(raw).length} outcome(s) from outcomes.json`);
    } catch {
      console.warn('  ⚠  Could not parse outcomes.json — ignoring');
    }
  }

  // 2. OUTCOMES env var overrides
  const envOutcomes = process.env.OUTCOMES ?? '';
  if (envOutcomes) {
    for (const pair of envOutcomes.split(',')) {
      const [id, val] = pair.trim().split(':');
      if (id && val !== undefined) {
        map[id.trim()] = val.trim().toLowerCase() === 'true';
      }
    }
    console.log(`Applied OUTCOMES env overrides: ${envOutcomes}`);
  }

  return map;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!GHOST_MARKET_ADDR) throw new Error('GHOST_MARKET_ADDRESS not set in cadence/.env');

  console.log('\n=== GhostMarket — Cadence Bulk Scheduler ===\n');
  console.log(`GhostMarket (Flow EVM) : ${GHOST_MARKET_ADDR}`);
  console.log(`Default outcome        : ${DEFAULT_OUTCOME ? 'YES ✅' : 'NO ❌'}`);
  console.log('');

  const outcomes = loadOutcomes();

  const provider    = new ethers.JsonRpcProvider(FLOW_EVM_RPC);
  const ghostMarket = new ethers.Contract(GHOST_MARKET_ADDR, GHOST_MARKET_ABI, provider);

  const ids: bigint[] = await ghostMarket.getAllMarketIds();
  console.log(`Found ${ids.length} total market(s) on Flow EVM\n`);

  const now = Math.floor(Date.now() / 1000);
  let scheduled = 0;
  let skipped   = 0;
  let failed    = 0;

  for (const id of ids) {
    const marketId = String(Number(id));
    const m        = await ghostMarket.markets(id);
    const title    = m.title as string;
    const expiryAt = Number(m.expiryAt as bigint);
    const status   = Number(m.status as bigint);

    // Only schedule Active (status=0) markets
    if (status !== 0) {
      console.log(`  [${marketId}] "${title}"`);
      console.log(`         → skipped (status=${status}, not Active)\n`);
      skipped++;
      continue;
    }

    // Skip already-expired markets
    if (expiryAt < now) {
      console.log(`  [${marketId}] "${title}"`);
      console.log(`         → skipped (expired ${new Date(expiryAt * 1000).toISOString()})\n`);
      skipped++;
      continue;
    }

    const outcome = outcomes[marketId] ?? DEFAULT_OUTCOME;
    const expiryStr = new Date(expiryAt * 1000).toISOString();

    console.log(`  [${marketId}] "${title}"`);
    console.log(`         expiry  : ${expiryStr}`);
    console.log(`         outcome : ${outcome ? 'YES ✅' : 'NO ❌'}${outcomes[marketId] !== undefined ? '' : '  (default)'}`);

    const result = await scheduleVaultDelivery(marketId, outcome);

    if (result.status === 'scheduled') {
      console.log(`         ✅ scheduled — Flow tx: ${result.txId}\n`);
      scheduled++;
    } else if (result.status === 'skipped') {
      console.log(`         ⚠  skipped — ${result.message}\n`);
      skipped++;
    } else {
      console.log(`         ❌ failed  — ${result.message}\n`);
      failed++;
    }
  }

  console.log('─'.repeat(60));
  console.log(`Done — ${scheduled} scheduled, ${skipped} skipped, ${failed} failed`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
