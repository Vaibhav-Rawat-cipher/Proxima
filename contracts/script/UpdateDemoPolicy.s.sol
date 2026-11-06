// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console} from "forge-std/Script.sol";
import {Policy, PolicyCodec} from "../src/PolicyCodec.sol";
import {BlindspotSetup} from "./BlindspotSetup.sol";

/// @notice Owner updates the demo agent's rules on ENS: ONE setData on demo.blindspot-demo.eth's "blindspot.policy".
///         No contract is redeployed — BlindspotModule reads the record on every transaction.
///         Change (owner, 2026-11-06): MockUSDC daily cap 50 → NEW_USDC_DAILY_CAP (default 100). Nothing else changes:
///         the script first proves its starting point equals the record currently on-chain (keccak in config).
contract UpdateDemoPolicy is BlindspotSetup {
    function run() external {
        _load();
        Policy memory p = _policy();
        bytes32 current = keccak256(PolicyCodec.encode(p));
        bytes32 deployed = vm.parseJsonBytes32(vm.readFile("../config/sepolia.json"), ".agents.demo.policyKeccak");
        require(current == deployed, "starting rules differ from the deployed record");

        p.dailyCap[0] = vm.envOr("NEW_USDC_DAILY_CAP", uint256(100e6));
        bytes memory encoded = PolicyCodec.encode(p);
        require(PolicyCodec.isValid(p, encoded), "new policy invalid");
        console.log("old policy keccak:");
        console.logBytes32(deployed);
        console.log("new policy keccak:");
        console.logBytes32(keccak256(encoded));
        console.log("MockUSDC per tx (6 decimals):", p.maxOut[0]);
        console.log("MockUSDC per day (6 decimals):", p.dailyCap[0]);

        vm.startBroadcast(ownerKey);
        agentResolver.setData(_agentDns(), POLICY_KEY, encoded);
        vm.stopBroadcast();
    }
}
