// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BatchPayout} from "../src/BatchPayout.sol";
import {MockUSDT} from "../src/MockUSDT.sol";

/// @notice Deploys MockUSDT (6 decimals) + BatchPayout to a TESTNET and mints test USDT to the treasury.
///   npm run contracts:deploy -- bsc_testnet     (chain 97)
///   npm run contracts:deploy -- sepolia         (chain 11155111)
/// Env: DEPLOYER_PRIVATE_KEY (throwaway testnet key), TREASURY_ADDRESS, MOCK_MINT_AMOUNT (base units, optional).
contract Deploy is Script {
    function run() external returns (BatchPayout payoutContract, MockUSDT usdt) {
        require(block.chainid == 97 || block.chainid == 11155111 || block.chainid == 31337, "Deploy: testnets only (97, 11155111)");

        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasury = vm.envOr("TREASURY_ADDRESS", vm.addr(key));
        uint256 mintAmount = vm.envOr("MOCK_MINT_AMOUNT", uint256(1_000_000e6));

        vm.startBroadcast(key);
        usdt = new MockUSDT(6);
        payoutContract = new BatchPayout();
        usdt.mint(treasury, mintAmount);
        vm.stopBroadcast();

        console2.log("chainId        ", block.chainid);
        console2.log("MockUSDT       ", address(usdt));
        console2.log("BatchPayout    ", address(payoutContract));
        console2.log("treasury       ", treasury);
        console2.log("minted (units) ", mintAmount);
    }
}
