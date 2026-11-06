// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {TrialProvisioner} from "../src/TrialProvisioner.sol";

/// @notice Owner, one broadcast: point the provisioner at the gas-only relayer and fund the relayer with a little
///         Sepolia ETH (gas for provision() only). Reads OWNER_PRIVATE_KEY and TRIAL_RELAYER_ADDRESS with vm.env*.
contract SetRelayer is Script {
    uint256 internal constant RELAYER_FUND = 0.005 ether; // ~4,000 provision() calls at today's Sepolia fees

    function run() external {
        uint256 ownerKey = vm.envUint("OWNER_PRIVATE_KEY");
        address relayer = vm.envAddress("TRIAL_RELAYER_ADDRESS");
        TrialProvisioner prov = TrialProvisioner(payable(vm.parseJsonAddress(vm.readFile("../config/sepolia.json"), ".trials.provisioner")));
        require(prov.owner() == vm.addr(ownerKey), "OWNER_PRIVATE_KEY is not the provisioner owner");
        require(relayer != address(0) && relayer.code.length == 0, "relayer must be a fresh account");
        console.log("provisioner", address(prov));
        console.log("relayer    ", relayer);
        console.log("relayer balance before (wei):", relayer.balance);

        vm.startBroadcast(ownerKey);
        prov.setRelayer(relayer);
        (bool ok,) = payable(relayer).call{value: RELAYER_FUND}("");
        require(ok, "relayer funding failed");
        vm.stopBroadcast();
        require(prov.relayer() == relayer, "relayer not set");
    }
}
