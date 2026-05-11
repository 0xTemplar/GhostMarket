<div align="center">

# GhostMarket

**Confidential Prediction Markets powered by Fully Homomorphic Encryption**

[![Ethereum Sepolia](https://img.shields.io/badge/Ethereum-Sepolia_11155111-627EEA?style=flat-square&logo=ethereum)](https://sepolia.etherscan.io)
[![Zama fhevm](https://img.shields.io/badge/Zama-fhevm_coprocessor-412891?style=flat-square)](https://docs.zama.ai/fhevm)
[![License](https://img.shields.io/badge/License-MIT-gray?style=flat-square)](LICENSE)

<img width="1920" height="1080" alt="417f7baa-c99c-494f-a97a-be66169737e3" src="https://github.com/user-attachments/assets/4c3e3305-9ec8-4e7d-9d2e-beccaa48b92c" />

*Your position size is invisible to the market. The chain. The oracle. The block explorer. Front-runners.*

</div>

---

## Table of Contents

- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
  - [Contract Overview](#contract-overview)
  - [Privacy Model](#privacy-model)
  - [Compliance Model](#compliance-model)
- [Tech Stack](#tech-stack)
  - [Zama fhevm — Encrypted AMM](#zama-fhevm--encrypted-amm)
  - [GhostVault — USDC Custody](#ghostvault--usdc-custody)
  - [GhostMarket — Single Entry Point](#ghostmarket--single-entry-point)
  - [Oracle Service — Agent Swarm](#oracle-service--agent-swarm)
- [End-to-End User Journey](#end-to-end-user-journey)
- [Contract Addresses](#contract-addresses)
- [Confirmed On-Chain Transactions](#confirmed-on-chain-transactions)
- [Running Locally](#running-locally)
- [Testing](#testing)
- [Project Structure](#project-structure)

---

## The Problem

### 1. Market Transparency as a Bug

On public prediction markets every trade is visible in real time. Large position sizes reveal institutional intent, invite front-running, and create systematic adverse selection against sophisticated traders. The public order book is not a feature — it is an attack surface.

### 2. Oracle Trust Gap

Single-provider oracles are censorable and manipulatable. There is no cryptographic guarantee that a reported outcome matches the evidence it claimed to use.

### 3. Web3 UX Friction

Seed phrases, gas tokens, and wallet prompts are adoption killers. Mainstream users will not onboard if the experience requires a 12-word mnemonic before they can place a bet.

---

## The Solution

GhostMarket is a **single-chain confidential prediction market on Ethereum Sepolia** that solves all three problems:

| Problem | Solution |
|---|---|
| Position size visibility | FHE-encrypted AMM — bet amounts are `euint64` ciphertext on-chain, never plaintext |
| Oracle manipulation | 7-agent swarm with EIP-712 signed attestations — outcome is oracle-quorum attested |
| Web3 UX friction | Privy walletless login — Google sign-in, no seed phrase, embedded wallet created automatically |

The core claim: **your bet amount is invisible to every other participant, every node operator, every block explorer, and us — while payout correctness is mathematically enforced on-chain.**

---

## How It Works

```
                     YOU (browser)
                          │
              ┌───────────┴───────────┐
              │                       │
    1. Login with Google         2. Deposit USDC
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
                                          5-of-7 quorum reached
                                          Oracle signs EIP-712 settlement
                          │
              6. Claim USDC payout
              ◄─────────────────────────  GhostVault verifies oracle signature
                                          computeExpectedPayout() checks amount
                                          USDC transferred to user
```

---

## Architecture

### Contract Overview

All contracts live on **Ethereum Sepolia (chain 11155111)**. There is no cross-chain bridge or multi-chain complexity.

```
┌────────────────────────────────────────────────────────────────┐
│                    ETHEREUM SEPOLIA (11155111)                  │
│                                                                │
│  GhostMarket.sol           ←── single admin entry point        │
│  · Stores market metadata (title, category, expiry)            │
│  · createMarket() forwards to GhostEAMM atomically             │
│  · resolveMarket() / cancelMarket() cascade to GhostEAMM       │
│                   │                                            │
│                   ▼                                            │
│  GhostEAMM.sol             ←── FHE execution layer             │
│  · placeBet(encAmount, proof) — encrypted euint64 input        │
│  · yesPool / noPool stored as FHE ciphertext                   │
│  · Per-user position handles — ACL-scoped, never plaintext     │
│  · GhostMarket is its sole manager + resolver                  │
│                                                                │
│  GhostVault.sol            ←── USDC custody + settlement       │
│  · deposit() / withdraw() — USDC (6 decimals)                  │
│  · lockForBet() — commits collateral before encrypted bet      │
│  · claimPayout() — verifies oracle EIP-712 sig, pays winner    │
│  · computeExpectedPayout() — oracle cannot forge amounts       │
│                                                                │
│  MockUSDC.sol              ←── ERC20 collateral token          │
│  · name: "USD Coin", symbol: "USDC", decimals: 6              │
│  · mint() owner-only — swap address for real USDC on mainnet  │
└────────────────────────────────────────────────────────────────┘
                              │
              Zama FHE Coprocessor (off-chain, verifiable)
              · euint64 arithmetic
              · FHE.gt / FHE.select (encrypted conditionals)
              · FHE.add (encrypted pool accumulation)
              · Re-encryption gateway (ACL-gated decryption)
```

### Privacy Model

```
ON ZAMA (Ethereum Sepolia)
──────────────────────────────────────────────────────────────────
WHAT IS PUBLIC               WHAT IS PRIVATE (FHE-encrypted)
────────────────             ────────────────────────────────
Market ID                    Bet amount (euint64)
User address                 YES pool total (euint64)
Side (YES / NO)              NO pool total (euint64)
Market status                Per-user position handle (euint64)
Market expiry                Pool depth — never decrypted on-chain

IN GHOSTVAULT
──────────────────────────────────────────────────────────────────
WHAT IS PUBLIC               WHAT IS PRIVATE
────────────────             ────────────────
User's own locked stake*     Pool depth aggregates (remain FHE-
Market ID of lock            encrypted in GhostEAMM)
Resolved binary outcome
computeExpectedPayout()

* Locked amount is visible in the user's own custody record only —
  not to other participants where front-running occurs.
  Pool-depth totals are NEVER written to GhostVault.
```

### Compliance Model

GhostMarket's privacy is **trader-private, not authority-private**. Position sizes are hidden from other market participants — not from auditors or regulators. The Zama ACL system enforces this at the contract level:

| Role | Access | Mechanism |
|---|---|---|
| **User (self)** | Can always decrypt their own position | `FHE.allow(position, msg.sender)` on `placeBet` |
| **Contract** | Full access to its own ciphertext handles | `FHE.allowThis(...)` throughout |
| **Oracle / resolver** | Pool access granted only after market resolution | `FHE.allow(pool, resolver)` on `resolveMarket` |
| **Other traders** | No access — ever | No ACL entry is written for third parties |

This maps to how institutional dark pools work in traditional finance: execution size is private from other participants, but reportable through defined access paths.

---

## Tech Stack

### Zama fhevm — Encrypted AMM

`GhostEAMM.sol` is the confidential execution layer. Every financial value — bet amounts, pool totals, per-user positions — is an encrypted `euint64`. The Zama FHE coprocessor processes all arithmetic. No plaintext amount ever appears in calldata, events, or storage.

**FHE primitives used:**

| Primitive | Where | Purpose |
|---|---|---|
| `euint64` | Pool and position storage | Encrypted 64-bit integer for all financial values |
| `ebool` | `placeBet` guard | Encrypted boolean from comparison result |
| `externalEuint64` | `placeBet` input | Client-submitted encrypted handle from relayer-sdk |
| `FHE.fromExternal()` | `placeBet` | Verifies ZKPoK proof, binds handle to `(contract, user)` |
| `FHE.add()` | Pool accumulation | Encrypted addition — pool totals accumulate without revealing inputs |
| `FHE.asEuint64()` | Pool init, guard | Trivially encrypt constants |
| `FHE.gt()` | Minimum bet guard | Encrypted comparison — `amount > MIN_BET_UNITS` → `ebool` |
| `FHE.select()` | Minimum bet guard | Encrypted conditional — `aboveMin ? amount : 0` |
| `FHE.isInitialized()` | Access checks | Check handle existence without decrypting |
| `FHE.allowThis()` | Throughout | ACL — grants contract access to its own ciphertexts |
| `FHE.allow()` | Positions, resolution | ACL — grants specific address gateway-decrypt access |

**Key design: encrypted input validation**

In a normal contract you write `require(amount >= MIN_BET)`. You cannot do this with ciphertext — the EVM cannot compare an encrypted value to a plaintext threshold. The GhostEAMM pattern:

```solidity
// Runs inside the Zama FHE coprocessor. EVM never sees plaintext.
ebool   aboveMin        = FHE.gt(amount, FHE.asEuint64(MIN_BET_UNITS));
euint64 effectiveAmount = FHE.select(aboveMin, amount, FHE.asEuint64(0));
```

`FHE.gt` produces an encrypted boolean. `FHE.select` is an encrypted conditional — it returns `amount` if `aboveMin` is true, else `0`. Dust bets are silently neutralized without revealing whether the submitted amount was above or below the threshold. The minimum-bet guard is enforced **homomorphically**.

**Client-side encryption:**
```typescript
// In the browser — amount never leaves the client in plaintext
const buffer = instance.createEncryptedInput(EAMM_ADDRESS, userAddress);
buffer.add64(amountInUsdcBaseUnits); // e.g. parseUnits("10", 6) for 10 USDC
const { handles, inputProof } = await buffer.encrypt();

// placeBet receives (handle, inputProof) — not the plaintext amount
await placeEncryptedBet(walletClient, marketId, side, { handle, inputProof });
```

The relayer-sdk produces a ZK proof of knowledge (`inputProof`) bound to `(contractAddress, userAddress)`. `FHE.fromExternal()` on-chain verifies this proof — a handle encrypted for one contract cannot be replayed on another.

**Confirmed on Etherscan:**

The `encAmount` field in `placeBet` calldata is an opaque `bytes32` handle. The `BetPlaced` event emits only `marketId`, `user`, `side` — no amount:

```solidity
event BetPlaced(uint256 indexed marketId, address indexed user, bool indexed side);
```

> [Live shielded bet tx](https://sepolia.etherscan.io/tx/0x5994971938fcce4b63f3691218a62286963d57fe6b224e07879319691f6e9350)

---

### GhostVault — USDC Custody

`GhostVault.sol` is the collateral and settlement layer. It holds USDC (6 decimals), locks collateral before encrypted bets, and releases payouts after oracle attestation.

**Settlement message schema (EIP-712):**
```solidity
bytes32 public constant CLAIM_TYPEHASH = keccak256(
    "Claim(address user,bytes32 marketId,uint256 amount,uint256 nonce,uint256 expiry)"
);
```

**Security model:**
```solidity
contract GhostVault is ReentrancyGuard, Pausable, Ownable2Step, EIP712
```
- `ReentrancyGuard` on all state-mutating functions (CEI pattern enforced)
- `SafeERC20` for all token transfers
- Nonce replay protection — `usedNonces[user][marketId][nonce]`
- Expiry enforcement on settlement messages
- `computeExpectedPayout()` — vault independently enforces the correct payout amount. A compromised oracle cannot produce an accepted overpayment; `claimPayout()` reverts with `PayoutMismatch` if the signed amount differs.
- Collateral lock — `lockForBet()` commits USDC before the encrypted bet. The locked amount cannot be withdrawn until oracle settlement.

**Deposit flow:**
```
1. User calls MockUSDC.approve(vaultAddress, amount)
2. User calls GhostVault.deposit(amount)  ← or approveAndDeposit() helper
3. Vault pulls USDC via safeTransferFrom
4. balance[user] += amount
```

To upgrade to real USDC on mainnet: redeploy with Circle's USDC address. Zero vault or frontend code changes required.

---

### GhostMarket — Single Entry Point

`GhostMarket.sol` is the single admin entry point for market lifecycle. It stores human-readable metadata and atomically forwards every lifecycle call to `GhostEAMM`.

**One call, both contracts updated atomically:**
```
Admin calls GhostMarket.createMarket(title, description, category, expiry)
  ├─ Stores metadata in GhostMarket
  └─ Calls GhostEAMM.createMarket(marketId, expiry)  ← same transaction

Oracle calls GhostMarket.resolveMarket(marketId, outcome)
  ├─ Updates status in GhostMarket
  └─ Calls GhostEAMM.resolveMarket(marketId, outcome) ← same transaction
```

`GhostEAMM` only accepts calls from `GhostMarket` (set as both `marketManager` and `resolver` during deploy). It is an internal implementation detail — no direct admin access.

---

### Oracle Service — Agent Swarm

The oracle is a Node.js service running a 7-agent swarm. Each agent independently gathers evidence and signs an EIP-712 attestation. After 5-of-7 quorum, the oracle wallet signs a `GhostVault` settlement message that the winning user can claim.

**Settlement flow:**
```
1. Market expires
2. Oracle agents independently gather real-world outcome evidence
3. 5-of-7 quorum reached
4. Oracle wallet signs EIP-712 Claim message:
     { user, marketId, amount, nonce, expiry }
5. Signed message delivered to frontend
6. User calls GhostVault.claimPayout(marketId, amount, nonce, expiry, sig)
7. Vault verifies: sig → settlementSigner, nonce unused, expiry valid,
                   amount === computeExpectedPayout(user, marketId)
8. USDC transferred to user
```

**Oracle files:**
```
oracle/src/index.ts           — Agent swarm orchestration
oracle/src/oracle-signer.ts   — EIP-712 settlement signing
oracle/src/eamm-resolver.ts   — GhostEAMM resolve + grantPositionAccess calls
oracle/src/settlement.ts      — Settlement message construction
oracle/src/agents.ts          — Agent definitions and evidence gathering
```

---

## End-to-End User Journey

### Phase 1 — Market Discovery

1. User lands on the market homepage with active event cards and implied odds.
2. User opens a market detail page and chooses YES or NO.
3. User authenticates with walletless login (Google, email, or passkey via Privy).

### Phase 2 — Deposit Collateral

4. User navigates to the Vault page.
5. User enters a USDC amount — UI auto-detects allowance and sends approve tx if needed.
6. Deposit tx pulls USDC into `GhostVault`. Balance visible immediately.

### Phase 3 — Shielded Bet

7. User enters bet amount in the bet-slip modal.
8. `lockForBet()` commits USDC collateral — cannot be withdrawn until settlement.
9. `@zama-fhe/relayer-sdk` encrypts the amount in the browser. Plaintext is gone.
10. Encrypted handle + ZKPoK proof submitted to `GhostEAMM.placeBet()`.
11. Position recorded as `euint64` — amount invisible to every on-chain observer.

### Phase 4 — Oracle Resolution

12. Oracle swarm fetches outcome data from defined sources.
13. 5-of-7 quorum reached — oracle wallet signs EIP-712 settlement message.
14. `GhostMarket.resolveMarket()` called — status updated in both contracts atomically.

### Phase 5 — Claim Payout

15. Portfolio page shows claimable position.
16. User clicks Claim — frontend submits signed settlement to `GhostVault.claimPayout()`.
17. Vault verifies signature, nonce, expiry, and `computeExpectedPayout()`.
18. USDC transferred directly to user's wallet.

---

## Contract Addresses

All contracts are deployed on **Ethereum Sepolia (chain 11155111)**.

| Contract | Address | Etherscan |
|---|---|---|
| `MockUSDC.sol` | [`0x01CA967cA04CC1251518d4e6672f301FC99c46ec`](https://sepolia.etherscan.io/address/0x01CA967cA04CC1251518d4e6672f301FC99c46ec) | [View](https://sepolia.etherscan.io/address/0x01CA967cA04CC1251518d4e6672f301FC99c46ec) |
| `GhostEAMM.sol` | [`0x9420a7f50d083BD6853aaB94C822dae7117810dC`](https://sepolia.etherscan.io/address/0x9420a7f50d083BD6853aaB94C822dae7117810dC) | [View](https://sepolia.etherscan.io/address/0x9420a7f50d083BD6853aaB94C822dae7117810dC) |
| `GhostVault.sol` | [`0x1622ff3C54855ADF63197583F6da00BB629bBE08`](https://sepolia.etherscan.io/address/0x1622ff3C54855ADF63197583F6da00BB629bBE08) | [View](https://sepolia.etherscan.io/address/0x1622ff3C54855ADF63197583F6da00BB629bBE08) |
| `GhostMarket.sol` | [`0x74Cc357cA55b58D81320EBE46DE06253d75230a7`](https://sepolia.etherscan.io/address/0x74Cc357cA55b58D81320EBE46DE06253d75230a7) | [View](https://sepolia.etherscan.io/address/0x74Cc357cA55b58D81320EBE46DE06253d75230a7) |

**Zama infrastructure (Sepolia):**

| Component | Address |
|---|---|
| Zama ACL | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` |
| Zama KMS Verifier | `0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A` |
| Zama Relayer | `https://relayer.testnet.zama.org` |

---

## Confirmed On-Chain Transactions

| Event | Transaction |
|---|---|
| Shielded bet — encrypted calldata, no amount in events | [0x5994971938fcce4b…](https://sepolia.etherscan.io/tx/0x5994971938fcce4b63f3691218a62286963d57fe6b224e07879319691f6e9350) |
| MockUSDC deploy + 1M USDC minted to deployer | [View on Etherscan](https://sepolia.etherscan.io/address/0x01CA967cA04CC1251518d4e6672f301FC99c46ec) |
| GhostMarket wired to GhostEAMM (setMarketManager + setResolver) | [View on Etherscan](https://sepolia.etherscan.io/address/0x9420a7f50d083BD6853aaB94C822dae7117810dC) |

---

## Running Locally

### Prerequisites

- Node.js 18+
- A Sepolia RPC URL (Alchemy or Infura)
- A funded Sepolia wallet (for contract gas)

### Frontend (Next.js)

```bash
cd web
npm install
npm run dev
# Open http://localhost:3000
```

Required env vars in `web/.env.local`:

```env
NEXT_PUBLIC_MOCK_USDC_ADDRESS=0x01CA967cA04CC1251518d4e6672f301FC99c46ec
NEXT_PUBLIC_GHOST_EAMM_ADDRESS=0x9420a7f50d083BD6853aaB94C822dae7117810dC
NEXT_PUBLIC_GHOST_VAULT_ADDRESS=0x1622ff3C54855ADF63197583F6da00BB629bBE08
NEXT_PUBLIC_GHOST_MARKET_ADDRESS=0x74Cc357cA55b58D81320EBE46DE06253d75230a7
NEXT_PUBLIC_SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<key>
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
DEPLOYER_PRIVATE_KEY=0x...
ORACLE_PRIVATE_KEY=0x...
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<key>
GHOST_EAMM_ADDRESS=0x9420a7f50d083BD6853aaB94C822dae7117810dC
GHOST_VAULT_ADDRESS=0x1622ff3C54855ADF63197583F6da00BB629bBE08
GHOST_MARKET_ADDRESS=0x74Cc357cA55b58D81320EBE46DE06253d75230a7
```

### Smart Contracts

```bash
cd contracts
npm install

# Compile
npx hardhat compile

# Deploy all contracts to Sepolia
npx hardhat run scripts/deploy-sepolia.ts --network sepolia

# Run tests
npx hardhat test --network hardhat
```

---

## Testing

```bash
cd contracts
npm install
npx hardhat test --network hardhat
```

**Test suites:**

```
GhostEAMM
  placeBet
    ✔ Alice can place an encrypted YES bet
    ✔ Bob can place an encrypted NO bet
    ✔ BetPlaced event contains no amount — only marketId, user, side
    ✔ position handles are set after bet
    ✔ Alice can decrypt her own YES position
    ✔ Bob cannot decrypt Alice's position
    ✔ multiple bets accumulate in encrypted pool
  minimum bet guard (FHE.gt + FHE.select)
    ✔ MIN_BET_UNITS constant is exposed and non-zero (1 USDC)
    ✔ bet above minimum records a non-zero position handle
    ✔ bet below minimum is silently zeroed — no dust position recorded
  grantPositionAccess
    ✔ grants oracle access to the winner's position after YES resolution
    ✔ grants both positions after cancellation for refunds

GhostVault
  ✔ records USDC deposit from user
  ✔ relayer can deposit on behalf of user (depositFor)
  ✔ credits user balance on valid attested payout
  ✔ rejects replayed payout nonce
  ✔ rejects expired payout
  ✔ owner can rotate settlement signer
  ✔ pause blocks deposit
  ✔ lockForBet blocks withdrawal of locked collateral
  ✔ claimPayout reverts with PayoutMismatch on wrong amount

GhostMarket
  ✔ createMarket stores metadata and calls GhostEAMM atomically
  ✔ resolveMarket updates status and calls GhostEAMM.resolveMarket
  ✔ cancelMarket updates status and calls GhostEAMM.cancelMarket
  ✔ only resolver can resolve/cancel
  ✔ invalid expiry reverts
```

---

## Project Structure

```
GhostMarket/
├── contracts/
│   ├── contracts/
│   │   ├── GhostEAMM.sol          — FHE encrypted AMM (Zama coprocessor)
│   │   ├── GhostVault.sol         — USDC custody + EIP-712 settlement
│   │   ├── GhostMarket.sol        — Market metadata + lifecycle entry point
│   │   └── MockUSDC.sol           — Mintable ERC20 (swap for real USDC on mainnet)
│   ├── scripts/
│   │   └── deploy-sepolia.ts      — Deploy all four contracts + wire GhostEAMM
│   └── test/
│       ├── GhostEAMM.test.ts
│       ├── GhostVault.test.ts
│       └── GhostMarket.test.ts
├── web/                           — Next.js frontend
│   └── src/
│       ├── app/
│       │   ├── page.tsx           — Market homepage
│       │   ├── markets/[id]/      — Market detail + bet slip
│       │   ├── portfolio/         — Positions + claim
│       │   ├── vault/             — USDC deposit / withdraw
│       │   └── admin/             — Market creation (resolver only)
│       ├── components/
│       │   ├── bet-slip.tsx       — Shielded bet flow (approve → lock → encrypt → submit)
│       │   └── oracle-room.tsx    — Live agent swarm dashboard
│       └── lib/
│           ├── eamm.ts            — relayer-sdk encryption helpers
│           ├── vault.ts           — GhostVault + MockUSDC read/write helpers
│           └── market.ts          — GhostMarket read helpers
├── oracle/                        — Oracle agent service (Node.js)
│   └── src/
│       ├── index.ts               — Agent swarm orchestration
│       ├── oracle-signer.ts       — EIP-712 settlement signing
│       ├── eamm-resolver.ts       — GhostEAMM resolve + ACL grant
│       ├── settlement.ts          — Settlement message construction
│       └── agents.ts              — Agent definitions
└── api/                           — FastAPI backend (gas relay + oracle proxy)
```

---

<div align="center">

**FHE so no one knows your position. An oracle quorum so no one can manipulate the outcome. And USDC so collateral is stable, portable, and mainnet-ready with a single address swap.**

*That's GhostMarket.*

</div>
