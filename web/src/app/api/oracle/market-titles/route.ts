import { proxyOracleRequest } from '@/lib/server/oracle-proxy';

export async function GET() {
  return proxyOracleRequest('/oracle/market-titles');
}
