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
  console.log('\n=== Synapse SDK smoke test (v0.39.0, withCDN=true) ===\n');

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

  // ── 3. FilCDN URL fetch ───────────────────────────────────────────────────────
  if (!pieceCid.startsWith('placeholder:')) {
    // The retrieval URL printed above follows: https://{address}.calibration.filcdn.io/{cid}
    // Reconstruct it from what we know and try fetching via Synapse SDK download (withCDN=true)
    console.log('\n[3] Fetching via Synapse CDN download (withCDN=true)...');
    try {
      const downloaded = await downloadFromFilecoin(pieceCid);
      console.log('    ✓ CDN download succeeded');
      console.log('    Data:', JSON.stringify(downloaded));
    } catch (err) {
      console.warn('    ⚠  CDN download failed (piece may still be propagating):', (err as Error).message);
    }

    // ── 4. Direct filcdn.io URL probe ──────────────────────────────────────────
    // Try constructing the filcdn.io URL using provider address from the Synapse storage info.
    console.log('\n[4] Probing filcdn.io URL directly...');
    try {
      const { Synapse, calibration } = await import('@filoz/synapse-sdk');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { http } = await import('viem');
      const account = privateKeyToAccount(process.env.CALIBRATION_PRIVATE_KEY as `0x${string}`);
      const synapse = Synapse.create({ account, transport: http(process.env.CALIBRATION_RPC_URL ?? 'https://filecoin-calibration.drpc.org'), chain: calibration, withCDN: true, source: 'smoke-test' });
      const info = await synapse.storage.getStorageInfo();
      const providers = info.providers ?? [];
      console.log(`    Found ${providers.length} provider(s)`);
      for (const p of providers.slice(0, 3)) {
        const addr = (p as { ownerAddress?: string; address?: string }).ownerAddress
          ?? (p as { address?: string }).address
          ?? '';
        if (!addr) continue;
        const filcdnUrl = `https://${addr.toLowerCase()}.calibration.filcdn.io/${pieceCid}`;
        console.log(`    Trying: ${filcdnUrl}`);
        try {
          const res = await fetch(filcdnUrl, { signal: AbortSignal.timeout(8000) });
          console.log(`    → HTTP ${res.status}`);
          if (res.ok) {
            const text = await res.text();
            console.log('    ✓ filcdn.io fetch succeeded:', text.slice(0, 120));
            break;
          }
        } catch (fetchErr) {
          console.warn(`    → fetch error: ${(fetchErr as Error).message}`);
        }
      }
    } catch (err) {
      console.warn('    ⚠  filcdn.io probe failed:', (err as Error).message);
    }
  } else {
    console.log('\n[3] Skipping CDN test (placeholder CID).');
  }

  console.log('\n=== Smoke test complete ===\n');
}

main().catch(err => {
  console.error('\nFatal:', err);
  process.exit(1);
});
