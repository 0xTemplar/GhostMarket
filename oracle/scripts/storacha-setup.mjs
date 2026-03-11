/**
 * storacha-setup.mjs
 *
 * Programmatically creates a Storacha space and delegation for the oracle agent.
 * No interactive prompts — outputs the STORACHA_PROOF base64 directly.
 *
 * Run: node scripts/storacha-setup.mjs
 */

import * as Client from '@storacha/client';
import { StoreMemory } from '@storacha/client/stores/memory';
import { generate } from '@storacha/client/principal/ed25519';
import { parse as parseDID } from '@ipld/dag-ucan/did';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The oracle agent DID that needs to be delegated upload rights
const ORACLE_AGENT_DID = 'did:key:z6MksYDbQfiEwLhumGcbGXDEMDXWApd8gYZjus8uqfPuigJN';

async function main() {
  console.log('=== GhostMarket Storacha Space Setup ===\n');

  // 1. Create a brand-new space owner (principal)
  const spacePrincipal = await generate();
  console.log('Space owner DID:', spacePrincipal.did());

  // 2. Create a Storacha client backed by the space principal
  const store  = new StoreMemory();
  const client = await Client.create({ principal: spacePrincipal, store });

  // 3. Create a space
  const space = await client.createSpace('ghost-oracle');
  await client.setCurrentSpace(space.did());
  console.log('Space DID:      ', space.did());

  // 4. Create a delegation for the oracle agent
  //    Grants store/add + upload/add — enough to upload evidence files
  const oracleDID   = parseDID(ORACLE_AGENT_DID);
  const delegation  = await client.createDelegation(
    oracleDID,
    ['store/add', 'upload/add', 'space/blob/add', 'space/index/add', 'filecoin/offer'],
    { expiration: Infinity },
  );

  // 5. Serialise delegation to CAR bytes then base64
  // archive() returns Result<Uint8Array, Error> in ucanto
  const archiveResult = await delegation.archive();
  const bytes = archiveResult.ok ?? archiveResult;  // handle both Result and direct return
  const b64   = Buffer.from(bytes).toString('base64');

  console.log('\n✓ Delegation created\n');
  console.log('Add these to oracle/.env:\n');
  console.log(`STORACHA_SPACE_DID=${space.did()}`);
  console.log(`STORACHA_PROOF=${b64}`);
  console.log('OR write proof to a file and set: STORACHA_PROOF_FILE=./storacha-proof.txt');

  // Write to a file for convenience
  const outPath = path.join(__dirname, '../storacha-proof.txt');
  fs.writeFileSync(outPath, b64);
  console.log(`\n✓ Proof also written to oracle/storacha-proof.txt`);
}

main().catch(err => {
  console.error('✗ Setup failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
