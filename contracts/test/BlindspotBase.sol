// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {Grant} from "@ensdomains/contracts-v2/access-control/interfaces/IEACGrantInitializable.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {IRegistryURIRenderer} from "@ensdomains/contracts-v2/registry/interfaces/IRegistryURIRenderer.sol";
import {UserRegistry} from "@ensdomains/contracts-v2/registry/UserRegistry.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";
import {IContractNamer} from "@ensdomains/contracts-v2/reverse-registrar/interfaces/IContractNamer.sol";
import {ILabelStore} from "@ensdomains/contracts-v2/utils/interfaces/ILabelStore.sol";
import {LabelStore} from "@ensdomains/contracts-v2/utils/LabelStore.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";

import {Enum} from "@safe/common/Enum.sol";
import {Safe} from "@safe/Safe.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";
import {CompatibilityFallbackHandler} from "@safe/handler/CompatibilityFallbackHandler.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";
import {Policy, PolicyCodec} from "../src/PolicyCodec.sol";
import {TestERC20} from "./utils/TestERC20.sol";

/// @notice Local deployment of the real stack: Safe v1.4.1 and ENSv2 contracts-v2 (Sepolia commit
///         07e55a05) built from source, proxies created through the real VerifiableFactory.
///         Nothing under test is mocked. Sepolia fork tests are separate (they need SEPOLIA_RPC_URL).
abstract contract BlindspotBase is Test {
    uint256 internal constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes4 internal constant TRANSFER = 0xa9059cbb;
    bytes4 internal constant APPROVE = 0x095ea7b3;
    bytes4 internal constant EMPTY = 0x00000000;

    // "\x05owner\x03eth\x00"
    bytes internal constant PARENT_DNS = hex"056f776e657203657468" hex"00";
    string internal constant LABEL = "trader";

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal vendor = makeAddr("vendor");
    address internal attacker = makeAddr("attacker");
    address internal spender = makeAddr("spender");
    /// @dev Contract-naming role holder required by the ENS constructors (must be non-zero).
    address internal namer = makeAddr("namer");

    Safe internal safe;
    UserRegistry internal registry;
    PermissionedResolver internal resolver;
    BlindspotModule internal module;
    TestERC20 internal usdc;

    function setUp() public virtual {
        vm.warp(1_790_000_000);

        // --- Safe (1-of-1, owner) ---
        Safe singleton = new Safe();
        SafeProxyFactory safeFactory = new SafeProxyFactory();
        address[] memory owners = new address[](1);
        owners[0] = owner;
        // Standard Safe fallback handler (lets the Safe receive ERC-721 safe transfers / ERC-1155).
        address handler = address(new CompatibilityFallbackHandler());
        bytes memory setup = abi.encodeCall(
            Safe.setup, (owners, 1, address(0), "", handler, address(0), 0, payable(address(0)))
        );
        safe = Safe(payable(address(safeFactory.createProxyWithNonce(address(singleton), setup, 0))));

        // --- ENSv2: agent registry (UserRegistry) + per-agent resolver, via VerifiableFactory ---
        VerifiableFactory factory = new VerifiableFactory();
        LabelStore labelStore = new LabelStore(IContractNamer(address(0)));
        UserRegistry registryImpl =
            new UserRegistry(ILabelStore(address(labelStore)), IRegistryURIRenderer(address(0)), namer);
        PermissionedResolver resolverImpl = new PermissionedResolver(namer);

        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant({account: owner, roleBitmap: ALL_ROLES});
        vm.startPrank(owner);
        registry = UserRegistry(
            factory.deployProxy(address(registryImpl), 1, abi.encodeCall(UserRegistry.initialize, (grants)))
        );
        resolver = PermissionedResolver(
            factory.deployProxy(
                address(resolverImpl), 2, abi.encodeCall(PermissionedResolver.initialize, (grants, new bytes[](0)))
            )
        );
        // Agent subname: owned by the agent, zero roles, absolute expiry.
        registry.register(LABEL, agent, IRegistry(address(0)), address(resolver), 0, uint64(block.timestamp + 30 days));
        vm.stopPrank();

        // --- Module + enable on the Safe (owner signs with an approved-hash signature, v = 1) ---
        module = new BlindspotModule(ISafe(address(safe)), IPermissionedRegistry(address(registry)), PARENT_DNS);
        _ownerSafeTx(address(safe), abi.encodeCall(safe.enableModule, (address(module))));

        // --- Funds ---
        usdc = new TestERC20("USD Coin", "USDC", 6);
        usdc.mint(address(safe), 1_000e6);
        vm.deal(address(safe), 1 ether);

        _setPolicy(_defaultPolicy());
    }

    // ------------------------------------------------------------------ helpers

    function _agentDns() internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(LABEL).length), LABEL, PARENT_DNS);
    }

    function _defaultPolicy() internal view returns (Policy memory p) {
        p.version = 1;
        p.targets = new address[](2);
        p.targets[0] = address(usdc);
        p.targets[1] = vendor;
        p.codeHashes = new bytes32[](2);
        p.codeHashes[0] = address(usdc).codehash;
        p.selectors = new bytes4[][](2);
        p.selectors[0] = new bytes4[](2);
        p.selectors[0][0] = TRANSFER;
        p.selectors[0][1] = APPROVE;
        p.selectors[1] = new bytes4[](1);
        p.selectors[1][0] = EMPTY;
        p.payees = new address[](1);
        p.payees[0] = vendor;
        p.spenders = new address[](1);
        p.spenders[0] = spender;
        p.tokens = new address[](2);
        p.tokens[0] = address(usdc);
        p.tokens[1] = address(0);
        p.tokenKinds = new uint8[](2); // both ERC-20 / ETH (kind 0)
        p.maxOut = new uint256[](2);
        p.maxOut[0] = 100e6;
        p.maxOut[1] = 0.01 ether;
        p.dailyCap = new uint256[](2);
        p.dailyCap[0] = 250e6;
        p.dailyCap[1] = 0.05 ether;
        p.maxEth = 0.01 ether;
        p.rateLimitPerHour = 10;
        p.askOwnerAbove = 50e6;
        p.blockNewContracts = true;
    }

    function _setPolicy(Policy memory p) internal {
        _setPolicyRaw(PolicyCodec.encode(p));
    }

    function _setPolicyRaw(bytes memory raw) internal {
        vm.prank(owner);
        resolver.setData(_agentDns(), "blindspot.policy", raw);
    }

    function _ownerSafeTx(address to, bytes memory data) internal {
        bytes memory sig = abi.encodePacked(uint256(uint160(owner)), uint256(0), uint8(1));
        vm.prank(owner);
        bool ok = safe.execTransaction(
            to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig
        );
        require(ok, "owner safe tx failed");
    }

    function _exec(address to, uint256 value, bytes memory data) internal returns (bytes memory) {
        vm.prank(agent);
        return module.execute(LABEL, to, value, data);
    }

    function _execBatch(BlindspotModule.Call[] memory calls) internal returns (bytes[] memory) {
        vm.prank(agent);
        return module.executeBatch(LABEL, calls);
    }

    function _c(address to, uint256 value, bytes memory data) internal pure returns (BlindspotModule.Call memory) {
        return BlindspotModule.Call({to: to, value: value, data: data});
    }

    function _calls(BlindspotModule.Call memory a) internal pure returns (BlindspotModule.Call[] memory r) {
        r = new BlindspotModule.Call[](1);
        r[0] = a;
    }

    function _calls(BlindspotModule.Call memory a, BlindspotModule.Call memory b)
        internal
        pure
        returns (BlindspotModule.Call[] memory r)
    {
        r = new BlindspotModule.Call[](2);
        r[0] = a;
        r[1] = b;
    }

    /// @dev Append a target with its pinned code hash (0 = unpinned) and selectors.
    function _addTarget(Policy memory p, address t, bytes32 codeHash, bytes4[] memory sels) internal pure {
        uint256 n = p.targets.length;
        address[] memory targets = new address[](n + 1);
        bytes32[] memory hashes = new bytes32[](n + 1);
        bytes4[][] memory selectors = new bytes4[][](n + 1);
        for (uint256 i; i < n; ++i) {
            targets[i] = p.targets[i];
            hashes[i] = p.codeHashes[i];
            selectors[i] = p.selectors[i];
        }
        targets[n] = t;
        hashes[n] = codeHash;
        selectors[n] = sels;
        p.targets = targets;
        p.codeHashes = hashes;
        p.selectors = selectors;
    }

    /// @dev Append a tracked token with kind and caps.
    function _addToken(Policy memory p, address t, uint8 kind, uint256 maxOut, uint256 dailyCap) internal pure {
        uint256 n = p.tokens.length;
        address[] memory tokens = new address[](n + 1);
        uint8[] memory kinds = new uint8[](n + 1);
        uint256[] memory mo = new uint256[](n + 1);
        uint256[] memory dc = new uint256[](n + 1);
        for (uint256 i; i < n; ++i) {
            tokens[i] = p.tokens[i];
            kinds[i] = p.tokenKinds[i];
            mo[i] = p.maxOut[i];
            dc[i] = p.dailyCap[i];
        }
        tokens[n] = t;
        kinds[n] = kind;
        mo[n] = maxOut;
        dc[n] = dailyCap;
        p.tokens = tokens;
        p.tokenKinds = kinds;
        p.maxOut = mo;
        p.dailyCap = dc;
    }

    function _addSpender(Policy memory p, address s) internal pure {
        address[] memory a = new address[](p.spenders.length + 1);
        for (uint256 i; i < p.spenders.length; ++i) {
            a[i] = p.spenders[i];
        }
        a[p.spenders.length] = s;
        p.spenders = a;
    }

    function _sels(bytes4 a) internal pure returns (bytes4[] memory r) {
        r = new bytes4[](1);
        r[0] = a;
    }

    function _sels(bytes4 a, bytes4 b) internal pure returns (bytes4[] memory r) {
        r = new bytes4[](2);
        r[0] = a;
        r[1] = b;
    }

    function _transfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TRANSFER, to, amount);
    }
}
