/**
 * Sepolia EOA used for GhostEAMM txs, sealed-window settlement, and EIP-712 vault claims.
 * Matches `GhostVaultV2.settlementSigner` and must be able to call EAMM as owner/resolver.
 */

export function getSepoliaOraclePrivateKey(): string {
  return (
    process.env.ORACLE_PRIVATE_KEY?.trim() ||
    process.env.SEPOLIA_PRIVATE_KEY?.trim() ||
    process.env.SETTLEMENT_SIGNER_PRIVATE_KEY?.trim() ||
    ''
  );
}

/**
 * After `GhostEAMM.settleSealedWindow`, pool handles are `FHE.allow(..., resolver)` —
 * userDecrypt must be signed by **that** resolver EOA, not necessarily the tx signer
 * (e.g. owner can settle but KMS still checks `resolver`).
 */
export function getEammResolverPrivateKey(): string {
  const explicit = process.env.EAMM_RESOLVER_PRIVATE_KEY?.trim();
  if (explicit) return explicit;
  return getSepoliaOraclePrivateKey();
}
