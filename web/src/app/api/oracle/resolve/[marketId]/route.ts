import { proxyOracleRequest } from '@/lib/server/oracle-proxy';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ marketId: string }> },
) {
  const { marketId } = await ctx.params;
  const body = await req.text();
  return proxyOracleRequest(`/oracle/resolve/${marketId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

