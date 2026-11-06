// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {console} from "forge-std/Script.sol";

import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {IPermissionedResolver} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";
import {IAddrResolver} from "@ens/contracts/resolvers/profiles/IAddrResolver.sol";
import {ITextResolver} from "@ens/contracts/resolvers/profiles/ITextResolver.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {Enum} from "@safe/common/Enum.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {BlindspotSetup} from "./BlindspotSetup.sol";

/// @notice Final Step 1 run (one command):
///   1. Script D as the owner: agent-context, agent addr record, payee resolver, vendor1/vendor2 + addr records.
///   2. Owner sends 0.005 ETH to the agent.
///   3. Agent key: ONE real BlindspotModule.execute paying 1 MockUSDC from the Safe to vendor1.
///   4. Non-broadcast checks from the agent address (simulated calls, never sent): unlisted recipient,
///      26 MockUSDC, direct Safe call. Each exact error is asserted; any FAIL reverts the whole script,
///      so forge broadcasts nothing.
/// Every part skips itself if it is already done on-chain, so the same command resumes a partial run.
contract SetupFinal is BlindspotSetup {
    uint256 internal constant AGENT_FUND = 0.005 ether;
    uint256 internal constant PAY_VENDOR1 = 1e6; // 1 MockUSDC
    address internal constant UNLISTED = 0x000000000000000000000000000000000000dEaD;

    BlindspotModule internal module;
    uint256 internal agentKey;
    uint256 internal failures;

    function run() external {
        _load();
        string memory cfg = vm.readFile("../config/sepolia.json");
        module = BlindspotModule(vm.parseJsonAddress(cfg, ".module"));
        require(address(safe) == vm.parseJsonAddress(cfg, ".safeAddress"), "Safe address != config");
        require(address(module.safe()) == address(safe), "module.safe() != Safe");
        agentKey = vm.envUint("AGENT_PRIVATE_KEY");
        require(vm.addr(agentKey) == agent, "AGENT_PRIVATE_KEY does not match AGENT_ADDRESS");
        _logAddresses();
        console.log("module        ", address(module));

        _partD();
        _fundAgent();
        _agentPays();
        _checks();
        require(failures == 0, "checks failed: nothing will be broadcast");
    }

    // ---------------------------------------------------------------- 1. Script D (owner)
    function _partD() internal {
        bytes memory agentDns = _agentDns();
        vm.startBroadcast(ownerKey);
        if (keccak256(bytes(_text(agentResolver, agentDns, "agent-context"))) != keccak256(bytes(_agentContext()))) {
            console.log("D: set agent-context");
            agentResolver.setText(agentDns, "agent-context", _agentContext());
        } else {
            console.log("D: agent-context already set, skip");
        }
        if (_addr(agentResolver, agentDns) != agent) {
            console.log("D: set agent address record");
            agentResolver.setAddress(agentDns, 60, abi.encodePacked(agent));
        } else {
            console.log("D: agent address record already set, skip");
        }
        if (address(payeeResolver).code.length == 0) {
            console.log("D: deploy payee resolver");
            factory.deployProxy(
                resolverImpl, payeeResolverSalt, abi.encodeWithSignature("initialize((address,uint256)[],bytes[])", _grants(), new bytes[](0))
            );
        } else {
            console.log("D: payee resolver already deployed, skip");
        }
        for (uint256 i; i < 2; ++i) {
            string memory label = i == 0 ? "vendor1" : "vendor2";
            bytes memory dns = _dns3(label, parentLabel, "eth");
            if (registry.getState(uint256(keccak256(bytes(label)))).status != IPermissionedRegistry.Status.REGISTERED) {
                console.log("D: register", label);
                registry.register(label, owner, IRegistry(address(0)), address(payeeResolver), 0, uint64(block.timestamp) + YEAR);
            } else {
                console.log("D: already registered, skip", label);
            }
            if (_addr(payeeResolver, dns) != payees[i]) {
                console.log("D: set address record", label);
                payeeResolver.setAddress(dns, 60, abi.encodePacked(payees[i]));
            } else {
                console.log("D: address record already set, skip", label);
            }
        }
        vm.stopBroadcast();
    }

    // ---------------------------------------------------------------- 2. owner -> agent gas money
    function _fundAgent() internal {
        if (usdc.balanceOf(payees[0]) >= PAY_VENDOR1 || agent.balance >= AGENT_FUND / 2) {
            console.log("fund agent: not needed, skip (agent ETH wei):", agent.balance);
            return;
        }
        console.log("fund agent: owner sends 0.005 ETH");
        vm.startBroadcast(ownerKey);
        (bool ok,) = payable(agent).call{value: AGENT_FUND}("");
        require(ok, "funding agent failed");
        vm.stopBroadcast();
    }

    // ---------------------------------------------------------------- 3. the one real agent transaction
    function _agentPays() internal {
        if (usdc.balanceOf(payees[0]) >= PAY_VENDOR1) {
            console.log("agent pays vendor1: already done, skip");
            return;
        }
        uint256 safeBefore = usdc.balanceOf(address(safe));
        console.log("agent pays vendor1: module.execute(demo, MockUSDC, transfer(vendor1, 1 MockUSDC))");
        vm.startBroadcast(agentKey);
        module.execute(AGENT_LABEL, address(usdc), 0, abi.encodeWithSelector(0xa9059cbb, payees[0], PAY_VENDOR1));
        vm.stopBroadcast();
        require(usdc.balanceOf(payees[0]) >= PAY_VENDOR1, "vendor1 not paid");
        require(usdc.balanceOf(address(safe)) == safeBefore - PAY_VENDOR1, "Safe balance did not drop by 1");
    }

    // ---------------------------------------------------------------- 4. simulated checks (never broadcast)
    function _checks() internal {
        console.log("--- checks (simulated calls from the agent address; not broadcast)");
        bytes memory payUnlisted = abi.encodeCall(
            module.execute, (AGENT_LABEL, address(usdc), 0, abi.encodeWithSelector(0xa9059cbb, UNLISTED, PAY_VENDOR1))
        );
        _expectRevert("pay an unlisted address -> RecipientNotAllowed", address(module), payUnlisted,
            abi.encodeWithSelector(BlindspotModule.RecipientNotAllowed.selector, UNLISTED));

        bytes memory pay26 = abi.encodeCall(
            module.execute, (AGENT_LABEL, address(usdc), 0, abi.encodeWithSelector(0xa9059cbb, payees[0], 26e6))
        );
        _expectRevert("pay 26 MockUSDC -> OutflowExceeded", address(module), pay26,
            abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(usdc), 26e6));

        bytes memory direct = abi.encodeCall(
            safe.execTransactionFromModule, (address(usdc), 0, abi.encodeWithSelector(0xa9059cbb, agent, PAY_VENDOR1), Enum.Operation.Call)
        );
        _expectRevert("agent calls the Safe directly -> GS104", address(safe), direct, abi.encodeWithSignature("Error(string)", "GS104"));

        bytes memory writePolicy = abi.encodeCall(agentResolver.setData, (_agentDns(), POLICY_KEY, hex"01"));
        _expectRevert("agent writes blindspot.policy -> EACUnauthorizedAccountRoles", address(agentResolver), writePolicy,
            abi.encodeWithSignature("EACUnauthorizedAccountRoles(uint256,uint256,address)", uint256(keccak256(bytes(POLICY_KEY))), uint256(1 << 24), agent));
    }

    function _expectRevert(string memory what, address target, bytes memory data, bytes memory expected) internal {
        vm.prank(agent);
        (bool ok, bytes memory ret) = target.call(data);
        bool pass = !ok && keccak256(ret) == keccak256(expected);
        if (!pass) ++failures;
        console.log(pass ? "PASS" : "FAIL", what);
        if (!pass) console.logBytes(ret);
    }

    // ---------------------------------------------------------------- record reads
    function _text(IPermissionedResolver r, bytes memory dns, string memory key) internal view returns (string memory) {
        if (address(r).code.length == 0) return "";
        bytes memory res = r.resolve(dns, abi.encodeCall(ITextResolver.text, (NameCoder.namehash(dns, 0), key)));
        return abi.decode(res, (string));
    }

    function _addr(IPermissionedResolver r, bytes memory dns) internal view returns (address) {
        if (address(r).code.length == 0) return address(0);
        bytes memory res = r.resolve(dns, abi.encodeCall(IAddrResolver.addr, (NameCoder.namehash(dns, 0))));
        return abi.decode(res, (address));
    }
}
