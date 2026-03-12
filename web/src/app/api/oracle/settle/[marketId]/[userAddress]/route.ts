import { proxyOracleRequest } from '@/lib/server/oracle-proxy';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ marketId: string; userAddress: string }> },
) {
  const { marketId, userAddress } = await ctx.params;
  return proxyOracleRequest(`/oracle/settle/${marketId}/${userAddress}`);
}

