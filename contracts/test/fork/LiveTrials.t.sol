// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";

import {BlindspotModule} from "../../src/BlindspotModule.sol";
import {TrialProvisioner} from "../../src/TrialProvisioner.sol";

/// @notice 3d against a fork of LIVE Sepolia, using the DEPLOYED trial contracts (config/sepolia.json "trials",
///         broadcast by the owner 2026-11-06). Nothing is sent: provisioning and payments happen on the local fork.
contract LiveTrialsTest is Test {
    bytes4 internal constant TRANSFER = 0xa9059cbb;
    BlindspotModule internal demoModule;
    IPermissionedRegistry internal demoRegistry;
    IERC20 internal usdc;
    address internal demoAgent;
    address internal vendor1;
    address internal vendor2;
    bytes32 internal demoPolicyHash;

    BlindspotModule internal trialModule;
    TrialProvisioner internal prov;
    IPermissionedRegistry internal trialRegistry;

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        string memory cfg = vm.readFile("../config/sepolia.json");
        demoModule = BlindspotModule(vm.parseJsonAddress(cfg, ".module"));
        demoRegistry = IPermissionedRegistry(vm.parseJsonAddress(cfg, ".agentRegistry"));
        usdc = IERC20(vm.parseJsonAddress(cfg, ".ens.MockUSDC"));
        demoAgent = vm.parseJsonAddress(cfg, ".agents.demo.address");
        vendor1 = vm.parseJsonAddress(cfg, ".payees.vendor1");
        vendor2 = vm.parseJsonAddress(cfg, ".payees.vendor2");
        demoPolicyHash = keccak256(abi.encode(demoModule.previewPolicy("demo")));

        trialModule = BlindspotModule(vm.parseJsonAddress(cfg, ".trials.trialModule"));
        prov = TrialProvisioner(payable(vm.parseJsonAddress(cfg, ".trials.provisioner")));
        trialRegistry = IPermissionedRegistry(vm.parseJsonAddress(cfg, ".trials.trialRegistry"));
        assertEq(address(prov.trialRegistry()), address(trialRegistry));
        assertEq(address(trialModule.agentRegistry()), address(trialRegistry));
    }

    function _pay(address agent, string memory label, address to, uint256 amount) internal {
        vm.prank(agent);
        trialModule.execute(label, address(usdc), 0, abi.encodeWithSelector(TRANSFER, to, amount));
    }

    function test_liveTrials_wiring() public view {
        assertEq(address(demoRegistry.getSubregistry("trials")), address(trialRegistry), "trials.blindspot-demo.eth -> trial registry");
        assertTrue(trialRegistry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(prov)));
        assertFalse(demoRegistry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(prov)));
        assertGe(address(prov).balance, prov.drip());
        assertGe(usdc.balanceOf(address(trialModule.safe())), 2e6);
        assertEq(address(trialModule.safe()), vm.parseJsonAddress(vm.readFile("../config/sepolia.json"), ".trials.trialSafe"));
        assertEq(keccak256(abi.encode(demoModule.previewPolicy("demo"))), demoPolicyHash, "demo rules unchanged");
    }

    function test_liveTrials_judgeGetsTrial_paysForReal_capsHold() public {
        address judge = makeAddr("judge");
        address trialAgent = makeAddr("trialAgent");
        vm.prank(judge);
        (, string memory label) = prov.provision(trialAgent);
        assertEq(label, string.concat("try", vm.toString(prov.trialCount())));
        assertEq(trialAgent.balance, 0.00005 ether);
        assertTrue(trialModule.isAgentActive(label, trialAgent));

        uint256 v1 = usdc.balanceOf(vendor1);
        _pay(trialAgent, label, vendor1, 1e6);
        assertEq(usdc.balanceOf(vendor1), v1 + 1e6);

        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(usdc), 1.5e6));
        _pay(trialAgent, label, vendor2, 1.5e6);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.RecipientNotAllowed.selector, judge));
        _pay(trialAgent, label, judge, 1e6);
        _pay(trialAgent, label, vendor2, 1e6);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.DailyCapExceeded.selector, address(usdc), 3e6));
        _pay(trialAgent, label, vendor1, 1e6);
    }

    function test_liveTrials_isolationFromDemoSafe() public {
        address trialAgent = makeAddr("trialAgent");
        vm.prank(makeAddr("judge"));
        (, string memory label) = prov.provision(trialAgent);
        vm.prank(trialAgent);
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        demoModule.execute(label, address(usdc), 0, abi.encodeWithSelector(TRANSFER, vendor1, 1e6));
        vm.prank(demoAgent);
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        trialModule.execute("demo", address(usdc), 0, abi.encodeWithSelector(TRANSFER, vendor1, 1e6));
    }

    function test_liveTrials_expiresAfter24h() public {
        address trialAgent = makeAddr("trialAgent");
        vm.prank(makeAddr("judge"));
        (, string memory label) = prov.provision(trialAgent);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        _pay(trialAgent, label, vendor1, 1e6);
    }
}
