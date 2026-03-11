export interface OpenClawToolContext {
  agentId: number;
  marketId: string;
}

export interface OpenClawTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  execute: (input: Input, ctx: OpenClawToolContext) => Promise<Output>;
}

export interface OpenClawAgentSpec {
  id: number;
  name: string;
  role: string;
  source: string;
  systemPrompt: string;
  tools: string[];
}

export interface OpenClawRoundResult {
  marketId: string;
  agentId: number;
  vote: boolean;
  storachaCid: string;
  attestationTx: string | null;
}
