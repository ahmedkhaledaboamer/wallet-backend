// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title BatchPayout
/// @notice Pays many recipients of one ERC-20 token in a single transaction, straight from
///         the caller's wallet (the company treasury). Non-custodial: no owner, no admin,
///         never holds funds — every transfer is token.transferFrom(payer → recipient).
/// @dev The caller must first approve this contract for at least sum(amounts).
contract BatchPayout {
    using SafeERC20 for IERC20;

    /// @notice Upper bound that keeps a batch comfortably under the block gas limit.
    uint256 public constant MAX_RECIPIENTS = 200;

    /// @notice payer => batchRef => already paid. Keyed by payer so nobody can "burn"
    ///         another payer's batchRef by front-running it (griefing protection).
    mapping(address payer => mapping(bytes32 batchRef => bool)) public paid;

    event BatchPaid(bytes32 indexed batchRef, address indexed token, address indexed payer, uint256 total, uint256 count);

    error EmptyBatch();
    error TooManyRecipients(uint256 count, uint256 max);
    error LengthMismatch(uint256 recipients, uint256 amounts);
    error ZeroAddress(uint256 index);
    error InvalidToken();
    error AlreadyPaid(bytes32 batchRef);

    function payout(bytes32 batchRef, IERC20 token, address[] calldata recipients, uint256[] calldata amounts) external {
        uint256 count = recipients.length;
        if (count == 0) revert EmptyBatch();
        if (count > MAX_RECIPIENTS) revert TooManyRecipients(count, MAX_RECIPIENTS);
        if (count != amounts.length) revert LengthMismatch(count, amounts.length);
        if (address(token) == address(0)) revert InvalidToken();
        if (paid[msg.sender][batchRef]) revert AlreadyPaid(batchRef);

        // Effects before interactions: a re-entrant call with the same batchRef reverts.
        paid[msg.sender][batchRef] = true;

        uint256 total;
        for (uint256 i; i < count; ++i) {
            address to = recipients[i];
            if (to == address(0)) revert ZeroAddress(i);
            uint256 amount = amounts[i];
            total += amount;
            token.safeTransferFrom(msg.sender, to, amount);
        }

        emit BatchPaid(batchRef, address(token), msg.sender, total, count);
    }
}
