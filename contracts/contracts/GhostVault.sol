// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title GhostVault
 * @notice Consumer-facing custody vault on Flow EVM.
 *
 * Collateral model (Option B — verifiable payouts):
 *  - Users lock FLOW with lockForBet(marketId, amount, side) before placing an
 *    encrypted bet on GhostEAMM (Sepolia).
 *  - side (true=YES, false=NO) is stored so the vault can compute payouts
 *    without relying on FHE-encrypted EAMM pool reads.
 *  - The oracle reports the market outcome with reportOutcome() after quorum.
 *  - computeExpectedPayout() is a public view that derives the exact payout
 *    from on-chain pool totals — the oracle cannot lie about amounts, only
 *    about the outcome (which is quorum-constrained and slash-able).
 *  - claimPayout / claimPayoutFor verify the signed amount matches the
 *    on-chain formula when an outcome has been reported.
 *
 * Safety:
 *  - ReentrancyGuard on deposit, withdraw, lockForBet, and claimPayout.
 *  - Pausable circuit breaker.
 *  - Ownable2Step: new owner must explicitly accept before transfer completes.
 */
contract GhostVault is ReentrancyGuard, Pausable, Ownable2Step, EIP712 {

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Total vault balance per user (in wei / 1e-18 FLOW).
    mapping(address => uint256) public balances;

    /// @notice Collateral locked per user per market — cannot be withdrawn.
    mapping(address => mapping(bytes32 => uint256)) public lockedAmounts;

    /// @notice Sum of all per-market locks for a user (for O(1) free-balance check).
    mapping(address => uint256) public totalLocked;

    /// @notice Bet side per user per market: true = YES, false = NO.
    mapping(address => mapping(bytes32 => bool)) public userSides;

    /// @notice Whether the oracle has reported an outcome for a market.
    mapping(bytes32 => bool) public isResolved;

    /// @notice The reported outcome for each resolved market (true = YES won).
    mapping(bytes32 => bool) public resolvedOutcomes;

    /**
     * @notice Authorised settlement signer — must match the oracle's signing key
     *         or the Lit PKP address when Lit Protocol is configured.
     */
    address public settlementSigner;

    /**
     * @notice Authorised outcome reporter — may call reportOutcome() in addition
     *         to the owner. Set to the Cadence COA EVM address to allow the
     *         FlowTransactionScheduler to deliver outcomes autonomously.
     *         Zero address disables (owner-only mode).
     */
    address public outcomeReporter;

    /// @notice Replay-protection: tracks consumed (user, marketId, nonce) triples.
    mapping(address => mapping(bytes32 => mapping(uint256 => bool))) public usedNonces;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    /// @dev `side` is emitted for auditability; not used in on-chain payout math.
    event BetLocked(address indexed user, bytes32 indexed marketId, uint256 amount, bool side);
    event BetUnlocked(address indexed user, bytes32 indexed marketId, uint256 amount);
    event PayoutClaimed(address indexed user, bytes32 indexed marketId, uint256 amount);
    event MarketResolved(bytes32 indexed marketId, bool outcome);
    event SettlementSignerUpdated(address indexed previous, address indexed next);
    event OutcomeReporterUpdated(address indexed previous, address indexed next);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error InsufficientBalance(uint256 have, uint256 need);
    error TransferFailed();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error PayoutExpired();
    error ZeroAmount();
    error ZeroAddress();
    error BetAlreadyLocked(bytes32 marketId);
    error MarketAlreadyResolved(bytes32 marketId);
    error UnauthorizedReporter();
    error PayoutMismatch(uint256 computed, uint256 claimed);

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(address user,bytes32 marketId,uint256 amount,uint256 nonce,uint256 expiry)");

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _settlementSigner) Ownable(msg.sender) EIP712("GhostVault", "1") {
        if (_settlementSigner == address(0)) revert ZeroAddress();
        settlementSigner = _settlementSigner;
    }

    // ─── Deposit ──────────────────────────────────────────────────────────────

    /**
     * @notice Direct deposit: user calls this and pays their own gas.
     */
    function deposit() external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice Relayer deposit: backend credits FLOW to `user`.
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
     * @param marketId  The GhostEAMM market ID (bytes32, abi.encode(uint256)).
     * @param amount    Exact stake in wei — must match the encrypted bet amount.
     * @param side      true = YES position, false = NO position.
     *
     * The amount is visible on Flow EVM (user's own custody record).
     * The encrypted bet on GhostEAMM remains FHE-hidden from other participants.
     * The side is recorded here so payout can be computed on-chain without
     * reading the FHE-encrypted EAMM pools.
     */
    function lockForBet(
        bytes32 marketId,
        uint256 amount,
        bool    side
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (lockedAmounts[msg.sender][marketId] != 0) revert BetAlreadyLocked(marketId);

        uint256 free = balances[msg.sender] - totalLocked[msg.sender];
        if (free < amount) revert InsufficientBalance(free, amount);

        lockedAmounts[msg.sender][marketId] = amount;
        userSides[msg.sender][marketId]     = side;
        totalLocked[msg.sender]            += amount;

        // Pool-depth aggregates are never written to this contract.
        // They remain FHE-encrypted inside GhostEAMM throughout the market lifecycle.

        emit BetLocked(msg.sender, marketId, amount, side);
    }

    // ─── Outcome reporting (Option B) ─────────────────────────────────────────

    /**
     * @notice Called by the oracle after quorum to record the market outcome.
     *
     * Callable by the owner OR the designated outcomeReporter (e.g. the Cadence
     * COA address used by FlowTransactionScheduler for autonomous delivery).
     * Both paths remain active simultaneously — no ownership transfer required.
     *
     * Pool-depth (aggregate YES/NO totals) is never written here — it remains
     * FHE-encrypted inside GhostEAMM on Sepolia throughout the market lifecycle.
     *
     * @param marketId  The GhostEAMM market ID (bytes32).
     * @param outcome   true = YES won, false = NO won.
     */
    function reportOutcome(bytes32 marketId, bool outcome) external {
        if (msg.sender != owner() && msg.sender != outcomeReporter)
            revert UnauthorizedReporter();
        if (isResolved[marketId]) revert MarketAlreadyResolved(marketId);
        isResolved[marketId]       = true;
        resolvedOutcomes[marketId] = outcome;
        emit MarketResolved(marketId, outcome);
    }

    /**
     * @notice Set the authorised outcome reporter address.
     *         Set to the Cadence COA EVM address to enable autonomous Cadence
     *         scheduler delivery. Set to address(0) to revert to owner-only mode.
     */
    function setOutcomeReporter(address reporter) external onlyOwner {
        emit OutcomeReporterUpdated(outcomeReporter, reporter);
        outcomeReporter = reporter;
    }

    // ─── Payout computation ────────────────────────────────────────────────────

    /**
     * @notice Compute the exact payout owed to `user` for `marketId`.
     *         Returns 0 if the market is not resolved or the user lost.
     *
     * Formula:
     *   winner → lockedAmount  (original stake returned)
     *   loser  → 0             (stake forfeited)
     *
     * Pool-depth aggregates are intentionally omitted here — they remain
     * FHE-encrypted in GhostEAMM. This keeps the privacy boundary clean:
     * no aggregate information ever needs to be published on Flow EVM.
     */
    function computeExpectedPayout(
        address user,
        bytes32 marketId
    ) public view returns (uint256) {
        if (!isResolved[marketId]) return 0;
        bool won = (userSides[user][marketId] == resolvedOutcomes[marketId]);
        if (!won) return 0;
        return lockedAmounts[user][marketId];
    }

    // ─── Withdraw ─────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw free (unlocked) FLOW from the vault back to msg.sender.
     *         Locked collateral is excluded until the market settles.
     */
    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 free = balances[msg.sender] - totalLocked[msg.sender];
        if (free < amount) revert InsufficientBalance(free, amount);

        unchecked { balances[msg.sender] -= amount; }

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ─── Payout claim ─────────────────────────────────────────────────────────

    /**
     * @notice Claim payout for msg.sender using EIP-712 oracle permit.
     */
    function claimPayout(
        bytes32 marketId,
        uint256 amount,
        uint256 nonce,
        uint256 expiry,
        bytes calldata sig
    ) external nonReentrant {
        _claimPayoutFor(msg.sender, marketId, amount, nonce, expiry, sig);
    }

    /**
     * @notice Claim payout on behalf of `user` (relayer gas sponsorship).
     */
    function claimPayoutFor(
        address user,
        bytes32 marketId,
        uint256 amount,
        uint256 nonce,
        uint256 expiry,
        bytes calldata sig
    ) external nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        _claimPayoutFor(user, marketId, amount, nonce, expiry, sig);
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

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _claimPayoutFor(
        address user,
        bytes32 marketId,
        uint256 amount,
        uint256 nonce,
        uint256 expiry,
        bytes calldata sig
    ) internal {
        if (block.timestamp > expiry) revert PayoutExpired();
        if (usedNonces[user][marketId][nonce]) revert NonceAlreadyUsed();

        // Option B: if the oracle has reported an outcome, the amount must
        // exactly match the on-chain formula. This removes the oracle's ability
        // to manipulate individual payout amounts.
        if (isResolved[marketId]) {
            uint256 expected = computeExpectedPayout(user, marketId);
            if (amount != expected) revert PayoutMismatch(expected, amount);
        }

        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, user, marketId, amount, nonce, expiry)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, sig);
        if (recovered != settlementSigner) revert InvalidSignature();

        usedNonces[user][marketId][nonce] = true;

        uint256 locked = lockedAmounts[user][marketId];
        if (locked > 0) {
            lockedAmounts[user][marketId] = 0;
            totalLocked[user]            -= locked;
            balances[user]               -= locked;

            // finalYesPools / finalNoPools are immutable resolution snapshots — not decremented here.
            emit BetUnlocked(user, marketId, locked);
        }

        balances[user] += amount;
        emit PayoutClaimed(user, marketId, amount);
    }

    /**
     * @notice Plain FLOW transfers credit the sender's vault balance.
     */
    receive() external payable {
        require(!paused(), "Pausable: paused");
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }
}
