declare module '@onflow/fcl' {
  export function config(opts: Record<string, string>): void;
  export function mutate(opts: {
    cadence: string;
    args: (arg: typeof import('@onflow/fcl').arg, types: typeof import('@onflow/types')) => unknown[];
    proposer: unknown;
    payer: unknown;
    authorizations: unknown[];
    limit: number;
  }): Promise<string>;
  export function arg(value: unknown, type: unknown): unknown;
}
