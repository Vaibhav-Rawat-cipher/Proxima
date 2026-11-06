// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {SimplePool} from "../src/demo/SimplePool.sol";
import {BlindspotSetup} from "./BlindspotSetup.sol";

/// @notice ONE real testbed transaction (Step 2.3): the agent key, via BlindspotModule.executeBatch for
///         `test.blindspot-demo.eth`, approves exactly 10 MockDAI to SimplePool and swaps it for 10 MockUSDC.
///         The calls are byte-for-byte scenario F, which the wallet core evaluates as ALLOW.
contract TestbedSwap is BlindspotSetup {
    function run() external {
        _load();
        string memory cfg = vm.readFile("../config/sepolia.json");
        BlindspotModule module = BlindspotModule(vm.parseJsonAddress(cfg, ".module"));
        IERC20 dai = IERC20(vm.parseJsonAddress(cfg, ".ens.MockDAI"));
        SimplePool pool = SimplePool(vm.parseJsonAddress(cfg, ".testbed.simplePool"));
        uint256 agentKey = vm.envUint("AGENT_PRIVATE_KEY");
        require(vm.addr(agentKey) == agent, "AGENT_PRIVATE_KEY does not match AGENT_ADDRESS");

        uint256 amountIn = 10e18; // 10 MockDAI
        uint256 minOut = 10e6; // 10 MockUSDC
        BlindspotModule.Call[] memory calls = new BlindspotModule.Call[](2);
        calls[0] = BlindspotModule.Call(address(dai), 0, abi.encodeWithSelector(0x095ea7b3, address(pool), amountIn));
        calls[1] = BlindspotModule.Call(address(pool), 0, abi.encodeCall(SimplePool.swap, (address(dai), amountIn, minOut)));

        uint256 daiBefore = dai.balanceOf(address(safe));
        uint256 usdcBefore = usdc.balanceOf(address(safe));
        vm.startBroadcast(agentKey);
        module.executeBatch("test", calls);
        vm.stopBroadcast();

        require(dai.balanceOf(address(safe)) == daiBefore - amountIn, "DAI not spent");
        require(usdc.balanceOf(address(safe)) == usdcBefore + minOut, "USDC not received");
        require(dai.allowance(address(safe), address(pool)) == 0, "leftover allowance");
        console.log("Safe MockDAI ", daiBefore, "->", dai.balanceOf(address(safe)));
        console.log("Safe MockUSDC", usdcBefore, "->", usdc.balanceOf(address(safe)));
    }
}
