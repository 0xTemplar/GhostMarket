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

  // Optional: --only <id1,id2,...> to register a subset of agents
  const onlyFlagIdx = process.argv.indexOf('--only');
  const onlyArg = process.argv.find(a => a.startsWith('--only='))?.split('=')[1]
    ?? (onlyFlagIdx !== -1 ? process.argv[onlyFlagIdx + 1] : undefined);
  const onlyIds = onlyArg
    ? new Set(onlyArg.split(',').map(v => Number(v.trim())))
    : null;

  // Default: register only the agents the oracle actually uses (ACTIVE_ORACLE_AGENTS).
  // Pass --all to register all 7 (e.g. when scaling up to a full 7-agent swarm).
  const registerAll = process.argv.includes('--all');
  const activeCount = Number(process.env.ACTIVE_ORACLE_AGENTS ?? 4);

  const definitions = onlyIds
    ? AGENT_DEFINITIONS.filter(d => onlyIds.has(d.id))
    : registerAll
    ? AGENT_DEFINITIONS
    : AGENT_DEFINITIONS.slice(0, activeCount);

  const scopeLabel = onlyIds
    ? `agents: ${[...onlyIds].join(', ')}`
    : registerAll
    ? 'all 7 agents'
    : `agents 1–${activeCount} (ACTIVE_ORACLE_AGENTS=${activeCount}; pass --all for all 7)`;

  console.log(`\n=== GhostMarket Oracle Agent Registration (${scopeLabel}) ===\n`);

  // Load existing registrations so we can merge results
  const outPath = path.join(__dirname, '../registered-agents.json');
  let existing: Record<number, (typeof registered)[number]> = {};
  try {
    const raw = fs.readFileSync(outPath, 'utf8');
    for (const entry of JSON.parse(raw)) existing[entry.id] = entry;
  } catch { /* first run */ }

  const registered: Array<{
    id: number;
    name: string;
    address: string;
    metadataCid: string;
    erc8004Id: string;
    calibrationTx: string;
  }> = [];

  for (const def of definitions) {
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

  // Merge new results into existing registrations and save
  for (const entry of registered) existing[entry.id] = entry;
  const merged = AGENT_DEFINITIONS.map(d => existing[d.id]).filter(Boolean);
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
  console.log(`\n✓ Registration complete. Results saved to oracle/registered-agents.json`);
  console.log('\n=== Summary (this run) ===');
  console.table(registered.map(a => ({
    id: a.id,
    name: a.name,
    calibrationTx: a.calibrationTx ? a.calibrationTx.slice(0, 18) + '...' : '(skipped)',
    erc8004Id: a.erc8004Id,
  })));
}

main().catch(err => {
  console.error('\n✗ Registration failed:', err.message);
  process.exit(1);
});
