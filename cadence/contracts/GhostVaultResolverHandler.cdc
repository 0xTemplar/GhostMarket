// SPDX-License-Identifier: MIT
//
// GhostVaultResolverHandler.cdc
//
// A Cadence TransactionHandler that the FlowTransactionScheduler calls at market
// expiry to deliver oracle outcomes to GhostVault on Flow EVM.
//
// Deploy once to the oracle Cadence account on Flow Testnet.
// After deploying, run transactions/setup-handler.cdc to create the COA and
// handler resource in account storage.
//
// References:
//   FlowTransactionScheduler:  0x8c5303eaa26202d6 (testnet)
//   EVM COA docs:              https://developers.flow.com/blockchain-development-tutorials/cross-vm-apps/interacting-with-coa

import "FlowTransactionScheduler"
import "EVM"

access(all) contract GhostVaultResolverHandler {

    access(all) let HandlerStoragePath: StoragePath
    access(all) let HandlerPublicPath:  PublicPath

    // ── Payload ───────────────────────────────────────────────────────────────

    /// Passed to executeTransaction() via the scheduler's optional data field.
    access(all) struct DeliveryPayload {
        /// Hex-encoded bytes32 market ID — 64 chars, no 0x prefix.
        /// Derived from the GhostEAMM uint256 marketId via zeroPadValue.
        access(all) let marketIdHex: String

        /// Oracle-determined outcome: true = YES won, false = NO won.
        access(all) let outcome: Bool

        /// GhostVault EVM address — 40 chars, no 0x prefix.
        access(all) let ghostVaultHex: String

        init(marketIdHex: String, outcome: Bool, ghostVaultHex: String) {
            self.marketIdHex   = marketIdHex
            self.outcome       = outcome
            self.ghostVaultHex = ghostVaultHex
        }
    }

    // ── Handler resource ──────────────────────────────────────────────────────

    access(all) resource Handler: FlowTransactionScheduler.TransactionHandler {

        /// COA that owns GhostVault on Flow EVM.
        /// Must be the address returned by transferOwnership() on GhostVault.
        access(self) let coa: Capability<auth(EVM.Call) &EVM.CadenceOwnedAccount>

        init(coa: Capability<auth(EVM.Call) &EVM.CadenceOwnedAccount>) {
            self.coa = coa
        }

        /// Called by the FlowTransactionScheduler when the market's expiryAt
        /// timestamp is reached. Calls GhostVault.reportOutcome(bytes32,bool)
        /// on Flow EVM via the oracle account's COA.
        access(FlowTransactionScheduler.Execute)
        fun executeTransaction(id: UInt64, data: AnyStruct?) {
            let payload = data as! GhostVaultResolverHandler.DeliveryPayload

            // bytes32 is encoded as [UInt8] of length 32 in Cadence ABI encoding.
            let marketIdBytes: [UInt8] = payload.marketIdHex.decodeHex()

            let calldata = EVM.encodeABIWithSignature(
                "reportOutcome(bytes32,bool)",
                [marketIdBytes, payload.outcome]
            )

            let coaRef = self.coa.borrow()
                ?? panic("GhostVaultResolverHandler: COA capability unavailable")

            let result = coaRef.call(
                to:       EVM.addressFromString(payload.ghostVaultHex),
                data:     calldata,
                gasLimit: 100_000,
                value:    EVM.Balance(attoflow: UInt(0))
            )

            // A failing EVM call does NOT automatically revert the Cadence tx —
            // assert here so the scheduled execution fails loudly on-chain.
            assert(
                result.status == EVM.Status.successful,
                message: "GhostVaultResolverHandler: GhostVault.reportOutcome() reverted — "
                    .concat("errorCode=").concat(result.errorCode.toString())
                    .concat(" errorMessage=").concat(result.errorMessage)
            )
        }

        // Required by TransactionHandler interface.
        access(all) view fun getViews(): [Type]          { return [] }
        access(all) fun resolveView(_ view: Type): AnyStruct? { return nil }
    }

    // ── Factory ───────────────────────────────────────────────────────────────

    access(all) fun createHandler(
        coa: Capability<auth(EVM.Call) &EVM.CadenceOwnedAccount>
    ): @Handler {
        return <- create Handler(coa: coa)
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    init() {
        self.HandlerStoragePath = /storage/ghostVaultResolverHandler
        self.HandlerPublicPath  = /public/ghostVaultResolverHandler
    }
}
