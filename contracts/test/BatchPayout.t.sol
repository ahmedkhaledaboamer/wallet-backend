// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {BatchPayout} from "../src/BatchPayout.sol";
import {MockUSDT} from "../src/MockUSDT.sol";

contract BatchPayoutTest is Test {
    event BatchPaid(bytes32 indexed batchRef, address indexed token, address indexed payer, uint256 total, uint256 count);

    BatchPayout internal payoutContract;
    MockUSDT internal usdt;
    address internal treasury = makeAddr("treasury");
    address internal attacker = makeAddr("attacker");
    // UUID 3f2b8c1e-9a4d-4e5f-8b6a-1c2d3e4f5a6b right-padded to bytes32 (same encoding as the backend).
    bytes32 internal constant REF = 0x3f2b8c1e9a4d4e5f8b6a1c2d3e4f5a6b00000000000000000000000000000000;

    function setUp() public {
        payoutContract = new BatchPayout();
        usdt = new MockUSDT(6);
        usdt.mint(treasury, 1_000_000e6);
        vm.prank(treasury);
        usdt.approve(address(payoutContract), type(uint256).max);
    }

    function _batch(uint256 n) internal pure returns (address[] memory r, uint256[] memory a) {
        r = new address[](n);
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            r[i] = address(uint160(0x1000 + i));
            a[i] = (i + 1) * 1e6;
        }
    }

    // ── Happy path ─────────────────────────────────────────────────────────────

    function test_PaysEveryRecipientAndEmitsBatchPaid() public {
        (address[] memory r, uint256[] memory a) = _batch(3);
        vm.expectEmit(true, true, true, true, address(payoutContract));
        emit BatchPaid(REF, address(usdt), treasury, 6e6, 3);

        vm.prank(treasury);
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);

        assertEq(usdt.balanceOf(r[0]), 1e6);
        assertEq(usdt.balanceOf(r[1]), 2e6);
        assertEq(usdt.balanceOf(r[2]), 3e6);
        assertEq(usdt.balanceOf(treasury), 1_000_000e6 - 6e6);
        assertEq(usdt.balanceOf(address(payoutContract)), 0, "contract never holds funds");
        assertTrue(payoutContract.paid(treasury, REF));
    }

    function test_ExactAllowanceIsEnough() public {
        address payer = makeAddr("exact");
        usdt.mint(payer, 6e6);
        (address[] memory r, uint256[] memory a) = _batch(3);
        vm.startPrank(payer);
        usdt.approve(address(payoutContract), 6e6);
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
        vm.stopPrank();
        assertEq(usdt.allowance(payer, address(payoutContract)), 0);
    }

    function test_MaxRecipients() public {
        (address[] memory r, uint256[] memory a) = _batch(200);
        vm.prank(treasury);
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
        assertEq(usdt.balanceOf(r[199]), 200e6);
    }

    // ── Replay ─────────────────────────────────────────────────────────────────

    function test_RevertWhen_SameBatchPaidTwice() public {
        (address[] memory r, uint256[] memory a) = _batch(2);
        vm.startPrank(treasury);
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
        vm.expectRevert(abi.encodeWithSelector(BatchPayout.AlreadyPaid.selector, REF));
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
        vm.stopPrank();
        assertEq(usdt.balanceOf(r[0]), 1e6, "paid exactly once");
    }

    // ── Griefing protection ────────────────────────────────────────────────────

    function test_AttackerCannotBurnTreasuryBatchRef() public {
        (address[] memory r, uint256[] memory a) = _batch(1);
        usdt.mint(attacker, 1e6);
        vm.startPrank(attacker);
        usdt.approve(address(payoutContract), 1e6);
        payoutContract.payout(REF, IERC20(address(usdt)), r, a); // front-runs with the same batchRef
        vm.stopPrank();

        assertTrue(payoutContract.paid(attacker, REF));
        assertFalse(payoutContract.paid(treasury, REF), "treasury's batch is still payable");

        (address[] memory r2, uint256[] memory a2) = _batch(2);
        vm.prank(treasury);
        payoutContract.payout(REF, IERC20(address(usdt)), r2, a2);
        assertTrue(payoutContract.paid(treasury, REF));
    }

    function test_CannotSpendSomeoneElsesAllowance() public {
        (address[] memory r, uint256[] memory a) = _batch(1);
        // The attacker has no tokens/allowance: transferFrom is always from msg.sender, never from the treasury.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(payoutContract), 0, 1e6));
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
        assertEq(usdt.balanceOf(treasury), 1_000_000e6);
    }

    // ── Input validation ───────────────────────────────────────────────────────

    function test_RevertWhen_Empty() public {
        vm.prank(treasury);
        vm.expectRevert(BatchPayout.EmptyBatch.selector);
        payoutContract.payout(REF, IERC20(address(usdt)), new address[](0), new uint256[](0));
    }

    function test_RevertWhen_LengthMismatch() public {
        (address[] memory r,) = _batch(3);
        (, uint256[] memory a) = _batch(2);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(BatchPayout.LengthMismatch.selector, 3, 2));
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
    }

    function test_RevertWhen_TooManyRecipients() public {
        (address[] memory r, uint256[] memory a) = _batch(201);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(BatchPayout.TooManyRecipients.selector, 201, 200));
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
    }

    function test_RevertWhen_ZeroAddressRecipient_AndNothingMoves() public {
        (address[] memory r, uint256[] memory a) = _batch(3);
        r[2] = address(0);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(BatchPayout.ZeroAddress.selector, 2));
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
        assertEq(usdt.balanceOf(r[0]), 0, "whole batch reverted");
        assertFalse(payoutContract.paid(treasury, REF));
    }

    function test_RevertWhen_ZeroToken() public {
        (address[] memory r, uint256[] memory a) = _batch(1);
        vm.prank(treasury);
        vm.expectRevert(BatchPayout.InvalidToken.selector);
        payoutContract.payout(REF, IERC20(address(0)), r, a);
    }

    // ── Insufficient allowance / balance ───────────────────────────────────────

    function test_RevertWhen_InsufficientAllowance() public {
        address payer = makeAddr("short");
        usdt.mint(payer, 100e6);
        (address[] memory r, uint256[] memory a) = _batch(3); // needs 6e6
        vm.startPrank(payer);
        usdt.approve(address(payoutContract), 5e6);
        // Fails on the 3rd transfer (allowance 2e6 left, needs 3e6) and reverts the whole batch.
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(payoutContract), 2e6, 3e6));
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
        vm.stopPrank();
        assertEq(usdt.balanceOf(r[0]), 0);
        assertEq(usdt.balanceOf(payer), 100e6);
        assertFalse(payoutContract.paid(payer, REF), "flag rolled back with the revert");
    }

    function test_RevertWhen_InsufficientBalance() public {
        address payer = makeAddr("poor");
        usdt.mint(payer, 1e6);
        (address[] memory r, uint256[] memory a) = _batch(2);
        vm.startPrank(payer);
        usdt.approve(address(payoutContract), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, payer, 0, 2e6));
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
        vm.stopPrank();
    }

    // ── Fuzz ───────────────────────────────────────────────────────────────────

    function testFuzz_TotalEqualsSumOfAmounts(uint8 n, uint64 seed) public {
        uint256 count = bound(n, 1, 50);
        address[] memory r = new address[](count);
        uint256[] memory a = new uint256[](count);
        uint256 expected;
        for (uint256 i; i < count; ++i) {
            r[i] = address(uint160(0x5000 + i));
            a[i] = uint256(keccak256(abi.encode(seed, i))) % 1_000e6;
            expected += a[i];
        }
        vm.expectEmit(true, true, true, true, address(payoutContract));
        emit BatchPaid(REF, address(usdt), treasury, expected, count);
        vm.prank(treasury);
        payoutContract.payout(REF, IERC20(address(usdt)), r, a);
        assertEq(usdt.balanceOf(treasury), 1_000_000e6 - expected);
    }
}
