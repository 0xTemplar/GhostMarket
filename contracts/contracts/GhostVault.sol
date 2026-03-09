// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title GhostVault
 * @notice Consumer-facing custody vault on Flow EVM.
 *
 * Responsibilities (Phase 2):
 *  - Accept FLOW deposits from users or a trusted relayer (gasless path).
 *  - Track per-user balances.
 *  - Allow withdrawals back to user addresses.
 *
 * Responsibilities (Phase 6 — stub included):
 *  - Accept attested payout messages from an authorised settlement signer.
 *  - Enforce nonce-based replay protection per market per user.
 *
 * Gas on Flow EVM is negligible (~$0.0001 per tx), but the `depositFor`
 * function supports a backend relayer sponsoring gas so users never need
 * to hold FLOW for fees.
 */
contract GhostVault {
    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Vault balance per EVM address (in wei / 1e-18 FLOW).
    mapping(address => uint256) public balances;

    /**
     * @notice Authorised settlement signer for Phase 6 attested payouts.
     * Set at deploy time; owner can rotate it.
     */
    address public settlementSigner;

    address public owner;

    /// @notice Replay-protection: tracks consumed (user, marketId, nonce) triples.
    mapping(address => mapping(bytes32 => mapping(uint256 => bool))) public usedNonces;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event PayoutClaimed(address indexed user, bytes32 indexed marketId, uint256 amount);
    event SettlementSignerUpdated(address indexed previous, address indexed next);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error InsufficientBalance(uint256 have, uint256 need);
    error TransferFailed();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error PayoutExpired();
    error Unauthorised();
    error ZeroAmount();

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _settlementSigner) {
        owner = msg.sender;
        settlementSigner = _settlementSigner;
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorised();
        _;
    }

    // ─── Deposit ──────────────────────────────────────────────────────────────

    /**
     * @notice Direct deposit: user calls this and pays their own gas.
     *         Gas cost on Flow EVM is ~$0.0001 so this is acceptable.
     */
    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice Relayer deposit: backend calls this on behalf of the user,
     *         paying gas from the relayer wallet. The FLOW sent as msg.value
     *         is credited to `user`.
     *
     * In the full gasless flow the frontend signs an EIP-712 intent and the
     * relayer verifies it before calling this function (Phase 8). For Phase 2
     * the relayer is a trusted EOA controlled by the backend.
     */
    function depositFor(address user) external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (user == address(0)) revert Unauthorised();
        balances[user] += msg.value;
        emit Deposited(user, msg.value);
    }

    // ─── Withdraw ─────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw FLOW from the vault back to msg.sender.
     */
    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 have = balances[msg.sender];
        if (have < amount) revert InsufficientBalance(have, amount);
        unchecked { balances[msg.sender] = have - amount; }
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ─── Payout claim (Phase 6 stub) ──────────────────────────────────────────

    /**
     * @notice Claim a payout after oracle quorum + Lit attestation (Phase 6).
     *
     * The settlement signer signs the following EIP-191 message:
     *   keccak256(abi.encodePacked(
     *     "\x19Ethereum Signed Message:\n32",
     *     keccak256(abi.encode(user, marketId, amount, nonce, expiry, address(this)))
     *   ))
     *
     * @param marketId  Unique identifier for the resolved market.
     * @param amount    Payout amount in wei.
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
    ) external {
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
        balances[msg.sender] += amount;

        emit PayoutClaimed(msg.sender, marketId, amount);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function getBalance(address user) external view returns (uint256) {
        return balances[user];
    }

    // ─── Owner admin ──────────────────────────────────────────────────────────

    function setSettlementSigner(address next) external onlyOwner {
        emit SettlementSignerUpdated(settlementSigner, next);
        settlementSigner = next;
    }

    function transferOwnership(address next) external onlyOwner {
        owner = next;
    }

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

    receive() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }
}
