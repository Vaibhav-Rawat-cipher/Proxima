// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {IPermissionedResolver} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";
import {IEnhancedAccessControl} from "@ensdomains/contracts-v2/access-control/interfaces/IEnhancedAccessControl.sol";

/// @notice Owner, one broadcast: let the RULES key change ONLY the "blindspot.policy" record on the demo agent's
///         resolver (ENSv2 grantSetterRoles → ROLE_SET_DATA scoped to that key), and send it a little ETH for gas.
///         It gets nothing else: no other record, no registry role, no Safe access.
contract GrantRulesKey is Script {
    uint256 internal constant ROLE_SET_DATA = 1 << 24;
    uint256 internal constant RULES_KEY_FUND = 0.001 ether; // thousands of rule updates at today's Sepolia fees

    function run() external {
        uint256 ownerKey = vm.envUint("OWNER_PRIVATE_KEY");
        address rulesKey = vm.envAddress("RULES_KEY_ADDRESS");
        IPermissionedResolver resolver = IPermissionedResolver(vm.parseJsonAddress(vm.readFile("../config/sepolia.json"), ".agentResolver"));
        require(rulesKey != vm.addr(ownerKey), "rules key must differ from the owner key");
        uint256 resource = uint256(keccak256(bytes("blindspot.policy")));

        vm.startBroadcast(ownerKey);
        resolver.grantSetterRoles(abi.encodeWithSignature("setData(bytes,string,bytes)", bytes(""), "blindspot.policy", bytes("")), rulesKey);
        (bool ok,) = payable(rulesKey).call{value: RULES_KEY_FUND}("");
        require(ok, "funding failed");
        vm.stopBroadcast();

        IEnhancedAccessControl eac = IEnhancedAccessControl(address(resolver));
        require(eac.roles(resource, rulesKey) & ROLE_SET_DATA != 0, "role not granted");
        require(eac.roles(0, rulesKey) == 0, "rules key must hold no root roles");
        console.log("rules key", rulesKey);
        console.log("may set blindspot.policy on resolver", address(resolver));
    }
}
