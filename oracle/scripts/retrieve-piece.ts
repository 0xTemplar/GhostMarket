import dotenv from 'dotenv';
dotenv.config();

import { downloadFromFilecoin } from '../src/synapse-client.js';

const cid = process.argv[2];
if (!cid) {
  console.error('Usage: npx tsx scripts/retrieve-piece.ts <pieceCid>');
  process.exit(1);
}

async function main() {
  console.log('Downloading PieceCID:', cid);
  const data = await downloadFromFilecoin(cid);
  console.log('✓ Success:');
  console.log(JSON.stringify(data, null, 2));
}

main().catch(err => {
  console.error('✗ Failed:', (err as Error).message);
  process.exit(1);
});
