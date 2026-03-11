// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title GhostVault
 * @notice Consumer-facing custody vault on Flow EVM.
 *
 * Responsibilities (Phase 2):
 *  - Accept FLOW deposits from users or a trusted relayer (gasless path).
 *  - Track per-user balances.
 *  - Allow withdrawals back to user addresses.
 *
 * Collateral model:
 *  - Before placing an encrypted bet on GhostEAMM (Sepolia), the user calls
 *    lockForBet() here to commit their stake.  This prevents withdrawing
 *    collateral between bet placement and settlement, closing the insolvency
 *    vector inherent in cross-chain bet systems.
 *  - lockForBet is a two-layer privacy design: the locked amount is visible on
 *    Flow EVM (the user's own custody record), while the bet itself remains
 *    FHE-encrypted on Zama and is hidden from other market participants.
 *  - At settlement the Lit PKP verifies decrypted bet ≤ locked amount, then
 *    signs a settlement message with the net payout.  claimPayout atomically
 *    releases the lock and credits the payout.
 *
 * Responsibilities (Phase 6 — stub included):
 *  - Accept attested payout messages from an authorised settlement signer.
 *  - Enforce nonce-based replay protection per market per user.
 *
 * Safety:
 *  - ReentrancyGuard on deposit, withdraw, lockForBet, and claimPayout.
 *  - Pausable circuit breaker.
 *  - Ownable2Step: new owner must explicitly accept before transfer completes.
 */
contract GhostVault is ReentrancyGuard, Pausable, Ownable2Step {

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Total vault balance per user (in wei / 1e-18 FLOW).
    mapping(address => uint256) public balances;

    /// @notice Collateral locked per user per market — cannot be withdrawn.
    mapping(address => mapping(bytes32 => uint256)) public lockedAmounts;

    /// @notice Sum of all per-market locks for a user (for O(1) free-balance check).
    mapping(address => uint256) public totalLocked;

    /**
     * @notice Authorised settlement signer for Phase 6 attested payouts.
     * Set at deploy time; owner can rotate it.
     */
    address public settlementSigner;

    /// @notice Replay-protection: tracks consumed (user, marketId, nonce) triples.
    mapping(address => mapping(bytes32 => mapping(uint256 => bool))) public usedNonces;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event BetLocked(address indexed user, bytes32 indexed marketId, uint256 amount);
    event BetUnlocked(address indexed user, bytes32 indexed marketId, uint256 amount);
    event PayoutClaimed(address indexed user, bytes32 indexed marketId, uint256 amount);
    event SettlementSignerUpdated(address indexed previous, address indexed next);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error InsufficientBalance(uint256 have, uint256 need);
    error TransferFailed();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error PayoutExpired();
    error ZeroAmount();
    error ZeroAddress();
    error BetAlreadyLocked(bytes32 marketId);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _settlementSigner) Ownable(msg.sender) {
        if (_settlementSigner == address(0)) revert ZeroAddress();
        settlementSigner = _settlementSigner;
    }

    // ─── Deposit ──────────────────────────────────────────────────────────────

    /**
     * @notice Direct deposit: user calls this and pays their own gas.
     *         Gas cost on Flow EVM is ~$0.0001 so this is acceptable.
     */
    function deposit() external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice Relayer deposit: backend calls this on behalf of the user,
     *         paying gas from the relayer wallet. The FLOW sent as msg.value
     *         is credited to `user`.
     */
    function depositFor(address user) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        if (user == address(0)) revert ZeroAddress();
        balances[user] += msg.value;
        emit Deposited(user, msg.value);
    }

    // ─── Collateral locking ───────────────────────────────────────────────────

    /**
     * @notice Lock `amount` as collateral for an encrypted bet on GhostEAMM.
     *
     * Call this on Flow EVM BEFORE calling placeBet() on GhostEAMM (Sepolia).
     * The locked amount cannot be withdrawn until claimPayout() settles the
     * market, preventing collateral drainage between bet and resolution.
     *
     * Privacy note: `amount` is a plaintext value visible in this transaction's
     * calldata on Flow EVM.  This is intentional — it is the user's own custody
     * record.  The corresponding bet on GhostEAMM remains FHE-encrypted and
     * invisible to other market participants on Zama.
     *
     * @param marketId  The GhostEAMM market ID (bytes32, hashed from uint256).
     * @param amount    Exact stake in wei — must match the encrypted bet amount.
     */
    function lockForBet(
        bytes32 marketId,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (lockedAmounts[msg.sender][marketId] != 0) revert BetAlreadyLocked(marketId);

        uint256 free = balances[msg.sender] - totalLocked[msg.sender];
        if (free < amount) revert InsufficientBalance(free, amount);

        lockedAmounts[msg.sender][marketId] = amount;
        totalLocked[msg.sender] += amount;

        emit BetLocked(msg.sender, marketId, amount);
    }

    // ─── Withdraw ─────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw free (unlocked) FLOW from the vault back to msg.sender.
     *         Locked collateral is excluded — it cannot be withdrawn until the
     *         corresponding market settles via claimPayout().
     *         Follows CEI: balance updated before the external call.
     */
    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 free = balances[msg.sender] - totalLocked[msg.sender];
        if (free < amount) revert InsufficientBalance(free, amount);

        // ── Effect before interaction ─────────────────────────────────────────
        unchecked { balances[msg.sender] -= amount; }

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ─── Payout claim (Phase 6 stub) ──────────────────────────────────────────

    /**
     * @notice Claim a payout after oracle quorum + Lit attestation (Phase 6).
     *
     * If collateral was locked for this market via lockForBet(), claimPayout
     * atomically:
     *   1. Releases the lock (frees it from totalLocked).
     *   2. Debits the original stake from balances.
     *   3. Credits the attested payout amount.
     *
     * For winners: payout > stake → net gain.
     * For losers:  payout = 0    → stake is consumed, net loss.
     * If no lock existed (e.g. legacy / demo flow): payout is credited as-is.
     *
     * The settlement signer signs the following EIP-191 message:
     *   keccak256(abi.encodePacked(
     *     "\x19Ethereum Signed Message:\n32",
     *     keccak256(abi.encode(user, marketId, amount, nonce, expiry, address(this)))
     *   ))
     *
     * @param marketId  Unique identifier for the resolved market.
     * @param amount    Net payout in wei (winners: > stake; losers: 0).
     * @param nonce     Per-market nonce; must be unused for (user, marketId).
     * @param expiry    Unix timestamp after which this claim is invalid.
     * @param sig       65-byte ECDSA signature from `settlementSigner`.
     */
    function claimPayout(
        bytes32 marketId,
        uint256 amount,
        uint256 nonce,
        uint256 expiry,
        bytes calldata sig
    ) external nonReentrant {
        if (block.timestamp > expiry) revert PayoutExpired();
        if (usedNonces[msg.sender][marketId][nonce]) revert NonceAlreadyUsed();

        bytes32 msgHash = keccak256(
            abi.encode(msg.sender, marketId, amount, nonce, expiry, address(this))
        );
        bytes32 ethHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash)
        );

        address recovered = _recoverSigner(ethHash, sig);
        if (recovered != settlementSigner) revert InvalidSignature();

        usedNonces[msg.sender][marketId][nonce] = true;

        // ── Release collateral lock if one exists ─────────────────────────────
        // balances[user] >= totalLocked[user] is always true because lockForBet
        // validates free balance and withdraw only reduces free balance.
        uint256 locked = lockedAmounts[msg.sender][marketId];
        if (locked > 0) {
            lockedAmounts[msg.sender][marketId] = 0;
            totalLocked[msg.sender] -= locked;
            balances[msg.sender] -= locked;   // deduct the stake
            emit BetUnlocked(msg.sender, marketId, locked);
        }

        // Credit the net payout (0 for losers, >0 for winners).
        balances[msg.sender] += amount;

        emit PayoutClaimed(msg.sender, marketId, amount);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function getBalance(address user) external view returns (uint256) {
        return balances[user];
    }

    /// @notice FLOW available to withdraw — excludes collateral locked for active bets.
    function getFreeBalance(address user) external view returns (uint256) {
        return balances[user] - totalLocked[user];
    }

    // ─── Owner admin ──────────────────────────────────────────────────────────

    function setSettlementSigner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit SettlementSignerUpdated(settlementSigner, next);
        settlementSigner = next;
    }

    /// @notice Emergency stop — blocks deposits, withdrawals, and locks.
    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _recoverSigner(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(hash, v, r, s);
    }

    /**
     * @notice Plain FLOW transfers credit the sender's vault balance.
     *         Blocked when paused so emergency stops work end-to-end.
     */
    receive() external payable {
        require(!paused(), "Pausable: paused");
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }
}
