import { proxyOracleRequest } from '@/lib/server/oracle-proxy';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ marketId: string }> },
) {
  const { marketId } = await ctx.params;
  return proxyOracleRequest(`/oracle/status/${marketId}`);
}

