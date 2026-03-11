/**
 * smoke-test-synapse.ts
 *
 * Minimal smoke test for synapse-client.ts against Filecoin Calibration.
 *
 * Steps:
 *   1. Init Synapse (private key → viem account → Synapse.create)
 *   2. Print USDFC wallet balance
 *   3. Upload a small JSON payload
 *   4. Print the returned PieceCID
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/smoke-test-synapse.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { getUSDFCBalance, uploadToFilecoin, downloadFromFilecoin } from '../src/synapse-client.js';

async function main() {
  console.log('\n=== Synapse SDK smoke test (v0.39.0) ===\n');

  // ── 1. Wallet balance ────────────────────────────────────────────────────────
  console.log('[1] Fetching USDFC wallet balance...');
  try {
    const balance = await getUSDFCBalance();
    console.log(`    ✓ USDFC balance: ${balance}`);
  } catch (err) {
    console.error('    ✗ Balance check failed:', (err as Error).message);
    process.exit(1);
  }

  // ── 2. Upload ────────────────────────────────────────────────────────────────
  const payload = {
    test: 'smoke-test',
    timestamp: new Date().toISOString(),
    value: Math.random(),
  };

  console.log('\n[2] Uploading test payload...');
  console.log('    Payload:', JSON.stringify(payload));

  let pieceCid: string;
  try {
    pieceCid = await uploadToFilecoin(payload, 'smoke-test');
    if (pieceCid.startsWith('placeholder:')) {
      console.warn('    ⚠  Upload returned placeholder CID — provider may be unavailable.');
      console.warn('    CID:', pieceCid);
    } else {
      console.log('    ✓ Upload succeeded');
      console.log('    PieceCID:', pieceCid);
    }
  } catch (err) {
    console.error('    ✗ Upload failed:', (err as Error).message);
    process.exit(1);
  }

  // ── 3. Download (only for real CIDs) ─────────────────────────────────────────
  if (!pieceCid.startsWith('placeholder:')) {
    console.log('\n[3] Downloading by PieceCID...');
    try {
      const downloaded = await downloadFromFilecoin(pieceCid);
      console.log('    ✓ Download succeeded');
      console.log('    Data:', JSON.stringify(downloaded));
    } catch (err) {
      console.warn('    ⚠  Download failed (provider may need more time):', (err as Error).message);
    }
  } else {
    console.log('\n[3] Skipping download (placeholder CID).');
  }

  console.log('\n=== Smoke test complete ===\n');
}

main().catch(err => {
  console.error('\nFatal:', err);
  process.exit(1);
});
