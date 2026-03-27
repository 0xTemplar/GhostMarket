# Cadence Scheduling Adapter — Architecture Options

> **Status:** Option A implemented. Options B and C are documented for future phases.
>
> **References:**
> - [Flow Scheduled Transactions](https://developers.flow.com/build/cadence/advanced-concepts/scheduled-transactions) — `FlowTransactionScheduler` contract, live on Testnet at `0x8c5303eaa26202d6`
> - [Interacting with COAs from Cadence](https://developers.flow.com/blockchain-development-tutorials/cross-vm-apps/interacting-with-coa) — `EVM.encodeABIWithSignature`, `coa.call()`
> - Confirmed by Flow team: scheduled transactions via Cadence can trigger Flow EVM contract calls

---

## Mental Model

The oracle and the Cadence scheduler solve completely different problems. They are complementary, not competing.

| | Oracle | Cadence Scheduler |
|---|---|---|
| **Job** | Determine truth from the real world | Execute a pre-approved action at a specific time |
| **Has opinions** | Yes — AI agents reason, vote, reach quorum | No — it is a clock with a payload |
| **Can fetch data** | Yes — scrapes news, sports APIs, external sources | No |
| **Needs trust** | Yes — 5/7 quorum, ERC-8004 reputation, Filecoin evidence | No — execution is protocol-level |
| **Can replace the oracle** | — | No |

Clean separation across three layers:
```
Oracle service       = determines WHAT happened
Lit Protocol         = signs WHO gets paid (policy enforcement)
Cadence Scheduler    = enforces WHEN settlement executes
```

---

## Option A — Cadence as Delivery (Implemented)

### What it does

After oracle quorum is reached and the outcome is determined, the oracle schedules a Cadence transaction via `FlowTransactionScheduler` to call `GhostVault.reportOutcome()` on Flow EVM at `market.expiryAt`. The scheduling call is fire-and-forget — even if the oracle server shuts down after quorum, the delivery is committed to the Flow blockchain and will execute autonomously.

### Flow

```
Oracle quorum at T
        ↓
Oracle calls FlowTransactionScheduler.schedule(
    timestamp = market.expiryAt,
    data      = { marketIdHex, outcome, ghostVaultHex }
)
        ↓  (oracle can shut down — delivery is committed on-chain)
At market.expiryAt → GhostVaultResolverHandler.executeTransaction() fires
        ↓
COA calls GhostVault.reportOutcome(marketId, outcome) on Flow EVM
```

The existing `reportOutcomeToVault()` path via ethers.js still runs as a fallback. The Cadence path is additive — if `CADENCE_SCHEDULER_ENABLED=true` and the required env vars are set, both run. If not configured, the system falls back to the existing immediate ethers delivery.

### Setup required (one-time)

1. Create a Flow Cadence account with secp256k1 key and fund it with FLOW for fees.
2. Deploy `oracle/cadence/GhostVaultResolverHandler.cdc` to that account.
3. Run `oracle/cadence/setup-handler.cdc` to create the COA and handler resource.
4. Call `GhostVault.transferOwnership()` to point ownership at the COA's EVM address.
5. Set env vars: `CADENCE_ACCOUNT_ADDRESS`, `CADENCE_PRIVATE_KEY`, `CADENCE_SCHEDULER_FEE_FLOW`.

### What you gain

- Oracle's private key no longer needs permanent VAULT_OWNER authority. Once a delivery is scheduled it is committed to chain, no server required.
- Idempotent — the handler checks `isResolved` before calling `reportOutcome`, so double-scheduling is safe.
- Runs alongside the existing ethers path; zero breaking changes.

### Files

- `oracle/cadence/GhostVaultResolverHandler.cdc` — Cadence contract, deploy once
- `oracle/cadence/setup-handler.cdc` — one-time setup transaction
- `oracle/cadence/schedule-delivery.cdc` — scheduling transaction (called by oracle post-quorum)
- `oracle/src/cadence-scheduler.ts` — Node.js module that calls the above via FCL

---

## Option B — Cadence as Dispute Window

### What it does

After oracle quorum, the outcome is written to a Cadence approval contract but **not delivered immediately**. A Cadence transaction is scheduled to execute the delivery at `T + disputeWindow` (e.g., 24 hours). During this window, anyone can inspect the pending outcome. If a dispute is filed against a dispute contract, the scheduled Cadence tx is cancelled (with 50% fee refund). If no dispute is filed, Cadence fires delivery autonomously.

### Flow

```
Oracle quorum at T
        ↓
Outcome written to CadenceApprovalStore contract (publicly readable)
Cadence schedules delivery at T + 24h
        ↓
During T → T+24h:
    Anyone can inspect the pending outcome
    Dispute contract accepts challenges (staked FLOW as collateral)
        ↓
Dispute filed?  →  Scheduled Cadence tx cancelled (50% fee refund)
                   Oracle re-runs with escalation flag
No dispute?     →  At T+24h Cadence fires delivery autonomously
```

### Why this matters

This pattern (Optimistic Oracle style) turns the trust model from:
> "Trust us, 5/7 agents agreed"

into:
> "5/7 agents agreed, the outcome was publicly visible for 24 hours before any funds moved, and anyone with collateral could have challenged it"

This is a significantly stronger security and trust story, particularly for large-stake markets.

### New contracts needed

- `CadenceApprovalStore.cdc` — stores pending oracle outcomes, publicly readable
- `DisputeRegistry.cdc` — accepts disputes with staked collateral, can trigger cancellation
- Update `GhostVaultResolverHandler.cdc` to check `DisputeRegistry` before executing

### Status

Not yet implemented. Depends on Option A being stable first. Recommend for Phase 2.

---

## Option C — Cadence as Full Lifecycle Clock

### What it does

When a new market is created, multiple Cadence transactions are scheduled at creation time to manage the full market lifecycle without any external triggers:

```
Market created at T₀ (expiryAt = T₂)

T₁ = betting close   →  Cadence fires "lock bets" on GhostVault (no new lockForBet)
T₂ = expiry          →  Cadence emits MarketReadyForResolution event
                         Oracle listens → starts resolution pipeline
T₂ + 24h             →  Cadence fires settlement delivery (after oracle resolves)
T₂ + 72h             →  Cadence fires emergency unlock if market never resolved
```

### What changes

- The oracle no longer needs to be manually triggered via `POST /oracle/resolve/:marketId` — it listens for Flow events.
- Market betting windows are enforced on-chain by Cadence, not by application logic.
- Settlement has a mandatory delay (dispute window baked in).
- Emergency unlock is a safety net that requires zero human intervention if oracle fails.

### Why this is powerful

No cron jobs anywhere. No "is the oracle server up?" anxiety. The entire market lifecycle — betting window, oracle trigger, settlement, safety net — is committed to the blockchain at market creation time and executes autonomously. Everything is auditable and predictable before it happens.

### Complexity

High. Requires:
- Multiple new Cadence contracts
- Flow event listener in oracle
- Market creation flow changes (on-chain scheduling at creation time)
- FLOW token budget at market creation time for all scheduled tx fees

### Status

Not yet implemented. Recommend as the north-star architecture for Phase 3+. Option A and B are the path to get here incrementally.
