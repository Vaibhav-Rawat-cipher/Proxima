// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {Policy, PolicyCodec} from "../src/PolicyCodec.sol";

/// @notice Task 1.1: the TS codec output (test/fixtures/policy.json, generated from
///         packages/shared/src/policy.fixture.ts) decodes on-chain to the same values and
///         re-encodes to identical bytes.
contract PolicyCodecTest is Test {
    BlindspotModule internal decoder;

    function setUp() public {
        // decodePolicy is pure; constructor args only need to be non-zero.
        decoder = new BlindspotModule(
            BlindspotModuleLikeSafe(address(1)), BlindspotModuleLikeRegistry(address(2)), hex"00"
        );
    }

    function test_tsFixture_roundTrip() public view {
        string memory json = vm.readFile("test/fixtures/policy.json");
        bytes memory encoded = vm.parseJsonBytes(json, ".encoded");

        Policy memory p = decoder.decodePolicy(encoded);

        // Values from SAMPLE_POLICY (packages/shared/src/policy.fixture.ts)
        assertEq(p.version, 3);
        assertEq(p.targets.length, 3);
        assertEq(p.targets[0], 0x1111111111111111111111111111111111111111);
        assertEq(p.targets[1], 0x2222222222222222222222222222222222222222);
        assertEq(p.targets[2], 0x5555555555555555555555555555555555555555);
        assertEq(p.codeHashes[0], bytes32(0xabababababababababababababababababababababababababababababababab));
        assertEq(p.codeHashes[1], bytes32(0));
        assertEq(p.codeHashes[2], bytes32(0));
        assertEq(p.selectors[0].length, 2);
        assertEq(p.selectors[0][0], bytes4(0xa9059cbb));
        assertEq(p.selectors[0][1], bytes4(0x095ea7b3));
        assertEq(p.selectors[1][0], bytes4(0x12345678));
        assertEq(p.selectors[2][0], bytes4(0xa22cb465));
        assertEq(p.payees[0], 0x3333333333333333333333333333333333333333);
        assertEq(p.payees[1], 0x4444444444444444444444444444444444444444);
        assertEq(p.spenders[0], 0x2222222222222222222222222222222222222222);
        assertEq(p.operators[0], 0x6666666666666666666666666666666666666666);
        assertEq(p.tokens[0], 0x1111111111111111111111111111111111111111);
        assertEq(p.tokens[1], address(0));
        assertEq(p.tokens[2], 0x5555555555555555555555555555555555555555);
        assertEq(p.tokenKinds[0], 0);
        assertEq(p.tokenKinds[1], 0);
        assertEq(p.tokenKinds[2], 1);
        assertEq(p.maxOut[0], 100_000_000);
        assertEq(p.maxOut[1], 1e16);
        assertEq(p.maxOut[2], 1);
        assertEq(p.dailyCap[0], 500_000_000);
        assertEq(p.dailyCap[1], 5e16);
        assertEq(p.dailyCap[2], 2);
        assertEq(p.maxEth, 1e16);
        assertEq(p.rateLimitPerHour, 10);
        assertEq(p.askOwnerAbove, 50_000_000);
        assertTrue(p.blockNewContracts);

        assertEq(PolicyCodec.encode(p), encoded, "Solidity re-encoding differs from TS bytes");
    }

    function test_revert_empty() public {
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        decoder.decodePolicy("");
    }

    function test_revert_trailingBytes() public {
        bytes memory encoded = vm.parseJsonBytes(vm.readFile("test/fixtures/policy.json"), ".encoded");
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        decoder.decodePolicy(abi.encodePacked(encoded, hex"00"));
    }

    function _sample() internal view returns (Policy memory) {
        return decoder.decodePolicy(vm.parseJsonBytes(vm.readFile("test/fixtures/policy.json"), ".encoded"));
    }

    function test_revert_tokenMovingOnUntrackedTarget() public {
        Policy memory p = _sample();
        p.selectors[1][0] = 0x095ea7b3; // approve() on 0x2222.., which is not in tokens
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        decoder.decodePolicy(abi.encode(p));
    }

    function test_tokenMovingSelectors_allRejectedOnUntrackedTarget() public {
        bytes4[9] memory moving = [
            bytes4(0xa9059cbb), 0x23b872dd, 0x42842e0e, 0xb88d4fde, 0xf242432a, 0x2eb2c2d6, 0x095ea7b3, 0x39509351, 0xa22cb465
        ];
        for (uint256 i; i < moving.length; ++i) {
            Policy memory p = _sample();
            p.selectors[1][0] = moving[i];
            vm.expectRevert(BlindspotModule.PolicyMissing.selector);
            decoder.decodePolicy(abi.encode(p));
        }
    }

    function test_revert_badTokenKinds() public {
        Policy memory p = _sample();
        p.tokenKinds[2] = 3; // unknown kind
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        decoder.decodePolicy(abi.encode(p));

        p = _sample();
        p.tokenKinds[1] = 1; // ETH must be kind 0
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        decoder.decodePolicy(abi.encode(p));

        p = _sample();
        p.tokenKinds = new uint8[](2); // length mismatch
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        decoder.decodePolicy(abi.encode(p));
    }

    function test_revert_erc1155WithCaps() public {
        Policy memory p = _sample();
        p.tokenKinds[2] = 2; // ERC-1155 with maxOut 1 / dailyCap 2
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        decoder.decodePolicy(abi.encode(p));
        p.maxOut[2] = 0;
        p.dailyCap[2] = 0;
        decoder.decodePolicy(abi.encode(p)); // valid with zero caps
    }

    function test_revert_maxOutAboveDailyCap() public {
        bytes memory encoded = vm.parseJsonBytes(vm.readFile("test/fixtures/policy.json"), ".encoded");
        Policy memory p = decoder.decodePolicy(encoded);
        p.maxOut[0] = p.dailyCap[0] + 1;
        vm.expectRevert(BlindspotModule.PolicyMissing.selector);
        decoder.decodePolicy(abi.encode(p));
    }
}

import {IPermissionedRegistry as BlindspotModuleLikeRegistry} from
    "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {ISafe as BlindspotModuleLikeSafe} from "../src/interfaces/ISafe.sol";
