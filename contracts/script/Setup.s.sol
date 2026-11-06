// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console} from "forge-std/Script.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {BlindspotSetup} from "./BlindspotSetup.sol";

/// @notice Script A (R2 part 1): mint MockUSDC, UserRegistry + agent resolver proxies, exact approval, commit.
contract SetupA is BlindspotSetup {
    function run() external {
        _load();
        _logAddresses();
        _stepA();
    }
}

/// @notice Script B (R2 part 2): run >= 60 s after A. Register parent, agent subname, policy, agent.status role.
contract SetupB is BlindspotSetup {
    function run() external {
        _load();
        _logAddresses();
        _stepB();
    }
}

/// @notice Script C (1.4): Safe, BlindspotModule, owner-signed enableModule, fund 0.01 ETH + 100 MockUSDC.
contract SetupC is BlindspotSetup {
    function run() external {
        _load();
        _logAddresses();
        BlindspotModule module = _stepC();
        console.log("module        ", address(module));
    }
}

/// @notice Script D (1.5): agent-context, agent addr record, payee resolver, vendor1/vendor2 + addr records.
contract SetupD is BlindspotSetup {
    function run() external {
        _load();
        _logAddresses();
        _stepD();
    }
}

/// @notice DRY-RUN ONLY. Runs A -> (61 s) -> B -> C -> D in one simulation to show the whole plan.
///         It warps time, so it must never be broadcast; run() refuses if broadcasting is detected.
contract SetupRehearsal is BlindspotSetup {
    function run() external {
        require(!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast), "rehearsal must not be broadcast");
        _load();
        _logAddresses();
        _stepA();
        vm.warp(block.timestamp + 61);
        _stepB();
        BlindspotModule module = _stepC();
        console.log("module        ", address(module));
        _stepD();
    }
}

import {VmSafe} from "forge-std/Vm.sol";
