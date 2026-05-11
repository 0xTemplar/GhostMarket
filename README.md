<div align="center">

# GhostMarket

**Confidential Prediction Markets on Ethereum, end-to-end encrypted with Zama FHEVM and ERC-7984.**

[![Ethereum Sepolia](https://img.shields.io/badge/Ethereum-Sepolia_11155111-627EEA?style=flat-square&logo=ethereum)](https://sepolia.etherscan.io)
[![Zama FHEVM](https://img.shields.io/badge/Zama-FHEVM_protocol-412891?style=flat-square)](https://docs.zama.ai/fhevm)
[![ERC-7984](https://img.shields.io/badge/ERC--7984-confidential_token-1a73e8?style=flat-square)](https://eips.ethereum.org/EIPS/eip-7984)
[![Privy](https://img.shields.io/badge/Privy-walletless_login-7c3aed?style=flat-square)](https://privy.io)
[![License](https://img.shields.io/badge/License-MIT-gray?style=flat-square)](LICENSE)

<img width="1920" height="1080" alt="GhostMarket hero" src="https://github.com/user-attachments/assets/4c3e3305-9ec8-4e7d-9d2e-beccaa48b92c" />

*Your deposit, your stake, your pool share, your payout — none of them exist as plaintext anywhere on-chain.*

</div>

---

## Table of Contents

- [What GhostMarket Is](#what-ghostmarket-is)
- [The Problem](#the-problem)
- [What We Built](#what-we-built)
- [System Architecture](#system-architecture)
- [Privacy Model — What's Public, What's Encrypted](#privacy-model--whats-public-whats-encrypted)
- [The Encrypted Stack, in Depth](#the-encrypted-stack-in-depth)
  - [1. ERC-7984 cUSDC Custody](#1-erc-7984-cusdc-custody--encrypted-money-on-rails)
  - [2. GhostEAMM — Encrypted AMM](#2-ghosteamm--encrypted-amm)
  - [3. Sealed-Bid Windows](#3-sealed-bid-windows--time-batched-frontrun-proof-price-reveal)
  - [4. Oracle Room — AI Agent Quorum](#4-oracle-room--ai-agent-quorum)
  - [5. Confidential Settlement](#5-confidential-settlement--signing-over-ciphertext-handles)
  - [6. Walletless Onboarding](#6-walletless-onboarding-via-privy)
- [End-to-End User Journey](#end-to-end-user-journey)
- [Compliance Model](#compliance-model)
- [Deployed Contracts (Sepolia)](#deployed-contracts-sepolia)
- [Repository Layout](#repository-layout)
- [Running Locally](#running-locally)
- [Testing](#testing)
- [Operational Notes](#operational-notes)
- [Roadmap](#roadmap)

---

## What GhostMarket Is

GhostMarket is a **fully confidential prediction-market protocol** deployed on **Ethereum Sepolia** with the Zama FHEVM coprocessor. It is not a privacy *layer* bolted on top of a public market — it is a market where **every value that has a dollar sign in front of it is a ciphertext from the moment it leaves the user's browser until the moment it lands in their wallet on the other side**.

That includes:

- **Vault deposits and balances** — held as encrypted ERC-7984 cUSDC. The token contract literally cannot tell you how much cUSDC anyone owns.
- **Per-market collateral locks** — encrypted on a per-user, per-market basis. Even the vault owner can't read them.
- **Bet amounts** — encrypted client-side before they hit calldata, processed by the FHE coprocessor.
- **Pool depths (YES / NO totals)** — encrypted in the AMM. Decrypted only after a sealed-bid window settles, and only to authorised addresses.
- **Per-user position shares** — encrypted, ACL-scoped to the position owner.
- **Payouts** — the oracle signs over the *encrypted* payout handle, not a plaintext amount. The vault transfers cUSDC by handle; the recipient receives confidential tokens; the explorer sees nothing.

Combined with a **sealed-bid window** mechanism that freezes the visible odds during a buying window (so two bettors can't watch each other's clicks move the price), a **4-of-N AI agent oracle quorum** with reasoning grounded in real exchange APIs, and **walletless Privy login**, GhostMarket is what Polymarket would look like if the chain refused to publish your size.

---

## The Problem

### 1. Public order books are an attack surface

On every major on-chain prediction market today, every trade is visible in real time at base-unit precision. Bet sizes leak intent, invite front-running, allow whale-watching, and make adverse selection trivial. "Transparency" of execution detail is not a feature for the trader — it is a feature for the people trading against them.

### 2. "Hidden" usually means hidden behind a centralised operator

The handful of markets that obscure trade size do so by routing through a trusted backend that holds plaintext internally. The privacy isn't cryptographic; it's "we promise we won't tell." Anyone who compromises the operator, or anyone who *is* the operator, can read everything.

### 3. Oracles are a single point of failure

Most testnet and even production markets resolve from a single feed. There's no quorum, no attestation chain, no way to audit what the oracle "saw" when it decided your bet lost.

### 4. Web3 onboarding is a brick wall

Seed phrases, faucet runs, gas tokens, and wallet pop-ups will continue to kill mainstream adoption for the foreseeable future.

---

## What We Built

| Problem | GhostMarket's answer | Mechanism |
|---|---|---|
| Bet-size leakage to other traders | **End-to-end FHE encryption of every value** | `euint64` ciphertexts in calldata, storage, events, and settlements — verified by Zama coprocessor |
| Trust-based privacy | **Cryptographic privacy, no trusted operator** | ACL-gated re-encryption via Zama KMS; nobody (us included) has a master key |
| Pool-depth front-running during a bet | **Sealed-bid windows** | Pool handles snapshotted at window open, decryption ACL not granted until window expires |
| Single-feed oracle risk | **Multi-agent oracle with on-chain attestation** | N independent LLM agents pulling different exchange feeds, majority quorum, EIP-712-signed settlement |
| Oracle forging payout amounts | **Settlement commits to encrypted handle, not amount** | Oracle signs `keccak(user, marketId, amountHandle, nonce, expiry)`; vault transfers by handle |
| Seed-phrase friction | **Walletless login** | Privy embedded wallets — Google / email / passkey, no mnemonic |
| Cross-chain bridge risk | **Single chain** | All contracts live on Ethereum Sepolia (mainnet-ready with one address swap) |

---

## System Architecture

```
                              ┌──────────────────────────────────────┐
                              │            USER (browser)            │
                              │  Next.js · viem · Privy embedded EOA │
                              └──────────────┬───────────────────────┘
                                             │
                                             │ @zama-fhe/relayer-sdk (browser)
                                             │ encrypts amount + builds ZKPoK
                                             │
                ┌────────────────────────────┼────────────────────────────┐
                │                            │                            │
                ▼                            ▼                            ▼
        ┌───────────────┐           ┌──────────────────┐         ┌────────────────┐
        │  cUSDC Mock   │           │  GhostVaultV2    │         │   GhostEAMM    │
        │  (ERC-7984)   │           │  encrypted USDC  │         │  encrypted AMM │
        │  Zama Sepolia │◄──────────┤  custody + EIP-  │◄────────┤  YES/NO pools  │
        │  canonical    │ confiden- │  712 settlement  │ shared  │  + sealed-bid  │
        └───────┬───────┘ tialTrans │  signer          │ marketId│  windows       │
                │         fer       └────────┬─────────┘ space   └────────┬───────┘
                │                            │                            │
                │                            │                            │
                │              ┌─────────────┴────────────────────────────┘
                │              │
                │              ▼
                │     ┌────────────────┐
                │     │  GhostMarket   │  ← single admin entry point
                │     │  metadata +    │     createMarket / resolve / cancel /
                │     │  lifecycle     │     openSealedWindow forward to EAMM
                │     └───────┬────────┘
                │             │
                │             │ resolveMarket(outcome) on quorum
                │             │
                │   ┌─────────┴──────────────────────────────────────┐
                │   │              Oracle Service (Node.js)          │
                │   │  WS + REST · http://localhost:8092             │
                │   │  ┌──────────────────────────────────────────┐  │
                │   │  │  N agents (default 4, definitions = 7)   │  │
                │   │  │  ├─ Cipher    (Binance)                  │  │
                │   │  │  ├─ Specter   (CoinGecko)                │  │
                │   │  │  ├─ Wraith    (Chainlink / CryptoCompare)│  │
                │   │  │  ├─ Phantom   (Coinbase)                 │  │
                │   │  │  ├─ Shade     (Kraken)                   │  │
                │   │  │  ├─ Echo      (OKX)                      │  │
                │   │  │  └─ Vex       (Bybit)                    │  │
                │   │  │                                          │  │
                │   │  │  Each agent: fetch live price → reason   │  │
                │   │  │  via OpenAI (gpt-4o-mini) → cast vote    │  │
                │   │  └──────────────────────────────────────────┘  │
                │   │                                                │
                │   │  ▸ floor(N/2)+1 quorum → resolveMarket on EAMM │
                │   │  ▸ Zama gateway userDecrypt of position       │
                │   │  ▸ EIP-712 sign Claim(user, marketId,         │
                │   │      amountHandle, nonce, expiry)             │
                │   │  ▸ sealed-window watcher: settle + decrypt    │
                │   │      + publishWindowPrice on expiry           │
                │   └────────────────────────────────────────────────┘
                │
                ▼
        confidentialTransfer back to user (ERC-7984 cUSDC).
        Calldata, events, balances — all ciphertext.
```

Everything is on **Ethereum Sepolia (chainId 11155111)**. There is no cross-chain bridge, no L2 hop, no offchain order book.

---

## Privacy Model — What's Public, What's Encrypted

```
ON-CHAIN (Ethereum Sepolia, anyone can read)
─────────────────────────────────────────────────────────────────────────────
WHAT IS PUBLIC                          WHAT IS FHE-ENCRYPTED
──────────────                          ─────────────────────
Market ID                               Vault deposit amount     (euint64)
Market title / category / expiry        Vault balance per user   (euint64)
User EOA address                        Per-market lock amount   (euint64)
Bet side (YES or NO)                    Total locked per user    (euint64)
Market status (Active / Resolved)       YES pool total           (euint64)
Resolved outcome (binary)               NO pool total            (euint64)
Sealed-window start / end / settled     Per-user YES position    (euint64)
Tx hashes + block timestamps            Per-user NO position     (euint64)
                                        Pre-window pool snapshot (euint64)
                                        Payout amount handle     (euint64)
                                        Confidential transfers   (euint64)
```

**Events deliberately strip amount fields.** For example:

```solidity
event BetPlaced  (uint256 indexed marketId, address indexed user, bool indexed side);
event Deposited  (address indexed user);
event Withdrawn  (address indexed user);
event BetLocked  (address indexed user, bytes32 indexed marketId, bool side);
event PayoutClaimed(address indexed user, bytes32 indexed marketId);
```

Notice: zero `amount` parameters. Compare this to any standard prediction market.

The ACL model (enforced by Zama coprocessor):

| Role | Can decrypt | How |
|---|---|---|
| **User (self)** | Own vault balance, own lock, own position | `FHE.allow(handle, msg.sender)` on every write |
| **Contract** | Its own ciphertexts (for re-use in arithmetic) | `FHE.allowThis(handle)` |
| **Oracle resolver** | Pool totals **only after** market resolution or sealed-window settlement | `FHE.allow(pool, resolver)` in `resolveMarket` / `settleSealedWindow` |
| **Winner's position** | Granted to oracle only after `grantPositionAccess` post-resolution | Single-use grant per resolution |
| **Other traders** | Never. No ACL entry is ever written for third parties. | — |

---

## The Encrypted Stack, in Depth

### 1. ERC-7984 cUSDC Custody — encrypted money on rails

The collateral asset is **Zama's canonical Sepolia confidential USDC** — a wrapper around a public mock USDC that implements [ERC-7984](https://eips.ethereum.org/EIPS/eip-7984):

| Layer | Address (Sepolia) | Role |
|---|---|---|
| Underlying mock USDC (public ERC-20, mintable) | `0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF` | Faucet token — users mint, then wrap |
| cUSDC Mock wrapper (ERC-7984 confidential) | `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639` | The encrypted version users actually deposit |

ERC-7984 is the "encrypted balance" standard built on Zama's FHEVM:

- `confidentialBalanceOf(user)` returns an **encrypted handle** — even calling `balanceOf` reveals nothing.
- `confidentialTransfer(to, encAmount)` moves encrypted value between users.
- `setOperator(spender, untilTimestamp)` is the encrypted-token replacement for ERC-20 `approve` — the spender (e.g. `GhostVaultV2`) becomes authorised to call `confidentialTransferFrom(user, ...)` for the validity period.

**GhostVaultV2** (`contracts/contracts/GhostVaultV2.sol`) is the protocol's confidential bank:

```solidity
contract GhostVaultV2 is ZamaEthereumConfig, ReentrancyGuard, Pausable, Ownable2Step, EIP712 {
    IERC7984 public immutable collateral;                 // cUSDC

    mapping(address => euint64)                        _balances;
    mapping(address => mapping(bytes32 => euint64))    _lockedAmounts;
    mapping(address => euint64)                        _totalLocked;
}
```

`deposit(externalEuint64 encAmount, bytes proof)` is **the single most interesting function in the codebase**:

1. The user already called `setOperator(vault, untilForever)` on cUSDC.
2. They encrypt the deposit amount client-side, producing `(encAmount, proof)` bound to `(GhostVaultV2, msg.sender)`.
3. Vault verifies the proof via `FHE.fromExternal`.
4. Vault calls `FHE.allowThis(amount)` and `FHE.allow(amount, address(collateral))` — granting the cUSDC token contract permission to use the handle in its internal FHE arithmetic.
5. Vault calls `collateral.confidentialTransferFrom(user, vault, amount)`. The token uses the user's encrypted balance and the operator allowance to homomorphically subtract `amount` and credit the vault — **all without ever decrypting**.
6. Vault accumulates the transferred handle into the user's encrypted vault balance.

Withdraws, locks, and unlocks all follow the same handle-only pattern. There is no `uint256 balance` anywhere on the vault.

**`lockForBet` is also worth highlighting:**

```solidity
ebool   isSufficient    = FHE.ge(free, amount);
euint64 effectiveAmount = FHE.select(isSufficient, amount, FHE.asEuint64(0));
```

The vault cannot revert on an encrypted comparison (the EVM never sees the plaintext). Instead, an overdraw is silently clamped to zero via `FHE.select`. Same trick as the EAMM's minimum-bet guard — branching happens **inside** the coprocessor, the EVM only handles ciphertext handles.

### 2. GhostEAMM — Encrypted AMM

`contracts/contracts/GhostEAMM.sol` is the confidential execution layer. Three things make it interesting:

**(a) Pool totals are ciphertexts, accumulated homomorphically.**

```solidity
m.yesPool = FHE.add(m.yesPool, effectiveAmount);
FHE.allowThis(m.yesPool);
```

No party — not the resolver, not the contract owner, not the deployer — has standing ACL access to the pool until either the market resolves or a sealed window settles.

**(b) Minimum-bet guard, enforced homomorphically.**

You can't write `require(amount >= 1 USDC)` against ciphertext. Instead:

```solidity
ebool   aboveMin        = FHE.gt(amount, FHE.asEuint64(MIN_BET_UNITS));   // encrypted bool
euint64 effectiveAmount = FHE.select(aboveMin, amount, FHE.asEuint64(0)); // encrypted ternary
```

Dust bets are silently neutralised. The chain never learns whether a particular submission was above or below threshold — the proof of which is the centerpiece of the contract's "encrypted conditional logic" pattern.

**(c) Per-user position handles, ACL-scoped.**

```solidity
_yesPositions[marketId][msg.sender] = FHE.add(_yesPositions[marketId][msg.sender], effectiveAmount);
FHE.allowThis(_yesPositions[marketId][msg.sender]);
FHE.allow    (_yesPositions[marketId][msg.sender], msg.sender);   // <-- user can re-encrypt own position
```

The user can pull their own position handle and decrypt it via the Zama gateway's `userDecrypt` re-encryption flow. Nobody else can. After resolution, the resolver gets one-shot access to *only the winning side* of *one specific user* per call to `grantPositionAccess`.

### 3. Sealed-Bid Windows — time-batched, frontrun-proof price reveal

Even with encrypted bets, there's a subtle leakage path: if **decrypted** post-bet pool prices are continuously visible, a trader can place a tiny probe bet, watch the price tick, and infer the previous bet's size from the delta.

Sealed-bid windows close that hole. They're a novel mechanism in this stack and arguably the most interesting product surface:

```solidity
struct SealedWindow {
    uint64  startsAt;
    uint64  endsAt;
    bool    settled;
    euint64 yesPoolSnapshot;   // handle that points to the pool state AT window-open
    euint64 noPoolSnapshot;
}
```

The flow:

1. **`openSealedWindow(marketId, durationSecs)`** — snapshots the *current* pool handles. Because every `FHE.add` produces a fresh handle, the snapshot handles remain frozen at the pre-window state forever.
2. **During the window**, `placeBet` continues to land encrypted bets. New `FHE.add` calls produce new handles for the live pools — but **no party is granted ACL on the new handles yet**, so the live totals stay opaque to everyone, including the oracle. The frontend shows the snapshot-derived odds.
3. **Window expires** — `placeBet` is gated by a `WindowSettlementPending` revert until settlement happens, preventing a sneak-in-bet between expiry and ACL-grant.
4. **Oracle watcher** (`oracle/src/sealed-window-watcher.ts`, polling at 10s default) calls `settleSealedWindow(marketId, idx)` — the contract `FHE.allow`s the resolver on both the post-window pool handles **and** the snapshots.
5. Watcher does a Zama `userDecrypt` (re-encryption EIP-712 flow with an ephemeral keypair) of the post-window pools, computing actual totals.
6. Watcher calls **`publishWindowPrice(marketId, idx, yesTotal, noTotal)`** which emits `PriceRevealed`. The frontend (`web/src/components/sealed-countdown.tsx`) animates the reveal — the price visibly jumps as the batched bets land at once.

This is **commit-reveal without the user ceremony**. Traders aren't asked to "come back and reveal" — the clock is the reveal, the bet was real the whole time, and nobody owes a second transaction.

Public surface of a window: `startsAt`, `endsAt`, `settled`, ciphertext snapshot handles, on-chain `PriceRevealed` event after settlement. Public surface during the window: nothing. The combined delta is published as a single event after the window closes, so no participant inside the window can chart anyone else's order flow.

### 4. Oracle Room — AI agent quorum

`oracle/` is a standalone Node.js HTTP + WebSocket server (port 8092) that runs the agent swarm.

**Agent definitions** (`oracle/src/agents.ts`):

| ID | Name | Source | Personality |
|---|---|---|---|
| 1 | Cipher  | Binance       | Data-driven analyst; only trusts on-chain + top-tier CEX feeds |
| 2 | Specter | CoinGecko     | Cautious risk assessor; requires high-confidence signals for YES |
| 3 | Wraith  | Chainlink*    | Prioritises on-chain oracle feeds over off-chain price data |
| 4 | Phantom | Coinbase      | Contrarian; stress-tests the consensus, probes edge cases |
| 5 | Shade   | Kraken        | Consensus-seeker; cross-references multiple signals |
| 6 | Echo    | OKX           | Aggregator; synthesises across sources, weights by volume |
| 7 | Vex     | Bybit         | Adversarial tester; actively looks for manipulation / stale data |

\* CryptoCompare used as a public proxy for Chainlink-style aggregated pricing on testnet.

Configurable agent count via `ACTIVE_ORACLE_AGENTS` (default 4). Quorum is `floor(N/2)+1` (so 3-of-4, or 4-of-7 if all definitions are active).

**Per-agent resolution flow** (`oracle/src/index.ts`):

1. `fetching` → hits its source's public API (`oracle/src/fetcher.ts`) with a 6s timeout. Public, unauthenticated endpoints — no API keys required. Endpoints cover BTC/ETH/SOL/XRP/DOGE/ADA/TON spot, Base TVL via DeFiLlama, Fed Funds via US Treasury FiscalData, and policy/macro markets via reasoning fallback.
2. `attesting` → injects the fetched value into a personality-specific OpenAI prompt (default `gpt-4o-mini`, 9s timeout, JSON-only output). The agent returns `{vote: YES|NO, reasoning: "2-3 sentences"}` grounded in the real number it just fetched.
3. `submitted` → records the vote.
4. When quorum is reached, the oracle:
   - Marks the market finalised in memory.
   - Calls `GhostEAMM.resolveMarket(marketId, outcome)` on Sepolia.
   - Begins serving signed settlements via `POST /oracle/settle/:marketId`.
5. Reputation scores update: +2 for correct vote, –10 for wrong (in-memory, persists across the session).

**Frontend `Oracle Room`** (`web/src/components/oracle-room.tsx`, ~1250 LOC of real-time UX):

- WebSocket subscription per market — live agent state transitions, real reasoning text, vote tallies, and on-chain tx hashes scroll as they happen.
- "Resolve market" button triggers `POST /oracle/resolve/:marketId`.
- Visible: source URLs the agents are pulling, the actual reasoning each agent returned, the tx hash of the on-chain `resolveMarket` call, and the per-user settlement claim status.

The oracle is the demo's most "AI-native" surface — every line of reasoning the audience sees is a live LLM response grounded in a real fetch, not pre-canned text.

### 5. Confidential Settlement — signing over ciphertext handles

This is the part that closes the loop. After quorum, the oracle has to issue a payout claim that the user can present to GhostVault to get their cUSDC. **It does this without ever knowing or revealing the plaintext payout.**

The EIP-712 schema in `GhostVaultV2`:

```solidity
bytes32 public constant CLAIM_TYPEHASH = keccak256(
    "Claim(address user,bytes32 marketId,bytes32 amountHandle,uint256 nonce,uint256 expiry)"
);
```

Note `amountHandle` is `bytes32` — the **encrypted handle** of an `euint64`, not a `uint256` amount.

The oracle (`oracle/src/oracle-signer.ts`) signs over the handle of the user's locked-collateral position. The vault verifies and immediately calls `collateral.confidentialTransfer(user, amount)` — passing the same encrypted handle through to cUSDC, which homomorphically debits the vault and credits the user.

**The plaintext payout amount exists only in two places, ever:**

1. The user's own browser when they decrypt their position handle to display "you have 12.50 USDC pending".
2. The user's own browser when they decrypt their cUSDC balance after the claim lands.

It never exists in: the oracle's memory, the oracle's database, the vault's storage, the cUSDC token's storage, the calldata, the events, or any block explorer.

Replay protection: `usedNonces[user][marketId][nonce]` triple. Expiry enforcement: 24-hour TTL. Signer rotation: `setSettlementSigner(newOracle)` from vault owner.

### 6. Walletless onboarding via Privy

`web/src/lib/privy/` integrates [Privy](https://privy.io) for embedded wallets. The user signs in with Google / email / passkey and an EOA is created for them in-browser — same address every time they log in, same Sepolia identity. No mnemonic, no extension, no faucet step before login.

That EOA signs:

- The cUSDC `setOperator` tx (one-time per session).
- The Zama relayer-SDK EIP-712 re-encryption authorisations.
- The Vault `deposit`/`lockForBet`/`claimPayout` txs.
- The EAMM `placeBet` tx.

The bet-slip flow (`web/src/components/bet-slip.tsx`) chains operator-set → vault-deposit (if low) → lock-collateral → encrypt-bet → place-bet automatically, with stepwise UI ("encrypting…", "locking…", "signing…"). The user clicks one button.

---

## End-to-End User Journey

### Phase 1 — Discover

1. Land on `/` — see active markets with implied odds drawn from the public market metadata + (post-sealed-window) revealed pool ratios.
2. Click a market → `/markets/[id]`. The `MarketDetailLeftPanel` shows the title, expiry, category, source-of-truth blurb, the live YES/NO odds (or the frozen snapshot odds if a sealed window is active), and the `SealedCountdown` overlay if relevant.

### Phase 2 — Onboard (first-time only)

3. Click **YES** or **NO** → the `BetSlip` opens, prompting **Sign in with Google**.
4. Privy creates an embedded EOA. The address is shown in the navbar — no mnemonic.

### Phase 3 — Fund the encrypted vault

5. Navigate to `/vault`.
6. The page detects the user's underlying USDC balance, cUSDC balance, and vault balance handle.
7. **Mint** flow if needed (mock underlying USDC has public `mint`).
8. **Wrap** → calls `cUSDCMock.wrap(user, amount)` (after approving the wrapper to pull the underlying ERC-20).
9. **setOperator** → makes the vault authorised to call `confidentialTransferFrom` on the user's cUSDC.
10. **Deposit** → client-side encrypt the amount; submit `GhostVaultV2.deposit(encAmount, proof)`. The vault's stored balance for this user is now an `euint64`.

### Phase 4 — Shielded bet

11. Back in the bet-slip, enter an amount, click **Place bet**.
12. UI runs: `encrypt(amount) for vault` → `lockForBet(marketId, side, encAmount, proof)` → `encrypt(amount) for EAMM` → `placeBet(marketId, side, encAmount, proof)` — all in one chained click.
13. `BetPlaced` emits; the explorer log shows market + user + side, **no amount**.
14. If a sealed window is active, the displayed odds don't move. The user's bet is in the pool, but the pool delta won't surface until the window settles.

### Phase 5 — Sealed-window reveal (optional)

15. If admin opened a window (`GhostMarket.openSealedWindow(id, durationSecs)`), the `SealedCountdown` shows a ticking timer with the frozen snapshot price.
16. Bets pile in encrypted during the window — from this user, from a second incognito user, from anyone.
17. Timer hits zero → "Settling…" indicator.
18. Watcher settles + decrypts + publishes → `PriceRevealed` emitted → UI flashes the new price.

### Phase 6 — Resolution

19. Market expiry (or admin trigger) → user navigates to `/oracle` for the chosen market, clicks **Resolve**.
20. The Oracle Room WebSocket subscribes; agents start spinning in real time. The user sees each agent's fetched price, each agent's LLM reasoning, each vote.
21. Quorum reached → `GhostEAMM.resolveMarket(id, outcome)` tx hash appears live.
22. Oracle has finalised the outcome; settlement endpoint goes live.

### Phase 7 — Claim payout

23. `/portfolio` shows the user's positions per market, marked claimable when the oracle has finalised.
24. User clicks **Claim** → frontend hits `POST /oracle/settle/:marketId` with their address → receives an EIP-712 signed claim over their `amountHandle`.
25. Frontend submits `GhostVaultV2.claimPayout(marketId, amountHandle, nonce, expiry, sig)`.
26. Vault verifies sig + nonce + expiry, releases the lock, calls `cUSDC.confidentialTransfer(user, amountHandle)`. The user's encrypted cUSDC balance ticks up.
27. The user can now `withdraw(encAmount, proof)` from the vault back to their cUSDC, then unwrap to underlying USDC if desired.

Every step above logs an event with **no plaintext amounts**.

---

## Compliance Model

GhostMarket's privacy is **trader-private, not authority-private**.

- A user can always re-encrypt and view their own positions, balances, and locks via the Zama gateway.
- A regulator can be issued an ACL grant to specific handles via a contract upgrade or a new admin function — the cryptography supports it.
- Block explorers see who interacted with what contract, when, on which side — they just don't see size.

This is the same shape as institutional dark pools in TradFi: execution size is private from other participants, but reportable through defined access paths. Selective disclosure is a feature of the model, not a workaround for it.

---

## Deployed Contracts (Sepolia)

All on **Ethereum Sepolia, chainId 11155111**. Wired so `GhostMarket` is the only admin entry point — it's set as both `marketManager` and `resolver` on the EAMM. The deployed oracle EOA is the EAMM's underlying resolver/owner and the vault's `settlementSigner`.

| Component | Address |
|---|---|
| Underlying USDC mock (public mint, ERC-20) | [`0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF`](https://sepolia.etherscan.io/address/0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF) |
| cUSDC Mock wrapper (ERC-7984 confidential) | [`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`](https://sepolia.etherscan.io/address/0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639) |
| `GhostEAMM.sol` (encrypted AMM + sealed windows) | [`0xab7562Cfb1C57aF0975988bDC3e5403C228c0F5E`](https://sepolia.etherscan.io/address/0xab7562Cfb1C57aF0975988bDC3e5403C228c0F5E) |
| `GhostVaultV2.sol` (cUSDC custody + settlement) | [`0xddd9551a02B27a798510d88f6Eda9D9BB3BdB48f`](https://sepolia.etherscan.io/address/0xddd9551a02B27a798510d88f6Eda9D9BB3BdB48f) |
| `GhostMarket.sol` (metadata + lifecycle entry) | [`0xbD4fBBD2789466e2F38B47b25648839c68F9Bfd0`](https://sepolia.etherscan.io/address/0xbD4fBBD2789466e2F38B47b25648839c68F9Bfd0) |

The Zama mock USDC and cUSDC Mock are Zama's [canonical Sepolia addresses](https://docs.zama.org/protocol/protocol-apps/addresses/testnet/sepolia) — anyone with USDC there can use the same vault.

**Zama protocol infrastructure used (Sepolia):**

| Component | Endpoint |
|---|---|
| FHEVM coprocessor | Wired via `@fhevm/solidity` `ZamaEthereumConfig` at compile time |
| Relayer | `https://relayer.testnet.zama.org` (auto-configured by `SepoliaConfig` / `SepoliaConfigV2` in `@zama-fhe/relayer-sdk`) |
| KMS gateway | Embedded in relayer SDK; used for `userDecrypt` re-encryption flow |

---

## Repository Layout

```
GhostMarket/
├── contracts/                        — Hardhat workspace (Solidity 0.8.26, viaIR, optimizer 200)
│   ├── contracts/
│   │   ├── GhostEAMM.sol             — FHE encrypted AMM + sealed-bid windows
│   │   ├── GhostVaultV2.sol          — ERC-7984 cUSDC custody + EIP-712 settlement
│   │   ├── GhostMarket.sol           — Metadata registry + lifecycle forwarder
│   │   └── MockUSDC.sol              — Optional plaintext-mode test ERC-20 (Zama mock used by default)
│   ├── legacy/                       — Archived v1 plaintext vault, not deployed
│   ├── scripts/
│   │   ├── deploy-sepolia.ts         — Full Sepolia stack deployment (use this)
│   │   ├── redeploy-eamm.ts          — EAMM-only upgrade (auto-rewires GhostMarket)
│   │   ├── demo-sealed-window.ts     — Seed a 5-min sealed-window market for demo
│   │   ├── seed-markets.ts           — Seed canonical demo market set
│   │   ├── seed-3-markets.ts         — Smaller demo seed
│   │   ├── seed-eamm-bet.ts          — Place a test encrypted bet
│   │   ├── sync-markets-to-eamm.ts   — Reconcile metadata ↔ EAMM after partial redeploys
│   │   ├── update-settlement-signer.ts — Rotate the oracle key on GhostVaultV2
│   │   └── fund-wallet.ts            — Send Sepolia ETH from deployer to a target wallet
│   ├── test/
│   │   ├── GhostEAMM.test.ts         — FHE bet flow, sealed-window lifecycle, ACL grants, min-bet guard
│   │   └── GhostMarket.test.ts       — Legacy v1 self-contained market suite (kept for reference)
│   └── hardhat.config.ts             — Sepolia + Hardhat-local FHE-mock networks
│
├── oracle/                           — Node.js oracle service (port 8092)
│   └── src/
│       ├── index.ts                  — Express + WebSocket server, per-market resolution sessions
│       ├── agents.ts                 — 7 agent personality definitions
│       ├── fetcher.ts                — Public-API fetchers (Binance/CoinGecko/Coinbase/Kraken/OKX/Bybit/CryptoCompare/DeFiLlama/FRED)
│       ├── eamm-resolver.ts          — On-chain GhostEAMM.resolveMarket + grantPositionAccess
│       ├── settlement.ts             — Per-user EIP-712 claim caching
│       ├── oracle-signer.ts          — EIP-712 signing of Claim over `amountHandle`
│       ├── sealed-window-watcher.ts  — Settles expired windows, decrypts pools via Zama KMS, publishes PriceRevealed
│       └── sepolia-keys.ts           — Centralised key loader (oracle / resolver / settlement signer)
│
├── web/                              — Next.js 15 frontend (React 19, Tailwind v4, Privy v3, viem v2)
│   └── src/
│       ├── app/
│       │   ├── page.tsx              — Market homepage
│       │   ├── markets/[id]/page.tsx — Market detail + bet slip
│       │   ├── vault/page.tsx        — Underlying mint → wrap → setOperator → deposit / withdraw
│       │   ├── portfolio/page.tsx    — Per-user positions + claim
│       │   ├── oracle/page.tsx       — Oracle Room (live agent dashboard)
│       │   ├── admin/page.tsx        — createMarket / openSealedWindow (resolver-only)
│       │   └── api/oracle/…          — Frontend proxy to the Node oracle service
│       ├── components/
│       │   ├── bet-slip.tsx          — Shielded-bet chain (encrypt → lock → encrypt → place)
│       │   ├── sealed-countdown.tsx  — Window countdown + reveal animation
│       │   ├── oracle-room.tsx       — Live agent state + WebSocket subscription
│       │   ├── portfolio-position-row.tsx — Decrypt-on-demand position display
│       │   ├── market-detail-left-panel.tsx
│       │   └── ui/                   — shadcn-style primitives (Button, Badge, Input)
│       └── lib/
│           ├── eamm.ts               — relayer-sdk init, encryption helpers, EAMM ABI + reads/writes, sealed-window subscriptions
│           ├── vault.ts              — GhostVaultV2 + cUSDC helpers (wrap, setOperator, deposit, lock, claim, withdraw)
│           ├── cusdc.ts              — Mock USDC + cUSDC Mock ABIs
│           ├── oracle-client.ts      — Oracle REST + WS typed client
│           ├── privy/                — Privy provider + embedded wallet helpers
│           └── market.ts             — GhostMarket metadata reads
│
└── api/                              — FastAPI orchestration layer (optional, secondary surface)
    ├── main.py                       — Health + router mount (port 8000)
    └── routers/                      — markets / portfolio / auth / relayer / oracle proxy
```

---

## Running Locally

### Prerequisites

- Node.js ≥ 18
- A Sepolia RPC URL (Alchemy / Infura strongly preferred over public RPCs for the relayer SDK)
- A funded Sepolia EOA (for gas on deploys + admin operations; about 0.1 ETH covers a full redeploy + a dozen markets)
- An OpenAI API key (optional; the oracle falls back to deterministic reasoning if missing)

### 1. Deploy the contracts (Sepolia)

```bash
cd contracts
npm install
cp .env.example .env
# Fill in DEPLOYER_PRIVATE_KEY, ORACLE_PRIVATE_KEY, SEPOLIA_RPC_URL.
# For testnet you can reuse the same key for both.

npx hardhat compile
npx hardhat run scripts/deploy-sepolia.ts --network sepolia
```

The script prints exact lines to paste into `contracts/.env`, `oracle/.env`, and `web/.env.local`. **Update all three in one pass** — partial updates leave the EAMM pointer mismatched and break the sealed-window flow.

Defaults: collateral = Zama's canonical Sepolia `cUSDCMock` (`0x7c5B…`); to use a freshly deployed plaintext `MockUSDC.sol` + legacy plaintext vault instead, set `USE_ZAMA_SEPOLIA_MOCK_USDC=0` (and pull v1 from `contracts/legacy/`; not recommended).

### 2. Seed test markets

```bash
# From contracts/
npx hardhat run scripts/seed-3-markets.ts --network sepolia
# Or the full demo set:
npx hardhat run scripts/seed-markets.ts --network sepolia
```

Optionally open a sealed-bid window for the demo:

```bash
npx hardhat run scripts/demo-sealed-window.ts --network sepolia
# Note the market ID printed. Set WATCHED_MARKETS=<id> in oracle/.env.
```

### 3. Oracle service

```bash
cd oracle
npm install
cp .env.example .env
# Required: SEPOLIA_RPC_URL, SEPOLIA_PRIVATE_KEY (== ORACLE_PRIVATE_KEY from contracts/),
#           GHOST_EAMM_ADDRESS, GHOST_VAULT_ADDRESS, GHOST_MARKET_ADDRESS,
#           GHOST_VAULT_EIP712_VERSION=2  (V2 vault domain)
# Optional: OPENAI_API_KEY, ORACLE_REASONING_MODEL, ACTIVE_ORACLE_AGENTS,
#           WATCHED_MARKETS, WINDOW_POLL_MS
npm run dev
# HTTP: http://localhost:8092/oracle/health
# WS:   ws://localhost:8092/oracle/ws/:marketId
```

The sealed-window watcher starts automatically and polls every 10 s.

### 4. Web frontend

```bash
cd web
npm install
cp .env.local.example .env.local
# Fill in the NEXT_PUBLIC_* addresses from the deploy output,
# NEXT_PUBLIC_PRIVY_APP_ID from privy.io,
# NEXT_PUBLIC_SEPOLIA_RPC_URL,
# NEXT_PUBLIC_ORACLE_URL=http://localhost:8092
npm run dev
# http://localhost:3000
```

### 5. Optional: FastAPI orchestration layer

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r api/requirements.txt
uvicorn api.main:app --reload
# http://localhost:8000/docs
```

The frontend works without this. It's an orchestration surface for relay/server-side flows that don't belong in the browser.

---

## Testing

### Smart-contract tests

```bash
cd contracts
npx hardhat test --network hardhat       # mock FHE — fast (CI-friendly)
npx hardhat test --network sepolia       # real FHE — slow, costs gas
```

`@fhevm/hardhat-plugin` runs FHE in mock mode on the default Hardhat network so tests don't need the relayer. The suite covers:

```
GhostEAMM
  deployment            ✔ owner/marketManager/resolver set
  createMarket          ✔ manager + owner authorised
                        ✔ duplicate-market revert
                        ✔ pool handles initialised to trivially-encrypted zero
  placeBet              ✔ encrypted YES + NO bets accepted
                        ✔ BetPlaced event has exactly 3 args, no amount
                        ✔ self-decrypt of own position succeeds
                        ✔ cross-decrypt of another user's position is rejected
                        ✔ multi-bet accumulation in encrypted pool
                        ✔ expired / non-existent market reverts
  minimum-bet guard     ✔ MIN_BET_UNITS exposed, non-zero
                        ✔ above-min records non-zero handle equal to amount
                        ✔ below-min silently zeroed (no dust position)
  resolveMarket         ✔ resolver + owner can resolve
                        ✔ unauthorized revert
                        ✔ double-resolve revert
                        ✔ post-resolve placeBet revert
  cancelMarket          ✔ resolver authorised, others revert
  grantPositionAccess   ✔ winner-only ACL after YES resolution
                        ✔ both-side ACL after cancellation
                        ✔ rejects users with no position
                        ✔ rejects active markets
  sealed-bid windows    ✔ manager + owner open windows; non-manager reverts
                        ✔ duration below MIN_WINDOW_SECS reverts
                        ✔ second window while first pending reverts
                        ✔ snapshot handles non-zero
                        ✔ bets accepted during open window
                        ✔ bets blocked between window expiry and settlement
                        ✔ settle-before-expiry reverts
                        ✔ resolver settles + decrypts pool ciphertexts after settle
                        ✔ double-settle reverts
                        ✔ bets re-open after settle
                        ✔ publishWindowPrice emits PriceRevealed
                        ✔ publish on unsettled window reverts
                        ✔ getActiveWindowIdx returns max-uint when none / settled
  admin                 ✔ Ownable2Step admin updates
                        ✔ pause / unpause gate state changes
```

### Oracle smoke test

With the oracle running:

```bash
curl http://localhost:8092/oracle/health
curl -X POST http://localhost:8092/oracle/resolve/21 -H 'content-type: application/json' \
  -d '{"outcome": true, "marketTitle": "Will BTC trade above $150,000?"}'
```

Then open `/oracle?marketId=21` in the web app and watch the agents tick through `fetching → attesting → submitted → quorum → finalized` in real time.

---

## Operational Notes

- **Always full-deploy, don't single-redeploy.** `deploy-sepolia.ts` wires `GhostMarket → GhostEAMM` with `setMarketManager` + `setResolver`. Redeploying only the EAMM without also calling `GhostMarket.setEamm` (or using `scripts/redeploy-eamm.ts` which handles it) will leave metadata on one EAMM and encrypted state on another. Symptoms: bets land but `placeBet` reverts with `MarketNotFound`.
- **The EIP-712 domain version is `"2"`.** `GhostVaultV2` uses `EIP712("GhostVault", "2")`. The oracle defaults to version `2`; set `GHOST_VAULT_EIP712_VERSION` only if pointing at the legacy v1 vault in `contracts/legacy/`.
- **The settlement signer must equal the on-chain `settlementSigner`.** After redeploying the vault, run `scripts/update-settlement-signer.ts` if you want to use a different oracle key.
- **Sealed windows need a watcher.** Add the market ID to `WATCHED_MARKETS` in `oracle/.env` and restart the oracle, or rely on dynamic discovery via the `SealedWindowOpened` event listener.
- **Mainnet swap.** Replace the underlying USDC + cUSDC addresses with Circle USDC + a production ERC-7984 wrapper. Zero vault, EAMM, or frontend code changes required — only `.env` addresses.

---

## Roadmap

- **Multi-decimal markets.** `euint64` covers up to ~1.8 × 10^19 base units; future versions can stack `euint128` for jumbo positions.
- **Permissioned ACL grants for regulators.** Selective disclosure to an auditor's hardware-bound key, on demand.
- **TEE-based oracle agents.** Move LLM reasoning into attested enclaves so each agent's attestation is publicly verifiable, not just trusted.
- **Per-market sealed-window scheduling.** Currently admin-triggered; can be automated on a fixed cadence or volume threshold.
- **MEV-resistant payout claims.** Bundle the claim through a private relayer so the act of claiming doesn't itself broadcast the user's identity to mempool watchers.

---

<div align="center">

**The chain knows you bet. It does not know on what, in what size, or for how much.**

That's the difference between a redacted form and a receipt that doesn't exist.

</div>
