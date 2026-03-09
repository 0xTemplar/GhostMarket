# GhostMarket Contracts

Solidity contracts deployed on **Flow EVM** (chain ID 545 testnet / 747 mainnet).

## Setup

```bash
cd contracts
npm install
cp .env.example .env
# fill in DEPLOYER_PRIVATE_KEY and SETTLEMENT_SIGNER_ADDRESS
```

Get test FLOW: https://faucet.flow.com → request to your EVM address.

## Compile

```bash
npx hardhat compile
```

## Test (local Hardhat network)

```bash
npx hardhat test
```

## Deploy to Flow EVM Testnet

```bash
npx hardhat run scripts/deploy.ts --network flowTestnet
```

Copy the printed `NEXT_PUBLIC_GHOST_VAULT_ADDRESS` into `web/.env.local` and `GHOST_VAULT_ADDRESS` into `api/.env`.

## Contract: GhostVault

| Function | Who calls | Phase |
|---|---|---|
| `deposit()` | User (pays tiny gas) | 2 |
| `depositFor(user)` | Backend relayer (gasless) | 2 |
| `withdraw(amount)` | User | 2 |
| `claimPayout(marketId, amount, nonce, expiry, sig)` | User after oracle resolution | 6 |
| `setSettlementSigner(addr)` | Owner | 6 |
