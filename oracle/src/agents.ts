import type { OracleAgent } from './types';

/**
 * The 7 oracle agents that form the GhostMarket swarm.
 *
 * Each agent has a name that reflects their analytical personality.
 * In production each agent runs in its own process. For the demo they
 * share the service process but maintain independent state and make
 * independent LLM-driven decisions (via the Python api/ layer).
 */

export interface AgentDefinition {
  id:          number;
  name:        string;
  source:      string;    // primary data source
  personality: string;    // short description used in LLM prompts
}

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id:          1,
    name:        'Cipher',
    source:      'Binance',
    personality: 'Data-driven analyst who only trusts on-chain data and top-tier CEX feeds.',
  },
  {
    id:          2,
    name:        'Specter',
    source:      'CoinGecko',
    personality: 'Cautious risk assessor who requires high-confidence signals before voting YES.',
  },
  {
    id:          3,
    name:        'Wraith',
    source:      'Chainlink',
    personality: 'Fast mover who prioritises on-chain oracle feeds over off-chain price data.',
  },
  {
    id:          4,
    name:        'Phantom',
    source:      'Coinbase',
    personality: 'Contrarian thinker who stress-tests the consensus and probes edge cases.',
  },
  {
    id:          5,
    name:        'Shade',
    source:      'Kraken',
    personality: 'Consensus-seeker who cross-references multiple signals before attesting.',
  },
  {
    id:          6,
    name:        'Echo',
    source:      'OKX',
    personality: 'Aggregator who synthesises data across sources and weights by volume.',
  },
  {
    id:          7,
    name:        'Vex',
    source:      'Bybit',
    personality: 'Adversarial tester who actively looks for manipulation or stale data.',
  },
];

export const AGENT_NAMES = AGENT_DEFINITIONS.map(a => a.name);

export function buildAgents(addresses: string[]): OracleAgent[] {
  return AGENT_DEFINITIONS.map((def, i) => ({
    id:             def.id,
    name:           def.name,
    walletAddress:  addresses[i] ?? '0x0000000000000000000000000000000000000000',
    reputationScore: 80,
    erc8004Id:      null,
    status:         'idle',
    vote:           null,
    storachaCid:    null,
    filecoinCid:    null,
    attestedAt:     null,
  }));
}

/** Staggered delay so agents don't all respond simultaneously */
export function agentDelay(agentId: number): number {
  const base   = 1500 + agentId * 600;
  const jitter = Math.floor(Math.random() * 1000);
  return base + jitter;
}
