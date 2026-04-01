<div align="center">

#  GhostMarket

**Confidential Dark-Pool Prediction Markets**

[![Flow EVM](https://img.shields.io/badge/Flow_EVM-Testnet_545-00EF8B?style=flat-square&logo=flow)](https://evm-testnet.flowscan.io)
[![Zama fhevm](https://img.shields.io/badge/Zama-fhevm_Sepolia-412891?style=flat-square)](https://sepolia.etherscan.io)
[![Filecoin](https://img.shields.io/badge/Filecoin-Calibration_314159-0090FF?style=flat-square&logo=filecoin)](https://calibration.filfox.info)
[![Lit Protocol](https://img.shields.io/badge/Lit_Protocol-Naga_V1-F97316?style=flat-square)](https://developer.litprotocol.com)
[![Storacha](https://img.shields.io/badge/Storacha-w3s.link-8B5CF6?style=flat-square)](https://storacha.network)
[![Tests](https://img.shields.io/badge/Tests-101_passing-22C55E?style=flat-square)](#testing)
[![License](https://img.shields.io/badge/License-MIT-gray?style=flat-square)](LICENSE)

![Ghost-market-header](https://github.com/user-attachments/assets/60eec664-d53f-4ff1-8589-a7803037e691)

*Your position size is invisible to the market. The chain. The oracle. The block explorer. Front-runners.*

</div>

---

## Table of Contents

- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
  - [Dual-Chain Model](#dual-chain-model)
  - [Data Flow](#data-flow)
  - [Privacy Model](#privacy-model)
- [Tech Stack](#tech-stack)
  - [Flow — Consumer Layer](#flow--consumer-layer)
  - [Zama — eAMM Execution Engine](#zama--eamm-execution-engine)
    - [Compliance Model](#compliance-model--trader-private-not-authority-private)
  - [Lit Protocol — Cross-Chain Settlement](#lit-protocol--cross-chain-settlement)
  - [Filecoin — Verifiable Oracle Memory](#filecoin--verifiable-oracle-memory)
  - [Storacha — Persistent Agent State](#storacha--persistent-agent-state)
  - [ERC-8004 — Portable Agent Identity](#erc-8004--portable-agent-identity)
- [End-to-End User Journey](#end-to-end-user-journey)
- [Oracle Room](#oracle-room)
- [Contract Addresses](#contract-addresses)
  - [EVM Contracts](#evm-contracts)
  - [Cadence Contract — Flow Native](#cadence-contract--flow-native)
  - [Zama / FHE Infrastructure](#zama--fhe-infrastructure-sepolia)
- [Confirmed On-Chain Transactions](#confirmed-on-chain-transactions)
- [Running Locally](#running-locally)
- [Testing](#testing)
- [Acceptance Criteria](#acceptance-criteria)
- [Project Structure](#project-structure)

---

## The Problem

### 1. Market Transparency as a Bug

On public prediction markets, every trade is visible in real time. Large position sizes reveal institutional intent, invite front-running, and create systematic adverse selection against sophisticated traders. The public order book is not a feature — it is an attack surface.

### 2. Oracle Trust Gap

Single-provider oracles are censorable and manipulatable. There is no cryptographic guarantee that an oracle's reported outcome matches the evidence it claimed to use. A corrupt oracle can forge a result and there is no verifiable audit trail to prove otherwise.

### 3. Ephemeral Agent Memory

AI trading agents that operate across sessions lose critical context on restart. Stateless agents cannot execute long-horizon strategies reliably — a crash or failover means lost state, missed executions, and unrecoverable positions.

### 4. Web3 UX Friction

Seed phrases, gas tokens, and MetaMask prompts are adoption killers. Mainstream users will not self-custody if the onboarding experience requires a 12-word mnemonic before they can place a bet.

---

## The Solution

GhostMarket is a **dual-chain confidential prediction market** that solves all four problems simultaneously:

| Problem | Solution |
|---|---|
| Position size visibility | FHE-encrypted AMM — bet amounts are `euint64` ciphertext on-chain. No plaintext ever |
| Oracle manipulation | 7-agent swarm with Filecoin-anchored evidence bundles — every attestation has a verifiable Piece CID |
| Ephemeral agent memory | Storacha-backed checkpoints — agents resume from last state after any restart |
| Web3 UX friction | Privy walletless login on Flow — Google sign-in, no seed phrase, gas abstracted |

The core claim: **your bet amount is invisible to every other participant, every node operator, every block explorer, and us — while payout correctness is mathematically enforced on-chain.**

---

## How It Works

```
                     YOU (browser)
                          │
              ┌───────────┴───────────┐
              │                       │
    1. Login with Google         2. Deposit FLOW
    (Privy, no seed phrase)      into GhostVault
              │                       │
              └───────────┬───────────┘
                          │
              3. Encrypt bet in browser
              (@zama-fhe/relayer-sdk)
              Plaintext gone. Handle produced.
                          │
              4. Submit encrypted handle
              ─────────────────────────►  GhostEAMM (Zama / Sepolia)
                                          FHE coprocessor processes
                                          euint64 position stored
                                          No amount in calldata or events
                          │
              5. Oracle swarm resolves
              ─────────────────────────►  7 agents gather evidence
                                          Storacha: intermediate CIDs
                                          5-of-7 quorum reached
                                          Filecoin: final bundle (PieceCID)
                                          OracleAgentRegistry updated
                          │
              6. Lit Action bridges chains
              ─────────────────────────►  TEE reads Zama gateway
                                          Decrypts position, computes payout
                                          Signs settlement message
                                          Key never leaves enclave
                          │
              7. Claim payout (gasless)
              ◄─────────────────────────  GhostVault verifies Lit signature
                                          computeExpectedPayout() checks amount
                                          FLOW released to user
```

---

## Architecture

### Dual-Chain Model

GhostMarket uses two chains with one job each. They never speak to each other directly — a Lit Action bridges them through a signed attestation.

| Chain | Role | Contracts |
|---|---|---|
| **Flow EVM** (545) | Consumer layer — holds money, handles UX, pays out winners | `GhostVault.sol`, `GhostMarket.sol` |
| **Ethereum Sepolia / Zama** (11155111) | Execution layer — keeps bet amounts FHE-encrypted | `GhostEAMM.sol` |
| **Filecoin Calibration** (314159) | Oracle registry — anchors agent identity and evidence | `OracleAgentRegistry.sol` |

```
┌─────────────────────────────────┐     ┌──────────────────────────────────┐
│         FLOW EVM (545)          │     │    ZAMA / SEPOLIA (11155111)     │
│                                 │     │                                  │
│  GhostVault.sol                 │     │  GhostEAMM.sol                   │
│  · Holds FLOW tokens            │     │  · Holds encrypted euint64       │
│  · deposit() / withdraw()       │     │    position handles              │
│  · lockForBet()                 │     │  · placeBet(encAmount, proof)    │
│  · claimPayout(settlementMsg)   │     │  · resolveMarket()               │
│  · Verifies Lit PKP signature   │     │  · grantPositionAccess()         │
│  · computeExpectedPayout()      │     │                                  │
│  · Nonce replay protection      │     │  Zama FHE Coprocessor            │
│                                 │     │  · euint64 arithmetic            │
│  GhostMarket.sol                │     │  · FHE.gt / FHE.select           │
│  · Public market metadata       │     │  · FHE.add / FHE.allow           │
│  · YES/NO prices                │     │  · Re-encryption gateway         │
│  · LMSR-style market maker      │     │                                  │
└─────────────────────────────────┘     └──────────────────────────────────┘
                  ▲                                      │
                  │                                      │
                  └──────────── Lit Action ──────────────┘
                            (TEE — Naga Dev)
                     Reads Zama → Computes → Signs → Delivers

┌──────────────────────────────────────────────────────────────────┐
│              FILECOIN CALIBRATION (314159)                       │
│                                                                  │
│  OracleAgentRegistry.sol                                         │
│  · agentId → Piece CID mapping                                   │
│  · Stake, owner, active status                                   │
│  · 3-of-4 / 5-of-7 quorum finalization                          │
│  · Reputation CID chain per agent                                │
│                                                                  │
│  Synapse SDK storage (USDFC payments)                            │
│  · Agent metadata JSON → PieceCID                               │
│  · Evidence bundles → PieceCID (PDP-verified)                   │
│  · Reputation snapshots → PieceCID chain                        │
└──────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
USER BROWSER
    │
    ├─ 1. encrypt(5 FLOW) ──────────────────► ZAMA / SEPOLIA
    │                                              │
    │                                         GhostEAMM stores
    │                                         encrypted euint64 handle
    │                                              │
    │                                         Oracle resolves market
    │                                              │
    │                                         LIT ACTION (TEE)
    │                                         Reads Zama gateway ──► decrypt
    │                                         Verifies vault collateral
    │                                         Signs settlement message
    │                                              │
    └─ 5. receive payout ◄───────────────── FLOW EVM
                                            GhostVault verifies
                                            Lit PKP signature → releases
```

> **No token bridge. No wrapped assets. Only a signed message crosses chain boundaries.**

### Privacy Model

```
ON ZAMA (Ethereum Sepolia)
──────────────────────────────────────────────────────────────────────
WHAT IS PUBLIC               WHAT IS PRIVATE (FHE-encrypted)
────────────────             ────────────────────────────────
Market ID                    Bet amount (euint64)
User address                 YES pool total (euint64)
Side (YES / NO)              NO pool total (euint64)
Market status                Per-user position handle (euint64)
Market expiry                Pool depth — never decrypted to any
                             on-chain state

ON FLOW EVM (GhostVault)
──────────────────────────────────────────────────────────────────────
WHAT IS PUBLIC               WHAT IS PRIVATE
────────────────             ────────────────
User's own locked stake*     Pool depth aggregates (remain FHE-
Market ID of lock            encrypted in GhostEAMM)
Resolved binary outcome
computeExpectedPayout()

* Locked amount is visible in the user's own custody record only —
  not visible to other participants on Zama where front-running occurs.
  Pool-depth totals are NEVER written to GhostVault.
```

---

## Tech Stack

### Flow — Consumer Layer

Flow EVM is the consumer layer. It handles every part of the user experience: login, asset custody, and payout delivery. Users never need to know Zama exists.

**What Flow provides:**

- **Walletless onboarding** via Privy — email, passkey, or Google sign-in. No seed phrase, no MetaMask. An embedded EVM wallet is created silently on first login and becomes the user's identity across both chains.
- **FLOW vault custody** — `GhostVault.sol` holds all user balances. Users deposit and withdraw natively. FLOW never leaves Flow EVM.
- **Collateral locking** — `lockForBet()` commits stake before the encrypted bet is placed. The collateral cannot be withdrawn until settlement arrives. This closes the cross-chain solvency gap without a bridge.
- **On-chain payout verification** — `computeExpectedPayout()` enforces the correct amount on-chain. Even a compromised oracle cannot produce an accepted overpayment — `claimPayout()` reverts with `PayoutMismatch` if the signed amount differs.
- **Gasless claim path** — `depositFor(address user)` supports a trusted relayer depositing on behalf of users. The backend relayer endpoint is built; gasless activation requires one env var switch.
- **Scheduled market resolution** — `GhostVaultResolverHandler` on Flow's native Cadence scheduler fires `reportOutcome()` at each market's expiry timestamp. 29 scheduled deliveries are pre-committed and verifiable on Flowscan — resolution fires even if the oracle server is offline.

**Security model:**
```solidity
contract GhostVault is ReentrancyGuard, Pausable, Ownable2Step, EIP712
```
- `ReentrancyGuard` on all state-mutating functions (CEI pattern enforced)
- `Pausable` emergency stop
- `Ownable2Step` prevents accidental ownership loss
- Nonce replay protection — `usedNonces[user][marketId][nonce]`
- Expiry enforcement on settlement messages
- EIP-712 typed data with domain separator (chain-specific, vault-specific)

**Settlement message schema:**
```solidity
bytes32 public constant CLAIM_TYPEHASH = keccak256(
    "Claim(address user,bytes32 marketId,uint256 amount,uint256 nonce,uint256 expiry)"
);
```

**Relevant files:**
```
contracts/contracts/GhostVault.sol     — Collateral locking, EIP-712 settlement, payout verification
contracts/contracts/GhostMarket.sol    — LMSR prediction market registry on Flow EVM
web/src/lib/flow/vault.ts              — GhostVault read/write helpers
web/src/app/vault/page.tsx             — Vault page (balance, locked, free)
web/src/app/portfolio/page.tsx         — Portfolio (on-chain + shielded positions)
cadence/contracts/GhostVaultResolver.cdc — Cadence scheduling adapter
```

---

### Zama — eAMM Execution Engine

`GhostEAMM.sol` is the confidential execution layer. It is a binary prediction market AMM where every financial value — bet amounts, pool totals, per-user positions — is an encrypted `euint64`. The Zama FHE coprocessor processes all arithmetic. No plaintext amount ever appears in calldata, events, or storage.

The privacy model is **trader-private, not authority-private** — position sizes are hidden from other market participants, but regulators and auditors retain defined, on-chain access paths to resolved market data. This is an explicit design choice to make confidential finance viable in regulated environments.

**FHE primitives used:**

| Primitive | Where | Purpose |
|---|---|---|
| `euint64` | Pool and position storage | Encrypted 64-bit integer for all financial values |
| `ebool` | `placeBet` guard | Encrypted boolean from comparison result |
| `externalEuint64` | `placeBet` input | Client-submitted encrypted handle from relayer-sdk |
| `FHE.fromExternal()` | `placeBet` | Verifies ZKPoK proof, binds handle to `(contract, user)` |
| `FHE.add()` | Pool accumulation | Encrypted addition — pool totals accumulate without revealing inputs |
| `FHE.asEuint64()` | Pool init, guard | Trivially encrypt constants |
| `FHE.gt()` | Minimum bet guard | Encrypted comparison — `amount > MIN_BET_WEI` → `ebool` |
| `FHE.select()` | Minimum bet guard | Encrypted conditional — `aboveMin ? amount : 0` |
| `FHE.isInitialized()` | Access checks | Check handle existence without decrypting |
| `FHE.allowThis()` | Throughout | ACL — grants contract access to its own ciphertexts |
| `FHE.allow()` | Positions, resolution | ACL — grants specific address gateway-decrypt access |

**Key design: encrypted input validation**

In a normal contract you write `require(amount >= MIN_BET)`. You cannot do this with ciphertext — the EVM cannot compare an encrypted value to a plaintext threshold. The GhostEAMM pattern:

```solidity
// All of this runs inside the Zama FHE coprocessor.
// The EVM never sees any plaintext.

ebool   aboveMin        = FHE.gt(amount, FHE.asEuint64(MIN_BET_WEI));
euint64 effectiveAmount = FHE.select(aboveMin, amount, FHE.asEuint64(0));
```

`FHE.gt` produces an encrypted boolean. `FHE.select` is an encrypted conditional — it returns `amount` if `aboveMin` is true, else `0`. Dust bets are silently neutralized without revealing whether the submitted amount was above or below the threshold. The minimum-bet guard is enforced **homomorphically**.

**Client-side encryption:**
```typescript
// In the browser — amount never leaves the client in plaintext
const buffer = instance.createEncryptedInput(EAMM_ADDRESS, userAddress);
buffer.add64(amountInWei);
const { handles, inputProof } = await buffer.encrypt();

// placeBet receives (handle, inputProof) — not the plaintext amount
await placeEncryptedBet(walletClient, marketId, side, { handle, inputProof });
```

The relayer-sdk produces a ZK proof of knowledge (`inputProof`) bound to `(contractAddress, userAddress)`. `FHE.fromExternal()` on-chain verifies this proof — a handle encrypted for one contract cannot be replayed on another.

**Verified on Etherscan:**

The confirmed shielded bet transaction shows the `encAmount` field as an opaque `bytes32` handle. The `BetPlaced` event emits only `marketId`, `user`, `side` — no amount:

```solidity
event BetPlaced(uint256 indexed marketId, address indexed user, bool indexed side);
```

> [Live tx: `0x5994971938fcce4b...`](https://sepolia.etherscan.io/tx/0x5994971938fcce4b63f3691218a62286963d57fe6b224e07879319691f6e9350)

#### Compliance Model — Trader-Private, Not Authority-Private

GhostMarket's privacy design is not a black box. It is deliberately scoped to protect traders from each other — not to shield activity from auditors, regulators, or the protocol itself. This is the critical distinction that makes FHE viable in regulated finance.

The Zama ACL system enforces this at the contract level:

| Role | Access | Mechanism |
|---|---|---|
| **User (self)** | Can always decrypt their own position | `FHE.allow(position, msg.sender)` on `placeBet` |
| **Contract** | Full access to its own ciphertext handles | `FHE.allowThis(...)` throughout |
| **Oracle / resolver** | Pool access granted only after market resolution | `FHE.allow(pool, resolver)` on `resolveMarket` |
| **Lit PKP** | Position + pool access for payout computation | `grantPositionAccess()` — explicit, auditable grant |
| **Other traders** | No access — ever | No ACL entry is ever written for third parties |

What this means in practice:

- A **regulator or auditor** can always access resolved market data — the oracle, the Lit PKP, and the protocol DAO each have a defined ACL path. There is no "unbreakable" privacy layer; access control is governed by explicit on-chain grants, not cryptographic impossibility.
- An **institutional participant** is protected from competitors seeing their position size before settlement — exactly the privacy that matters for hedging without signaling.
- **KYC/AML compatibility** is preserved by design. Privy handles user identity at the application layer, binding every embedded wallet to a verified email, Google account, or passkey. User addresses are public on-chain. The `BetPlaced` event always emits the user's address and side — only the amount is encrypted. Law enforcement with a valid legal process has a clear identity trail from wallet address → Privy identity → user account.
- **Payout amounts are verified on-chain** by `GhostVault.computeExpectedPayout()`. The oracle cannot produce an inflated payout even with a valid signature. The binary outcome (YES/NO) is the only oracle-attested value — and it is public, disputable, and slash-penalized.

This model maps directly to how institutional dark pools operate in traditional finance: execution size is private from other participants, but reportable to clearing houses and regulators through defined access paths. GhostMarket implements the same principle on-chain using FHE ACLs instead of legal agreements.

**Relevant files:**
```
contracts/contracts/GhostEAMM.sol          — FHE contract (primary Zama deliverable)
contracts/test/GhostEAMM.test.ts           — 36-test suite (mock FHE)
contracts/scripts/deploy-eamm.ts           — Deploy to Sepolia
contracts/scripts/test-shielded-bet.ts     — End-to-end live Sepolia demo
web/src/lib/flow/eamm.ts                   — Client-side relayer-sdk encryption
```

---

### Lit Protocol — Cross-Chain Settlement

Lit Protocol is the bridge — a TEE that reads an FHE-encrypted result on one chain and produces a cryptographic signature that releases funds on another. The PKP private key never leaves the enclave.

**Three Naga patterns in one Lit Action:**

**1. Privacy-Preserving Oracle**

The Lit Action reads encrypted position data from the Zama gateway inside the TEE. `GhostEAMM.grantPositionAccess()` gives the Lit PKP ACL access to the user's `euint64` handle. The position is decrypted inside the enclave — no bet amount is ever exposed in plaintext to any observer, including the oracle nodes themselves.

**2. Cross-Chain Signing (no bridge)**

A single Lit PKP operates across two chains in one execution:
- Reads `GhostEAMM.getMarketMeta()` on **Ethereum Sepolia** (resolved outcome)
- Reads `GhostVault.lockedAmounts()` on **Flow EVM** (collateral verification)
- Produces one EIP-191 signature valid on **Flow EVM** for `claimPayout()`

**3. Conditional Asset Release**

The settlement signature is only produced when all conditions pass:

| Condition | Check |
|---|---|
| Market status | `status === 1` (RESOLVED) on GhostEAMM |
| User placed a bet | `BetPlaced` event exists for `(marketId, user)` |
| Collateral locked | `lockedAmount > 0` in GhostVault |
| Winning side | `userSide === outcome` |
| Amount correctness | Verified by `GhostVault.computeExpectedPayout()` on-chain |

Any condition failure → no signature → vault never releases funds.

**Technical setup:**
```bash
# Pin the Lit Action to IPFS
# Set LIT_ACTION_IPFS_CID=Qm... in oracle/.env

# Mint PKP + add permitted action
cd oracle && npm run lit:setup
# → Prints: LIT_PKP_PUBLIC_KEY and LIT_PKP_ETH_ADDRESS

# Set PKP as GhostVault.settlementSigner on Flow EVM
cd contracts && npx ts-node scripts/update-settlement-signer.ts
```

**Relevant files:**
```
oracle/src/lit-action.js           — Lit Action (pinned to IPFS)
oracle/src/lit-client.ts           — Naga V1 SDK client setup
oracle/scripts/setup-lit-pkp.ts    — Programmatic PKP mint + permission grant
```

---

### Filecoin — Verifiable Oracle Memory

Every oracle resolution cycle produces a permanent, content-addressed evidence record on Filecoin Calibration. Evidence cannot be altered after upload — the Piece CID is a cryptographic commitment. Any verifier can pull it without API keys.

**Two-layer architecture:**

1. **`OracleAgentRegistry.sol`** — deployed on Filecoin Calibration. An EVM-compatible Solidity contract mapping `agentId → Piece CID`, stake, owner, and active status. The on-chain source of truth for which agents are authorized.

2. **Synapse SDK** (`@filoz/synapse-sdk` v0.39.0) — the storage layer. Agent metadata, reputation snapshots, evidence bundles, and slash records are uploaded via `synapse.storage.upload()`. The returned Piece CIDs are written into the registry contract. Storage is paid in USDFC via `synapse.payments`.

**Oracle resolution flow:**

```
Oracle agent gathers evidence
  │
  ├─ serialize → JSON payload
  │
  ├─ saveIntermediateEvidence() → Storacha (hot write, UCAN-scoped)
  │    └── CID for fast peer-read during collection phase
  │
  ├─ submitAttestation() → Calibration (OracleAgentRegistry)
  │    └── quorum of 3-of-4 triggers _tryFinalize() on-chain
  │
  ├─ [on quorum] buildEvidenceBundle() → JSON with all agent CIDs
  │
  ├─ [on quorum] synapse.storage.upload(bundle, { withCDN: true })
  │    └── Filecoin Calibration — PDP-verified permanent storage
  │    └── resolves on onStored (data committed)
  │
  ├─ recordEvidence() × N → Calibration (nonce-ordered queue)
  │
  └─ uploadRepSnapshot() × N → Filecoin (reputation CID chain)
```

**Why Filecoin for evidence:**

| Property | Benefit for Oracle |
|---|---|
| Content addressing | CID is a cryptographic commitment — evidence cannot be altered after upload |
| PDP proofs | Provider continuously proves data is stored — not just a claim |
| Public retrieval | Any verifier can fetch evidence JSON by CID with no permissioned API |
| USDFC payment rail | Stablecoin payments — no ETH price exposure for storage costs |

**Confirmed live uploads (Market 1 resolution):**
```
Evidence bundle PieceCID : bafkzcibdwmaqlzdqx7uf2anlz7gtjhu6adbbphy53aan5k7xjazretr4ss4iw5qj
Retrieval URL            : https://calib.ezpdpz.net/piece/bafkzcibdwmaqlzdqx7uf2anlz7gtjhu6adbbphy53aan5k7xjazretr4ss4iw5qj
On-chain record tx       : 0x0c978a35a43a906577e676de61588184f0ccbfdad92ad29b3c8a602710218bd1
```

**Run the smoke test:**
```bash
cd oracle
npm install
npx tsx --tsconfig tsconfig.json scripts/smoke-test-synapse.ts

# Expected output:
# ✓ USDFC balance: 147.97 USDFC
# ✓ Upload succeeded — PieceCID: bafkzcib...
# ✓ CDN download succeeded — {"test":"smoke-test",...}
```

**Relevant files:**
```
oracle/src/synapse-client.ts          — Synapse v0.39.0 wrapper (upload, download, payment)
oracle/scripts/smoke-test-synapse.ts  — End-to-end upload + retrieval smoke test
contracts/contracts/OracleAgentRegistry.sol — Registry contract on Calibration
```

---

### Storacha — Persistent Agent State

Storacha (`w3s.link`) is the hot-path operational store. It handles two jobs: keeping oracle agent state alive across restarts, and coordinating evidence sharing within the swarm before quorum.

**Persistent agent memory:**

Oracle agent runtime state and strategy checkpoints are written to Storacha as content-addressed objects after each significant operation. On restart or failover, agents pull their last checkpoint and resume pending execution. An agent crash loses nothing — state restoration from Storacha is automatic.

**Multi-agent coordination:**

Oracle evidence bundles are published to Storacha and referenced by CID in each attestation. This makes intermediate resolution data immediately accessible to all agents in the swarm before the final bundle is committed to Filecoin.

**UCAN delegation:**

Each oracle agent has write access scoped only to its own evidence namespace via UCAN delegation. An agent cannot write to another agent's namespace — cross-agent tampering is structurally impossible.

**Hot vs. cold separation:**

```
Storacha (hot)              Filecoin / Synapse (cold)
────────────────            ─────────────────────────
Agent checkpoints           Final evidence bundle (PDP-verified)
Intermediate evidence       Reputation snapshots
Sub-second writes           Permanent archival
UCAN-scoped per agent       USDFC payment gated
CIDs shared during swarm    PieceCIDs on-chain in registry
```

**Relevant files:**
```
oracle/src/storacha-client.ts     — Storacha SDK wrapper
oracle/agent-heads.json           — Mutable CID head pointers per agent
```

---

### ERC-8004 — Portable Agent Identity

Every oracle agent has a portable on-chain identity anchored by an ERC-8004 token on Ethereum Sepolia. The identity token links the agent's name, capability scope, and Filecoin Piece CID history into a single verifiable record.

**Registered agents:**

| Agent | Name | ERC-8004 ID | Calibration Registration |
|---|---|---|---|
| 1 | Cipher | 1747 | [0x0bb4abc5...](https://calibration.filfox.info/en/tx/0x0bb4abc54409a12a78c98ca5e002a771a5ad91d4654016e4d67e5d3ae4dc2774) |
| 2 | Specter | 1748 | [0x8f66e106...](https://calibration.filfox.info/en/tx/0x8f66e106123f59fcbcb4a116479624edcc15a5131bf2a21bb989844d02669f27) |
| 3 | Wraith | 1749 | [0xcf958dce...](https://calibration.filfox.info/en/tx/0xcf958dce8e0082958b13b6b8733f9ab75bc177bbad7d8f252c1ce8130a4c8abe) |
| 4 | Phantom | 1750 | [0x46bb58e4...](https://calibration.filfox.info/en/tx/0x46bb58e412ac60c84a66cfccb465cbcbd9c81dbb56ae4dd70f64736ed18b52dc) |

**Reputation model:**

Each agent has a CID-rooted reputation object — a JSON document containing historical accuracy rate, slash events, participation rate, and dispute reversals — uploaded via Synapse SDK. Reputation scores are fully reproducible from the Piece CID chain. An agent can restore its complete identity from any single CID.

**Slashing:**

Incorrect final-side votes trigger a 10% stake slash, recorded as a new Synapse-uploaded piece and referenced in the registry contract. Repeated non-participation auto-suspends the agent from the active set.

---

## End-to-End User Journey

### Phase 1 — Market Discovery

1. User lands on the market homepage with active event cards and implied odds.
2. User opens a market detail page and chooses YES or NO.
3. User authenticates with walletless Flow login (Google, email, or passkey via Privy).

### Phase 2 — Shielded Bet

4. User deposits FLOW into `GhostVault`. `lockForBet()` commits stake as collateral.
5. User enters bet amount in the bet-slip modal — shielded execution enabled by default.
6. `@zama-fhe/relayer-sdk` encrypts the amount in the browser. Plaintext is gone.
7. Encrypted handle + ZKPoK proof submitted to `GhostEAMM.placeBet()` on Sepolia.
8. Position is recorded as `euint64` — amount invisible to every observer on-chain.

### Phase 3 — Position Management

9. Portfolio page shows open positions — market status and payout potential.
10. Public view exposes only non-sensitive metadata.
11. Private view (`Reveal` button) triggers Zama gateway re-encryption for authorized access.

### Phase 4 — Oracle Resolution

12. Oracle swarm fetches outcome data from defined sources.
13. Each agent writes intermediate evidence to Storacha (fast, UCAN-scoped).
14. 5-of-7 quorum reached — final evidence bundle uploaded to Filecoin via Synapse.
15. `OracleAgentRegistry` updated with Piece CID. Market finalized on-chain.

### Phase 5 — Gasless Claim

16. Lit Action (TEE) reads Zama gateway, computes payout, signs settlement message.
17. Signed message delivered to `GhostVault.claimPayout()` on Flow EVM.
18. Vault verifies Lit PKP signature, nonce, expiry, and `computeExpectedPayout()`.
19. User receives FLOW payout. No gas token required.

---

## Oracle Room

The Oracle Room (`/oracle`) is the live swarm dashboard. It shows:

- Real-time agent attestation logs as they populate
- Quorum progress bar (5-of-7 threshold)
- Per-agent reputation scores
- Filecoin Piece CID proof links — verifiable by anyone, no credentials required
- 29 [scheduled Cadence deliveries](https://testnet.flowscan.io/contract/A.59403984ca469d1c.GhostVaultResolverHandler?tab=scheduled) on Flowscan — resolution fires even if the oracle goes offline

> Each attestation is anchored on-chain. You can pull any Piece CID right now and verify the agent's reasoning directly from Filecoin.

---

## Contract Addresses

### EVM Contracts

| Contract | Chain | Address | Explorer |
|---|---|---|---|
| `GhostEAMM.sol` | Ethereum Sepolia (11155111) | [`0x7508D1e7...`](https://sepolia.etherscan.io/address/0x7508D1e77A700EEf9d9b7cEc2Bf8d48c2F177F46) | [Contract](https://sepolia.etherscan.io/address/0x7508D1e77A700EEf9d9b7cEc2Bf8d48c2F177F46) · [Txns](https://sepolia.etherscan.io/address/0x7508D1e77A700EEf9d9b7cEc2Bf8d48c2F177F46#transactions) · [Events](https://sepolia.etherscan.io/address/0x7508D1e77A700EEf9d9b7cEc2Bf8d48c2F177F46#events) |
| `GhostVault.sol` | Flow EVM Testnet (545) | [`0x377688cf...`](https://evm-testnet.flowscan.io/address/0x377688cf84caaD124d5Ee99671323729D76C186f) | [Contract](https://evm-testnet.flowscan.io/address/0x377688cf84caaD124d5Ee99671323729D76C186f) · [Txns](https://evm-testnet.flowscan.io/address/0x377688cf84caaD124d5Ee99671323729D76C186f?tab=transactions) |
| `GhostMarket.sol` | Flow EVM Testnet (545) | [`0x7D26f77c...`](https://evm-testnet.flowscan.io/address/0x7D26f77c698C9277b9eBaB47E3b73CF08853d76a) | [Contract](https://evm-testnet.flowscan.io/address/0x7D26f77c698C9277b9eBaB47E3b73CF08853d76a) · [Txns](https://evm-testnet.flowscan.io/address/0x7D26f77c698C9277b9eBaB47E3b73CF08853d76a?tab=transactions) |
| `OracleAgentRegistry.sol` | Filecoin Calibration (314159) | [`0x268A2b52...`](https://calibration.filfox.info/en/address/0x268A2b5267f071F85ab44fEC76f512CB9Be4692f) | [Contract](https://calibration.filfox.info/en/address/0x268A2b5267f071F85ab44fEC76f512CB9Be4692f) · [Txns](https://calibration.filfox.info/en/address/0x268A2b5267f071F85ab44fEC76f512CB9Be4692f?t=transactions) |

### Cadence Contract — Flow Native

| Contract | Address | Links |
|---|---|---|
| `GhostVaultResolverHandler` | [`A.59403984ca469d1c.GhostVaultResolverHandler`](https://testnet.flowscan.io/contract/A.59403984ca469d1c.GhostVaultResolverHandler) | [Contract](https://testnet.flowscan.io/contract/A.59403984ca469d1c.GhostVaultResolverHandler) · [**Scheduled Deliveries →**](https://testnet.flowscan.io/contract/A.59403984ca469d1c.GhostVaultResolverHandler?tab=scheduled) · [Transactions](https://testnet.flowscan.io/contract/A.59403984ca469d1c.GhostVaultResolverHandler?tab=transactions) |

> 29 market resolution deliveries are pre-committed to Flow's native transaction scheduler. At each market's expiry timestamp, `reportOutcome()` fires automatically — even if the oracle server is offline. [View all scheduled deliveries →](https://testnet.flowscan.io/contract/A.59403984ca469d1c.GhostVaultResolverHandler?tab=scheduled)

### Zama / FHE Infrastructure (Sepolia)

| Component | Address | Explorer |
|---|---|---|
| Zama ACL | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` | [Etherscan](https://sepolia.etherscan.io/address/0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D) |
| Zama KMS Verifier | `0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A` | [Etherscan](https://sepolia.etherscan.io/address/0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A) |
| Zama Relayer | `https://relayer.testnet.zama.org` | — |

---

## Confirmed On-Chain Transactions

| Event | Chain | Transaction |
|---|---|---|
| Shielded bet — encrypted calldata, no amount in events | Sepolia | [0x5994971938fcce4b...](https://sepolia.etherscan.io/tx/0x5994971938fcce4b63f3691218a62286963d57fe6b224e07879319691f6e9350) |
| Market resolution — agent attestation (Calibration) | Filecoin | [0xd02a46bac8a32d...](https://calibration.filfox.info/en/tx/0xd02a46bac8a32d0c406d7dde03398fdb5014134eb03712d22ff51bf185007e2a) |
| Evidence Piece CID recorded on Calibration | Filecoin | [0x0c978a35a43a90...](https://calibration.filfox.info/en/tx/0x0c978a35a43a906577e676de61588184f0ccbfdad92ad29b3c8a602710218bd1) |
| Cross-chain payout claimed on Flow EVM | Flow EVM | [0x939fcc0a71544e...](https://evm-testnet.flowscan.io/tx/0x939fcc0a71544e8f7baf8b2d81f999bf847ad48c9b18e6fedc7fbfdb2b54654e) |

**Evidence bundle on Filecoin (publicly retrievable, no API key):**
[`bafkzcibdwmaqlzdqx7uf2anlz7gtjhu6adbbphy53aan5k7xjazretr4ss4iw5qj`](https://calib.ezpdpz.net/piece/bafkzcibdwmaqlzdqx7uf2anlz7gtjhu6adbbphy53aan5k7xjazretr4ss4iw5qj)

**Agent metadata Piece CIDs (registered on Filecoin Calibration via Synapse):**

| Agent | Name | Piece CID |
|---|---|---|
| 1 | Cipher | [`bafkzcibdx4bqkk...`](https://calib.ezpdpz.net/piece/bafkzcibdx4bqkkup35gmjzeu4l64e34rfkvtjuyyz2qdmhkm7d56zpjjfgdmplqi) |
| 2 | Specter | [`bafkzcibdxqbqlk...`](https://calib.ezpdpz.net/piece/bafkzcibdxqbqlkfepyhnjwczkg2vpfgreibgnhjs2x6yjx5od7tbk2zth4b4murq) |
| 3 | Wraith | [`bafkzcibdxubqlw...`](https://calib.ezpdpz.net/piece/bafkzcibdxubqlwxve74xhaibatzoopsrs7fbguilg6bkttbpl6qznvvkulnbhnjg) |
| 4 | Phantom | [`bafkzcibdxubqki...`](https://calib.ezpdpz.net/piece/bafkzcibdxubqkih2auxj7qz76tecwngh2dzjzrpm3ydxfyirfssiulbkdez5s4zb) |

---

## Running Locally

### Prerequisites

- Node.js 18+
- A Sepolia RPC URL (Alchemy or Infura)
- A funded Sepolia wallet (for `GhostEAMM` gas)
- A funded Flow EVM testnet wallet

### Frontend (Next.js)

```bash
cd web
npm install
npm run dev
# Open http://localhost:3000
```

Required env vars in `web/.env.local`:

```env
NEXT_PUBLIC_GHOST_EAMM_ADDRESS=0x7508D1e77A700EEf9d9b7cEc2Bf8d48c2F177F46
NEXT_PUBLIC_GHOST_MARKET_ADDRESS=0x7D26f77c698C9277b9eBaB47E3b73CF08853d76a
NEXT_PUBLIC_GHOST_VAULT_ADDRESS=0x377688cf84caaD124d5Ee99671323729D76C186f
NEXT_PUBLIC_SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<key>
NEXT_PUBLIC_FLOW_EVM_RPC=https://testnet.evm.nodes.onflow.org
NEXT_PUBLIC_PRIVY_APP_ID=<your-privy-app-id>
```

### Backend API (FastAPI)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r api/requirements.txt
uvicorn api.main:app --reload
# API: http://localhost:8000 | Docs: http://localhost:8000/docs
```

### Oracle Service

```bash
cd oracle
npm install
npm run dev
```

Required env vars in `oracle/.env`:

```env
CALIBRATION_PRIVATE_KEY=0x...
CALIBRATION_RPC_URL=https://api.calibration.node.glif.io/rpc/v1
LIT_AUTH_PRIVATE_KEY=0x...
LIT_PKP_PUBLIC_KEY=...
LIT_ACTION_IPFS_CID=Qm...
```

### Smart Contracts

```bash
cd contracts
npm install

# Deploy to Sepolia (GhostEAMM)
npx ts-node scripts/deploy-eamm.ts

# Deploy to Flow EVM (GhostVault + GhostMarket)
npx ts-node scripts/deploy-vault-flow.ts

# Run end-to-end settlement simulation
npx ts-node scripts/simulate-settlement.ts
```

---

## Testing

```bash
cd contracts
npm install
npx hardhat test --network hardhat
```

**101 tests, all passing:**

```
GhostEAMM (36 tests)
  placeBet
    ✔ Alice can place an encrypted YES bet
    ✔ Bob can place an encrypted NO bet
    ✔ BetPlaced event contains no amount — only marketId, user, side
    ✔ position handles are set after bet
    ✔ Alice can decrypt her own YES position
    ✔ Bob cannot decrypt Alice's position
    ✔ multiple bets accumulate in encrypted pool
  minimum bet guard (FHE.gt + FHE.select)
    ✔ MIN_BET_WEI constant is exposed and non-zero
    ✔ bet above minimum records a non-zero position handle
    ✔ bet below minimum is silently zeroed — no dust position recorded
  grantPositionAccess
    ✔ grants Lit PKP access to the winner's position after YES resolution
    ✔ grants both positions after cancellation for refunds
  [+ 24 additional lifecycle, access control, and admin tests]

GhostMarket (27 tests)
  ✔ increments marketCount and stores data
  ✔ records YES bet and updates pool
  ✔ returns 5000 when pools are empty (50/50 price)
  ✔ returns 7500/2500 for 3:1 YES/NO pool split
  ✔ pays correct net amount to YES winner
  ✔ sends protocol fee to treasury
  ✔ allows refund after grace period when unresolved
  ✔ owner can dispute then re-resolve
  [+ 19 more]

GhostVault (38 tests)
  ✔ records deposit from user
  ✔ relayer can deposit on behalf of user (gasless path)
  ✔ credits user balance on valid attested payout
  ✔ rejects replayed payout nonce
  ✔ rejects expired payout
  ✔ owner can rotate settlement signer
  ✔ pause blocks deposit
  ✔ lockForBet blocks withdrawal of locked collateral
  ✔ claimPayout reverts with PayoutMismatch on wrong amount
  [+ 29 more including 11 collateral locking scenarios]
```

---

## Acceptance Criteria

| Criterion | Evidence |
|---|---|
| Encrypted trade size not readable from calldata/events | Live tx: `encAmount` is opaque `bytes32`, `BetPlaced` emits no amount |
| FHE contract deployed and functional | `GhostEAMM` on Sepolia, 36 tests passing |
| Consumer DeFi on Flow (walletless, vault, payout) | Privy login + `GhostVault` + `GhostMarket` on Flow EVM testnet |
| Cross-chain collateral locking — solvency guarantee | `lockForBet` blocks withdrawal; collateral locked on Flow, bet encrypted on Zama |
| On-chain payout verification (oracle cannot manipulate amounts) | `computeExpectedPayout()` on `GhostVault`; `claimPayout` reverts with `PayoutMismatch` |
| Pool-depth privacy end-to-end | YES/NO pool totals remain FHE-encrypted in `GhostEAMM` — never written to any plaintext state |
| Cross-chain settlement without token bridge | EIP-712 signed message from oracle to Flow EVM — confirmed on Flowscan |
| Agent state survives restart | Storacha-backed checkpoints; agents resume pending strategy on failover |
| Oracle quorum reproducible in test runbook | `OracleAgentRegistry` — 3-of-4 finalization logic, scripted test scenario |
| Dispute flow can reverse tentative result and slash | Slash records uploaded to Filecoin via Synapse; CID written to registry |
| User completes onboarding to payout without gas token handling | Privy embedded wallet → gasless relayer path → `claimPayout` on Flow EVM |
| Scheduled automation fires without human trigger | 29 pre-committed Flowscan deliveries via `GhostVaultResolverHandler` |
| 101 tests passing | `npx hardhat test --network hardhat` |
| Publicly verifiable oracle audit trail | PieceCID content-addressed; HTTP 200 retrieval via `calib.ezpdpz.net` |

---

## Project Structure

```
GhostMarket/
├── contracts/
│   ├── contracts/
│   │   ├── GhostEAMM.sol             — FHE encrypted AMM (Zama / Sepolia)
│   │   ├── GhostVault.sol            — Collateral vault + EIP-712 settlement (Flow EVM)
│   │   ├── GhostMarket.sol           — LMSR prediction market (Flow EVM)
│   │   └── OracleAgentRegistry.sol   — Oracle registry (Filecoin Calibration)
│   ├── scripts/
│   │   ├── deploy-eamm.ts
│   │   ├── deploy-vault-flow.ts
│   │   ├── simulate-settlement.ts
│   │   └── test-shielded-bet.ts
│   └── test/
│       ├── GhostEAMM.test.ts         — 36 FHE tests
│       ├── GhostMarket.test.ts       — 27 market tests
│       └── GhostVault.test.ts        — 38 vault tests
├── web/                              — Next.js frontend
│   └── src/
│       ├── app/
│       │   ├── page.tsx              — Market homepage
│       │   ├── portfolio/page.tsx    — On-chain + shielded positions
│       │   └── vault/page.tsx        — Vault balance + lock breakdown
│       ├── components/
│       │   ├── bet-slip.tsx          — Shielded/public toggle
│       │   └── hero-section.tsx
│       └── lib/flow/
│           ├── eamm.ts               — relayer-sdk encryption
│           ├── vault.ts              — GhostVault helpers
│           └── market.ts             — GhostMarket helpers
├── oracle/                           — Oracle agent service
│   └── src/
│       ├── lit-action.js             — Lit Action (pinned to IPFS)
│       ├── lit-client.ts             — Naga V1 SDK client
│       ├── synapse-client.ts         — Synapse v0.39.0 wrapper
│       ├── storacha-client.ts        — Storacha SDK wrapper
│       └── vault-reporter.ts         — reportOutcome() relay
├── api/                              — FastAPI backend
├── cadence/                          — Flow Cadence scheduling adapter
└── docs/
```

---

<div align="center">

**FHE so no one knows your position. A TEE so no one can manipulate the payout. Filecoin so the oracle can't lie about its reasoning. And Flow so the resolution fires even when we're not watching.**

*That's GhostMarket.*

</div>
