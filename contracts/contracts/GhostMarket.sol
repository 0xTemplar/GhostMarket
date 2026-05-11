// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

// ─── GhostEAMM interface ──────────────────────────────────────────────────────
// Lifecycle + sealed-window entry points GhostMarket forwards to GhostEAMM.
interface IGhostEAMM {
    function createMarket(uint256 marketId, uint64 expiryAt) external;
    function resolveMarket(uint256 marketId, bool outcome) external;
    function cancelMarket(uint256 marketId) external;
    function openSealedWindow(uint256 marketId, uint64 durationSecs) external;
}

/**
 * @title GhostMarket
 * @notice Single entry point for market lifecycle on Ethereum Sepolia.
 *
 * Responsibilities:
 *  1. Stores human-readable market metadata (title, description, category,
 *     resolution source, expiry).
 *  2. Forwards every lifecycle call (create / resolve / cancel / openSealedWindow)
 *     to GhostEAMM so the encrypted AMM stays in sync automatically.
 *
 * There is no manual "sync" or "mirror" step — one admin call here propagates
 * to both contracts atomically in the same transaction.
 *
 * GhostVault handles collateral custody (USDC) and oracle-signed payouts
 * independently; it does not need to be called from here.
 */
contract GhostMarket is ReentrancyGuard, Pausable, Ownable2Step {

    // ─── Constants ────────────────────────────────────────────────────────────

    uint64  public constant RESOLUTION_GRACE    = 7 days;
    uint64  public constant MAX_MARKET_DURATION = 730 days;
    uint256 public constant MAX_STRING_LEN      = 512;

    // ─── Types ────────────────────────────────────────────────────────────────

    enum MarketStatus { Active, Resolved, Cancelled }

    struct Market {
        string       title;
        string       description;
        string       category;
        string       resolutionSource;
        uint64       expiryAt;
        MarketStatus status;
        bool         outcome;
        address      creator;
    }

    // ─── State ────────────────────────────────────────────────────────────────

    uint256    public marketCount;
    mapping(uint256 => Market) public markets;

    /// @notice Oracle wallet that can resolve/cancel markets.
    address    public resolver;

    /// @notice GhostEAMM contract — receives every lifecycle call.
    IGhostEAMM public eamm;

    // ─── Events ───────────────────────────────────────────────────────────────

    event MarketCreated(uint256 indexed marketId, string title, string category, uint64 expiryAt);
    event MarketResolved(uint256 indexed marketId, bool outcome);
    event MarketCancelled(uint256 indexed marketId);
    event ResolverUpdated(address indexed previous, address indexed next);
    event EammUpdated(address indexed previous, address indexed next);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error MarketNotActive(uint256 marketId);
    error InvalidExpiry();
    error InvalidStringLength();
    error InvalidResolver();
    error ZeroAddress();

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyResolver() {
        if (msg.sender != resolver && msg.sender != owner())
            revert OwnableUnauthorizedAccount(msg.sender);
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param _resolver  Oracle wallet address.
     * @param _eamm      GhostEAMM contract address on Sepolia.
     *                   GhostEAMM must have this contract set as both
     *                   marketManager and resolver before any markets are created.
     */
    constructor(address _resolver, address _eamm) Ownable(msg.sender) {
        if (_resolver == address(0)) revert InvalidResolver();
        if (_eamm    == address(0)) revert ZeroAddress();
        resolver = _resolver;
        eamm     = IGhostEAMM(_eamm);
    }

    // ─── Market creation ──────────────────────────────────────────────────────

    /**
     * @notice Create a market.
     *
     * Stores metadata here and atomically registers the market in GhostEAMM
     * so the encrypted AMM is ready to accept bets immediately.
     */
    function createMarket(
        string calldata title,
        string calldata description,
        string calldata category,
        string calldata resolutionSource,
        uint64          expiryAt
    ) external whenNotPaused returns (uint256 marketId) {
        _validateStrings(title, description, category, resolutionSource);
        if (expiryAt <= block.timestamp) revert InvalidExpiry();
        if (expiryAt > block.timestamp + MAX_MARKET_DURATION) revert InvalidExpiry();

        marketId = ++marketCount;

        markets[marketId] = Market({
            title:            title,
            description:      description,
            category:         category,
            resolutionSource: resolutionSource,
            expiryAt:         expiryAt,
            status:           MarketStatus.Active,
            outcome:          false,
            creator:          msg.sender
        });

        // Forward to GhostEAMM — initialises encrypted pools for this market.
        eamm.createMarket(marketId, expiryAt);

        emit MarketCreated(marketId, title, category, expiryAt);
    }

    // ─── Resolution ───────────────────────────────────────────────────────────

    /**
     * @notice Resolve a market.
     *
     * Updates metadata status here and forwards the outcome to GhostEAMM,
     * which grants the resolver ACL access to the encrypted pool handles
     * for payout computation.
     */
    function resolveMarket(uint256 marketId, bool outcome) external onlyResolver {
        Market storage m = markets[marketId];
        if (m.status != MarketStatus.Active) revert MarketNotActive(marketId);
        m.status  = MarketStatus.Resolved;
        m.outcome = outcome;

        eamm.resolveMarket(marketId, outcome);

        emit MarketResolved(marketId, outcome);
    }

    /**
     * @notice Cancel a market (oracle unavailable, admin decision, etc.).
     */
    function cancelMarket(uint256 marketId) external onlyResolver {
        Market storage m = markets[marketId];
        if (m.status != MarketStatus.Active) revert MarketNotActive(marketId);
        m.status = MarketStatus.Cancelled;

        eamm.cancelMarket(marketId);

        emit MarketCancelled(marketId);
    }

    /**
     * @notice Open a sealed-bid window on the linked GhostEAMM for a market.
     *
     * Forwards as `marketManager` so this works even when the EAMM owner is a
     * different key than the GhostMarket owner.
     */
    function openSealedWindow(uint256 marketId, uint64 durationSecs) external onlyOwner {
        eamm.openSealedWindow(marketId, durationSecs);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function getAllMarketIds() external view returns (uint256[] memory ids) {
        ids = new uint256[](marketCount);
        for (uint256 i = 0; i < marketCount; i++) {
            ids[i] = i + 1;
        }
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setResolver(address _resolver) external onlyOwner {
        if (_resolver == address(0)) revert InvalidResolver();
        emit ResolverUpdated(resolver, _resolver);
        resolver = _resolver;
    }

    /**
     * @notice Update the GhostEAMM address (e.g. after an upgrade).
     *         Make sure the new GhostEAMM has this contract set as
     *         marketManager and resolver before switching.
     */
    function setEamm(address _eamm) external onlyOwner {
        if (_eamm == address(0)) revert ZeroAddress();
        emit EammUpdated(address(eamm), _eamm);
        eamm = IGhostEAMM(_eamm);
    }

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
            bytes(b).length > MAX_STRING_LEN ||
            bytes(c).length > MAX_STRING_LEN ||
            bytes(d).length > MAX_STRING_LEN
        ) revert InvalidStringLength();
    }
}
