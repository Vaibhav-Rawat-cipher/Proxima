// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Enum} from "@safe/common/Enum.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {Policy} from "../src/PolicyCodec.sol";
import {BlindspotBase} from "./BlindspotBase.sol";

/// @notice Allowed target that tries to re-enter the module while the Safe is calling it.
contract Reenterer {
    BlindspotModule internal immutable module;

    constructor(BlindspotModule m) {
        module = m;
    }

    fallback() external payable {
        module.execute("trader", address(this), 0, hex"12345678");
    }
}

contract BlindspotModuleTest is BlindspotBase {
    // ------------------------------------------------------------------ happy paths

    function test_transferToPayee_executes() public {
        vm.expectEmit(address(module));
        uint256[] memory outflows = new uint256[](2);
        outflows[0] = 40e6;
        emit BlindspotModule.Executed(LABEL, address(usdc), TRANSFER, outflows);
        _exec(address(usdc), 0, _transfer(vendor, 40e6));

        assertEq(usdc.balanceOf(vendor), 40e6);
        assertEq(usdc.balanceOf(address(safe)), 960e6);
        assertEq(module.spentPerDay(keccak256(bytes(LABEL)), address(usdc), block.timestamp / 1 days), 40e6);
    }

    function test_ethToPayee_executes() public {
        _exec(vendor, 0.01 ether, "");
        assertEq(vendor.balance, 0.01 ether);
    }

    function test_views() public view {
        assertTrue(module.isAgentActive(LABEL, agent));
        assertFalse(module.isAgentActive(LABEL, attacker));
        Policy memory p = module.previewPolicy(LABEL);
        assertEq(p.version, 1);
        assertEq(p.payees[0], vendor);
    }

    // ------------------------------------------------------------------ 1. AgentNotActive

    function test_revert_AgentNotActive_wrongSender() public {
        vm.prank(attacker);
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        module.execute(LABEL, address(usdc), 0, _transfer(vendor, 1e6));
    }

    function test_revert_AgentNotActive_unknownLabel() public {
        vm.prank(agent);
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        module.execute("nobody", address(usdc), 0, _transfer(vendor, 1e6));
    }

    function test_revert_AgentNotActive_expired() public {
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        _exec(address(usdc), 0, _transfer(vendor, 1e6));
    }

    function test_revert_AgentNotActive_revoked() public {
        vm.prank(owner);
        registry.unregister(uint256(keccak256(bytes(LABEL))));
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        _exec(address(usdc), 0, _transfer(vendor, 1e6));
    }

    function test_revert_AgentNotActive_reRegisteredToOtherAgent() public {
        address newAgent = makeAddr("newAgent");
        vm.startPrank(owner);
        registry.unregister(uint256(keccak256(bytes(LABEL))));
        registry.register(LABEL, newAgent, IRegistry(address(0)), address(resolver), 0, uint64(block.timestamp + 1 days));
        vm.stopPrank();

        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        _exec(address(usdc), 0, _transfer(vendor, 1e6)); // old agent key

        vm.prank(newAgent); // token ID changed; the module reads fresh state, nothing cached
        module.execute(LABEL, address(usdc), 0, _transfer(vendor, 1e6));
        assertEq(usdc.balanceOf(vendor), 1e6);
    }

    // ------------------------------------------------------------------ 2. PolicyMissing

    function test_revert_PolicyMissing_noRecord() public {
        _setPolicyRaw("");
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        _exec(address(usdc), 0, _transfer(vendor, 1e6));
    }

    function test_revert_PolicyMissing_garbage() public {
        _setPolicyRaw(hex"deadbeef");
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        _exec(address(usdc), 0, _transfer(vendor, 1e6));
    }

    function test_revert_PolicyMissing_trailingBytes() public {
        _setPolicyRaw(abi.encodePacked(abi.encode(_defaultPolicy()), hex"00"));
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        _exec(address(usdc), 0, _transfer(vendor, 1e6));
    }

    function test_revert_PolicyMissing_inconsistentArrays() public {
        Policy memory p = _defaultPolicy();
        p.codeHashes = new bytes32[](1);
        _setPolicyRaw(abi.encode(p));
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        _exec(address(usdc), 0, _transfer(vendor, 1e6));
    }

    function test_revert_PolicyMissing_noResolver() public {
        vm.prank(owner);
        registry.setResolver(uint256(keccak256(bytes(LABEL))), address(0));
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        _exec(address(usdc), 0, _transfer(vendor, 1e6));
    }

    // ------------------------------------------------------------------ 3. ForbiddenTarget

    function test_revert_ForbiddenTarget_safe() public {
        Policy memory p = _defaultPolicy();
        p.targets[1] = address(safe); // even if the owner listed it
        _setPolicy(p);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.ForbiddenTarget.selector, address(safe)));
        _exec(address(safe), 0, abi.encodeCall(safe.enableModule, (attacker)));
    }

    function test_revert_ForbiddenTarget_module() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.ForbiddenTarget.selector, address(module)));
        _exec(address(module), 0, "");
    }

    // ------------------------------------------------------------------ 4. TargetNotAllowed / CodeHashMismatch

    function test_revert_TargetNotAllowed() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.TargetNotAllowed.selector, attacker));
        _exec(attacker, 0, "");
    }

    function test_revert_CodeHashMismatch() public {
        Policy memory p = _defaultPolicy();
        p.codeHashes[0] = keccak256("some other code");
        _setPolicy(p);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.CodeHashMismatch.selector, address(usdc)));
        _exec(address(usdc), 0, _transfer(vendor, 1e6));
    }

    // ------------------------------------------------------------------ 5. SelectorNotAllowed

    function test_revert_SelectorNotAllowed() public {
        bytes memory data = abi.encodeWithSignature("transferFrom(address,address,uint256)", address(safe), vendor, 1);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.SelectorNotAllowed.selector, bytes4(0x23b872dd)));
        _exec(address(usdc), 0, data);
    }

    function test_revert_SelectorNotAllowed_emptyCalldataNotListed() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.SelectorNotAllowed.selector, bytes4(0)));
        _exec(address(usdc), 0, "");
    }

    function test_revert_SelectorNotAllowed_shortCalldata() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.SelectorNotAllowed.selector, bytes4(0)));
        _exec(address(usdc), 0, hex"a905");
    }

    // ------------------------------------------------------------------ 6. RecipientNotAllowed / SpenderNotAllowed

    function test_revert_RecipientNotAllowed_token() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.RecipientNotAllowed.selector, attacker));
        _exec(address(usdc), 0, _transfer(attacker, 1e6));
    }

    function test_revert_RecipientNotAllowed_eth() public {
        Policy memory p = _defaultPolicy();
        p.targets[1] = attacker; // target listed for empty calldata, but not a payee
        _setPolicy(p);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.RecipientNotAllowed.selector, attacker));
        _exec(attacker, 0.001 ether, "");
    }

    function test_revert_SpenderNotAllowed() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.SpenderNotAllowed.selector, attacker));
        _exec(address(usdc), 0, abi.encodeWithSelector(APPROVE, attacker, type(uint256).max));
    }

    // ------------------------------------------------------------------ 7/9. OutflowExceeded / DailyCapExceeded

    function test_revert_OutflowExceeded_eth() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(0), 0.02 ether));
        _exec(vendor, 0.02 ether, "");
    }

    function test_revert_OutflowExceeded_token() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(usdc), 100e6 + 1));
        _exec(address(usdc), 0, _transfer(vendor, 100e6 + 1));
    }

    function test_revert_DailyCapExceeded() public {
        _exec(address(usdc), 0, _transfer(vendor, 100e6));
        _exec(address(usdc), 0, _transfer(vendor, 100e6));
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.DailyCapExceeded.selector, address(usdc), 260e6));
        _exec(address(usdc), 0, _transfer(vendor, 60e6));
    }

    function test_dailyCap_resetsNextUtcDay() public {
        _exec(address(usdc), 0, _transfer(vendor, 100e6));
        _exec(address(usdc), 0, _transfer(vendor, 100e6));
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        _exec(address(usdc), 0, _transfer(vendor, 100e6));
        assertEq(usdc.balanceOf(vendor), 300e6);
    }

    // ------------------------------------------------------------------ 9. AllowanceResidue

    function test_revert_AllowanceResidue() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.AllowanceResidue.selector, address(usdc), spender, 5e6));
        _exec(address(usdc), 0, abi.encodeWithSelector(APPROVE, spender, 5e6));
    }

    // ------------------------------------------------------------------ 8. ExecutionFailed

    function test_revert_ExecutionFailed() public {
        vm.prank(address(safe));
        usdc.transfer(vendor, 1_000e6); // empty the Safe
        vm.expectPartialRevert(BlindspotModule.ExecutionFailed.selector);
        _exec(address(usdc), 0, _transfer(vendor, 1e6));
    }

    // ------------------------------------------------------------------ reentrancy

    function test_reentrancy_blocked() public {
        Reenterer r = new Reenterer(module);
        Policy memory p = _defaultPolicy();
        p.targets[1] = address(r);
        p.selectors[1][0] = 0x12345678;
        _setPolicy(p);
        // The nested execute hits nonReentrant first; the Safe call fails; the outer call reverts.
        vm.expectRevert(
            abi.encodeWithSelector(
                BlindspotModule.ExecutionFailed.selector,
                abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
            )
        );
        _exec(address(r), 0, hex"12345678");
    }

    // ------------------------------------------------------------------ module is the only path

    function test_agentCannotCallSafeDirectly() public {
        vm.prank(agent);
        vm.expectRevert(bytes("GS104"));
        safe.execTransactionFromModule(address(usdc), 0, _transfer(agent, 1e6), Enum.Operation.Call);
    }
}
