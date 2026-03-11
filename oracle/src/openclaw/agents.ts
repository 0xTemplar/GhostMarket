import { AGENT_DEFINITIONS } from '../agents';
import type { OpenClawAgentSpec } from './types';

export function buildOpenClawAgents(activeAgents: number): OpenClawAgentSpec[] {
  return AGENT_DEFINITIONS.slice(0, activeAgents).map(def => ({
    id: def.id,
    name: def.name,
    role: 'oracle-attestor',
    source: def.source,
    systemPrompt: [
      `You are ${def.name}, an autonomous oracle attestor.`,
      `Primary market data source: ${def.source}.`,
      `Behavior: ${def.personality}`,
      'Use Storacha tools for memory and cross-agent coordination.',
      'Submit final vote attestations to the OracleAgentRegistry tool.',
    ].join(' '),
    tools: [
      'storacha.write_evidence',
      'storacha.read_peer_evidence',
      'registry.submit_attestation',
    ],
  }));
}
