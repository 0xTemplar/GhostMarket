# GhostMarket Cadence Adapter

Lightweight microservice that schedules `GhostVault.reportOutcome()` deliveries on Flow EVM via the Flow blockchain's native `FlowTransactionScheduler`. After oracle quorum, the adapter commits the delivery to-chain so it executes at market expiry — even if the oracle server is offline.

See [`docs/cadence-scheduler-options.md`](../docs/cadence-scheduler-options.md) for the full architecture discussion (Options A, B, C).

---

## How It Works (Option A)

```
Oracle quorum at T
      ↓
Oracle POST /schedule → { marketId, outcome }
      ↓
Adapter fetches market.expiryAt from GhostMarket (Flow EVM)
Adapter calls FlowTransactionScheduler.schedule(timestamp = expiryAt)
      ↓  (adapter can stop — delivery is committed on-chain)
At expiryAt → GhostVaultResolverHandler.executeTransaction() fires
      ↓
COA calls GhostVault.reportOutcome(marketId, outcome) on Flow EVM
```

The oracle's existing `vault-reporter.ts` (ethers.js) path still runs as a fallback.

---

## One-Time Setup

### 1. Generate a Cadence account with secp256k1

```bash
flow keys generate --sig-algo ECDSA_secp256k1
```

Fund the account at <https://testnet-faucet.onflow.org> and note the address.

### 2. Configure the adapter

```bash
cp .env.example .env
# fill in CADENCE_ACCOUNT_ADDRESS, CADENCE_PRIVATE_KEY
```

### 3. Add account to flow.json

```json
{
  "accounts": {
    "oracle-account": {
      "address": "<your-cadence-address>",
      "key": {
        "type": "hex",
        "index": 0,
        "signatureAlgorithm": "ECDSA_secp256k1",
        "hashAlgorithm": "SHA3_256",
        "privateKey": "<your-private-key>"
      }
    }
  }
}
```

### 4. Deploy the handler contract

```bash
flow project deploy --network testnet
```

Set `CADENCE_HANDLER_CONTRACT_ADDRESS` in `.env` to the deployed address.

### 5. Create the COA and handler resource

```bash
flow transactions send transactions/setup-handler.cdc \
  --signer oracle-account \
  --network testnet
```

### 6. Get the COA EVM address and transfer vault ownership

```bash
flow scripts execute scripts/get-coa-address.cdc \
  --args-json '[{"type":"Address","value":"<your-cadence-address>"}]' \
  --network testnet
```

Then call `GhostVault.transferOwnership(<coa-evm-address>)` from the current vault owner.

### 7. Run the adapter

```bash
npm install
npm run dev
```

---

## Oracle Integration

The oracle fires a fire-and-forget POST after quorum:

```typescript
// In oracle/src/index.ts post-quorum block
void fetch(`http://localhost:${CADENCE_ADAPTER_PORT}/schedule`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ marketId: session.marketId, outcome }),
}).then(async (r) => {
  const result = await r.json();
  addLog(session, `[CadenceScheduler] ${result.message}`);
}).catch(() => {
  addLog(session, '[CadenceScheduler] adapter not reachable — skipped');
});
```

Set `CADENCE_ADAPTER_PORT=8093` in the oracle's `.env`.

---

## Endpoints

| Method | Path       | Description                              |
|--------|------------|------------------------------------------|
| GET    | `/health`  | Liveness + configuration status          |
| POST   | `/schedule`| Schedule a vault delivery for a market   |

### POST /schedule

```json
// Request
{ "marketId": "1", "outcome": true }

// Response
{
  "status": "scheduled",
  "txId": "abc123...",
  "message": "Cadence delivery scheduled for market 1 at 2026-04-01T00:00:00.000Z (tx: abc123)"
}
```

Status values: `scheduled` | `skipped` (not configured) | `failed`

---

## Files

```
cadence/
  contracts/
    GhostVaultResolverHandler.cdc   Deploy once to oracle Cadence account
  transactions/
    setup-handler.cdc               One-time: create COA + handler resource
    schedule-delivery.cdc           Per-market: submitted by scheduler.ts
  src/
    signer.ts                       secp256k1 signing for Flow (uses ethers)
    scheduler.ts                    FCL setup + scheduleVaultDelivery()
    server.ts                       Express HTTP server (port 8093)
  scripts/
    setup.ts                        CLI: validate config, print COA address
  .env.example
  README.md
```
