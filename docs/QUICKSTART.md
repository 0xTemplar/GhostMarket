# GhostMarket — Quickstart Guide

End-to-end setup for the full GhostMarket stack: smart contracts, oracle service, and Cadence scheduling adapter on Flow EVM Testnet.

---

## System Overview

```
┌─────────────┐    POST /oracle/resolve    ┌──────────────────────┐
│  Web / API  │ ─────────────────────────► │   Oracle Service      │
└─────────────┘                            │   (oracle/ · :8092)   │
                                           │                       │
                                           │  7 AI agents vote     │
                                           │  5/7 quorum required  │
                                           └──────────┬────────────┘
                                                      │
                               ┌──────────────────────┼─────────────────────┐
                               │ Path A (immediate)   │ Path B (scheduled)  │
                               ▼                      ▼                     │
                    vault-reporter.ts       Cadence Adapter                 │
                    (ethers.js direct)      (cadence/ · :8093)              │
                               │                      │                     │
                               │            FlowTransactionScheduler        │
                               │            schedules at market expiry      │
                               │                      │                     │
                               └──────────────────────┘                     │
                                          │                                 │
                                          ▼                                 │
                               GhostVault.reportOutcome()                   │
                               (Flow EVM · Solidity)                        │
```

Both paths run in parallel. If the Cadence adapter is disabled or unreachable, the oracle falls back to Path A silently.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |
| Flow CLI | ≥ 2.x | `brew install flow-cli` |
| Hardhat / ts-node | bundled | via npm |
| `cast` (Foundry) | optional | `brew install foundry` |

---

## Part 1 — Smart Contracts

### 1.1 Install dependencies

```bash
cd contracts
npm install
```

### 1.2 Configure

```bash
cp .env.example .env
```

Required values in `contracts/.env`:

| Variable | Description |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | EVM private key with testnet FLOW |
| `SETTLEMENT_SIGNER_ADDRESS` | Address allowed to sign settlements (can be same as deployer) |

### 1.3 Compile

```bash
cd contracts
npx hardhat compile
```

### 1.4 Deploy GhostVault

```bash
npx ts-node scripts/deploy-vault-flow.ts
```

Output includes the deployed address. Note it — you need it in the next parts.

```
✅ GhostVault deployed to: 0xa93F1B9054247D05D8cc80594801517cB6375991
NEXT_PUBLIC_GHOST_VAULT_ADDRESS=0xa93F1B9054247D05D8cc80594801517cB6375991
GHOST_VAULT_ADDRESS=0xa93F1B9054247D05D8cc80594801517cB6375991
```

> `GhostVault` includes an `outcomeReporter` role so both the oracle wallet and the Cadence COA can call `reportOutcome()` without either blocking the other.

---

## Part 2 — Oracle Service

### 2.1 Install dependencies

```bash
cd oracle
npm install
```

### 2.2 Configure

```bash
cp .env.example .env
```

Key variables in `oracle/.env`:

| Variable | Description |
|---|---|
| `PORT` | HTTP port (default `8092`) |
| `OPENAI_API_KEY` | GPT-4o-mini for AI agent reasoning |
| `FLOW_RPC_URL` | `https://testnet.evm.nodes.onflow.org` |
| `GHOST_VAULT_ADDRESS` | Deployed GhostVault address |
| `GHOST_MARKET_ADDRESS` | Deployed GhostMarket address |
| `VAULT_OWNER_PRIVATE_KEY` | EVM key that owns GhostVault |
| `SETTLEMENT_SIGNER_PRIVATE_KEY` | EVM key for EIP-712 settlement signatures |
| `ORACLE_REDIS_URL` | Redis connection string |
| `STORACHA_PRINCIPAL_KEY` | Storacha / w3up key for evidence storage |
| `STORACHA_PROOF` | Storacha delegation proof |
| `CADENCE_ADAPTER_ENABLED` | `false` initially; set `true` after Part 3 |
| `CADENCE_ADAPTER_PORT` | `8093` (must match cadence adapter) |

### 2.3 Register oracle agents (first run only)

```bash
npm run register
```

### 2.4 Start

```bash
npm run dev       # development (tsx watch)
npm run build && npm start   # production
```

### 2.5 Trigger a resolution

```bash
curl -X POST http://localhost:8092/oracle/resolve/18
```

Watch resolution progress:

```bash
curl http://localhost:8092/oracle/status/18
```

Or connect via WebSocket at `ws://localhost:8092/oracle/ws/18` for real-time events.

---

## Part 3 — Cadence Scheduling Adapter

This is optional but recommended. It commits the outcome delivery on-chain at oracle quorum time so the vault settles at market expiry — even if the oracle server goes offline.

### 3.1 Generate a Flow account

```bash
cd cadence
flow keys generate --sig-algo ECDSA_secp256k1
```

Fund the new account at [testnet-faucet.onflow.org](https://testnet-faucet.onflow.org). You need at least **1 FLOW** to cover deployment + scheduling fees (~0.11 FLOW per scheduled market).

### 3.2 Configure

```bash
cp .env.example .env
```

Key variables in `cadence/.env`:

| Variable | Description |
|---|---|
| `CADENCE_ACCOUNT_ADDRESS` | Your new Flow account address |
| `CADENCE_PRIVATE_KEY` | secp256k1 private key (no `0x`) |
| `GHOST_VAULT_ADDRESS` | Same as oracle — deployed GhostVault |
| `GHOST_MARKET_ADDRESS` | Deployed GhostMarket address |
| `CADENCE_SCHEDULER_FEE_FLOW` | Fee per scheduled market (`0.11` minimum) |

### 3.3 Configure flow.json

```bash
cp flow.json.example flow.json
```

Fill in `<YOUR_FLOW_ACCOUNT_ADDRESS>` and `<YOUR_FLOW_PRIVATE_KEY>` in `flow.json`.

> `flow.json` is gitignored — your private key stays local only.

### 3.4 Install dependencies

```bash
npm install
```

### 3.5 Validate setup

```bash
npm run setup
```

This validates your env vars and prints the COA EVM address that will be authorized on GhostVault.

### 3.6 Deploy the handler contract (once)

```bash
flow project deploy --network testnet
```

Copy the deployed contract address into `cadence/.env` as `CADENCE_HANDLER_CONTRACT_ADDRESS`.

### 3.7 Create COA + scheduler resources (once)

```bash
flow transactions send transactions/setup-handler.cdc \
  --network testnet \
  --signer oracle-account
```

This stores the `Manager` and `Handler` resources the scheduler needs inside your Flow account.

### 3.8 Grant the COA reporter rights on GhostVault (once)

```bash
npx tsx scripts/set-outcome-reporter.ts
```

This calls `GhostVault.setOutcomeReporter(coaEvmAddress)` from the vault owner. After this both the oracle's ethers path and the Cadence COA can call `reportOutcome()`.

### 3.9 Build and start

```bash
npm run build
npm start

# or during development:
npm run dev
```

Server starts on `http://localhost:8093`.

```
=== GhostMarket Cadence Adapter ===
HTTP  : http://localhost:8093/health
POST  : http://localhost:8093/schedule
Configured: true
Adapter ready.
```

### 3.10 Enable in the oracle

```bash
# oracle/.env
CADENCE_ADAPTER_ENABLED=true
```

Restart the oracle. From now on, after every quorum the oracle fires `POST /schedule` to the adapter, which schedules on-chain delivery at market expiry.

---

## Part 4 — Frontend & API

### Frontend (Next.js)

```bash
cd web
npm install
cp .env.local.example .env.local
# set NEXT_PUBLIC_GHOST_VAULT_ADDRESS and other vars
npm run dev
```

### API (Python / FastAPI)

```bash
cd api
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --port 8000
```

---

## Redeployment

If you change `GhostVault.sol`, redeploy and update addresses everywhere:

```bash
# 1. Redeploy
cd contracts
npx ts-node scripts/deploy-vault-flow.ts

# 2. Update vault address in all three env files:
#    oracle/.env          → GHOST_VAULT_ADDRESS
#    cadence/.env         → GHOST_VAULT_ADDRESS
#    web/.env.local       → NEXT_PUBLIC_GHOST_VAULT_ADDRESS

# 3. Re-grant reporter rights (COA changes on each deploy)
cd cadence
npx tsx scripts/set-outcome-reporter.ts
```

---

## Testing the Cadence Adapter

With the server running:

```bash
# Health check
curl http://localhost:8093/health

# Schedule a delivery for market 18 (outcome = YES)
curl -X POST http://localhost:8093/schedule \
  -H "Content-Type: application/json" \
  -d '{"marketId": "18", "outcome": true}'
```

Expected response:

```json
{
  "status": "scheduled",
  "txId": "f239272afb47...",
  "message": "Cadence delivery scheduled for market 18 at 2026-07-01T00:43:53.000Z (tx: f239272a...)"
}
```

Verify on [testnet.flowscan.io](https://testnet.flowscan.io) using the returned `txId`.

---

## Deployed Addresses (Testnet)

| Contract | Address |
|---|---|
| `GhostVault` | `0xa93F1B9054247D05D8cc80594801517cB6375991` |
| `GhostMarket` | `0x7D26f77c698C9277b9eBaB47E3b73CF08853d76a` |
| `GhostEAMM` | `0x7508D1e77A700EEf9d9b7cEc2Bf8d48c2F177F46` |
| `GhostVaultResolverHandler` (Cadence) | `0x59403984ca469d1c` |
| `FlowTransactionScheduler` (Cadence) | `0x8c5303eaa26202d6` |
| COA EVM address | `0x0000000000000000000000026fededbe9c416779` |

---

## Architecture Reference

- [`docs/cadence-scheduler-options.md`](./cadence-scheduler-options.md) — full comparison of Options A / B / C for Cadence integration
- [`cadence/README.md`](../cadence/README.md) — Cadence adapter API reference
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — full system architecture
