/**
 * pin-lit-action.ts — Pin oracle/src/lit-action.js to IPFS via Pinata.
 *
 * Returns the IPFS CID to set as LIT_ACTION_IPFS_CID in oracle/.env.
 * Lit nodes must be able to fetch the action from IPFS, so it needs to be
 * on a public gateway (Pinata free tier works).
 *
 * Usage:
 *   npm run lit:pin
 *
 * Required env vars (in oracle/.env):
 *   PINATA_JWT   — Pinata API JWT (free at https://app.pinata.cloud → API Keys)
 */

import * as fs   from 'fs';
import * as path from 'path';
import dotenv    from 'dotenv';

dotenv.config();

const PINATA_JWT  = process.env.PINATA_JWT ?? '';
const ACTION_PATH = path.resolve(__dirname, '../src/lit-action.js');

async function main() {
  if (!PINATA_JWT) {
    console.error('\n❌  PINATA_JWT not set in oracle/.env');
    console.error('    Get a free API key at https://app.pinata.cloud → API Keys → New Key');
    process.exit(1);
  }

  if (!fs.existsSync(ACTION_PATH)) {
    console.error(`\n❌  Lit Action not found at: ${ACTION_PATH}`);
    process.exit(1);
  }

  const content  = fs.readFileSync(ACTION_PATH, 'utf8');
  const filename = 'ghost-market-lit-action.js';

  console.log(`\n📦  Pinning ${filename} to IPFS via Pinata…`);
  console.log(`    Size: ${content.length} bytes`);

  // Use Pinata's pinFileToIPFS endpoint via multipart form upload
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([content], { type: 'application/javascript' }),
    filename,
  );
  formData.append(
    'pinataMetadata',
    JSON.stringify({ name: filename, keyvalues: { project: 'GhostMarket' } }),
  );
  formData.append(
    'pinataOptions',
    JSON.stringify({ cidVersion: 0 }), // CIDv0 (Qm...) — most widely supported
  );

  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method:  'POST',
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body:    formData,
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`\n❌  Pinata API error ${res.status}: ${body}`);
    process.exit(1);
  }

  const json = await res.json() as { IpfsHash: string; PinSize: number; Timestamp: string };

  console.log('\n✅  Pinned successfully!');
  console.log(`    CID:      ${json.IpfsHash}`);
  console.log(`    Size:     ${json.PinSize} bytes`);
  console.log(`    Gateway:  https://gateway.pinata.cloud/ipfs/${json.IpfsHash}`);

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  Add to oracle/.env:');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`LIT_ACTION_IPFS_CID=${json.IpfsHash}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('\nNext: npm run lit:setup   (add permitted action + print PKP keys)');
}

main().catch(err => {
  console.error('\n❌  Pin failed:', err.message ?? err);
  process.exit(1);
});
