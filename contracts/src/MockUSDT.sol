// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDT — TESTNET ONLY
/// @notice 6-decimal test token with an open faucet `mint`, standing in for USDT on
///         BSC Testnet / Sepolia. Has no value; never deploy to a mainnet.
contract MockUSDT is ERC20 {
    uint8 private immutable _decimals;

    constructor(uint8 decimals_) ERC20("Mock Tether USD", "USDT") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Open faucet for testing.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
