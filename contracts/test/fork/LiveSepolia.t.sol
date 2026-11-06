// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {IEnhancedAccessControl} from "@ensdomains/contracts-v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IPermissionedResolver} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";
import {PermissionedResolverLib} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";
import {IAddrResolver} from "@ens/contracts/resolvers/profiles/IAddrResolver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Enum} from "@safe/common/Enum.sol";
import {Safe} from "@safe/Safe.sol";

import {BlindspotModule} from "../../src/BlindspotModule.sol";
import {Policy, PolicyCodec} from "../../src/PolicyCodec.sol";

/// @dev Sepolia MockUSDC has an open faucet mint (used on the local fork only).
interface IMintableUSDC {
    function mint(address to, uint256 amount) external;
}

/// @notice Fork tests against the LIVE Sepolia deployment recorded in config/sepolia.json.
///         They fork the current Sepolia state and run locally; nothing is ever sent.
///         Skipped when SEPOLIA_RPC_URL is not set. Run:
///         forge test --match-path "test/fork/*" (with .env loaded)
contract LiveSepoliaForkTest is Test {
    string internal constant LABEL = "demo";
    bytes4 internal constant TRANSFER = 0xa9059cbb;
    address internal constant UNLISTED = 0x000000000000000000000000000000000000dEaD;

    BlindspotModule internal module;
    Safe internal safe;
    IPermissionedRegistry internal registry;
    IPermissionedResolver internal agentResolver;
    IERC20 internal usdc;
    address internal owner;
    address internal agent;
    address internal vendor1;
    address internal vendor2;
    bytes internal agentDns;

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        string memory cfg = vm.readFile("../config/sepolia.json");
        assertEq(vm.parseJsonUint(cfg, ".chainId"), block.chainid, "config chainId");
        module = BlindspotModule(vm.parseJsonAddress(cfg, ".module"));
        safe = Safe(payable(vm.parseJsonAddress(cfg, ".safeAddress")));
        registry = IPermissionedRegistry(vm.parseJsonAddress(cfg, ".agentRegistry"));
        agentResolver = IPermissionedResolver(vm.parseJsonAddress(cfg, ".agentResolver"));
        usdc = IERC20(vm.parseJsonAddress(cfg, ".ens.MockUSDC"));
        owner = vm.parseJsonAddress(cfg, ".owner");
        agent = vm.parseJsonAddress(cfg, ".agents.demo.address");
        vendor1 = vm.parseJsonAddress(cfg, ".payees.vendor1");
        vendor2 = vm.parseJsonAddress(cfg, ".payees.vendor2");
        agentDns = abi.encodePacked(uint8(4), "demo", uint8(14), "blindspot-demo", uint8(3), "eth", uint8(0));
    }

    function _pay(address to, uint256 amount) internal returns (bytes memory) {
        vm.prank(agent);
        return module.execute(LABEL, address(usdc), 0, abi.encodeWithSelector(TRANSFER, to, amount));
    }

    function _spentToday() internal view returns (uint256) {
        return module.spentPerDay(keccak256(bytes(LABEL)), address(usdc), block.timestamp / 1 days);
    }

    // ------------------------------------------------------------------ wiring

    function test_live_wiring() public view {
        address[] memory owners = safe.getOwners();
        assertEq(owners.length, 1);
        assertEq(owners[0], owner);
        assertEq(safe.getThreshold(), 1);
        assertTrue(safe.isModuleEnabled(address(module)));
        assertEq(address(module.safe()), address(safe));
        assertEq(address(module.agentRegistry()), address(registry));
        assertTrue(module.isAgentActive(LABEL, agent));
        assertFalse(module.isAgentActive(LABEL, owner));
        IPermissionedRegistry.State memory s = registry.getState(uint256(keccak256(bytes(LABEL))));
        assertEq(uint8(s.status), uint8(IPermissionedRegistry.Status.REGISTERED));
        assertEq(s.latestOwner, agent);
        assertEq(registry.roles(s.resource, agent), 0, "agent holds zero roles on its name");
    }

    function test_live_policyIsTheOwnersRules() public view {
        Policy memory p = module.previewPolicy(LABEL);
        assertEq(p.version, 1);
        assertEq(p.payees.length, 2);
        assertEq(p.payees[0], vendor1);
        assertEq(p.payees[1], vendor2);
        assertEq(p.targets[0], address(usdc));
        assertEq(p.codeHashes[0], address(usdc).codehash, "MockUSDC code pinned");
        assertEq(p.maxOut[0], 25e6);
        assertEq(p.dailyCap[0], 100e6); // owner raised 50 → 100 on ENS, 2026-11-06 (tx 0xdbd8c9fc…)
        assertEq(p.maxOut[1], 0.002 ether);
        assertEq(p.dailyCap[1], 0.005 ether);
        assertEq(p.maxEth, 0.002 ether);
    }

    function test_live_vendorNamesResolve() public view {
        // Resolver records for the payee names (the Universal Resolver path is checked off-chain).
        IPermissionedResolver payeeResolver = IPermissionedResolver(registry.getResolver("vendor1"));
        bytes memory v1 = abi.encodePacked(uint8(7), "vendor1", uint8(14), "blindspot-demo", uint8(3), "eth", uint8(0));
        bytes memory res = payeeResolver.resolve(v1, abi.encodeCall(IAddrResolver.addr, (keccak256(abi.encodePacked(module.parentNode(), keccak256("vendor1"))))));
        assertEq(abi.decode(res, (address)), vendor1);
    }

    // ------------------------------------------------------------------ allowed actions

    function test_live_agentPaysVendor2() public {
        uint256 before = usdc.balanceOf(address(safe));
        _pay(vendor2, 2e6);
        assertEq(usdc.balanceOf(vendor2), 2e6);
        assertEq(usdc.balanceOf(address(safe)), before - 2e6);
    }

    function test_live_agentPaysEthToPayee() public {
        uint256 before = vendor1.balance;
        vm.prank(agent);
        module.execute(LABEL, vendor1, 0.002 ether, "");
        assertEq(vendor1.balance, before + 0.002 ether);
    }

    function test_live_batchPaysBothVendors() public {
        BlindspotModule.Call[] memory calls = new BlindspotModule.Call[](2);
        calls[0] = BlindspotModule.Call(address(usdc), 0, abi.encodeWithSelector(TRANSFER, vendor1, 3e6));
        calls[1] = BlindspotModule.Call(address(usdc), 0, abi.encodeWithSelector(TRANSFER, vendor2, 4e6));
        vm.prank(agent);
        module.executeBatch(LABEL, calls);
        assertEq(usdc.balanceOf(vendor2), 4e6);
    }

    // ------------------------------------------------------------------ blocked actions

    function test_live_revert_unlistedRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.RecipientNotAllowed.selector, UNLISTED));
        _pay(UNLISTED, 1e6);
    }

    function test_live_revert_overPerTxCap() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(usdc), 26e6));
        _pay(vendor1, 26e6);
    }

    function test_live_revert_ethOverMaxEth() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(0), 0.003 ether));
        module.execute(LABEL, vendor1, 0.003 ether, "");
    }

    function test_live_revert_dailyCap() public {
        // Fill today's room in payments of at most 25 (the per-tx cap), then one more MockUSDC must hit the daily cap.
        IMintableUSDC(address(usdc)).mint(address(safe), 200e6); // the fork's Safe must hold more than the day's room
        uint256 cap = module.previewPolicy(LABEL).dailyCap[0];
        uint256 room = cap - _spentToday(); // includes real payments made today (UTC)
        while (room > 0) {
            uint256 amount = room > 25e6 ? 25e6 : room;
            _pay(vendor1, amount);
            room -= amount;
        }
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.DailyCapExceeded.selector, address(usdc), cap + 1e6));
        _pay(vendor1, 1e6);
    }

    function test_live_revert_agentCallsSafeDirectly() public {
        vm.prank(agent);
        vm.expectRevert(bytes("GS104"));
        safe.execTransactionFromModule(address(usdc), 0, abi.encodeWithSelector(TRANSFER, agent, 1e6), Enum.Operation.Call);
    }

    function test_live_revert_agentWritesPolicy() public {
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                uint256(keccak256(bytes("blindspot.policy"))),
                PermissionedResolverLib.ROLE_SET_DATA,
                agent
            )
        );
        agentResolver.setData(agentDns, "blindspot.policy", hex"01");
    }

    function test_live_agentMayWriteStatus() public {
        vm.prank(agent);
        agentResolver.setText(agentDns, "agent.status", "fork test");
    }

    // ------------------------------------------------------------------ owner controls via ENS (no redeploy)

    function test_live_ownerTightensRulesViaENS() public {
        Policy memory p = module.previewPolicy(LABEL);
        p.version = 2;
        p.maxOut[0] = 5e6;
        p.dailyCap[0] = _spentToday() + 10e6; // tight, independent of what was already spent today
        vm.prank(owner);
        agentResolver.setData(agentDns, "blindspot.policy", PolicyCodec.encode(p));
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(usdc), 6e6));
        _pay(vendor1, 6e6); // allowed under v1 (25 cap), blocked under the owner's new v2 rules
        _pay(vendor1, 5e6);
    }

    function test_live_ownerRevokesAgent() public {
        vm.prank(owner);
        registry.unregister(uint256(keccak256(bytes(LABEL))));
        assertFalse(module.isAgentActive(LABEL, agent));
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        _pay(vendor1, 1e6);
    }
}
