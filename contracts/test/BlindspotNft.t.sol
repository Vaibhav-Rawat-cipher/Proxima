// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {Policy} from "../src/PolicyCodec.sol";
import {BlindspotBase} from "./BlindspotBase.sol";
import {TestERC1155, TestERC721} from "./utils/TestNFTs.sol";

/// @notice Gap 3a: NFT operator approvals and ERC-721 single-token approvals are post-checked.
contract BlindspotNftTest is BlindspotBase {
    bytes4 internal constant SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes4 internal constant TRANSFER_FROM = 0x23b872dd;
    bytes4 internal constant ERC1155_SAFE_TRANSFER_FROM = 0xf242432a;

    TestERC721 internal nft;
    TestERC1155 internal multi;
    address internal allowedOperator = makeAddr("allowedOperator");

    function setUp() public override {
        super.setUp();
        nft = new TestERC721();
        multi = new TestERC1155();
        nft.mint(address(safe), 1);
        nft.mint(address(safe), 2);
        nft.mint(address(safe), 3);
        multi.mint(address(safe), 7, 10); // needs the Safe's fallback handler (onERC1155Received)

        Policy memory p = _defaultPolicy();
        bytes4[] memory nftSels = new bytes4[](3);
        nftSels[0] = SET_APPROVAL_FOR_ALL;
        nftSels[1] = APPROVE;
        nftSels[2] = TRANSFER_FROM;
        _addTarget(p, address(nft), address(nft).codehash, nftSels);
        _addToken(p, address(nft), 1, 1, 2); // ERC-721: max 1 NFT per tx, 2 per day
        _addTarget(p, address(multi), address(multi).codehash, _sels(SET_APPROVAL_FOR_ALL, ERC1155_SAFE_TRANSFER_FROM));
        _addToken(p, address(multi), 2, 0, 0); // ERC-1155: amounts not capped on-chain
        p.operators = new address[](1);
        p.operators[0] = allowedOperator;
        _setPolicy(p);
    }

    function _setAll(address token, address op, bool on) internal pure returns (BlindspotModule.Call memory c) {
        c = _c(token, 0, abi.encodeWithSelector(SET_APPROVAL_FOR_ALL, op, on));
    }

    function _nftTransfer(address to, uint256 id) internal view returns (BlindspotModule.Call memory) {
        return _c(address(nft), 0, abi.encodeWithSelector(TRANSFER_FROM, address(safe), to, id));
    }

    // ------------------------------------------------------------------ operators

    function test_revert_setApprovalForAll_unlistedOperator() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.SpenderNotAllowed.selector, attacker));
        _execBatch(_calls(_setAll(address(nft), attacker, true)));
    }

    function test_revert_OperatorResidue_erc721() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OperatorResidue.selector, address(nft), spender));
        _execBatch(_calls(_setAll(address(nft), spender, true)));
    }

    function test_revert_OperatorResidue_erc1155() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OperatorResidue.selector, address(multi), spender));
        _execBatch(_calls(_setAll(address(multi), spender, true)));
    }

    function test_operatorSetAndClearedInBatch_executes() public {
        _execBatch(_calls(_setAll(address(nft), spender, true), _setAll(address(nft), spender, false)));
        assertFalse(nft.isApprovedForAll(address(safe), spender));
    }

    function test_explicitlyAllowedOperator_mayPersist() public {
        _execBatch(_calls(_setAll(address(nft), allowedOperator, true)));
        assertTrue(nft.isApprovedForAll(address(safe), allowedOperator));
    }

    // ------------------------------------------------------------------ ERC-721 single-token approvals

    function test_revert_ApprovalResidue_erc721() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.ApprovalResidue.selector, address(nft), 1, spender));
        _execBatch(_calls(_c(address(nft), 0, abi.encodeWithSelector(APPROVE, spender, 1))));
    }

    function test_erc721ApproveThenTransfer_clearsApproval_executes() public {
        _execBatch(_calls(_c(address(nft), 0, abi.encodeWithSelector(APPROVE, spender, 1)), _nftTransfer(vendor, 1)));
        assertEq(nft.ownerOf(1), vendor);
        assertEq(nft.getApproved(1), address(0));
    }

    // ------------------------------------------------------------------ recipients and caps

    function test_revert_erc721_transferToAttacker() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.RecipientNotAllowed.selector, attacker));
        _execBatch(_calls(_nftTransfer(attacker, 1)));
    }

    function test_revert_erc721_outflowCap() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(nft), 2));
        _execBatch(_calls(_nftTransfer(vendor, 1), _nftTransfer(vendor, 2)));
    }

    function test_revert_erc721_dailyCap() public {
        _execBatch(_calls(_nftTransfer(vendor, 1)));
        _execBatch(_calls(_nftTransfer(vendor, 2)));
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.DailyCapExceeded.selector, address(nft), 3));
        _execBatch(_calls(_nftTransfer(vendor, 3)));
    }

    function test_revert_erc1155_transferToAttacker() public {
        bytes memory data = abi.encodeWithSelector(ERC1155_SAFE_TRANSFER_FROM, address(safe), attacker, 7, 10, "");
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.RecipientNotAllowed.selector, attacker));
        _execBatch(_calls(_c(address(multi), 0, data)));
    }

    /// @notice Honest limit: for ERC-1155, maxOut = dailyCap = 0 means "amount not tracked",
    ///         NOT "nothing can move". The full balance can go to a payee in one call.
    function test_honestLimit_erc1155AmountNotTracked() public {
        bytes memory data = abi.encodeWithSelector(ERC1155_SAFE_TRANSFER_FROM, address(safe), vendor, 7, 10, "");
        _execBatch(_calls(_c(address(multi), 0, data)));
        assertEq(multi.balanceOf(vendor, 7), 10, "whole balance moved despite caps of 0");
        assertEq(multi.balanceOf(address(safe), 7), 0);
    }

    function test_erc1155_transferToPayee_executes() public {
        bytes memory data = abi.encodeWithSelector(ERC1155_SAFE_TRANSFER_FROM, address(safe), vendor, 7, 4, "");
        _execBatch(_calls(_c(address(multi), 0, data)));
        assertEq(multi.balanceOf(vendor, 7), 4);
    }
}
