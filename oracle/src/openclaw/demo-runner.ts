/**
 * OpenClaw adapter demo runner.
 *
 * This is a thin OpenClaw-compatible orchestration layer that reuses the
 * existing GhostMarket Storacha + registry modules.
 *
 * Run:
 *   npm run openclaw:demo
 */

import dotenv from 'dotenv';
import { agentDelay } from '../agents';
import { buildOpenClawAgents } from './agents';
import {
  readPeerEvidenceTool,
  submitAttestationTool,
  writeEvidenceTool,
} from './tools';
import type { OpenClawRoundResult } from './types';

dotenv.config();

const ACTIVE_AGENTS = Math.max(1, Math.min(7, Number(process.env.ACTIVE_ORACLE_AGENTS ?? 4)));
const SKIP_REGISTRY = (process.env.OPENCLAW_SKIP_REGISTRY ?? 'false') === 'true';

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadEvidenceWithRetry(
  agentId: number,
  marketId: string,
  source: string,
  claim: string,
  vote: boolean,
  reasoning: string,
): Promise<string> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await writeEvidenceTool.execute(
        { source, claim, vote, reasoning },
        { agentId, marketId },
      );
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const backoffMs = 400 * (2 ** (attempt - 1));
      console.warn(
        `[OpenClaw] evidence upload retry ${attempt}/${maxAttempts - 1} for agent ${agentId}: ${(error as Error).message}`
      );
      await sleep(backoffMs);
    }
  }
  throw new Error(`Failed evidence upload for agent ${agentId}`);
}

async function runRound(marketId: string, expectedOutcome: boolean): Promise<OpenClawRoundResult[]> {
  const agents = buildOpenClawAgents(ACTIVE_AGENTS);
  const evidenceByAgent = new Map<number, string>();

  console.log(`\n[OpenClaw] Starting demo round for ${marketId}`);
  console.log(`[OpenClaw] Agents: ${agents.map(a => a.name).join(', ')}`);
  console.log(`[OpenClaw] Registry mode: ${SKIP_REGISTRY ? 'skip' : 'submit'}\n`);

  const results: OpenClawRoundResult[] = [];
  for (const [idx, agent] of agents.entries()) {
    await sleep(agentDelay(agent.id));

    // Simple simulated vote policy with slight disagreement.
    const vote = agent.id === 4 && Math.random() < 0.15 ? !expectedOutcome : expectedOutcome;

    // Demonstrate multi-agent coordination: later agents read earlier evidence.
    if (idx > 0) {
      const previousCid = evidenceByAgent.get(agents[idx - 1].id);
      if (previousCid) {
        const peer = await readPeerEvidenceTool.execute({ cid: previousCid }, { agentId: agent.id, marketId });
        if (peer) {
          console.log(`[OpenClaw] ${agent.name} read peer CID ${previousCid.slice(0, 20)}...`);
        }
      }
    }

    const storachaCid = await uploadEvidenceWithRetry(
      agent.id,
      marketId,
      agent.source,
      vote ? 'YES' : 'NO',
      vote,
      `OpenClaw demo vote by ${agent.name}`,
    );

    evidenceByAgent.set(agent.id, storachaCid);
    console.log(`[OpenClaw] ${agent.name} evidence -> ${storachaCid}`);

    let attestationTx: string | null = null;
    if (!SKIP_REGISTRY) {
      try {
        attestationTx = await submitAttestationTool.execute({
          vote,
          storachaCid,
        }, { agentId: agent.id, marketId });
        console.log(`[OpenClaw] ${agent.name} attested -> ${attestationTx}`);
      } catch (error) {
        console.warn(`[OpenClaw] ${agent.name} attestation failed: ${(error as Error).message}`);
      }
    }

    results.push({
      marketId,
      agentId: agent.id,
      vote,
      storachaCid,
      attestationTx,
    });
  }

  return results;
}

async function main() {
  const marketId = `openclaw-${Date.now()}`;
  const results = await runRound(marketId, true);
  const yesVotes = results.filter(r => r.vote).length;
  const noVotes = results.length - yesVotes;

  console.log('\n[OpenClaw] Round complete');
  console.log(`[OpenClaw] votes YES=${yesVotes} NO=${noVotes}`);
  console.log('[OpenClaw] result summary:');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error('[OpenClaw] demo failed:', error.message);
  process.exit(1);
});
