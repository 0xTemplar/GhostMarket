// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title MockUSDC
 * @notice Test-only USD Coin replacement.
 *
 * Identical interface to real Circle USDC:
 *   - 6 decimals (1 USDC = 1_000_000 units)
 *   - name / symbol match mainnet
 *
 * Only the owner can mint. On mainnet, replace this address with
 * the real Circle USDC contract — GhostVault and the frontend
 * code require zero changes.
 */
contract MockUSDC is ERC20, Ownable2Step {
    constructor(address initialOwner) ERC20("USD Coin", "USDC") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @notice Mint USDC to any address. Owner-only.
     * @param to      Recipient
     * @param amount  Amount in USDC base units (1 USDC = 1_000_000)
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
