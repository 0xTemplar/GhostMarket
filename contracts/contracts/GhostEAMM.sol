// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import { FHE, euint64, ebool, externalEuint64 } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title GhostEAMM
 * @notice Encrypted Automated Market Maker for GhostMarket binary prediction markets.
 *
 * Deployment target: Ethereum Sepolia (via ZamaEthereumConfig).
 * The GhostEAMM is the confidential execution layer; it never receives or holds
 * tokens.  Collateral custody lives in GhostVault (USDC, 6 decimals); bet amounts
 * here are the matching USDC base-unit values encrypted client-side.
 *
 * Privacy model:
 *  - Bet amounts are encrypted client-side with fhevmjs before the tx is sent.
 *  - Pool totals are ciphertexts; they are never emitted or stored as plaintext.
 *  - Per-user position handles are ACL-scoped: only the position owner and this
 *    contract can gateway-decrypt them.  After resolution the oracle resolver is
 *    also granted access via `grantPositionAccess`.
 *
 * ACL conventions (per Zama docs):
 *  - Call FHE.allowThis(ct) whenever a ciphertext is written to storage so the
 *    contract can read it in subsequent transactions.
 *  - Call FHE.allow(ct, addr) to let a specific external address decrypt.
 *  - Always call allowThis/allow on the *result* of an FHE operation, not on
 *    intermediate inputs.
 */
contract GhostEAMM is ZamaEthereumConfig, Ownable2Step, ReentrancyGuard, Pausable {

    // ─── Types ────────────────────────────────────────────────────────────────

    enum MarketStatus { Active, Resolved, Cancelled }

    struct EncryptedMarket {
        euint64      yesPool;   // encrypted running total of YES bets
        euint64      noPool;    // encrypted running total of NO bets
        MarketStatus status;
        bool         outcome;   // true = YES won (valid only when Resolved)
        uint64       expiryAt;  // unix seconds
        bool         exists;
    }

    /**
     * @notice A sealed-bid window during which pool totals are withheld from
     *         any external decryptor.  Bets continue to land encrypted, but no
     *         party (including the resolver) is granted FHE.allow on the live
     *         pools until `settleSealedWindow` is called after `endsAt`.
     *
     *         `yesPoolSnapshot` / `noPoolSnapshot` are the ciphertext handles
     *         that pointed to the pools *at the moment the window opened*.
     *         Because `FHE.add` writes a new handle to `m.yesPool` on every
     *         bet, the snapshot handles remain frozen at the pre-window state —
     *         the frontend reads them to show the "paused" price during the
     *         window.  After settlement, the delta = post-window − pre-window
     *         is computable by the resolver via gateway decryption.
     */
    struct SealedWindow {
        uint64  startsAt;         // unix seconds when window opened
        uint64  endsAt;           // unix seconds (exclusive) when window closes
        bool    settled;          // true once settleSealedWindow has been called
        euint64 yesPoolSnapshot;  // yesPool handle at window-open time
        euint64 noPoolSnapshot;   // noPool handle at window-open time
    }

    // ─── Storage ──────────────────────────────────────────────────────────────

    /// @dev marketId (mirrors GhostMarket.sol IDs) → encrypted state
    mapping(uint256 => EncryptedMarket) private _markets;

    /// @dev marketId → user → encrypted YES position accumulator
    mapping(uint256 => mapping(address => euint64)) private _yesPositions;

    /// @dev marketId → user → encrypted NO position accumulator
    mapping(uint256 => mapping(address => euint64)) private _noPositions;

    /// @dev marketId → ordered list of sealed windows
    mapping(uint256 => SealedWindow[]) private _windows;

    // ─── Constants ────────────────────────────────────────────────────────────

    /**
     * @notice Minimum bet enforced privately via FHE.gt + FHE.select.
     *
     * Because we cannot revert inside the contract based on an encrypted
     * comparison result, bets below this threshold are silently zeroed out:
     * the pool and position receive an encrypted 0, leaving the user's
     * position handle uninitialized (i.e., no dust position is recorded).
     *
     * Expressed in USDC base units (6 decimals): 1_000_000 = 1 USDC.
     *
     * This demonstrates conditional encrypted logic — the plaintext amount
     * is never revealed to enforce this rule; all branching happens inside
     * the FHE coprocessor.
     */
    uint64 public constant MIN_BET_UNITS = 1_000_000; // 1 USDC (6 decimals)

    /**
     * @notice Minimum duration for a sealed-bid window.
     *         30 s is enough for testnet; production markets should use ≥ 60 s.
     */
    uint64 public constant MIN_WINDOW_SECS = 30;

    // ─── Access control ───────────────────────────────────────────────────────

    /// @notice Can create markets (mirrors GhostMarket.sol owner).
    address public marketManager;

    /// @notice Can resolve/cancel markets — the oracle wallet on Sepolia.
    address public resolver;

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @dev Amount is intentionally NOT emitted — only side + market are public.
    event BetPlaced(uint256 indexed marketId, address indexed user, bool indexed side);
    event MarketCreated(uint256 indexed marketId, uint64 expiryAt);
    event MarketResolved(uint256 indexed marketId, bool outcome);
    event MarketCancelled(uint256 indexed marketId);
    event PositionAccessGranted(uint256 indexed marketId, address indexed user, address decryptor);
    event MarketManagerUpdated(address indexed previous, address indexed next);
    event ResolverUpdated(address indexed previous, address indexed next);

    /// @notice Emitted when a sealed-bid window is opened.
    event SealedWindowOpened(
        uint256 indexed marketId,
        uint256         windowIdx,
        uint64          startsAt,
        uint64          endsAt
    );

    /// @notice Emitted when the oracle settles a sealed window and ACL is granted.
    event SealedWindowSettled(uint256 indexed marketId, uint256 windowIdx);

    /**
     * @notice Emitted by the oracle after gateway-decrypting the pool totals.
     *         The oracle calls `publishWindowPrice` with the decrypted values;
     *         the frontend listens for this event to animate the price reveal.
     */
    event PriceRevealed(
        uint256 indexed marketId,
        uint256 indexed windowIdx,
        uint64          yesTotal,
        uint64          noTotal
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error MarketNotFound(uint256 marketId);
    error MarketAlreadyExists(uint256 marketId);
    error MarketNotActive(uint256 marketId);
    error MarketNotResolved(uint256 marketId);
    error MarketExpired(uint256 marketId);
    error NoPositionExists(uint256 marketId, address user);
    error Unauthorized();
    error ZeroAddress();

    /// @notice Thrown when trying to place a bet after a window has expired but before settlement.
    error WindowSettlementPending(uint256 marketId, uint256 windowIdx);
    /// @notice Thrown when trying to settle a window that is already settled.
    error WindowAlreadySettled(uint256 marketId, uint256 windowIdx);
    /// @notice Thrown when trying to settle before the window has expired.
    error WindowNotExpired(uint256 marketId, uint256 windowIdx);
    /// @notice Thrown when the window index is out of range.
    error WindowIndexOutOfBounds(uint256 marketId, uint256 idx);
    /// @notice Thrown when the requested duration is below the minimum.
    error DurationTooShort(uint64 minSecs);
    /// @notice Thrown when trying to open a second window while one is still pending settlement.
    error WindowStillPending(uint256 marketId, uint256 windowIdx);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyManagerOrOwner() {
        if (msg.sender != marketManager && msg.sender != owner()) revert Unauthorized();
        _;
    }

    modifier onlyResolverOrOwner() {
        if (msg.sender != resolver && msg.sender != owner()) revert Unauthorized();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _marketManager, address _resolver) Ownable(msg.sender) {
        if (_marketManager == address(0) || _resolver == address(0)) revert ZeroAddress();
        marketManager = _marketManager;
        resolver      = _resolver;
    }

    // ─── Market lifecycle ─────────────────────────────────────────────────────

    /**
     * @notice Register a new encrypted market, mirroring a GhostMarket.sol entry.
     *
     * Pools are initialised to trivially-encrypted zero.  FHE.allowThis is
     * called on each pool so the contract can read them in `placeBet`.
     *
     * @param marketId  Must match the uint256 ID used in GhostMarket.sol.
     * @param expiryAt  Unix timestamp; no new bets accepted at or after this time.
     */
    function createMarket(
        uint256 marketId,
        uint64  expiryAt
    ) external whenNotPaused onlyManagerOrOwner {
        if (_markets[marketId].exists) revert MarketAlreadyExists(marketId);

        euint64 initYes = FHE.asEuint64(0);
        euint64 initNo  = FHE.asEuint64(0);

        // allowThis so the contract can use these handles in future calls.
        FHE.allowThis(initYes);
        FHE.allowThis(initNo);

        _markets[marketId] = EncryptedMarket({
            yesPool:  initYes,
            noPool:   initNo,
            status:   MarketStatus.Active,
            outcome:  false,
            expiryAt: expiryAt,
            exists:   true
        });

        emit MarketCreated(marketId, expiryAt);
    }

    // ─── Encrypted bet submission ─────────────────────────────────────────────

    /**
     * @notice Place an encrypted bet.
     *
     * The caller encrypts their amount client-side with fhevmjs:
     *
     *   const input = instance.createEncryptedInput(EAMM_ADDRESS, userAddress);
     *   input.add64(amountInUsdcBaseUnits); // e.g. parseUnits("10", 6) for 10 USDC
     *   const { handles, inputProof } = await input.encrypt();
     *
     * The (handle, inputProof) pair is passed here.  The contract adds the
     * encrypted amount to the relevant pool and the caller's position — all
     * inside FHE.  No plaintext amount ever appears on-chain.
     *
     * @param marketId   Mirrors GhostMarket.sol market ID.
     * @param side       true = YES, false = NO.
     * @param encAmount  externalEuint64 handle from fhevmjs.
     * @param inputProof ZKPoK proof bytes from fhevmjs.
     */
    function placeBet(
        uint256         marketId,
        bool            side,
        externalEuint64 encAmount,
        bytes calldata  inputProof
    ) external nonReentrant whenNotPaused {
        EncryptedMarket storage m = _markets[marketId];
        if (!m.exists)                       revert MarketNotFound(marketId);
        if (m.status != MarketStatus.Active) revert MarketNotActive(marketId);
        if (block.timestamp >= m.expiryAt)   revert MarketExpired(marketId);

        // Sealed-window guard: block bets when the most recent window has expired
        // but not yet been settled by the oracle.  This prevents a bet from
        // sneaking in between window-end and the ACL-grant in settleSealedWindow.
        SealedWindow[] storage ws = _windows[marketId];
        if (ws.length > 0) {
            SealedWindow storage last = ws[ws.length - 1];
            if (block.timestamp >= last.endsAt && !last.settled) {
                revert WindowSettlementPending(marketId, ws.length - 1);
            }
        }

        // Convert the external (user-encrypted) handle to a usable euint64.
        // FHE.fromExternal verifies the ZKPoK and binds the handle to
        // (address(this), msg.sender) so it cannot be replayed by others.
        euint64 amount = FHE.fromExternal(encAmount, inputProof);

        // ── Minimum bet guard (FHE.gt + FHE.select) ──────────────────────────
        // We cannot revert on an encrypted comparison — the contract never sees
        // the plaintext amount.  Instead we use FHE.select to zero out bets
        // below MIN_BET_WEI; the pool addition of 0 is a no-op and the
        // position handle is never initialized for dust submissions.
        //
        // All branching happens inside the Zama FHE coprocessor:
        //   aboveMin      = encrypt(amount > MIN_BET_WEI)   ← encrypted bool
        //   effectiveAmount = aboveMin ? amount : encrypt(0) ← encrypted select
        euint64 minBet  = FHE.asEuint64(MIN_BET_UNITS);
        euint64 zeroAmt = FHE.asEuint64(0);
        FHE.allowThis(minBet);
        FHE.allowThis(zeroAmt);

        ebool   aboveMin        = FHE.gt(amount, minBet);
        FHE.allowThis(aboveMin);

        euint64 effectiveAmount = FHE.select(aboveMin, amount, zeroAmt);
        FHE.allowThis(effectiveAmount);

        if (side) {
            // ── YES bet ──────────────────────────────────────────────────────
            m.yesPool = FHE.add(m.yesPool, effectiveAmount);
            // allowThis on the result so the contract can read it next call.
            FHE.allowThis(m.yesPool);

            _yesPositions[marketId][msg.sender] = FHE.add(
                _yesPositions[marketId][msg.sender],
                effectiveAmount
            );
            FHE.allowThis(_yesPositions[marketId][msg.sender]);
            // Allow the user to gateway-decrypt their own position.
            FHE.allow(_yesPositions[marketId][msg.sender], msg.sender);
        } else {
            // ── NO bet ───────────────────────────────────────────────────────
            m.noPool = FHE.add(m.noPool, effectiveAmount);
            FHE.allowThis(m.noPool);

            _noPositions[marketId][msg.sender] = FHE.add(
                _noPositions[marketId][msg.sender],
                effectiveAmount
            );
            FHE.allowThis(_noPositions[marketId][msg.sender]);
            FHE.allow(_noPositions[marketId][msg.sender], msg.sender);
        }

        // Only side + market are public.  Amount stays shielded.
        emit BetPlaced(marketId, msg.sender, side);
    }

    // ─── Resolution ───────────────────────────────────────────────────────────

    /**
     * @notice Finalise a market outcome.
     *
     * Called by the oracle resolver EOA after the oracle agent quorum agrees
     * on the real-world result.
     *
     * Grants the resolver ACL access to both pool totals so it can
     * gateway-decrypt them via the Zama gateway for payout ratio computation.
     *
     * @param marketId  Market to resolve.
     * @param outcome   true = YES won, false = NO won.
     */
    function resolveMarket(
        uint256 marketId,
        bool    outcome
    ) external onlyResolverOrOwner {
        EncryptedMarket storage m = _markets[marketId];
        if (!m.exists)                       revert MarketNotFound(marketId);
        if (m.status != MarketStatus.Active) revert MarketNotActive(marketId);

        m.status  = MarketStatus.Resolved;
        m.outcome = outcome;

        // The resolver needs to read pool totals to compute payout ratios.
        FHE.allow(m.yesPool, resolver);
        FHE.allow(m.noPool,  resolver);

        emit MarketResolved(marketId, outcome);
    }

    /**
     * @notice Cancel a market (data unavailable, admin decision, etc.).
     *
     * On cancel the resolver should call `grantPositionAccess` for each user
     * so the oracle can gateway-decrypt their positions and issue USDC refunds
     * via signed GhostVault settlement messages.
     */
    function cancelMarket(uint256 marketId) external onlyResolverOrOwner {
        EncryptedMarket storage m = _markets[marketId];
        if (!m.exists)                       revert MarketNotFound(marketId);
        if (m.status != MarketStatus.Active) revert MarketNotActive(marketId);

        m.status = MarketStatus.Cancelled;

        // Grant resolver pool access for refund computation.
        FHE.allow(m.yesPool, resolver);
        FHE.allow(m.noPool,  resolver);

        emit MarketCancelled(marketId);
    }

    // ─── Oracle ACL hook ──────────────────────────────────────────────────────

    /**
     * @notice Grant a decryptor (oracle wallet) ACL access to a user's
     *         winning position handle and both pool totals.
     *
     * The oracle needs:
     *  - the user's winning position handle (to compute their share)
     *  - both pool totals (to compute the payout ratio)
     *
     * For cancelled markets, both YES and NO positions are granted so the
     * oracle can compute full USDC refunds and issue signed settlement claims.
     *
     * @param marketId   Resolved or cancelled market.
     * @param user       Position owner.
     * @param decryptor  Oracle address that will gateway-decrypt the handles.
     */
    function grantPositionAccess(
        uint256 marketId,
        address user,
        address decryptor
    ) external onlyResolverOrOwner {
        if (decryptor == address(0)) revert ZeroAddress();
        EncryptedMarket storage m = _markets[marketId];

        bool resolved  = m.status == MarketStatus.Resolved;
        bool cancelled = m.status == MarketStatus.Cancelled;
        if (!resolved && !cancelled) revert MarketNotActive(marketId); // reuse error — market must be finalised

        // Require at least one non-zero position handle.
        bool hasYes = FHE.isInitialized(_yesPositions[marketId][user]);
        bool hasNo  = FHE.isInitialized(_noPositions[marketId][user]);
        if (!hasYes && !hasNo) revert NoPositionExists(marketId, user);

        if (resolved) {
            // Only the winning side matters for payout.
            if (m.outcome && hasYes) {
                FHE.allow(_yesPositions[marketId][user], decryptor);
            } else if (!m.outcome && hasNo) {
                FHE.allow(_noPositions[marketId][user], decryptor);
            }
        } else {
            // Cancelled: grant access to whichever positions exist for refund.
            if (hasYes) FHE.allow(_yesPositions[marketId][user], decryptor);
            if (hasNo)  FHE.allow(_noPositions[marketId][user],  decryptor);
        }

        // Always grant pool access so the decryptor can compute ratios.
        FHE.allow(m.yesPool, decryptor);
        FHE.allow(m.noPool,  decryptor);

        emit PositionAccessGranted(marketId, user, decryptor);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the encrypted handles for a user's YES and NO positions.
     *
     * The returned values are opaque bytes32 handles — not plaintext amounts.
     * Only the ACL-permitted address can gateway-decrypt them.
     */
    function getUserPositionHandles(
        uint256 marketId,
        address user
    ) external view returns (euint64 yesHandle, euint64 noHandle) {
        return (
            _yesPositions[marketId][user],
            _noPositions[marketId][user]
        );
    }

    /**
     * @notice Returns encrypted pool handles for a market.
     *         Only the ACL-permitted resolver / Lit PKP can decrypt these.
     */
    function getPoolHandles(
        uint256 marketId
    ) external view returns (euint64 yesPool, euint64 noPool) {
        EncryptedMarket storage m = _markets[marketId];
        if (!m.exists) revert MarketNotFound(marketId);
        return (m.yesPool, m.noPool);
    }

    /**
     * @notice Returns non-sensitive public metadata — status, outcome, expiry.
     *         Safe to read by anyone; no encrypted values exposed.
     */
    function getMarketMeta(
        uint256 marketId
    ) external view returns (MarketStatus status, bool outcome, uint64 expiryAt) {
        EncryptedMarket storage m = _markets[marketId];
        if (!m.exists) revert MarketNotFound(marketId);
        return (m.status, m.outcome, m.expiryAt);
    }

    /**
     * @notice True if a user has a non-zero (initialised) position on either side.
     */
    function hasPosition(uint256 marketId, address user) external view returns (bool) {
        return
            FHE.isInitialized(_yesPositions[marketId][user]) ||
            FHE.isInitialized(_noPositions[marketId][user]);
    }

    // ─── Sealed-bid windows ───────────────────────────────────────────────────

    /**
     * @notice Open a sealed-bid window on an active market.
     *
     * During the window, `placeBet` continues to accept encrypted bets but
     * no external party is granted FHE.allow on the live pool handles —
     * not even the resolver.  The UI freezes the displayed price at the
     * snapshot values and shows a countdown.
     *
     * Only one active (unsettled) window is allowed per market at a time.
     * Minimum duration is `MIN_WINDOW_SECS` (30 s).
     *
     * @param marketId     Must be an active market.
     * @param durationSecs Window length in seconds.
     */
    function openSealedWindow(
        uint256 marketId,
        uint64  durationSecs
    ) external onlyManagerOrOwner {
        if (durationSecs < MIN_WINDOW_SECS) revert DurationTooShort(MIN_WINDOW_SECS);

        EncryptedMarket storage m = _markets[marketId];
        if (!m.exists)                       revert MarketNotFound(marketId);
        if (m.status != MarketStatus.Active) revert MarketNotActive(marketId);

        SealedWindow[] storage ws = _windows[marketId];
        if (ws.length > 0) {
            SealedWindow storage last = ws[ws.length - 1];
            if (!last.settled) revert WindowStillPending(marketId, ws.length - 1);
        }

        uint64 start = uint64(block.timestamp);
        uint64 end   = start + durationSecs;

        // Snapshot the current pool handles.  Future FHE.add calls on placeBet
        // write new handles to m.yesPool / m.noPool, leaving the snapshot handles
        // pointing to the pre-window ciphertext (which stays valid on the ACL).
        euint64 yesSnap = m.yesPool;
        euint64 noSnap  = m.noPool;

        // allowThis so the contract can re-allow these handles to the resolver
        // at settlement time.
        FHE.allowThis(yesSnap);
        FHE.allowThis(noSnap);

        uint256 idx = ws.length;
        ws.push(SealedWindow({
            startsAt:        start,
            endsAt:          end,
            settled:         false,
            yesPoolSnapshot: yesSnap,
            noPoolSnapshot:  noSnap
        }));

        emit SealedWindowOpened(marketId, idx, start, end);
    }

    /**
     * @notice Settle an expired sealed window.
     *
     * Marks the window as settled and grants the resolver FHE.allow on:
     *   - The current live pool handles (post-window totals).
     *   - The snapshot handles (pre-window totals, for delta computation).
     *
     * The resolver then calls the Zama gateway to decrypt both, computes the
     * delta bets that landed during the window, and calls `publishWindowPrice`
     * to broadcast the `PriceRevealed` event.
     *
     * @param marketId  Market whose window to settle.
     * @param windowIdx Index into the market's window array.
     */
    function settleSealedWindow(
        uint256 marketId,
        uint256 windowIdx
    ) external onlyResolverOrOwner {
        EncryptedMarket storage m = _markets[marketId];
        if (!m.exists) revert MarketNotFound(marketId);

        SealedWindow[] storage ws = _windows[marketId];
        if (windowIdx >= ws.length) revert WindowIndexOutOfBounds(marketId, windowIdx);

        SealedWindow storage w = ws[windowIdx];
        if (w.settled)                        revert WindowAlreadySettled(marketId, windowIdx);
        if (block.timestamp < w.endsAt)       revert WindowNotExpired(marketId, windowIdx);

        w.settled = true;

        // Grant the resolver ACL on the current (post-window) pool totals.
        FHE.allow(m.yesPool, resolver);
        FHE.allow(m.noPool,  resolver);

        // Grant access to the pre-window snapshots for delta computation.
        FHE.allow(w.yesPoolSnapshot, resolver);
        FHE.allow(w.noPoolSnapshot,  resolver);

        emit SealedWindowSettled(marketId, windowIdx);
    }

    /**
     * @notice Publish the decrypted pool totals after a sealed window settles.
     *
     * Called by the oracle after gateway-decrypting the pool handles granted by
     * `settleSealedWindow`.  Emits `PriceRevealed` so the frontend can animate
     * the price reveal.
     *
     * @param marketId   Market ID.
     * @param windowIdx  Window index.
     * @param yesTotal   Decrypted YES pool total (USDC base units, 6 decimals).
     * @param noTotal    Decrypted NO pool total (USDC base units, 6 decimals).
     */
    function publishWindowPrice(
        uint256 marketId,
        uint256 windowIdx,
        uint64  yesTotal,
        uint64  noTotal
    ) external onlyResolverOrOwner {
        SealedWindow[] storage ws = _windows[marketId];
        if (windowIdx >= ws.length) revert WindowIndexOutOfBounds(marketId, windowIdx);
        if (!ws[windowIdx].settled)  revert WindowNotExpired(marketId, windowIdx);

        emit PriceRevealed(marketId, windowIdx, yesTotal, noTotal);
    }

    // ─── Sealed-window view helpers ───────────────────────────────────────────

    /// @notice Number of sealed windows ever opened for a market.
    function getSealedWindowCount(uint256 marketId) external view returns (uint256) {
        return _windows[marketId].length;
    }

    /**
     * @notice Read a specific sealed window's public fields.
     *
     * Returns snapshot handles as `euint64` (opaque bytes32 on the ABI).
     * Only the ACL-permitted resolver can gateway-decrypt them.
     */
    function getSealedWindow(
        uint256 marketId,
        uint256 windowIdx
    ) external view returns (
        uint64  startsAt,
        uint64  endsAt,
        bool    settled,
        euint64 yesPoolSnapshot,
        euint64 noPoolSnapshot
    ) {
        SealedWindow[] storage ws = _windows[marketId];
        if (windowIdx >= ws.length) revert WindowIndexOutOfBounds(marketId, windowIdx);
        SealedWindow storage w = ws[windowIdx];
        return (w.startsAt, w.endsAt, w.settled, w.yesPoolSnapshot, w.noPoolSnapshot);
    }

    /**
     * @notice Returns the index of the most recent active (unsettled) window,
     *         or type(uint256).max if none exists.
     *
     * Useful for the frontend: poll this to know if a market is currently in a
     * sealed window without iterating the whole array.
     */
    function getActiveWindowIdx(uint256 marketId) external view returns (uint256) {
        SealedWindow[] storage ws = _windows[marketId];
        if (ws.length == 0) return type(uint256).max;
        SealedWindow storage last = ws[ws.length - 1];
        if (!last.settled && block.timestamp < last.endsAt) {
            return ws.length - 1;
        }
        return type(uint256).max;
    }

    // ─── Owner admin ──────────────────────────────────────────────────────────

    function setMarketManager(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit MarketManagerUpdated(marketManager, next);
        marketManager = next;
    }

    function setResolver(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit ResolverUpdated(resolver, next);
        resolver = next;
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
