// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IEnhancedAccessControl} from "@ensdomains/contracts-v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {PermissionedResolverLib} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";
import {IDataResolver} from "@ens/contracts/resolvers/profiles/IDataResolver.sol";
import {ITextResolver} from "@ens/contracts/resolvers/profiles/ITextResolver.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {BlindspotBase} from "./BlindspotBase.sol";

/// @notice SPEC §6 permission model on the real PermissionedResolver / UserRegistry code:
///         owner-only policy record; agent may write only text key `agent.status`.
contract EnsPermissionsTest is BlindspotBase {
    function setUp() public override {
        super.setUp();
        // Owner grants the agent a setter role for text key `agent.status` only (SPEC §6.6).
        bytes memory setter = abi.encodeCall(resolver.setText, (bytes(""), "agent.status", ""));
        vm.prank(owner);
        resolver.grantSetterRoles(setter, agent);
    }

    function test_agentCannotWritePolicy() public {
        bytes memory dns = _agentDns();
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                uint256(keccak256(bytes("blindspot.policy"))),
                PermissionedResolverLib.ROLE_SET_DATA,
                agent
            )
        );
        resolver.setData(dns, "blindspot.policy", hex"00");
    }

    function test_agentCanWriteStatusOnly() public {
        bytes memory dns = _agentDns();
        vm.prank(agent);
        resolver.setText(dns, "agent.status", "paying invoices");
        bytes32 node = keccak256(abi.encodePacked(module.parentNode(), keccak256(bytes(LABEL))));
        bytes memory res = resolver.resolve(dns, abi.encodeCall(ITextResolver.text, (node, "agent.status")));
        assertEq(abi.decode(res, (string)), "paying invoices");

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                uint256(keccak256(bytes("agent-context"))),
                PermissionedResolverLib.ROLE_SET_TEXT,
                agent
            )
        );
        resolver.setText(dns, "agent-context", "I am allowed to do anything");
    }

    function test_ownerCanWritePolicyAndContext() public {
        bytes memory dns = _agentDns();
        vm.startPrank(owner);
        resolver.setData(dns, "blindspot.policy", hex"01");
        resolver.setText(dns, "agent-context", "Blindspot agent; rules in data record blindspot.policy");
        vm.stopPrank();
        bytes32 node = keccak256(abi.encodePacked(module.parentNode(), keccak256(bytes(LABEL))));
        bytes memory res = resolver.resolve(dns, abi.encodeCall(IDataResolver.data, (node, "blindspot.policy")));
        assertEq(abi.decode(res, (bytes)), hex"01");
    }

    function test_agentHasNoRegistryRoles() public view {
        IPermissionedRegistry.State memory s = registry.getState(uint256(keccak256(bytes(LABEL))));
        assertEq(uint8(s.status), uint8(IPermissionedRegistry.Status.REGISTERED));
        assertEq(s.latestOwner, agent);
        assertEq(registry.roles(s.resource, agent), 0, "agent must hold zero roles on its name");
    }

    function test_agentCannotRevokeOrRenewItself() public {
        uint256 id = uint256(keccak256(bytes(LABEL)));
        vm.startPrank(agent);
        vm.expectPartialRevert(IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector);
        registry.renew(id, uint64(block.timestamp + 365 days));
        vm.expectPartialRevert(IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector);
        registry.setResolver(id, attacker);
        vm.stopPrank();
    }

    function test_ownerRevoke_stopsAgent() public {
        vm.prank(owner);
        registry.unregister(uint256(keccak256(bytes(LABEL))));
        assertFalse(module.isAgentActive(LABEL, agent));
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        _exec(address(usdc), 0, _transfer(vendor, 1e6));
    }
}
