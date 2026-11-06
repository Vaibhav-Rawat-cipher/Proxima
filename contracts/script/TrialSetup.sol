// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console} from "forge-std/Script.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {IPermissionedResolver} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";
import {Enum} from "@safe/common/Enum.sol";
import {Safe} from "@safe/Safe.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";
import {Policy, PolicyCodec} from "../src/PolicyCodec.sol";
import {TrialProvisioner} from "../src/TrialProvisioner.sol";
import {BlindspotSetup} from "./BlindspotSetup.sol";

/// @notice Step 3d on-chain setup (owner decision 2026-11-06, option A): trials live in their OWN registry,
///         `trials.<parent>.eth`, so the demo module (which reads the demo registry) never sees a trial name and the
///         demo Safe is fully isolated. One script run, owner key only:
///   1. trialRegistry  = UserRegistry proxy via VerifiableFactory (owner holds all roles)
///   2. agentRegistry.register("trials", owner, trialRegistry, …): the subregistry link (ENSv2 register(…, registry, …))
///   3. trialResolver  = PermissionedResolver proxy via VerifiableFactory (owner holds all roles)
///   4. trialSafe (1-of-1 owner) + trialModule = new BlindspotModule(trialSafe, trialRegistry, trials DNS name)
///   5. TrialProvisioner (fixed tiny policy, caps, drip)
///   6. roles: trialRegistry.grantRootRoles(ROLE_REGISTRAR, provisioner);
///             trialResolver.grantSetterRoles(setData(·,"blindspot.policy",·), provisioner)
///   7. owner-signed enableModule on the trial Safe; fund the provisioner (gas drips) and the trial Safe (MockUSDC mint)
abstract contract TrialSetup is BlindspotSetup {
    string internal constant TRIALS_LABEL = "trials";
    uint256 internal constant TRIAL_GLOBAL_DAILY_CAP = 100;
    uint256 internal constant TRIAL_RELAYER_DAILY_QUOTA = 100;
    uint256 internal constant TRIAL_DRIP = 0.00005 ether;
    uint256 internal constant PROVISIONER_FUND = 0.01 ether; // 200 drips
    uint256 internal constant TRIAL_SAFE_USDC = 100e6; // MockUSDC (open faucet mint)
    uint256 internal constant TRIAL_MAX_OUT = 1e6; // 1 MockUSDC per transaction
    uint256 internal constant TRIAL_DAILY_CAP = 2e6; // 2 MockUSDC per day per trial

    IPermissionedRegistry internal trialRegistry;
    IPermissionedResolver internal trialResolver;
    Safe internal trialSafe;
    uint256 internal trialRegistrySalt;
    uint256 internal trialResolverSalt;
    uint256 internal trialSafeSaltNonce;

    function _loadTrials() internal {
        _load();
        trialRegistrySalt = _salt("UserRegistry", _trialsDns());
        trialResolverSalt = _salt("PermissionedResolver", _trialsDns());
        trialRegistry = IPermissionedRegistry(factory.predictProxyAddress(owner, trialRegistrySalt));
        trialResolver = IPermissionedResolver(factory.predictProxyAddress(owner, trialResolverSalt));
        trialSafeSaltNonce = uint256(keccak256(abi.encodePacked("blindspot trial safe for ", TRIALS_LABEL, ".", parentLabel, ".eth")));
        bytes32 create2Salt = keccak256(abi.encodePacked(keccak256(safeInitializer), trialSafeSaltNonce));
        bytes32 initHash = keccak256(abi.encodePacked(safeFactory.proxyCreationCode(), uint256(uint160(safeSingleton))));
        trialSafe = Safe(payable(vm.computeCreate2Address(create2Salt, initHash, address(safeFactory))));
    }

    function _trialsDns() internal view returns (bytes memory) {
        return _dns3(TRIALS_LABEL, parentLabel, "eth");
    }

    /// @notice The fixed trial policy: MockUSDC transfer to vendor1 / vendor2 only, 1 per tx, 2 per day, no ETH.
    function _trialPolicy() internal view returns (Policy memory p) {
        p.version = 1;
        p.targets = new address[](1);
        p.targets[0] = address(usdc);
        p.codeHashes = new bytes32[](1);
        p.codeHashes[0] = address(usdc).codehash; // not a proxy: pin its code
        p.selectors = new bytes4[][](1);
        p.selectors[0] = new bytes4[](1);
        p.selectors[0][0] = 0xa9059cbb; // transfer(address,uint256)
        p.payees = payees;
        p.tokens = new address[](1);
        p.tokens[0] = address(usdc);
        p.tokenKinds = new uint8[](1);
        p.maxOut = new uint256[](1);
        p.maxOut[0] = TRIAL_MAX_OUT;
        p.dailyCap = new uint256[](1);
        p.dailyCap[0] = TRIAL_DAILY_CAP;
        p.maxEth = 0; // no ETH outflow
        p.rateLimitPerHour = 10;
        p.askOwnerAbove = 0;
        p.blockNewContracts = true;
    }

    function _setupTrials(address relayer) internal returns (BlindspotModule trialModule, TrialProvisioner provisioner) {
        Policy memory p = _trialPolicy();
        bytes memory encoded = PolicyCodec.encode(p);
        require(PolicyCodec.isValid(p, encoded), "trial policy invalid");
        console.log("trial policy bytes:", encoded.length);

        vm.startBroadcast(ownerKey);
        if (address(trialRegistry).code.length == 0) {
            factory.deployProxy(userRegistryImpl, trialRegistrySalt, abi.encodeWithSignature("initialize((address,uint256)[])", _grants()));
        }
        if (registry.getState(uint256(keccak256(bytes(TRIALS_LABEL)))).latestOwner == address(0)) {
            // Subregistry link: trials.<parent>.eth → trialRegistry. No resolver on the "trials" node itself.
            registry.register(TRIALS_LABEL, owner, IRegistry(address(trialRegistry)), address(0), 0, uint64(block.timestamp) + 360 days);
        }
        if (address(trialResolver).code.length == 0) {
            factory.deployProxy(
                resolverImpl, trialResolverSalt, abi.encodeWithSignature("initialize((address,uint256)[],bytes[])", _grants(), new bytes[](0))
            );
        }
        if (address(trialSafe).code.length == 0) {
            address created = address(safeFactory.createProxyWithNonce(safeSingleton, safeInitializer, trialSafeSaltNonce));
            require(created == address(trialSafe), "trial Safe address differs from prediction");
        }
        trialModule = new BlindspotModule(ISafe(address(trialSafe)), trialRegistry, _trialsDns());
        provisioner = new TrialProvisioner(
            trialRegistry, trialResolver, _trialsDns(), encoded, owner, relayer, TRIAL_GLOBAL_DAILY_CAP, TRIAL_RELAYER_DAILY_QUOTA, TRIAL_DRIP
        );
        trialRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(provisioner));
        trialResolver.grantSetterRoles(abi.encodeWithSignature("setData(bytes,string,bytes)", bytes(""), POLICY_KEY, bytes("")), address(provisioner));
        vm.stopBroadcast();

        // Real owner signature over the trial Safe's transaction hash (same as Step 1 script C).
        bytes memory data = abi.encodeCall(trialSafe.enableModule, (address(trialModule)));
        bytes32 txHash = trialSafe.getTransactionHash(address(trialSafe), 0, data, Enum.Operation.Call, 0, 0, 0, address(0), address(0), trialSafe.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, txHash);

        vm.startBroadcast(ownerKey);
        require(
            trialSafe.execTransaction(address(trialSafe), 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v)),
            "enableModule failed"
        );
        (bool ok,) = payable(address(provisioner)).call{value: PROVISIONER_FUND}("");
        require(ok, "provisioner funding failed");
        usdc.mint(address(trialSafe), TRIAL_SAFE_USDC);
        vm.stopBroadcast();
        require(trialSafe.isModuleEnabled(address(trialModule)), "trial module not enabled");
    }

    function _logTrials(BlindspotModule trialModule, TrialProvisioner provisioner) internal view {
        console.log("trialRegistry ", address(trialRegistry));
        console.log("trialResolver ", address(trialResolver));
        console.log("trialSafe     ", address(trialSafe));
        console.log("trialModule   ", address(trialModule));
        console.log("provisioner   ", address(provisioner));
        console.log("relayer       ", provisioner.relayer());
    }
}
