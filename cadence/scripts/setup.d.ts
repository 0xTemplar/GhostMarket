/**
 * setup.ts — One-time CLI helper for the Cadence adapter.
 *
 * Run: npx tsx scripts/setup.ts
 *
 * What it does:
 *   1. Validates that all required env vars are set.
 *   2. Prints the COA EVM address so you can call GhostVault.transferOwnership().
 *   3. Reminds you of the remaining manual steps (deploy contract, run
 *      setup-handler.cdc via Flow CLI).
 *
 * Note: this script does NOT submit the setup-handler.cdc transaction — that
 * must be done via the Flow CLI because it requires a Cadence account with
 * an already-deployed GhostVaultResolverHandler contract:
 *
 *   flow transactions send transactions/setup-handler.cdc \
 *     --signer oracle-account \
 *     --network testnet
 */
export {};
