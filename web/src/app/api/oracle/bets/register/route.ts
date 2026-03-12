import { proxyOracleRequest } from '@/lib/server/oracle-proxy';

export async function POST(req: Request) {
  const body = await req.text();
  return proxyOracleRequest('/oracle/bets/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

