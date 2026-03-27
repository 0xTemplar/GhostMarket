// schedule-delivery.cdc
//
// Schedules a GhostVault.reportOutcome() delivery via the FlowTransactionScheduler.
// Called by the cadence adapter service (src/scheduler.ts) after oracle quorum.
//
// Prerequisites: setup-handler.cdc must have been run for this account.
//
// Parameters:
//   timestamp      — market expiryAt as UFix64 Unix seconds ("1743734400.00000000")
//   feeAmount      — FLOW to pay for scheduling fees ("0.01000000")
//   marketIdHex    — bytes32 market ID as hex, no 0x prefix (64 chars)
//   outcome        — true = YES won, false = NO won
//   ghostVaultHex  — GhostVault EVM address, no 0x prefix (40 chars)

import "FlowTransactionScheduler"
import "FlowTransactionSchedulerUtils"
import "GhostVaultResolverHandler"
import "FlowToken"
import "FungibleToken"

transaction(
    timestamp:     UFix64,
    feeAmount:     UFix64,
    marketIdHex:   String,
    outcome:       Bool,
    ghostVaultHex: String
) {

    prepare(account: auth(
        BorrowValue,
        GetStorageCapabilityController
    ) &Account) {

        // ── Retrieve the entitled handler capability ───────────────────────────
        var handlerCap: Capability<
            auth(FlowTransactionScheduler.Execute) &{FlowTransactionScheduler.TransactionHandler}
        >? = nil

        for controller in account.capabilities.storage
            .getControllers(forPath: GhostVaultResolverHandler.HandlerStoragePath) {
            if let cap = controller.capability as? Capability<
                auth(FlowTransactionScheduler.Execute) &{FlowTransactionScheduler.TransactionHandler}
            > {
                handlerCap = cap
                break
            }
        }

        let cap = handlerCap
            ?? panic("Handler capability not found. Run setup-handler.cdc first.")

        // ── Withdraw scheduling fees ──────────────────────────────────────────
        let vault = account.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("Could not borrow FlowToken vault")

        let fees <- vault.withdraw(amount: feeAmount) as! @FlowToken.Vault

        // ── Borrow manager ────────────────────────────────────────────────────
        let manager = account.storage.borrow<
            auth(FlowTransactionSchedulerUtils.Owner) &{FlowTransactionSchedulerUtils.Manager}
        >(from: FlowTransactionSchedulerUtils.managerStoragePath)
            ?? panic("Scheduler manager not found. Run setup-handler.cdc first.")

        // ── Build payload and schedule ────────────────────────────────────────
        let payload = GhostVaultResolverHandler.DeliveryPayload(
            marketIdHex:   marketIdHex,
            outcome:       outcome,
            ghostVaultHex: ghostVaultHex
        )

        manager.schedule(
            handlerCap:      cap,
            data:            payload,
            timestamp:       timestamp,
            priority:        FlowTransactionScheduler.Priority.Medium,
            executionEffort: 500,
            fees:            <-fees
        )
    }
}
