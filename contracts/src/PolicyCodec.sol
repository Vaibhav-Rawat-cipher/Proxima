// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Owner rules stored in the agent's ENS data record `blindspot.policy` (SPEC §15).
/// @dev Must match POLICY_ABI in packages/shared/src/policy.ts field for field.
///      targets[i] pairs with codeHashes[i] (bytes32(0) = not pinned, proxy target) and selectors[i].
///      Selector 0x00000000 allows a call with empty calldata (plain ETH transfer to a payee).
///      tokens[i] pairs with tokenKinds[i], maxOut[i] and dailyCap[i]; tokens[i] == address(0) tracks ETH.
///      operators are NFT operators allowed to remain approved-for-all after a call.
///      The last three fields are wallet-only and are not enforced on-chain.
struct Policy {
    uint32 version;
    address[] targets;
    bytes32[] codeHashes;
    bytes4[][] selectors;
    address[] payees;
    address[] spenders;
    address[] operators;
    address[] tokens;
    uint8[] tokenKinds;
    uint256[] maxOut;
    uint256[] dailyCap;
    uint256 maxEth;
    uint32 rateLimitPerHour;
    uint256 askOwnerAbove;
    bool blockNewContracts;
}

library PolicyCodec {
    uint8 internal constant KIND_ERC20 = 0; // also native ETH when the token is address(0)
    uint8 internal constant KIND_ERC721 = 1;
    uint8 internal constant KIND_ERC1155 = 2;

    function encode(Policy memory p) internal pure returns (bytes memory) {
        return abi.encode(p);
    }

    /// @dev Reverts on malformed ABI data. Callers that must fail closed with a named error
    ///      wrap this in an external self-call (see BlindspotModule.decodePolicy).
    function decode(bytes memory raw) internal pure returns (Policy memory p) {
        p = abi.decode(raw, (Policy));
    }

    /// @notice Selectors that move tokens or grant rights over them (TOKEN_MOVING_SELECTORS in TS).
    function isTokenMoving(bytes4 s) internal pure returns (bool) {
        return s == 0xa9059cbb // transfer(address,uint256)
            || s == 0x23b872dd // transferFrom(address,address,uint256)
            || s == 0x42842e0e // safeTransferFrom(address,address,uint256)
            || s == 0xb88d4fde // safeTransferFrom(address,address,uint256,bytes)
            || s == 0xf242432a // safeTransferFrom(address,address,uint256,uint256,bytes)
            || s == 0x2eb2c2d6 // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
            || s == 0x095ea7b3 // approve(address,uint256)
            || s == 0x39509351 // increaseAllowance(address,uint256)
            || s == 0xa22cb465; // setApprovalForAll(address,bool)
    }

    /// @notice Same rules as validatePolicy in the TS codec, plus canonical encoding.
    function isValid(Policy memory p, bytes memory raw) internal pure returns (bool) {
        if (p.version == 0) return false;
        uint256 n = p.targets.length;
        if (p.codeHashes.length != n || p.selectors.length != n) return false;
        uint256 t = p.tokens.length;
        if (p.tokenKinds.length != t || p.maxOut.length != t || p.dailyCap.length != t) return false;
        for (uint256 i; i < t; ++i) {
            uint8 kind = p.tokenKinds[i];
            if (kind > KIND_ERC1155) return false;
            if (p.tokens[i] == address(0) && kind != KIND_ERC20) return false;
            if (p.maxOut[i] > p.dailyCap[i]) return false;
            // ERC-1155 balances are per id: amounts cannot be measured, so caps must be 0.
            if (kind == KIND_ERC1155 && (p.maxOut[i] != 0 || p.dailyCap[i] != 0)) return false;
        }
        // A target that allows a token-moving function must be a listed token.
        for (uint256 i; i < n; ++i) {
            bytes4[] memory sels = p.selectors[i];
            for (uint256 j; j < sels.length; ++j) {
                if (isTokenMoving(sels[j]) && indexOf(p.tokens, p.targets[i]) == type(uint256).max) return false;
            }
        }
        // Reject non-canonical encodings (e.g. trailing bytes): re-encoding must reproduce the input.
        return keccak256(abi.encode(p)) == keccak256(raw);
    }

    function indexOf(address[] memory list, address a) internal pure returns (uint256) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == a) return i;
        }
        return type(uint256).max;
    }
}
