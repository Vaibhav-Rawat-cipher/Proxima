// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IPermissionedResolver} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";

import {DepositTargetV1, DepositTargetV2Malicious, UpgradeableTarget} from "../src/demo/UpgradeableTarget.sol";
import {SimplePool} from "../src/demo/SimplePool.sol";
import {Policy, PolicyCodec} from "../src/PolicyCodec.sol";
import {SilentToken} from "../test/utils/SilentToken.sol";
import {BlindspotSetup, IMockUSDC} from "./BlindspotSetup.sol";

/// @notice Sepolia TESTBED (owner decision 2026-11-06: everything testable on testnet). Isolated under a
///         separate agent name `test.blindspot-demo.eth` with its own resolver and rules, so the demo
///         agent's rules and funds are never involved. The testbed agent may only touch MockDAI and the
///         test contracts below; MockUSDC and ETH outflows are capped at 0 for it.
///   - SilentToken: moves balances without events + emits an unknown event (fail-closed checks)
///   - proxyV1:      UpgradeableTarget on DepositTargetV1 (stays V1: proxy check passes with a baseline)
///   - proxyUpgraded: UpgradeableTarget deployed on V1, then upgraded by the owner to V2 (proxy check must fail)
///   - SimplePool(MockDAI, MockUSDC, 1 DAI = 1 USDC): swap simulated vs real on testnet
contract SetupTestbed is BlindspotSetup {
    string internal constant TEST_LABEL = "test";
    uint256 internal constant DAI = 1e18;

    function run() external {
        _load();
        IERC20 dai = IERC20(vm.parseJsonAddress(vm.readFile("../config/sepolia.json"), ".ens.MockDAI"));
        address safeAddr = address(safe);
        require(
            registry.getState(uint256(keccak256(bytes(TEST_LABEL)))).status != IPermissionedRegistry.Status.REGISTERED,
            "testbed already set up (test label registered)"
        );
        bytes memory testDns = _dns3(TEST_LABEL, parentLabel, "eth");
        uint256 testResolverSalt = _salt("PermissionedResolver", testDns);
        IPermissionedResolver testResolver = IPermissionedResolver(factory.predictProxyAddress(owner, testResolverSalt));

        vm.startBroadcast(ownerKey);
        // --- test contracts
        SilentToken silent = new SilentToken();
        silent.mint(safeAddr, 100e6);
        DepositTargetV1 v1 = new DepositTargetV1();
        DepositTargetV2Malicious v2 = new DepositTargetV2Malicious();
        UpgradeableTarget proxyV1 = new UpgradeableTarget(address(v1), abi.encodeCall(DepositTargetV1.initialize, (owner, dai)));
        UpgradeableTarget proxyUpgraded = new UpgradeableTarget(address(v1), abi.encodeCall(DepositTargetV1.initialize, (owner, dai)));
        DepositTargetV1(address(proxyUpgraded)).upgradeToAndCall(address(v2), "");
        SimplePool pool = new SimplePool(dai, IERC20(address(usdc)), 1, 1e12); // 1 DAI (18 dec) -> 1 USDC (6 dec)
        usdc.mint(address(pool), 1_000e6);
        IMockUSDC(address(dai)).mint(safeAddr, 100 * DAI);

        // --- testbed agent name: own resolver, zero roles, +90 days, its own rules
        if (address(testResolver).code.length == 0) {
            factory.deployProxy(resolverImpl, testResolverSalt, abi.encodeWithSignature("initialize((address,uint256)[],bytes[])", _grants(), new bytes[](0)));
        }
        registry.register(TEST_LABEL, agent, IRegistry(address(0)), address(testResolver), 0, uint64(block.timestamp) + AGENT_EXPIRY);
        Policy memory p = _testPolicy(address(dai), address(silent), address(pool), address(proxyV1), address(proxyUpgraded));
        bytes memory encoded = PolicyCodec.encode(p);
        require(PolicyCodec.isValid(p, encoded), "test policy invalid");
        testResolver.setData(testDns, POLICY_KEY, encoded);
        testResolver.setText(testDns, "agent-context", "Blindspot TESTBED agent. Its rules only allow MockDAI and test contracts; used to prove every wallet check on Sepolia.");
        vm.stopBroadcast();

        console.log("testResolver   ", address(testResolver));
        console.log("silentToken    ", address(silent));
        console.log("depositV1Impl  ", address(v1));
        console.log("depositV2Impl  ", address(v2));
        console.log("proxyV1        ", address(proxyV1));
        console.log("proxyUpgraded  ", address(proxyUpgraded));
        console.log("simplePool     ", address(pool));
        console.log("test policy bytes:", encoded.length);
    }

    function _testPolicy(address dai, address silent, address pool, address proxyV1, address proxyUpgraded)
        internal
        view
        returns (Policy memory p)
    {
        p.version = 1;
        p.targets = new address[](5);
        p.targets[0] = dai;
        p.targets[1] = silent;
        p.targets[2] = pool;
        p.targets[3] = proxyV1;
        p.targets[4] = proxyUpgraded;
        p.codeHashes = new bytes32[](5);
        p.codeHashes[0] = dai.codehash;
        p.codeHashes[1] = silent.codehash;
        p.codeHashes[2] = pool.codehash;
        // proxies: unpinned (0) -> the wallet's EIP-1967 baseline check applies
        p.selectors = new bytes4[][](5);
        p.selectors[0] = new bytes4[](2);
        p.selectors[0][0] = 0xa9059cbb; // transfer
        p.selectors[0][1] = 0x095ea7b3; // approve
        p.selectors[1] = new bytes4[](2);
        p.selectors[1][0] = 0xa9059cbb; // transfer (moves balance, emits nothing)
        p.selectors[1][1] = SilentToken.poke.selector;
        p.selectors[2] = new bytes4[](1);
        p.selectors[2][0] = SimplePool.swap.selector;
        p.selectors[3] = new bytes4[](1);
        p.selectors[3][0] = DepositTargetV1.deposit.selector;
        p.selectors[4] = new bytes4[](1);
        p.selectors[4][0] = DepositTargetV1.deposit.selector;
        p.payees = payees;
        p.spenders = new address[](3);
        p.spenders[0] = pool;
        p.spenders[1] = proxyV1;
        p.spenders[2] = proxyUpgraded;
        p.tokens = new address[](4);
        p.tokens[0] = dai;
        p.tokens[1] = silent;
        p.tokens[2] = address(usdc); // tracked with caps 0: the testbed agent can never move MockUSDC out
        p.tokens[3] = address(0); // ETH, caps 0
        p.tokenKinds = new uint8[](4);
        p.maxOut = new uint256[](4);
        p.maxOut[0] = 50 * DAI;
        p.maxOut[1] = 100e6;
        p.dailyCap = new uint256[](4);
        p.dailyCap[0] = 100 * DAI;
        p.dailyCap[1] = 200e6;
        p.maxEth = 0;
        p.rateLimitPerHour = 10;
        p.askOwnerAbove = 0; // off for the testbed (ASK_OWNER is tested on the demo agent)
        p.blockNewContracts = false; // testbed contracts are new by definition (tested on the demo agent)
    }
}
