/**
 * set-outcome-reporter.ts
 *
 * Calls GhostVault.setOutcomeReporter(coaEvmAddress) from the current owner.
 * This grants the Cadence COA the right to call reportOutcome() alongside
 * the existing oracle private-key path — no ownership transfer, no disruption.
 *
 * Both paths work simultaneously:
 *   - vault-reporter.ts (VAULT_OWNER_PRIVATE_KEY)  ← existing, unchanged
 *   - Cadence COA via FlowTransactionScheduler     ← new, autonomous
 *
 * Usage: npx tsx scripts/set-outcome-reporter.ts
 */
export {};
