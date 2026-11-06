// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";

import {Grant} from "@ensdomains/contracts-v2/access-control/interfaces/IEACGrantInitializable.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {IPermissionedResolver} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {Enum} from "@safe/common/Enum.sol";
import {Safe} from "@safe/Safe.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";
import {Policy, PolicyCodec} from "../src/PolicyCodec.sol";

/// @dev Signatures copied from contracts-v2 (07e55a05) src/registrar/interfaces/IETHRegistrar.sol
///      and IETHRenewer; address-typed params are ABI-identical to IRegistry / IERC20.
interface IETHRegistrarMin {
    function MIN_COMMITMENT_AGE() external view returns (uint64);
    function isAvailable(string calldata label) external view returns (bool);
    function commitmentAt(bytes32 commitment) external view returns (uint64);
    function getRegisterPrice(string calldata label, uint64 duration, address paymentToken)
        external
        view
        returns (uint256 base, uint256 premium);
    function makeCommitment(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    ) external pure returns (bytes32);
    function commit(bytes32 commitment) external;
    function register(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        address paymentToken,
        bytes32 referrer
    ) external returns (uint256);
}

/// @dev MockERC20 in contracts-v2 test/mocks (open faucet mint).
interface IMockUSDC {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Shared inputs and steps for the Sepolia setup (scripts A-D). Mirrors the dry-run plan in
///         scripts/setup/src/plan.ts step for step. Keys are read with vm.env* only.
abstract contract BlindspotSetup is Script {
    // ---------------------------------------------------------------- fixed parameters
    uint256 internal constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint64 internal constant YEAR = 365 days;
    uint64 internal constant AGENT_EXPIRY = 90 days;
    string internal constant AGENT_LABEL = "demo";
    string internal constant POLICY_KEY = "blindspot.policy";
    uint256 internal constant MINT_USDC = 109e6; // 8.000021 name + 100 Safe, rounded up
    uint256 internal constant SAFE_FUND_ETH = 0.01 ether;
    uint256 internal constant SAFE_FUND_USDC = 100e6;

    // ---------------------------------------------------------------- inputs
    uint256 internal ownerKey;
    address internal owner;
    address internal agent;
    address[] internal payees;
    string internal parentLabel;

    // config/sepolia.json
    IETHRegistrarMin internal registrar;
    IVerifiableFactory internal factory;
    address internal userRegistryImpl;
    address internal resolverImpl;
    IMockUSDC internal usdc;
    SafeProxyFactory internal safeFactory;
    address internal safeSingleton;
    address internal safeHandler;

    // ---------------------------------------------------------------- derived (deterministic)
    IPermissionedRegistry internal registry;
    IPermissionedResolver internal agentResolver;
    IPermissionedResolver internal payeeResolver;
    Safe internal safe;
    uint256 internal registrySalt;
    uint256 internal agentResolverSalt;
    uint256 internal payeeResolverSalt;
    uint256 internal safeSaltNonce;
    bytes internal safeInitializer;

    function _load() internal {
        ownerKey = vm.envUint("OWNER_PRIVATE_KEY");
        owner = vm.addr(ownerKey);
        agent = vm.envAddress("AGENT_ADDRESS");
        payees = vm.envAddress("PAYEE_ADDRESSES", ",");
        parentLabel = vm.envString("PARENT_NAME");
        require(payees.length == 2, "PAYEE_ADDRESSES: need exactly 2");
        require(agent != owner, "agent must differ from owner");

        string memory cfg = vm.readFile("../config/sepolia.json");
        require(vm.parseJsonUint(cfg, ".chainId") == block.chainid, "config chainId != connected chain");
        registrar = IETHRegistrarMin(vm.parseJsonAddress(cfg, ".ens.ETHRegistrar"));
        factory = IVerifiableFactory(vm.parseJsonAddress(cfg, ".ens.VerifiableFactory"));
        userRegistryImpl = vm.parseJsonAddress(cfg, ".ens.UserRegistryImpl");
        resolverImpl = vm.parseJsonAddress(cfg, ".ens.PermissionedResolverImpl");
        usdc = IMockUSDC(vm.parseJsonAddress(cfg, ".ens.MockUSDC"));
        safeFactory = SafeProxyFactory(vm.parseJsonAddress(cfg, ".safe.SafeProxyFactory"));
        safeSingleton = vm.parseJsonAddress(cfg, ".safe.Safe");
        safeHandler = vm.parseJsonAddress(cfg, ".safe.CompatibilityFallbackHandler");

        // Same salt scheme as the official VerifiableFactory example and the TS dry-run.
        registrySalt = _salt("UserRegistry", _parentDns());
        agentResolverSalt = _salt("PermissionedResolver", _agentDns());
        payeeResolverSalt = _salt("PermissionedResolver", _dns3("payees", parentLabel, "eth"));
        registry = IPermissionedRegistry(factory.predictProxyAddress(owner, registrySalt));
        agentResolver = IPermissionedResolver(factory.predictProxyAddress(owner, agentResolverSalt));
        payeeResolver = IPermissionedResolver(factory.predictProxyAddress(owner, payeeResolverSalt));

        address[] memory owners = new address[](1);
        owners[0] = owner;
        safeInitializer = abi.encodeCall(
            Safe.setup, (owners, 1, address(0), "", safeHandler, address(0), 0, payable(address(0)))
        );
        safeSaltNonce = uint256(keccak256(abi.encodePacked("blindspot safe for ", AGENT_LABEL, ".", parentLabel, ".eth")));
        bytes32 create2Salt = keccak256(abi.encodePacked(keccak256(safeInitializer), safeSaltNonce));
        bytes32 initHash = keccak256(abi.encodePacked(safeFactory.proxyCreationCode(), uint256(uint160(safeSingleton))));
        safe = Safe(payable(vm.computeCreate2Address(create2Salt, initHash, address(safeFactory))));
    }

    // ---------------------------------------------------------------- names
    function _dns2(string memory a, string memory b) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(a).length), a, uint8(bytes(b).length), b, uint8(0));
    }

    function _dns3(string memory a, string memory b, string memory c) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(a).length), a, uint8(bytes(b).length), b, uint8(bytes(c).length), c, uint8(0));
    }

    function _parentDns() internal view returns (bytes memory) {
        return _dns2(parentLabel, "eth");
    }

    function _agentDns() internal view returns (bytes memory) {
        return _dns3(AGENT_LABEL, parentLabel, "eth");
    }

    function _salt(string memory kind, bytes memory dnsName) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(keccak256(bytes(kind)), NameCoder.namehash(dnsName, 0), uint256(0))));
    }

    /// @dev Commit-reveal secret, derived so scripts A and B agree without storing state.
    ///      keccak256 of the owner key and a domain string: revealing it in register() leaks nothing.
    function _secret() internal view returns (bytes32) {
        return keccak256(abi.encode(ownerKey, "blindspot commit secret v1", parentLabel));
    }

    function _commitment() internal view returns (bytes32) {
        return registrar.makeCommitment(parentLabel, owner, _secret(), address(registry), address(0), YEAR, bytes32(0));
    }

    function _grants() internal view returns (Grant[] memory g) {
        g = new Grant[](1);
        g[0] = Grant({account: owner, roleBitmap: ALL_ROLES});
    }

    // ---------------------------------------------------------------- the owner's starting rules (dry-run defaults)
    function _policy() internal view returns (Policy memory p) {
        p.version = 1;
        p.targets = new address[](3);
        p.targets[0] = address(usdc);
        p.targets[1] = payees[0];
        p.targets[2] = payees[1];
        p.codeHashes = new bytes32[](3);
        p.codeHashes[0] = address(usdc).codehash; // MockUSDC is not a proxy: pin its code
        p.selectors = new bytes4[][](3);
        p.selectors[0] = new bytes4[](1);
        p.selectors[0][0] = 0xa9059cbb; // transfer(address,uint256)
        p.selectors[1] = new bytes4[](1); // 0x00000000: plain ETH to payee 1
        p.selectors[2] = new bytes4[](1); // 0x00000000: plain ETH to payee 2
        p.payees = payees;
        p.tokens = new address[](2);
        p.tokens[0] = address(usdc);
        p.tokens[1] = address(0); // ETH
        p.tokenKinds = new uint8[](2);
        p.maxOut = new uint256[](2);
        p.maxOut[0] = 25e6;
        p.maxOut[1] = 0.002 ether;
        p.dailyCap = new uint256[](2);
        p.dailyCap[0] = 50e6;
        p.dailyCap[1] = 0.005 ether;
        p.maxEth = 0.002 ether;
        p.rateLimitPerHour = 10;
        p.askOwnerAbove = 20e6;
        p.blockNewContracts = true;
    }

    function _agentContext() internal view returns (string memory) {
        string memory name = string.concat(AGENT_LABEL, ".", parentLabel, ".eth");
        return string.concat(
            "# ",
            name,
            "\nBlindspot demo agent. It manages a Safe on Sepolia through BlindspotModule.",
            "\nIts rules are the ABI-encoded data record \"blindspot.policy\" on this name (owner-only);",
            "\nBlindspotModule reads and enforces them on-chain for every transaction.",
            "\nThe agent may write only the text record \"agent.status\". Revoking this name stops the agent."
        );
    }

    // ---------------------------------------------------------------- steps (each broadcasts as the owner)
    /// Script A: mint, registry + agent resolver proxies, exact approval, commit.
    function _stepA() internal {
        (uint256 base, uint256 premium) = registrar.getRegisterPrice(parentLabel, YEAR, address(usdc));
        uint256 price = base + premium;
        console.log("name price (MockUSDC units, 6 decimals):", price);
        require(registrar.isAvailable(parentLabel), "parent name not available");

        vm.startBroadcast(ownerKey);
        usdc.mint(owner, MINT_USDC);
        if (address(registry).code.length == 0) {
            factory.deployProxy(userRegistryImpl, registrySalt, abi.encodeWithSignature("initialize((address,uint256)[])", _grants()));
        }
        if (address(agentResolver).code.length == 0) {
            factory.deployProxy(
                resolverImpl, agentResolverSalt, abi.encodeWithSignature("initialize((address,uint256)[],bytes[])", _grants(), new bytes[](0))
            );
        }
        usdc.approve(address(registrar), price);
        registrar.commit(_commitment());
        vm.stopBroadcast();
    }

    /// Script B: register parent (subregistry set in register), agent subname, policy, agent.status role.
    function _stepB() internal {
        uint64 committed = registrar.commitmentAt(_commitment());
        require(committed != 0, "no commitment found: run script A first");
        require(block.timestamp >= committed + registrar.MIN_COMMITMENT_AGE(), "commitment too new: wait >= 60 s after script A");
        Policy memory p = _policy();
        bytes memory encoded = PolicyCodec.encode(p);
        require(PolicyCodec.isValid(p, encoded), "policy invalid");
        console.log("policy record bytes:", encoded.length);

        vm.startBroadcast(ownerKey);
        registrar.register(parentLabel, owner, _secret(), address(registry), address(0), YEAR, address(usdc), bytes32(0));
        registry.register(AGENT_LABEL, agent, IRegistry(address(0)), address(agentResolver), 0, uint64(block.timestamp) + AGENT_EXPIRY);
        agentResolver.setData(_agentDns(), POLICY_KEY, encoded);
        agentResolver.grantSetterRoles(abi.encodeWithSignature("setText(bytes,string,string)", bytes(""), "agent.status", ""), agent);
        vm.stopBroadcast();
    }

    /// Script C: Safe (1-of-1 owner), module, owner-signed enableModule, funding.
    function _stepC() internal returns (BlindspotModule module) {
        vm.startBroadcast(ownerKey);
        if (address(safe).code.length == 0) {
            address created = address(safeFactory.createProxyWithNonce(safeSingleton, safeInitializer, safeSaltNonce));
            require(created == address(safe), "Safe address differs from prediction");
        }
        module = new BlindspotModule(ISafe(address(safe)), registry, _parentDns());
        vm.stopBroadcast();

        // Real owner signature (ECDSA over the Safe transaction hash), not an approved-hash shortcut.
        bytes memory data = abi.encodeCall(safe.enableModule, (address(module)));
        bytes32 txHash = safe.getTransactionHash(
            address(safe), 0, data, Enum.Operation.Call, 0, 0, 0, address(0), address(0), safe.nonce()
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, txHash);

        vm.startBroadcast(ownerKey);
        require(
            safe.execTransaction(address(safe), 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v)),
            "enableModule failed"
        );
        (bool ok,) = payable(address(safe)).call{value: SAFE_FUND_ETH}("");
        require(ok, "ETH funding failed");
        usdc.transfer(address(safe), SAFE_FUND_USDC);
        vm.stopBroadcast();
        require(safe.isModuleEnabled(address(module)), "module not enabled");
    }

    /// Script D: agent-context, agent addr record, payee resolver, vendor1/vendor2 + addr records.
    function _stepD() internal {
        vm.startBroadcast(ownerKey);
        agentResolver.setText(_agentDns(), "agent-context", _agentContext());
        agentResolver.setAddress(_agentDns(), 60, abi.encodePacked(agent));
        if (address(payeeResolver).code.length == 0) {
            factory.deployProxy(
                resolverImpl, payeeResolverSalt, abi.encodeWithSignature("initialize((address,uint256)[],bytes[])", _grants(), new bytes[](0))
            );
        }
        for (uint256 i; i < 2; ++i) {
            string memory label = i == 0 ? "vendor1" : "vendor2";
            registry.register(label, owner, IRegistry(address(0)), address(payeeResolver), 0, uint64(block.timestamp) + YEAR);
            payeeResolver.setAddress(_dns3(label, parentLabel, "eth"), 60, abi.encodePacked(payees[i]));
        }
        vm.stopBroadcast();
    }

    function _logAddresses() internal view {
        console.log("owner         ", owner);
        console.log("agent         ", agent);
        console.log("registry      ", address(registry));
        console.log("agentResolver ", address(agentResolver));
        console.log("payeeResolver ", address(payeeResolver));
        console.log("safe          ", address(safe));
    }
}
