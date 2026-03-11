/**
 * storacha-client.ts
 *
 * Wraps @storacha/client for GhostMarket oracle storage.
 *
 * Storacha is used for two load-bearing behaviours:
 *
 *  Track 1 — Persistent Agent Memory
 *    Each agent saves a checkpoint after every resolution. On startup the
 *    oracle service reads each agent's last checkpoint from Storacha and
 *    restores reputation, vote history, and last-market state — so agents
 *    actually remember across restarts.
 *
 *    The "head" CID for each agent is kept in oracle/agent-heads.json.
 *    That file is the mutable pointer into the immutable content-addressed
 *    store — the standard pattern for Storacha/IPFS head tracking.
 *
 *  Track 2 — Multi-Agent Coordination
 *    Each agent uploads its intermediate evidence during collection.
 *    Later-voting agents (Shade, Vex) call readByCid() to pull earlier
 *    agents' evidence from Storacha before finalising their own vote.
 *    This is real cross-agent knowledge sharing via content-addressed CIDs.
 *
 * Setup:
 *   1. Create a space at https://console.storacha.network/
 *   2. npx @storacha/cli@latest key create            → STORACHA_PRINCIPAL_KEY
 *   3. npx @storacha/cli@latest delegation create ... --base64
 *      (paste output into STORACHA_PROOF, or write it to STORACHA_PROOF_FILE)
 */

import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ── Client singleton ───────────────────────────────────────────────────────────
// Dynamic import required — Storacha client is ESM-only

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null;

function readProofFromEnv(): string {
  const inline = process.env.STORACHA_PROOF?.trim();
  if (inline) return inline.replace(/^['"]|['"]$/g, '').replace(/\s+/g, '');

  const proofFile = process.env.STORACHA_PROOF_FILE?.trim();
  if (proofFile) {
    const absolute = path.isAbsolute(proofFile) ? proofFile : path.resolve(__dirname, '..', proofFile);
    const fromFile = fs.readFileSync(absolute, 'utf-8').trim();
    if (fromFile) return fromFile.replace(/^['"]|['"]$/g, '').replace(/\s+/g, '');
  }

  return '';
}

async function getClient() {
  if (_client) return _client;

  const principalKey = process.env.STORACHA_PRINCIPAL_KEY;
  const proofStr     = readProofFromEnv();
  const spaceDid     = process.env.STORACHA_SPACE_DID?.trim();

  const Client          = await import('@storacha/client');
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — subpath exports require node16 moduleResolution
  const { StoreMemory } = await import('@storacha/client/stores/memory');
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — subpath exports require node16 moduleResolution
  const { Signer }      = await import('@storacha/client/principal/ed25519');
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const Proof           = await import('@storacha/client/proof');

  if (principalKey && proofStr) {
    const principal = Signer.parse(principalKey);
    const store     = new StoreMemory();

    // Don't cache until fully initialised (space set)
    const tempClient = await Client.create({ principal, store });

    try {
      const proof = await Proof.parse(proofStr);
      const space = await tempClient.addSpace(proof);
      await tempClient.setCurrentSpace(space.did());
      _client = tempClient;
      return _client;
    } catch (error) {
      throw new Error(
        `Failed to parse STORACHA_PROOF (${(error as Error).message}). Regenerate with @storacha/cli and set STORACHA_PROOF or STORACHA_PROOF_FILE.`
      );
    }
  }

  // Fallback: if delegations were previously persisted locally, this can work
  // with only STORACHA_SPACE_DID.
  if (spaceDid) {
    const tempClient = await Client.create();
    await tempClient.setCurrentSpace(spaceDid as `did:${string}:${string}`);
    _client = tempClient;
    return _client;
  }

  throw new Error(
    'Storacha not configured. Set STORACHA_PRINCIPAL_KEY + STORACHA_PROOF (or STORACHA_PROOF_FILE), or provide STORACHA_SPACE_DID with an already-authorized local client store.'
  );
}

// ── Head pointer index (mutable local file) ────────────────────────────────────
//
// Storacha CIDs are immutable — to track "latest checkpoint" we keep a small
// JSON file mapping agentId → latest CID. This is the standard IPFS head
// tracking pattern. In a deployed system this pointer would live on-chain or
// in a UCANs-based mutable root, but a local file is correct for the demo.

const HEADS_FILE = path.join(__dirname, '../agent-heads.json');

function loadHeads(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(HEADS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveHead(key: string, cid: string): void {
  const heads = loadHeads();
  heads[key]  = cid;
  fs.writeFileSync(HEADS_FILE, JSON.stringify(heads, null, 2));
  console.log(`[Storacha] head updated: ${key} → ${cid.slice(0, 20)}...`);
}

export function getAllHeads(): Record<string, string> {
  return loadHeads();
}

// ── Core upload / download ─────────────────────────────────────────────────────

export async function uploadToStoracha(
  payload: object,
  label: string,
): Promise<string> {
  const client = await getClient();

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const file = new File([blob], `${label}.json`);

  console.log(`[Storacha] Uploading ${label}...`);
  const cid    = await client.uploadFile(file);
  const cidStr = cid.toString();
  console.log(`[Storacha] ✓ ${label} → CID: ${cidStr}`);
  return cidStr;
}

/**
 * Fetch any object from Storacha (or any IPFS gateway) by CID.
 * Used by cross-agent reads: Shade reads Cipher's evidence before voting.
 */
export async function readByCid(cid: string): Promise<object> {
  // Try w3s.link first (Storacha's CDN gateway)
  const gateways = [
    `https://w3s.link/ipfs/${cid}`,
    `https://${cid}.ipfs.w3s.link`,
    `https://ipfs.io/ipfs/${cid}`,
  ];

  for (const url of gateways) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return await res.json() as object;
    } catch { /* try next gateway */ }
  }
  throw new Error(`Failed to fetch CID ${cid} from any gateway`);
}

// ── Track 1: Persistent Agent Memory ──────────────────────────────────────────

/**
 * Save an agent checkpoint to Storacha and update the head pointer.
 * Called after every resolution — agents always have their latest state
 * persisted and retrievable from any machine.
 */
export async function saveAgentCheckpoint(
  agentId: number,
  state: {
    lastMarket:      string | number;
    lastVote:        boolean;
    reputationScore: number;
    correctVotes:    number;
    totalVotes:      number;
    storachaCid:     string;
    calibrationTx:   string;
  },
): Promise<string> {
  const payload = {
    type:      'agent-checkpoint',
    agentId,
    checkpoint: state,
    savedAt:   new Date().toISOString(),
    version:   '1.0',
  };

  const cid = await uploadToStoracha(payload, `agent-${agentId}-checkpoint`);
  saveHead(`agent-${agentId}-checkpoint`, cid);
  return cid;
}

/**
 * Load the latest checkpoint for an agent from Storacha.
 * Returns null if no checkpoint exists (first run).
 */
export async function loadAgentCheckpoint(agentId: number): Promise<{
  lastMarket:      string | number;
  lastVote:        boolean;
  reputationScore: number;
  correctVotes:    number;
  totalVotes:      number;
} | null> {
  const heads = loadHeads();
  const cid   = heads[`agent-${agentId}-checkpoint`];
  if (!cid) return null;

  try {
    console.log(`[Storacha] Loading checkpoint for agent ${agentId} from ${cid.slice(0, 20)}...`);
    const data = await readByCid(cid) as { checkpoint: Record<string, unknown> };
    return data.checkpoint as {
      lastMarket:      string | number;
      lastVote:        boolean;
      reputationScore: number;
      correctVotes:    number;
      totalVotes:      number;
    };
  } catch (e) {
    console.warn(`[Storacha] Failed to load checkpoint for agent ${agentId}:`, (e as Error).message);
    return null;
  }
}

/**
 * Load checkpoints for all 7 agents on service startup.
 * Returns a map of agentId → checkpoint (or null if no checkpoint).
 */
export async function loadAllCheckpoints(): Promise<Record<number, Awaited<ReturnType<typeof loadAgentCheckpoint>>>> {
  console.log('\n[Storacha] Loading agent checkpoints on startup...');
  const results: Record<number, Awaited<ReturnType<typeof loadAgentCheckpoint>>> = {};

  await Promise.allSettled(
    Array.from({ length: 7 }, async (_, i) => {
      const agentId    = i + 1;
      results[agentId] = await loadAgentCheckpoint(agentId);
      if (results[agentId]) {
        const cp = results[agentId]!;
        console.log(`[Storacha] ✓ Agent ${agentId}: reputation=${cp.reputationScore}, lastMarket=${cp.lastMarket}`);
      } else {
        console.log(`[Storacha]   Agent ${agentId}: no checkpoint (first run)`);
      }
    })
  );

  return results;
}

// ── Track 2: Multi-Agent Coordination ─────────────────────────────────────────

/**
 * Upload intermediate evidence for an agent during oracle collection.
 * The returned CID is shared with other agents so they can read this
 * agent's evidence before casting their own vote.
 */
export async function saveIntermediateEvidence(
  agentId: number,
  marketId: string | number,
  evidence: {
    source:    string;
    timestamp: string;
    claim:     string;
    vote:      boolean;
    dataHash:  string;
    reasoning: string;
  },
): Promise<string> {
  const payload = {
    type:      'intermediate-evidence',
    agentId,
    marketId,
    evidence,
    storedAt:  new Date().toISOString(),
  };

  const cid = await uploadToStoracha(payload, `agent-${agentId}-market-${marketId}`);

  // Update the live evidence head so other agents can find the latest CID
  saveHead(`agent-${agentId}-market-${marketId}-evidence`, cid);
  return cid;
}

/**
 * Read another agent's evidence from Storacha by CID.
 * Used by Shade (consensus-seeker) and Vex (adversarial tester) to
 * verify peer attestations before casting their own vote.
 */
export async function readPeerEvidence(cid: string): Promise<{
  agentId:  number;
  evidence: { source: string; claim: string; vote: boolean; reasoning: string };
} | null> {
  try {
    const data = await readByCid(cid) as {
      agentId:  number;
      evidence: { source: string; claim: string; vote: boolean; reasoning: string };
    };
    return data;
  } catch {
    return null;
  }
}
