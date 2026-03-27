// setup-handler.cdc
//
// One-time setup transaction. Run this once after deploying
// GhostVaultResolverHandler.cdc to the oracle Cadence account.
//
// What it does:
//   1. Creates a COA (Cadence-Owned Account) at /storage/evm if not present.
//      This COA gets its own Flow EVM address. Print it and call
//      GhostVault.transferOwnership(<coa-evm-address>) from the current owner.
//   2. Creates a FlowTransactionSchedulerUtils.Manager for the account.
//   3. Creates a GhostVaultResolverHandler.Handler resource and issues the
//      entitled capability the scheduler needs to call executeTransaction().
//
// After running this script:
//   - Run `flow scripts execute scripts/get-coa-address.cdc` to get the COA
//     EVM address, then call GhostVault.transferOwnership(coaAddress).
//   - The oracle service can now call POST /schedule to schedule deliveries.

import "FlowTransactionScheduler"
import "FlowTransactionSchedulerUtils"
import "GhostVaultResolverHandler"
import "EVM"

transaction {

    prepare(account: auth(
        BorrowValue,
        SaveValue,
        IssueStorageCapabilityController,
        PublishCapability,
        GetStorageCapabilityController
    ) &Account) {

        // ── 1. Create COA ─────────────────────────────────────────────────────
        if !account.storage.check<@EVM.CadenceOwnedAccount>(from: /storage/evm) {
            let coa <- EVM.createCadenceOwnedAccount()
            account.storage.save(<-coa, to: /storage/evm)
            let coaCap = account.capabilities.storage
                .issue<&EVM.CadenceOwnedAccount>(/storage/evm)
            account.capabilities.publish(coaCap, at: /public/evm)
            log("COA created. Run get-coa-address.cdc to find its EVM address.")
        } else {
            log("COA already exists — skipping creation.")
        }

        // ── 2. Create scheduler manager ───────────────────────────────────────
        if !account.storage.check<@{FlowTransactionSchedulerUtils.Manager}>(
            from: FlowTransactionSchedulerUtils.managerStoragePath
        ) {
            let manager <- FlowTransactionSchedulerUtils.createManager()
            account.storage.save(<-manager, to: FlowTransactionSchedulerUtils.managerStoragePath)
            let managerCap = account.capabilities.storage.issue<&{FlowTransactionSchedulerUtils.Manager}>(
                FlowTransactionSchedulerUtils.managerStoragePath
            )
            account.capabilities.publish(managerCap, at: FlowTransactionSchedulerUtils.managerPublicPath)
            log("Scheduler manager created.")
        } else {
            log("Scheduler manager already exists — skipping.")
        }

        // ── 3. Create handler resource ────────────────────────────────────────
        if !account.storage.check<@GhostVaultResolverHandler.Handler>(
            from: GhostVaultResolverHandler.HandlerStoragePath
        ) {
            // Issue an entitled COA capability scoped to EVM.Call.
            let coaCallCap = account.capabilities.storage
                .issue<auth(EVM.Call) &EVM.CadenceOwnedAccount>(/storage/evm)

            let handler <- GhostVaultResolverHandler.createHandler(coa: coaCallCap)
            account.storage.save(<-handler, to: GhostVaultResolverHandler.HandlerStoragePath)

            // Issue the entitled capability the scheduler calls executeTransaction() through.
            account.capabilities.storage.issue<
                auth(FlowTransactionScheduler.Execute) &{FlowTransactionScheduler.TransactionHandler}
            >(GhostVaultResolverHandler.HandlerStoragePath)

            log("Handler resource created and capability issued.")
        } else {
            log("Handler already exists — skipping.")
        }

        log("Setup complete. Next step: call GhostVault.transferOwnership(<coa-evm-address>).")
    }
}
