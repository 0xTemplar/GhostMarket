/**
 * register-agents.ts
 *
 * One-time setup script. Run after deploying OracleAgentRegistry to Calibration.
 *
 * For each of the 7 oracle agents:
 *  1. Build agent metadata JSON
 *  2. Upload metadata to Filecoin via Synapse SDK → Piece CID
 *  3. Register in OracleAgentRegistry on Calibration with that Piece CID
 *  4. Register in ERC-8004 Identity Registry on Sepolia → erc8004Id
 *  5. Link erc8004Id back into OracleAgentRegistry
 *
 * Run:
 *   cd oracle
 *   npm install
 *   cp .env.example .env   # fill in keys
 *   npm run register
 */

import { ethers }                  from 'ethers';
import dotenv                      from 'dotenv';
import { AGENT_DEFINITIONS } from '../src/agents';
import { uploadToFilecoin }        from '../src/synapse-client';
import { registerAgent, linkERC8004 } from '../src/registry-client';
import { registerERC8004Agent }    from '../src/erc8004-client';
import * as fs                     from 'fs';
import * as path                   from 'path';

dotenv.config();

const SERVICE_ENDPOINT = `http://localhost:${process.env.PORT ?? 8080}`;

async function main() {
  const baseKey = process.env.CALIBRATION_PRIVATE_KEY;
  if (!baseKey) throw new Error('CALIBRATION_PRIVATE_KEY not set');

  console.log('\n=== GhostMarket Oracle Agent Registration ===\n');

  const registered: Array<{
    id: number;
    name: string;
    address: string;
    metadataCid: string;
    erc8004Id: string;
    calibrationTx: string;
  }> = [];

  for (const def of AGENT_DEFINITIONS) {
    const agentId  = def.id;
    const name     = def.name;
    const source   = def.source;

    // Derive deterministic wallet for this agent
    const agentKey  = ethers.keccak256(ethers.toUtf8Bytes(`${baseKey}-oracle-${agentId}`));
    const wallet    = new ethers.Wallet(agentKey);
    const address   = wallet.address;

    console.log(`\n── Agent ${agentId}: ${name} (${address}) ──`);

    // Build metadata
    const metadata = {
      type:          'oracle-agent-metadata',
      agentId,
      name,
      version:       '1.0.0',
      owner:         address,
      capabilityScope: ['market-resolution', 'data-attestation', 'quorum-voting'],
      dataSource:    source,
      stake:         '0',
      initialReputation: 80,
      slashPercent:  10,
      protocol:      'GhostMarket Oracle v1',
      createdAt:     new Date().toISOString(),
      networks: {
        calibration: process.env.ORACLE_REGISTRY_ADDRESS ?? 'pending',
        sepolia:     '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      },
    };

    // Step 1: Upload metadata to Filecoin via Synapse SDK
    let metadataCid: string;
    try {
      metadataCid = await uploadToFilecoin(metadata, `${name}-metadata`);
    } catch (err) {
      console.warn(`  Synapse upload failed: ${(err as Error).message}`);
      console.warn(`  Using placeholder CID for demo`);
      metadataCid = `bafkzcib-placeholder-agent-${agentId}`;
    }

    // Step 2: Register in OracleAgentRegistry on Calibration
    let calibrationTx = '';
    let erc8004Id = 0n;
    try {
      calibrationTx = await registerAgent(agentId, metadataCid, 0n);
    } catch (err) {
      console.warn(`  Registry registration failed: ${(err as Error).message}`);
    }

    // Step 3: Register in ERC-8004 Identity Registry on Sepolia
    try {
      erc8004Id = await registerERC8004Agent(
        name,
        `GhostMarket oracle agent ${agentId} — autonomous data fetcher and quorum voter for confidential prediction markets`,
        metadataCid,
        `${SERVICE_ENDPOINT}/oracle/agent/${agentId}`,
      );
    } catch (err) {
      console.warn(`  ERC-8004 registration failed: ${(err as Error).message}`);
    }

    // Step 4: Link ERC-8004 id back to Calibration registry
    if (erc8004Id > 0n && calibrationTx) {
      try {
        await linkERC8004(agentId, erc8004Id);
      } catch (err) {
        console.warn(`  ERC-8004 link failed: ${(err as Error).message}`);
      }
    }

    registered.push({
      id:            agentId,
      name,
      address,
      metadataCid,
      erc8004Id:     erc8004Id.toString(),
      calibrationTx,
    });

    console.log(`  ✓ metadataCid  : ${metadataCid}`);
    console.log(`  ✓ erc8004Id    : ${erc8004Id}`);
    console.log(`  ✓ calibration  : ${calibrationTx || '(skipped)'}`);
  }

  // Save registration results
  const outPath = path.join(__dirname, '../registered-agents.json');
  fs.writeFileSync(outPath, JSON.stringify(registered, null, 2));
  console.log(`\n✓ Registration complete. Results saved to oracle/registered-agents.json`);
  console.log('\n=== Summary ===');
  console.table(registered.map(a => ({
    id: a.id,
    name: a.name,
    metadataCid: a.metadataCid.slice(0, 20) + '...',
    erc8004Id: a.erc8004Id,
  })));
}

main().catch(err => {
  console.error('\n✗ Registration failed:', err.message);
  process.exit(1);
});
