// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title GhostVaultV2
 * @notice Confidential ERC7984 (cUSDC) custody vault on Ethereum Sepolia for GhostMarket.
 *
 * Token model:
 *  - Collateral token is set at deploy time to an ERC7984 token (e.g., cUSDCMock).
 *  - Users call `setOperator(vault, until)` on the token, then `deposit(encAmount, proof)`.
 *  - Balances and locked amounts are encrypted (`euint64`).
 *  - After oracle quorum, the oracle signs an EIP-712 settlement message committing to an encrypted payout handle.
 *  - `claimPayout()` verifies the signature and transfers cUSDC to the winner.
 */
contract GhostVaultV2 is ZamaEthereumConfig, ReentrancyGuard, Pausable, Ownable2Step, EIP712 {

    // ─── Immutable ────────────────────────────────────────────────────────────

    /// @notice The confidential collateral ERC7984 token (e.g., cUSDC).
    IERC7984 public immutable collateral;

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Total vault balance per user (encrypted).
    mapping(address => euint64) private _balances;

    /// @notice Collateral locked per user per market (encrypted).
    mapping(address => mapping(bytes32 => euint64)) private _lockedAmounts;

    /// @notice Sum of all per-market locks for a user (encrypted).
    mapping(address => euint64) private _totalLocked;

    /// @notice Bet side per user per market: true = YES, false = NO.
    mapping(address => mapping(bytes32 => bool)) public userSides;

    /// @notice Whether the oracle has reported an outcome for a market.
    mapping(bytes32 => bool) public isResolved;

    /// @notice The reported outcome for each resolved market (true = YES won).
    mapping(bytes32 => bool) public resolvedOutcomes;

    /**
     * @notice Authorised settlement signer — the oracle wallet that signs
     *         EIP-712 settlement messages after Zama gateway decryption.
     */
    address public settlementSigner;

    /// @notice Replay-protection: tracks consumed (user, marketId, nonce) triples.
    mapping(address => mapping(bytes32 => mapping(uint256 => bool))) public usedNonces;

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(address user,bytes32 marketId,bytes32 amountHandle,uint256 nonce,uint256 expiry)");

    // ─── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed user);
    event Withdrawn(address indexed user);
    event BetLocked(address indexed user, bytes32 indexed marketId, bool side);
    event BetUnlocked(address indexed user, bytes32 indexed marketId);
    event PayoutClaimed(address indexed user, bytes32 indexed marketId);
    event MarketResolved(bytes32 indexed marketId, bool outcome);
    event SettlementSignerUpdated(address indexed previous, address indexed next);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error InvalidSignature();
    error NonceAlreadyUsed();
    error PayoutExpired();
    error ZeroAddress();
    error MarketAlreadyResolved(bytes32 marketId);
    error PayoutMismatch();

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address _collateral,
        address _settlementSigner
    ) Ownable(msg.sender) EIP712("GhostVault", "2") {
        if (_collateral       == address(0)) revert ZeroAddress();
        if (_settlementSigner == address(0)) revert ZeroAddress();
        collateral       = IERC7984(_collateral);
        settlementSigner = _settlementSigner;
    }

    // ─── Deposit ──────────────────────────────────────────────────────────────

    /**
     * @notice Deposit cUSDC into the vault.
     *         Caller must have set this contract as an operator on the token.
     */
    function deposit(externalEuint64 encAmount, bytes calldata proof) external nonReentrant whenNotPaused {
        euint64 amount = collateral.confidentialTransferFrom(msg.sender, address(this), encAmount, proof);
        
        if (FHE.isInitialized(_balances[msg.sender])) {
            _balances[msg.sender] = FHE.add(_balances[msg.sender], amount);
        } else {
            _balances[msg.sender] = amount;
        }
        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);
        
        emit Deposited(msg.sender);
    }

    // ─── Collateral locking ───────────────────────────────────────────────────

    /**
     * @notice Lock cUSDC as collateral for an encrypted bet on GhostEAMM.
     *
     * @param marketId  The GhostEAMM market ID encoded as bytes32.
     * @param side      true = YES position, false = NO position.
     * @param encAmount Exact stake — must cryptographically match the encrypted bet on GhostEAMM.
     * @param proof     Zama ZKPoK proof for encAmount.
     */
    function lockForBet(
        bytes32 marketId,
        bool    side,
        externalEuint64 encAmount,
        bytes calldata  proof
    ) external nonReentrant whenNotPaused {
        euint64 amount = FHE.fromExternal(encAmount, proof);

        // Compute free balance: free = balances[msg.sender] - totalLocked[msg.sender]
        euint64 free;
        if (FHE.isInitialized(_totalLocked[msg.sender])) {
            free = FHE.sub(_balances[msg.sender], _totalLocked[msg.sender]);
        } else {
            free = _balances[msg.sender];
        }

        // Clamp the lock amount to the available free balance using FHE.select
        // If free >= amount, effectiveAmount = amount. Else effectiveAmount = 0 (or free, but 0 is safer to prevent dust bets).
        ebool isSufficient = FHE.ge(free, amount);
        euint64 effectiveAmount = FHE.select(isSufficient, amount, FHE.asEuint64(0));

        // Update locked amounts
        if (FHE.isInitialized(_lockedAmounts[msg.sender][marketId])) {
            _lockedAmounts[msg.sender][marketId] = FHE.add(_lockedAmounts[msg.sender][marketId], effectiveAmount);
        } else {
            _lockedAmounts[msg.sender][marketId] = effectiveAmount;
        }
        FHE.allowThis(_lockedAmounts[msg.sender][marketId]);
        // Allow the user to decrypt their own locked amount
        FHE.allow(_lockedAmounts[msg.sender][marketId], msg.sender);

        // Update total locked
        if (FHE.isInitialized(_totalLocked[msg.sender])) {
            _totalLocked[msg.sender] = FHE.add(_totalLocked[msg.sender], effectiveAmount);
        } else {
            _totalLocked[msg.sender] = effectiveAmount;
        }
        FHE.allowThis(_totalLocked[msg.sender]);

        userSides[msg.sender][marketId] = side;

        emit BetLocked(msg.sender, marketId, side);
    }

    // ─── Outcome reporting ────────────────────────────────────────────────────

    function reportOutcome(bytes32 marketId, bool outcome) external onlyOwner {
        if (isResolved[marketId]) revert MarketAlreadyResolved(marketId);
        isResolved[marketId]       = true;
        resolvedOutcomes[marketId] = outcome;
        emit MarketResolved(marketId, outcome);
    }

    // ─── Withdraw ─────────────────────────────────────────────────────────────

    function withdraw(externalEuint64 encAmount, bytes calldata proof) external nonReentrant whenNotPaused {
        euint64 amount = FHE.fromExternal(encAmount, proof);

        euint64 free;
        if (FHE.isInitialized(_totalLocked[msg.sender])) {
            free = FHE.sub(_balances[msg.sender], _totalLocked[msg.sender]);
        } else {
            free = _balances[msg.sender];
        }

        ebool isSufficient = FHE.ge(free, amount);
        euint64 effectiveAmount = FHE.select(isSufficient, amount, FHE.asEuint64(0));

        _balances[msg.sender] = FHE.sub(_balances[msg.sender], effectiveAmount);
        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);

        collateral.confidentialTransfer(msg.sender, effectiveAmount);
        
        emit Withdrawn(msg.sender);
    }

    // ─── Payout claim ─────────────────────────────────────────────────────────

    /**
     * @notice Claim payout using an EIP-712 permit signed by the oracle.
     *         The signature commits to the `amountHandle` (the bytes32 representation of the euint64).
     */
    function claimPayout(
        bytes32 marketId,
        euint64 amount,
        uint256 nonce,
        uint256 expiry,
        bytes calldata sig
    ) external nonReentrant {
        _claimPayoutFor(msg.sender, marketId, amount, nonce, expiry, sig);
    }

    function _claimPayoutFor(
        address user,
        bytes32 marketId,
        euint64 amount,
        uint256 nonce,
        uint256 expiry,
        bytes calldata sig
    ) internal {
        if (block.timestamp > expiry)                    revert PayoutExpired();
        if (usedNonces[user][marketId][nonce])           revert NonceAlreadyUsed();

        // Verify oracle EIP-712 signature.
        // We hash the bytes32 handle of the euint64 amount.
        bytes32 amountHandle = euint64.unwrap(amount);
        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, user, marketId, amountHandle, nonce, expiry)
        );
        bytes32 digest    = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, sig);
        if (recovered != settlementSigner)               revert InvalidSignature();

        usedNonces[user][marketId][nonce] = true;

        // Release the collateral lock.
        if (FHE.isInitialized(_lockedAmounts[user][marketId])) {
            euint64 locked = _lockedAmounts[user][marketId];
            
            // We zero out the lock by subtracting it from itself
            _lockedAmounts[user][marketId] = FHE.sub(locked, locked);
            FHE.allowThis(_lockedAmounts[user][marketId]);
            FHE.allow(_lockedAmounts[user][marketId], user);

            _totalLocked[user] = FHE.sub(_totalLocked[user], locked);
            FHE.allowThis(_totalLocked[user]);

            _balances[user] = FHE.sub(_balances[user], locked);
            FHE.allowThis(_balances[user]);
            FHE.allow(_balances[user], user);

            emit BetUnlocked(user, marketId);
        }

        // Credit payout — then transfer out immediately so the user receives cUSDC.
        // The oracle signature authorizes this exact encrypted amount handle to be transferred.
        collateral.confidentialTransfer(user, amount);
        emit PayoutClaimed(user, marketId);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function getBalanceHandle(address user) external view returns (euint64) {
        return _balances[user];
    }

    function getFreeBalanceHandles(address user) external view returns (euint64 balance, euint64 locked) {
        return (_balances[user], _totalLocked[user]);
    }

    function getLockedAmountHandle(address user, bytes32 marketId) external view returns (euint64) {
        return _lockedAmounts[user][marketId];
    }

    // ─── Owner admin ──────────────────────────────────────────────────────────

    function setSettlementSigner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit SettlementSignerUpdated(settlementSigner, next);
        settlementSigner = next;
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
