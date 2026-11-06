// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {TrialProvisioner} from "../src/TrialProvisioner.sol";
import {TrialSetup} from "./TrialSetup.sol";

/// @notice Step 3d setup in ONE run (owner key only). Dry run: without --broadcast. The owner runs the broadcast.
///         Optional env TRIAL_RELAYER_ADDRESS (the gas-only relayer; can be set later with setRelayer).
contract SetupTrials is TrialSetup {
    function run() external returns (BlindspotModule trialModule, TrialProvisioner provisioner) {
        _loadTrials();
        (trialModule, provisioner) = _setupTrials(vm.envOr("TRIAL_RELAYER_ADDRESS", address(0)));
        _logTrials(trialModule, provisioner);
    }
}
