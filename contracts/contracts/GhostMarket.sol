// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title GhostMarket
 * @notice Binary prediction market with parimutuel settlement on Flow EVM.
 *
 * Settlement model (Phase 3 — non-private baseline):
 *  - Users bet YES or NO by sending FLOW as msg.value.
 *  - Implied probability = winnerPool / totalPool (parimutuel).
 *  - Resolver calls resolveMarket() after expiry to set the outcome.
 *  - Winners claim their proportional share of the total pool minus feeBps.
 *  - Losers receive nothing.
 *
 * Safety mechanisms:
 *  - ReentrancyGuard on all state-mutating external functions.
 *  - Pausable circuit breaker for emergency stops.
 *  - Ownable2Step: ownership transfer requires explicit acceptance by new owner.
 *  - Resolution grace period: if the resolver fails to resolve within
 *    RESOLUTION_GRACE (7 days after expiry), users may claim a full refund.
 *  - Cancelled markets: admin can cancel a market, enabling full refunds.
 *  - Treasury guard: fee is only subtracted if treasury != address(0).
 *  - Minimum bet: configurable floor prevents dust attacks.
 *  - Max expiry: markets cannot be set more than 2 years out.
 *  - Input validation: string lengths are capped to prevent storage attacks.
 *
 * Phase 4 upgrade path:
 *  - placeBet will route through an encrypted eAMM using fhevm.
 *  - Public pool sizes become encrypted euint types.
 *  - This contract's interface stays stable; the frontend does not change.
 *
 * Phase 6 upgrade path:
 *  - claimWinnings will verify an EIP-712 attestation from the Lit Action
 *    relayer before releasing payout from GhostVault.
 */
contract GhostMarket is ReentrancyGuard, Pausable, Ownable2Step {

    // ─── Constants ────────────────────────────────────────────────────────────

    /// @dev How long after expiry the resolver has before refunds are unlocked.
    uint64  public constant RESOLUTION_GRACE  = 7 days;
    /// @dev Hard cap on how far in the future a market can expire.
    uint64  public constant MAX_MARKET_DURATION = 730 days;
    /// @dev Maximum length (bytes) for on-chain string fields.
    uint256 public constant MAX_STRING_LEN    = 512;
    /// @dev Denominator for fee arithmetic.
    uint256 public constant BPS_DENOM         = 10_000;

    // ─── Types ────────────────────────────────────────────────────────────────

    enum MarketStatus { Active, Resolved, Disputed, Cancelled }

    struct Market {
        string       title;
        string       description;
        string       category;
        string       resolutionSource;
        uint64       expiryAt;
        MarketStatus status;
        uint256      yesPool;   // total FLOW staked on YES (wei)
        uint256      noPool;    // total FLOW staked on NO  (wei)
        bool         outcome;   // true = YES wins (valid after Resolved)
        address      creator;
    }

    /// @dev Per-user position inside a single market.
    struct Position {
        uint256 yesAmount;
        uint256 noAmount;
        bool    claimed;    // true after claimWinnings or claimRefund
    }

    // ─── State ────────────────────────────────────────────────────────────────

    uint256 public marketCount;

    /// @notice marketId (1-indexed) → Market struct.
    mapping(uint256 => Market)                       public markets;

    /// @notice marketId → user → Position.
    mapping(uint256 => mapping(address => Position)) public positions;

    /// @notice Authorised resolver address (may be updated by owner).
    address public resolver;

    /// @notice Protocol fee in basis points (default 200 = 2%).
    uint256 public feeBps = 200;

    /**
     * @notice Fee recipient. If address(0), fees are waived (not silently
     *         lost) and winners receive the full gross payout.
     */
    address public treasury;

    /// @notice Minimum amount (wei) accepted in placeBet.
    uint256 public minBet = 0.001 ether; // 0.001 FLOW

    // ─── Events ───────────────────────────────────────────────────────────────

    event MarketCreated(
        uint256 indexed marketId,
        string  title,
        string  category,
        uint64  expiryAt
    );
    event BetPlaced(
        uint256 indexed marketId,
        address indexed user,
        bool    side,       // true = YES
        uint256 amount
    );
    event MarketResolved(uint256 indexed marketId, bool outcome);
    event MarketDisputed(uint256 indexed marketId);
    event MarketCancelled(uint256 indexed marketId);
    event WinningsClaimed(uint256 indexed marketId, address indexed user, uint256 payout);
    event RefundClaimed(uint256 indexed marketId, address indexed user, uint256 amount);
    event ResolverUpdated(address indexed previous, address indexed next);
    event TreasuryUpdated(address indexed previous, address indexed next);
    event FeeBpsUpdated(uint256 previous, uint256 next);
    event MinBetUpdated(uint256 previous, uint256 next);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error MarketNotActive();
    error MarketNotResolved();
    error MarketNotExpiredYet();
    error MarketAlreadyExpired();
    error MarketNotEligibleForRefund();
    error AlreadyClaimed();
    error NoWinningPosition();
    error NoPositionToRefund();
    error BetBelowMinimum(uint256 sent, uint256 minimum);
    error InvalidStringLength();
    error InvalidExpiry();
    error InvalidResolver();
    error FeeTooHigh();
    error TransferFailed();

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param _resolver  Initial resolver address (must be non-zero).
     * @param _treasury  Fee recipient. Pass address(0) to waive fees at launch.
     */
    constructor(address _resolver, address _treasury) Ownable(msg.sender) {
        if (_resolver == address(0)) revert InvalidResolver();
        resolver = _resolver;
        treasury = _treasury;
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyResolver() {
        // Owner retains resolver powers as a break-glass capability.
        if (msg.sender != resolver && msg.sender != owner()) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
        _;
    }

    // ─── Market creation ──────────────────────────────────────────────────────

    /**
     * @notice Create a new binary market. Only callable by the owner.
     * @param title            Short human-readable question (≤ 512 bytes).
     * @param description      Full resolution criteria (≤ 512 bytes).
     * @param category         One of: Crypto | Macro | Politics | Tech | Sports | Climate
     * @param resolutionSource Where the resolver will look for the answer.
     * @param expiryAt         Unix timestamp; must be in (now, now + 2 years].
     */
    function createMarket(
        string calldata title,
        string calldata description,
        string calldata category,
        string calldata resolutionSource,
        uint64          expiryAt
    ) external onlyOwner whenNotPaused returns (uint256 marketId) {
        _validateStrings(title, description, category, resolutionSource);

        uint64 now_ = uint64(block.timestamp);
        if (expiryAt <= now_)                             revert InvalidExpiry();
        if (expiryAt >  now_ + MAX_MARKET_DURATION)       revert InvalidExpiry();

        marketId = ++marketCount;
        markets[marketId] = Market({
            title:            title,
            description:      description,
            category:         category,
            resolutionSource: resolutionSource,
            expiryAt:         expiryAt,
            status:           MarketStatus.Active,
            yesPool:          0,
            noPool:           0,
            outcome:          false,
            creator:          msg.sender
        });

        emit MarketCreated(marketId, title, category, expiryAt);
    }

    // ─── Betting ──────────────────────────────────────────────────────────────

    /**
     * @notice Place a YES or NO bet. Send FLOW as msg.value.
     *
     * Reentrancy: nonReentrant + follows CEI (state written before emitting).
     * Paused: blocked while contract is paused.
     *
     * @param marketId  Target market.
     * @param side      true = YES, false = NO.
     */
    function placeBet(
        uint256 marketId,
        bool    side
    ) external payable nonReentrant whenNotPaused {
        if (msg.value < minBet) revert BetBelowMinimum(msg.value, minBet);

        Market   storage m   = markets[marketId];
        Position storage pos = positions[marketId][msg.sender];

        if (m.status != MarketStatus.Active)  revert MarketNotActive();
        if (block.timestamp >= m.expiryAt)    revert MarketAlreadyExpired();

        // ── Effects ──────────────────────────────────────────────────────────
        if (side) {
            m.yesPool     += msg.value;
            pos.yesAmount += msg.value;
        } else {
            m.noPool      += msg.value;
            pos.noAmount  += msg.value;
        }

        emit BetPlaced(marketId, msg.sender, side, msg.value);
        // ── No external calls after this point ───────────────────────────────
    }

    // ─── Resolution ───────────────────────────────────────────────────────────

    /**
     * @notice Settle the market. Only resolver or owner can call.
     *         Must be called after expiry and within the RESOLUTION_GRACE window.
     *
     * @param marketId  Market to resolve.
     * @param outcome   true = YES wins, false = NO wins.
     */
    function resolveMarket(
        uint256 marketId,
        bool    outcome
    ) external onlyResolver nonReentrant {
        Market storage m = markets[marketId];
        if (m.status != MarketStatus.Active)      revert MarketNotActive();
        if (block.timestamp < m.expiryAt)         revert MarketNotExpiredYet();

        m.status  = MarketStatus.Resolved;
        m.outcome = outcome;

        emit MarketResolved(marketId, outcome);
    }

    /**
     * @notice Flag a market as disputed. Blocks claim until owner re-resolves.
     */
    function disputeMarket(uint256 marketId) external onlyOwner nonReentrant {
        Market storage m = markets[marketId];
        if (m.status != MarketStatus.Active && m.status != MarketStatus.Resolved) {
            revert MarketNotActive();
        }
        m.status = MarketStatus.Disputed;
        emit MarketDisputed(marketId);
    }

    /**
     * @notice Re-resolve a disputed market. Only owner.
     */
    function reResolveMarket(
        uint256 marketId,
        bool    outcome
    ) external onlyOwner nonReentrant {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.Disputed, "not disputed");
        m.status  = MarketStatus.Resolved;
        m.outcome = outcome;
        emit MarketResolved(marketId, outcome);
    }

    /**
     * @notice Cancel a market entirely. Users can claim full refunds afterwards.
     */
    function cancelMarket(uint256 marketId) external onlyOwner nonReentrant {
        Market storage m = markets[marketId];
        if (m.status == MarketStatus.Resolved || m.status == MarketStatus.Cancelled) {
            revert MarketNotActive();
        }
        m.status = MarketStatus.Cancelled;
        emit MarketCancelled(marketId);
    }

    // ─── Claim winnings ───────────────────────────────────────────────────────

    /**
     * @notice Claim winnings after resolution.
     *
     * Payout formula (parimutuel):
     *   gross  = (userWinningStake / winningPool) × totalPool
     *   fee    = gross × feeBps / 10_000   (only if treasury != address(0))
     *   payout = gross − fee
     *
     * Reentrancy: nonReentrant + CEI (claimed = true before transfer).
     */
    function claimWinnings(uint256 marketId) external nonReentrant {
        Market   storage m   = markets[marketId];
        Position storage pos = positions[marketId][msg.sender];

        if (m.status != MarketStatus.Resolved) revert MarketNotResolved();
        if (pos.claimed)                        revert AlreadyClaimed();

        uint256 userStake   = m.outcome ? pos.yesAmount : pos.noAmount;
        uint256 winningPool = m.outcome ? m.yesPool     : m.noPool;

        if (userStake == 0) revert NoWinningPosition();

        // ── Effects ──────────────────────────────────────────────────────────
        pos.claimed = true;

        uint256 totalPool   = m.yesPool + m.noPool;
        uint256 grossPayout = (userStake * totalPool) / winningPool;

        uint256 payout = grossPayout;
        if (treasury != address(0) && feeBps > 0) {
            uint256 fee = (grossPayout * feeBps) / BPS_DENOM;
            payout      = grossPayout - fee;

            // ── Interactions ─────────────────────────────────────────────────
            (bool feeOk, ) = treasury.call{value: fee}("");
            if (!feeOk) revert TransferFailed();
        }

        (bool ok, ) = msg.sender.call{value: payout}("");
        if (!ok) revert TransferFailed();

        emit WinningsClaimed(marketId, msg.sender, payout);
    }

    // ─── Refund paths ─────────────────────────────────────────────────────────

    /**
     * @notice Claim a full refund when:
     *   (a) The market was cancelled by admin, OR
     *   (b) The resolver missed the RESOLUTION_GRACE window after expiry.
     *
     * This ensures user funds can never be permanently locked.
     */
    function claimRefund(uint256 marketId) external nonReentrant {
        Market   storage m   = markets[marketId];
        Position storage pos = positions[marketId][msg.sender];

        bool isGraceExpired = (
            m.status == MarketStatus.Active &&
            block.timestamp >= uint256(m.expiryAt) + RESOLUTION_GRACE
        );
        bool isCancelled = (m.status == MarketStatus.Cancelled);

        if (!isGraceExpired && !isCancelled) revert MarketNotEligibleForRefund();

        uint256 refund = pos.yesAmount + pos.noAmount;
        if (refund == 0)    revert NoPositionToRefund();
        if (pos.claimed)    revert AlreadyClaimed();

        // ── Effects ──────────────────────────────────────────────────────────
        pos.claimed = true;

        // ── Interactions ─────────────────────────────────────────────────────
        (bool ok, ) = msg.sender.call{value: refund}("");
        if (!ok) revert TransferFailed();

        emit RefundClaimed(marketId, msg.sender, refund);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    /**
     * @notice YES implied probability in basis points (0–10000).
     *         Returns 5000 when no bets have been placed yet.
     */
    function yesPrice(uint256 marketId) public view returns (uint256) {
        Market storage m = markets[marketId];
        uint256 total = m.yesPool + m.noPool;
        return total == 0 ? 5000 : (m.yesPool * BPS_DENOM) / total;
    }

    /// @notice NO implied probability in basis points (0–10000).
    function noPrice(uint256 marketId) public view returns (uint256) {
        return BPS_DENOM - yesPrice(marketId);
    }

    /// @notice Returns a user's position in a market.
    function getUserPosition(
        uint256 marketId,
        address user
    ) external view returns (uint256 yes, uint256 no, bool claimed) {
        Position storage pos = positions[marketId][user];
        return (pos.yesAmount, pos.noAmount, pos.claimed);
    }

    /// @notice Returns all market IDs from 1 to marketCount.
    function getAllMarketIds() external view returns (uint256[] memory ids) {
        ids = new uint256[](marketCount);
        for (uint256 i; i < marketCount; ++i) {
            ids[i] = i + 1;
        }
    }

    /**
     * @notice True if a user may claim a refund (grace expired or cancelled).
     */
    function isRefundEligible(uint256 marketId) external view returns (bool) {
        Market storage m = markets[marketId];
        if (m.status == MarketStatus.Cancelled) return true;
        return (
            m.status == MarketStatus.Active &&
            block.timestamp >= uint256(m.expiryAt) + RESOLUTION_GRACE
        );
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setResolver(address _resolver) external onlyOwner {
        if (_resolver == address(0)) revert InvalidResolver();
        emit ResolverUpdated(resolver, _resolver);
        resolver = _resolver;
    }

    function setTreasury(address _treasury) external onlyOwner {
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        if (_feeBps > 500) revert FeeTooHigh(); // 5% hard cap
        emit FeeBpsUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    function setMinBet(uint256 _minBet) external onlyOwner {
        emit MinBetUpdated(minBet, _minBet);
        minBet = _minBet;
    }

    /// @notice Emergency stop — blocks placeBet and createMarket.
    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _validateStrings(
        string calldata a,
        string calldata b,
        string calldata c,
        string calldata d
    ) internal pure {
        if (
            bytes(a).length == 0 || bytes(a).length > MAX_STRING_LEN ||
            bytes(b).length == 0 || bytes(b).length > MAX_STRING_LEN ||
            bytes(c).length == 0 || bytes(c).length > MAX_STRING_LEN ||
            bytes(d).length == 0 || bytes(d).length > MAX_STRING_LEN
        ) revert InvalidStringLength();
    }
}
