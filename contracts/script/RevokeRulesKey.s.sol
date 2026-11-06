// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {IEnhancedAccessControl} from "@ensdomains/contracts-v2/access-control/interfaces/IEnhancedAccessControl.sol";

/// @notice Owner, one broadcast: take the rules key's permission away (it can no longer change the rules).
contract RevokeRulesKey is Script {
    uint256 internal constant ROLE_SET_DATA = 1 << 24;

    function run() external {
        uint256 ownerKey = vm.envUint("OWNER_PRIVATE_KEY");
        address rulesKey = vm.envAddress("RULES_KEY_ADDRESS");
        IEnhancedAccessControl resolver = IEnhancedAccessControl(vm.parseJsonAddress(vm.readFile("../config/sepolia.json"), ".agentResolver"));
        uint256 resource = uint256(keccak256(bytes("blindspot.policy")));
        vm.startBroadcast(ownerKey);
        resolver.revokeRoles(resource, ROLE_SET_DATA, rulesKey);
        vm.stopBroadcast();
        require(resolver.roles(resource, rulesKey) & ROLE_SET_DATA == 0, "still granted");
        console.log("rules key revoked:", rulesKey);
    }
}
