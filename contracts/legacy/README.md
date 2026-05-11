# Legacy (not compiled, not supported)

## `archived-v1/GhostVault.sol`

Plaintext **GhostVault v1** (ERC-20 collateral, `EIP712("GhostVault", "1")`). It is **removed from the Hardhat source set** and kept here only for historical reference.

**Do not** wire this contract into `deploy-sepolia.ts`, the web app, or the oracle. Production flow is **GhostVaultV2** + Zama **cUSDCMock** on Sepolia (see `scripts/deploy-sepolia.ts`).

The former Hardhat test `test/GhostVault.test.ts` targeted an even older ETH-based design and has been deleted.
