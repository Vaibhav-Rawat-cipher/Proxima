// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Grant} from "@ensdomains/contracts-v2/access-control/interfaces/IEACGrantInitializable.sol";
import {IEnhancedAccessControl} from "@ensdomains/contracts-v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {IRegistryURIRenderer} from "@ensdomains/contracts-v2/registry/interfaces/IRegistryURIRenderer.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {UserRegistry} from "@ensdomains/contracts-v2/registry/UserRegistry.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";
import {IPermissionedResolver} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";
import {IContractNamer} from "@ensdomains/contracts-v2/reverse-registrar/interfaces/IContractNamer.sol";
import {ILabelStore} from "@ensdomains/contracts-v2/utils/interfaces/ILabelStore.sol";
import {LabelStore} from "@ensdomains/contracts-v2/utils/LabelStore.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {Enum} from "@safe/common/Enum.sol";
import {Safe} from "@safe/Safe.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";
import {Policy, PolicyCodec} from "../src/PolicyCodec.sol";
import {TrialProvisioner} from "../src/TrialProvisioner.sol";
import {BlindspotBase} from "./BlindspotBase.sol";

/// @notice Step 3d on the real stack built from source (Safe v1.4.1, ENSv2 contracts-v2 07e55a05). The base
///         contract gives the DEMO stack (registry "owner.eth", agent "trader", Safe, module, USDC); this test adds
///         the TRIAL stack exactly like script/TrialSetup.sol: trials.owner.eth → own registry, own resolver, own
///         Safe + module, provisioner with the two role grants.
contract TrialProvisionerTest is BlindspotBase {
    // "\x06trials\x05owner\x03eth\x00"
    bytes internal constant TRIALS_DNS = hex"06747269616c73" hex"056f776e6572" hex"03657468" hex"00";
    uint256 internal constant DRIP = 0.00005 ether;

    address internal vendor2 = makeAddr("vendor2");
    address internal relayer = makeAddr("relayer");
    address internal judge = makeAddr("judge");
    address internal trialAgent = makeAddr("trialAgent");

    UserRegistry internal trialRegistry;
    PermissionedResolver internal trialResolver;
    Safe internal trialSafe;
    BlindspotModule internal trialModule;
    TrialProvisioner internal prov;

    function setUp() public override {
        super.setUp();
        VerifiableFactory factory = new VerifiableFactory();
        LabelStore labelStore = new LabelStore(IContractNamer(address(0)));
        UserRegistry registryImpl = new UserRegistry(ILabelStore(address(labelStore)), IRegistryURIRenderer(address(0)), namer);
        PermissionedResolver resolverImpl = new PermissionedResolver(namer);
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant({account: owner, roleBitmap: ALL_ROLES});

        vm.startPrank(owner);
        trialRegistry = UserRegistry(factory.deployProxy(address(registryImpl), 11, abi.encodeCall(UserRegistry.initialize, (grants))));
        registry.register("trials", owner, IRegistry(address(trialRegistry)), address(0), 0, uint64(block.timestamp + 360 days));
        trialResolver = PermissionedResolver(
            factory.deployProxy(address(resolverImpl), 12, abi.encodeCall(PermissionedResolver.initialize, (grants, new bytes[](0))))
        );
        vm.stopPrank();

        Safe singleton = new Safe();
        SafeProxyFactory safeFactory = new SafeProxyFactory();
        address[] memory owners = new address[](1);
        owners[0] = owner;
        trialSafe = Safe(payable(address(safeFactory.createProxyWithNonce(address(singleton), abi.encodeCall(Safe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)))), 7))));
        trialModule = new BlindspotModule(ISafe(address(trialSafe)), IPermissionedRegistry(address(trialRegistry)), TRIALS_DNS);
        _trialSafeTx(abi.encodeCall(trialSafe.enableModule, (address(trialModule))));

        prov = new TrialProvisioner(
            IPermissionedRegistry(address(trialRegistry)), IPermissionedResolver(address(trialResolver)), TRIALS_DNS, _trialPolicyBytes(), owner, relayer, 100, 100, DRIP
        );
        vm.startPrank(owner);
        trialRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(prov));
        trialResolver.grantSetterRoles(abi.encodeWithSignature("setData(bytes,string,bytes)", bytes(""), "blindspot.policy", bytes("")), address(prov));
        vm.stopPrank();
        vm.deal(address(prov), 0.01 ether);
        usdc.mint(address(trialSafe), 100e6);
    }

    // ---------------------------------------------------------------- helpers
    function _trialPolicy() internal view returns (Policy memory p) {
        p.version = 1;
        p.targets = new address[](1);
        p.targets[0] = address(usdc);
        p.codeHashes = new bytes32[](1);
        p.codeHashes[0] = address(usdc).codehash;
        p.selectors = new bytes4[][](1);
        p.selectors[0] = _sels(TRANSFER);
        p.payees = new address[](2);
        p.payees[0] = vendor;
        p.payees[1] = vendor2;
        p.tokens = new address[](1);
        p.tokens[0] = address(usdc);
        p.tokenKinds = new uint8[](1);
        p.maxOut = new uint256[](1);
        p.maxOut[0] = 1e6;
        p.dailyCap = new uint256[](1);
        p.dailyCap[0] = 2e6;
        p.rateLimitPerHour = 10;
        p.blockNewContracts = true;
    }

    function _trialPolicyBytes() internal view returns (bytes memory) {
        return PolicyCodec.encode(_trialPolicy());
    }

    function _trialSafeTx(bytes memory data) internal {
        bytes memory sig = abi.encodePacked(uint256(uint160(owner)), uint256(0), uint8(1));
        vm.prank(owner);
        require(trialSafe.execTransaction(address(trialSafe), 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig), "trial safe tx failed");
    }

    function _trialDns(string memory label) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, TRIALS_DNS);
    }

    function _provision(address sender, address a) internal returns (string memory label) {
        vm.prank(sender);
        (, label) = prov.provision(a);
    }

    function _pay(address a, string memory label, address to, uint256 amount) internal {
        vm.prank(a);
        trialModule.execute(label, address(usdc), 0, _transfer(to, amount));
    }

    // ---------------------------------------------------------------- what a trial gets
    function test_provision_registersZeroRoleName_24h_policy_drip() public {
        vm.expectEmit(true, true, true, true, address(prov));
        emit TrialProvisioner.TrialProvisioned(1, "try1", trialAgent, judge, uint64(block.timestamp + 24 hours));
        string memory label = _provision(judge, trialAgent);
        assertEq(label, "try1");

        IPermissionedRegistry.State memory s = trialRegistry.getState(uint256(keccak256("try1")));
        assertEq(s.latestOwner, trialAgent);
        assertEq(s.expiry, uint64(block.timestamp + 24 hours));
        assertEq(trialRegistry.getResolver("try1"), address(trialResolver));
        assertEq(trialRegistry.roles(s.resource, trialAgent), 0, "trial agent must hold zero roles");
        assertEq(trialAgent.balance, DRIP);
        // the policy record the module will read
        assertEq(keccak256(abi.encode(trialModule.previewPolicy("try1"))), keccak256(_trialPolicyBytes()));
        // the demo registry is untouched and the parent link is in place
        assertEq(address(registry.getSubregistry("trials")), address(trialRegistry));
        assertEq(registry.getState(uint256(keccak256(bytes(LABEL)))).latestOwner, agent);
    }

    function test_labelsIncrease() public {
        assertEq(_provision(judge, trialAgent), "try1");
        assertEq(_provision(makeAddr("judge2"), makeAddr("a2")), "try2");
        assertEq(prov.trialCount(), 2);
    }

    // ---------------------------------------------------------------- real payments through the TRIAL module
    function test_trialAgentPays_withinTinyPolicy() public {
        string memory label = _provision(judge, trialAgent);
        _pay(trialAgent, label, vendor, 1e6);
        _pay(trialAgent, label, vendor2, 1e6);
        assertEq(usdc.balanceOf(vendor), 1e6);
        assertEq(usdc.balanceOf(vendor2), 1e6);
        assertEq(usdc.balanceOf(address(trialSafe)), 98e6);
    }

    function test_revert_overPerTxCap() public {
        string memory label = _provision(judge, trialAgent);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(usdc), 1.5e6));
        _pay(trialAgent, label, vendor, 1.5e6);
    }

    function test_revert_dailyCap() public {
        string memory label = _provision(judge, trialAgent);
        _pay(trialAgent, label, vendor, 1e6);
        _pay(trialAgent, label, vendor, 1e6);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.DailyCapExceeded.selector, address(usdc), 3e6));
        _pay(trialAgent, label, vendor, 1e6);
    }

    function test_revert_attackerRecipient() public {
        string memory label = _provision(judge, trialAgent);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.RecipientNotAllowed.selector, attacker));
        _pay(trialAgent, label, attacker, 1e6);
    }

    function test_revert_noEthOutflow() public {
        string memory label = _provision(judge, trialAgent);
        vm.deal(address(trialSafe), 1 ether);
        vm.prank(trialAgent);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.TargetNotAllowed.selector, vendor));
        trialModule.execute(label, vendor, 1 wei, "");
    }

    function test_revert_after24h_and_afterOwnerUnregister() public {
        string memory label = _provision(judge, trialAgent);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        _pay(trialAgent, label, vendor, 1e6);

        string memory l2 = _provision(makeAddr("judge2"), makeAddr("a2"));
        vm.prank(owner);
        trialRegistry.unregister(uint256(keccak256(bytes(l2))));
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        _pay(makeAddr("a2"), l2, vendor, 1e6);
    }

    // ---------------------------------------------------------------- isolation (owner decision 4 + option A)
    function test_isolation_trialAgentCannotUseDemoModule() public {
        string memory label = _provision(judge, trialAgent);
        vm.prank(trialAgent);
        vm.expectRevert(BlindspotModule.AgentNotActive.selector); // demo module reads the demo registry only
        module.execute(label, address(usdc), 0, _transfer(vendor, 1e6));
        assertEq(usdc.balanceOf(vendor), 0);
    }

    function test_isolation_demoAgentCannotUseTrialModule() public {
        vm.prank(agent);
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        trialModule.execute(LABEL, address(usdc), 0, _transfer(vendor, 1e6));
    }

    function test_isolation_trialsNodeIsNotAnAgent() public {
        // "trials" itself is a name in the demo registry (owned by the owner, no resolver): never an agent
        vm.prank(owner);
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        module.execute("trials", address(usdc), 0, _transfer(vendor, 1e6));
    }

    // ---------------------------------------------------------------- limits
    function test_limit_onePerSenderPerDay_thenNextDay() public {
        _provision(judge, trialAgent);
        uint256 day = block.timestamp / 1 days;
        vm.prank(judge);
        vm.expectRevert(abi.encodeWithSelector(TrialProvisioner.SenderLimitReached.selector, judge, day));
        prov.provision(makeAddr("a2"));
        vm.warp(block.timestamp + 1 days);
        assertEq(_provision(judge, makeAddr("a2")), "try2");
    }

    function test_limit_relayerQuota_insideGlobalCap() public {
        vm.prank(owner);
        prov.setLimits(5, 3);
        for (uint256 i; i < 3; ++i) _provision(relayer, makeAddr(string.concat("r", vm.toString(i))));
        uint256 day = block.timestamp / 1 days;
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(TrialProvisioner.RelayerQuotaReached.selector, day));
        prov.provision(makeAddr("r9"));
        _provision(judge, makeAddr("d1")); // direct callers still have room (global 5)
        _provision(makeAddr("judge2"), makeAddr("d2"));
        vm.prank(makeAddr("judge3"));
        vm.expectRevert(abi.encodeWithSelector(TrialProvisioner.GlobalCapReached.selector, day));
        prov.provision(makeAddr("d3"));
    }

    function test_limit_freshAgentOnly() public {
        _provision(judge, trialAgent);
        vm.prank(makeAddr("judge2"));
        vm.expectRevert(abi.encodeWithSelector(TrialProvisioner.AgentAlreadyUsed.selector, trialAgent));
        prov.provision(trialAgent);
        vm.prank(makeAddr("judge3"));
        vm.expectRevert(abi.encodeWithSelector(TrialProvisioner.InvalidAgent.selector, address(usdc))); // has code
        prov.provision(address(usdc));
        vm.prank(makeAddr("judge4"));
        vm.expectRevert(abi.encodeWithSelector(TrialProvisioner.InvalidAgent.selector, address(0)));
        prov.provision(address(0));
    }

    function test_killSwitch_pause_and_revokeRole() public {
        vm.prank(owner);
        prov.setPaused(true);
        vm.prank(judge);
        vm.expectRevert(TrialProvisioner.IsPaused.selector);
        prov.provision(trialAgent);
        vm.prank(owner);
        prov.setPaused(false);
        // hard stop: the owner revokes the registrar role on the trial registry
        vm.prank(owner);
        trialRegistry.revokeRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(prov));
        vm.prank(judge);
        vm.expectRevert(
            abi.encodeWithSelector(IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector, trialRegistry.ROOT_RESOURCE(), RegistryRolesLib.ROLE_REGISTRAR, address(prov))
        );
        prov.provision(trialAgent);
    }

    function test_dripFundsEmpty_failsClosed() public {
        vm.prank(owner);
        prov.withdraw(payable(owner), address(prov).balance);
        vm.prank(judge);
        vm.expectRevert(TrialProvisioner.DripFundsEmpty.selector);
        prov.provision(trialAgent);
    }

    // ---------------------------------------------------------------- permissions
    function test_trialAgentCannotChangeItsPolicy() public {
        _provision(judge, trialAgent);
        vm.prank(trialAgent);
        vm.expectRevert();
        trialResolver.setData(_trialDns("try1"), "blindspot.policy", hex"00");
    }

    function test_provisionerCanOnlyWriteThePolicyKey() public {
        vm.prank(address(prov));
        vm.expectRevert();
        trialResolver.setText(_trialDns("try1"), "agent-context", "x");
        vm.prank(address(prov));
        vm.expectRevert();
        trialResolver.setData(_trialDns("try1"), "other.key", hex"01");
        // and it holds no roles on the DEMO resolver at all
        vm.prank(address(prov));
        vm.expectRevert();
        resolver.setData(_agentDns(), "blindspot.policy", _trialPolicyBytes());
    }

    function test_provisionerHasNoRolesOnDemoRegistry() public {
        assertFalse(registry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(prov)));
        assertTrue(trialRegistry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(prov)));
        assertFalse(trialRegistry.hasRootRoles(RegistryRolesLib.ROLE_UNREGISTER, address(prov)));
        assertFalse(trialRegistry.hasRootRoles(RegistryRolesLib.ROLE_RENEW, address(prov)));
    }

    function test_onlyOwnerControls() public {
        vm.startPrank(judge);
        vm.expectRevert(TrialProvisioner.NotOwner.selector);
        prov.setPaused(true);
        vm.expectRevert(TrialProvisioner.NotOwner.selector);
        prov.setRelayer(judge);
        vm.expectRevert(TrialProvisioner.NotOwner.selector);
        prov.setLimits(1000, 1000);
        vm.expectRevert(TrialProvisioner.NotOwner.selector);
        prov.setDrip(1 ether);
        vm.expectRevert(TrialProvisioner.NotOwner.selector);
        prov.withdraw(payable(judge), 1);
        vm.expectRevert(TrialProvisioner.NotOwner.selector);
        prov.setPolicy(_trialPolicyBytes());
        vm.stopPrank();
    }

    function test_policyIsValidated() public {
        Policy memory bad = _trialPolicy();
        bad.maxOut[0] = 3e6; // above its daily cap
        bytes memory raw = PolicyCodec.encode(bad);
        vm.prank(owner);
        vm.expectRevert(TrialProvisioner.InvalidPolicy.selector);
        prov.setPolicy(raw);
        vm.expectRevert(TrialProvisioner.InvalidPolicy.selector);
        new TrialProvisioner(IPermissionedRegistry(address(trialRegistry)), IPermissionedResolver(address(trialResolver)), TRIALS_DNS, raw, owner, relayer, 100, 100, DRIP);
        vm.expectRevert(TrialProvisioner.InvalidConfig.selector);
        new TrialProvisioner(IPermissionedRegistry(address(trialRegistry)), IPermissionedResolver(address(trialResolver)), TRIALS_DNS, _trialPolicyBytes(), owner, relayer, 10, 11, DRIP);
    }

    function test_setPolicy_appliesToNewTrialsOnly() public {
        string memory l1 = _provision(judge, trialAgent);
        Policy memory p2 = _trialPolicy();
        p2.payees[1] = makeAddr("newVendor2");
        vm.prank(owner);
        prov.setPolicy(PolicyCodec.encode(p2));
        string memory l2 = _provision(makeAddr("judge2"), makeAddr("a2"));
        assertEq(keccak256(abi.encode(trialModule.previewPolicy(l1))), keccak256(_trialPolicyBytes()));
        assertEq(keccak256(abi.encode(trialModule.previewPolicy(l2))), keccak256(PolicyCodec.encode(p2)));
    }
}
