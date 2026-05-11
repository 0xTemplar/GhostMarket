function envTruthy(v: string | undefined): boolean {
  if (v == null || v === '') return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * When true, `/oracle` is not served (404) and Oracle Room links are hidden.
 *
 * Set **`NEXT_PUBLIC_ORACLE_ROOM_DISABLED=true`** so server + client both respect it.
 *
 * Legacy (server-only, hides page but not nav unless you also set the public flag):
 * `ORACLE_ROOM_LOCKED=true` or `ORACLE_ROOM_DISABLED=true`.
 */
export function isOracleRoomPubliclyDisabled(): boolean {
  if (envTruthy(process.env.NEXT_PUBLIC_ORACLE_ROOM_DISABLED)) return true;
  if (envTruthy(process.env.ORACLE_ROOM_LOCKED)) return true;
  if (envTruthy(process.env.ORACLE_ROOM_DISABLED)) return true;
  return false;
}
