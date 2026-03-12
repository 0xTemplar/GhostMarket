const ORACLE_BASE_URL =
  process.env.ORACLE_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_ORACLE_URL ??
  'http://localhost:8080';

export async function proxyOracleRequest(
  oraclePath: string,
  init?: RequestInit,
): Promise<Response> {
  const upstream = await fetch(`${ORACLE_BASE_URL}${oraclePath}`, init);
  const body = await upstream.text();
  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  return new Response(body, {
    status: upstream.status,
    headers: { 'Content-Type': contentType },
  });
}

