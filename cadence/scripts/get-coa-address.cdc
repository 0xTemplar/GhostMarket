// get-coa-address.cdc
// Returns the EVM address of the COA stored at /storage/evm for the given account.
// Run after setup-handler.cdc.
//
// Usage:
//   flow scripts execute scripts/get-coa-address.cdc \
//     --args-json '[{"type":"Address","value":"<your-cadence-address>"}]' \
//     --network testnet

import EVM from 0x8c5303eaa26202d6

access(all)
fun main(addr: Address): String {
    let account = getAuthAccount<auth(Storage) &Account>(addr)

    let coa = account.storage.borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm)
        ?? panic("COA not found at /storage/evm — run setup-handler.cdc first")

    // Returns hex without 0x prefix — prepend 0x before calling transferOwnership()
    return coa.address().toString()
}
