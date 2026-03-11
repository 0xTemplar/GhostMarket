import {
  readPeerEvidence,
  saveIntermediateEvidence,
} from '../storacha-client';
import { submitAttestation } from '../registry-client';
import type { OpenClawTool } from './types';

interface WriteEvidenceInput {
  source: string;
  claim: string;
  vote: boolean;
  reasoning: string;
}

interface AttestInput {
  vote: boolean;
  storachaCid: string;
}

export const writeEvidenceTool: OpenClawTool<WriteEvidenceInput, string> = {
  name: 'storacha.write_evidence',
  description: 'Persist intermediate evidence for an agent to Storacha',
  execute: async (input, ctx) => {
    return saveIntermediateEvidence(ctx.agentId, ctx.marketId, {
      source: input.source,
      timestamp: new Date().toISOString(),
      claim: input.claim,
      vote: input.vote,
      dataHash: `openclaw-${ctx.agentId}-${Date.now()}`,
      reasoning: input.reasoning,
    });
  },
};

export const readPeerEvidenceTool: OpenClawTool<{ cid: string }, object | null> = {
  name: 'storacha.read_peer_evidence',
  description: 'Read another agent evidence blob by CID from Storacha',
  execute: async (input) => {
    return readPeerEvidence(input.cid);
  },
};

export const submitAttestationTool: OpenClawTool<AttestInput, string> = {
  name: 'registry.submit_attestation',
  description: 'Submit agent attestation to OracleAgentRegistry',
  execute: async (input, ctx) => {
    return submitAttestation(ctx.agentId, ctx.marketId, input.vote, input.storachaCid);
  },
};

export const OPENCLAW_TOOLS = [
  writeEvidenceTool,
  readPeerEvidenceTool,
  submitAttestationTool,
];
