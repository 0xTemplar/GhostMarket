// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title GhostVault
 * @notice ERC20 (USDC) custody vault on Ethereum Sepolia for GhostMarket.
 *
 * Token model:
 *  - Collateral token is set at deploy time (MockUSDC on testnet, real USDC on mainnet).
 *  - USDC has 6 decimals: 1 USDC = 1_000_000 units.
 *  - Users call approve(vault, amount) then deposit(amount).
 *  - After oracle quorum the oracle signs an EIP-712 settlement message.
 *  - claimPayout() verifies the signature and transfers USDC to the winner.
 *
 * To upgrade to real USDC on mainnet: redeploy with the Circle USDC address.
 * Zero contract or frontend code changes required.
 */
contract GhostVault is ReentrancyGuard, Pausable, Ownable2Step, EIP712 {
    using SafeERC20 for IERC20;

    // ─── Immutable ────────────────────────────────────────────────────────────

    /// @notice The collateral ERC20 token (USDC, 6 decimals).
    IERC20 public immutable collateral;

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Total vault balance per user (in collateral base units).
    mapping(address => uint256) public balances;

    /// @notice Collateral locked per user per market.
    mapping(address => mapping(bytes32 => uint256)) public lockedAmounts;

    /// @notice Sum of all per-market locks for a user (O(1) free-balance check).
    mapping(address => uint256) public totalLocked;

    /// @notice Bet side per user per market: true = YES, false = NO.
    mapping(address => mapping(bytes32 => bool)) public userSides;

    /// @notice Whether the oracle has reported an outcome for a market.
    mapping(bytes32 => bool) public isResolved;

    /// @notice The reported outcome for each resolved market (true = YES won).
    mapping(bytes32 => bool) public resolvedOutcomes;

    /**
     * @notice Authorised settlement signer — the oracle wallet that signs
     *         EIP-712 settlement messages after Zama gateway decryption.
     *         Rotatable via setSettlementSigner().
     */
    address public settlementSigner;

    /// @notice Replay-protection: tracks consumed (user, marketId, nonce) triples.
    mapping(address => mapping(bytes32 => mapping(uint256 => bool))) public usedNonces;

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(address user,bytes32 marketId,uint256 amount,uint256 nonce,uint256 expiry)");

    // ─── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event BetLocked(address indexed user, bytes32 indexed marketId, uint256 amount, bool side);
    event BetUnlocked(address indexed user, bytes32 indexed marketId, uint256 amount);
    event PayoutClaimed(address indexed user, bytes32 indexed marketId, uint256 amount);
    event MarketResolved(bytes32 indexed marketId, bool outcome);
    event SettlementSignerUpdated(address indexed previous, address indexed next);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error InsufficientBalance(uint256 have, uint256 need);
    error InvalidSignature();
    error NonceAlreadyUsed();
    error PayoutExpired();
    error ZeroAmount();
    error ZeroAddress();
    error BetAlreadyLocked(bytes32 marketId);
    error MarketAlreadyResolved(bytes32 marketId);
    error PayoutMismatch(uint256 computed, uint256 claimed);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address _collateral,
        address _settlementSigner
    ) Ownable(msg.sender) EIP712("GhostVault", "1") {
        if (_collateral       == address(0)) revert ZeroAddress();
        if (_settlementSigner == address(0)) revert ZeroAddress();
        collateral       = IERC20(_collateral);
        settlementSigner = _settlementSigner;
    }

    // ─── Deposit ──────────────────────────────────────────────────────────────

    /**
     * @notice Deposit USDC into the vault.
     *         Caller must have approved this contract for at least `amount`.
     * @param amount Amount in USDC base units (1 USDC = 1_000_000).
     */
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        balances[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Relayer deposit: credits `amount` USDC to `user`.
     *         Caller must have approved this contract for at least `amount`.
     */
    function depositFor(address user, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (user == address(0)) revert ZeroAddress();
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        balances[user] += amount;
        emit Deposited(user, amount);
    }

    // ─── Collateral locking ───────────────────────────────────────────────────

    /**
     * @notice Lock `amount` USDC as collateral for an encrypted bet on GhostEAMM.
     *
     * @param marketId  The GhostEAMM market ID encoded as bytes32.
     * @param amount    Exact stake in USDC base units — must match the encrypted bet.
     * @param side      true = YES position, false = NO position.
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

        emit BetLocked(msg.sender, marketId, amount, side);
    }

    // ─── Outcome reporting ────────────────────────────────────────────────────

    /**
     * @notice Called by the oracle after quorum to record the market outcome.
     */
    function reportOutcome(bytes32 marketId, bool outcome) external onlyOwner {
        if (isResolved[marketId]) revert MarketAlreadyResolved(marketId);
        isResolved[marketId]       = true;
        resolvedOutcomes[marketId] = outcome;
        emit MarketResolved(marketId, outcome);
    }

    // ─── Payout computation ───────────────────────────────────────────────────

    /**
     * @notice Compute the exact payout owed to `user` for `marketId`.
     *         Returns 0 if the market is not resolved or the user lost.
     *         Winner receives their locked stake back in full.
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

    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 free = balances[msg.sender] - totalLocked[msg.sender];
        if (free < amount) revert InsufficientBalance(free, amount);
        unchecked { balances[msg.sender] -= amount; }
        collateral.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ─── Payout claim ─────────────────────────────────────────────────────────

    /**
     * @notice Claim payout using an EIP-712 permit signed by the oracle.
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
     * @notice Claim payout on behalf of `user` (gas sponsorship relay).
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
        if (block.timestamp > expiry)                    revert PayoutExpired();
        if (usedNonces[user][marketId][nonce])           revert NonceAlreadyUsed();

        // If the vault knows the outcome, enforce the computed amount on-chain.
        if (isResolved[marketId]) {
            uint256 expected = computeExpectedPayout(user, marketId);
            if (amount != expected)                      revert PayoutMismatch(expected, amount);
        }

        // Verify oracle EIP-712 signature.
        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, user, marketId, amount, nonce, expiry)
        );
        bytes32 digest    = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, sig);
        if (recovered != settlementSigner)               revert InvalidSignature();

        usedNonces[user][marketId][nonce] = true;

        // Release the collateral lock.
        uint256 locked = lockedAmounts[user][marketId];
        if (locked > 0) {
            lockedAmounts[user][marketId] = 0;
            totalLocked[user]            -= locked;
            balances[user]               -= locked;
            emit BetUnlocked(user, marketId, locked);
        }

        // Credit payout — then transfer out immediately so the user receives USDC.
        if (amount > 0) {
            collateral.safeTransfer(user, amount);
            emit PayoutClaimed(user, marketId, amount);
        }
    }
}
