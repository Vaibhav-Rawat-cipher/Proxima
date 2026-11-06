// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BlindspotModule} from "../src/BlindspotModule.sol";
import {SimplePool} from "../src/demo/SimplePool.sol";
import {Policy} from "../src/PolicyCodec.sol";
import {BlindspotBase} from "./BlindspotBase.sol";
import {TestERC20} from "./utils/TestERC20.sol";

/// @notice Allowed target that tries to re-enter executeBatch while the Safe is calling it.
contract BatchReenterer {
    BlindspotModule internal immutable module;

    constructor(BlindspotModule m) {
        module = m;
    }

    fallback() external payable {
        BlindspotModule.Call[] memory calls = new BlindspotModule.Call[](1);
        calls[0] = BlindspotModule.Call({to: address(this), value: 0, data: hex"12345678"});
        module.executeBatch("trader", calls);
    }
}

contract BlindspotBatchTest is BlindspotBase {
    TestERC20 internal dai;
    SimplePool internal pool;

    function setUp() public override {
        super.setUp();
        dai = new TestERC20("Dai", "DAI", 6);
        pool = new SimplePool(IERC20(address(usdc)), IERC20(address(dai)), 1, 1);
        dai.mint(address(pool), 1_000e6);
        _setPolicy(_poolPolicy());
    }

    function _poolPolicy() internal view returns (Policy memory p) {
        p = _defaultPolicy();
        _addTarget(p, address(pool), address(pool).codehash, _sels(SimplePool.swap.selector));
        _addSpender(p, address(pool));
        _addToken(p, address(dai), 0, 100e6, 250e6);
    }

    function _swapCalls(uint256 amount) internal view returns (BlindspotModule.Call[] memory) {
        return _calls(
            _c(address(usdc), 0, abi.encodeWithSelector(APPROVE, address(pool), amount)),
            _c(address(pool), 0, abi.encodeCall(SimplePool.swap, (address(usdc), amount, amount)))
        );
    }

    // ------------------------------------------------------------------ the case single calls cannot do

    function test_batch_approveAndSwap_executes() public {
        address[] memory targets = new address[](2);
        targets[0] = address(usdc);
        targets[1] = address(pool);
        bytes4[] memory sels = _sels(APPROVE, SimplePool.swap.selector);
        uint256[] memory outflows = new uint256[](3);
        outflows[0] = 50e6;
        vm.expectEmit(address(module));
        emit BlindspotModule.BatchExecuted(LABEL, targets, sels, outflows);

        bytes[] memory results = _execBatch(_swapCalls(50e6));

        assertEq(results.length, 2);
        assertEq(usdc.balanceOf(address(safe)), 950e6);
        assertEq(dai.balanceOf(address(safe)), 50e6);
        assertEq(usdc.allowance(address(safe), address(pool)), 0, "exact approval fully consumed");
    }

    function test_singleExecute_approveForSwap_stillReverts() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.AllowanceResidue.selector, address(usdc), address(pool), 50e6));
        _exec(address(usdc), 0, abi.encodeWithSelector(APPROVE, address(pool), 50e6));
    }

    function test_revert_batch_approveMoreThanSwapped_AllowanceResidue() public {
        BlindspotModule.Call[] memory calls = _swapCalls(50e6);
        calls[0].data = abi.encodeWithSelector(APPROVE, address(pool), 80e6);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.AllowanceResidue.selector, address(usdc), address(pool), 30e6));
        _execBatch(calls);
    }

    // ------------------------------------------------------------------ size

    function test_revert_BatchSizeInvalid_empty() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.BatchSizeInvalid.selector, 0));
        _execBatch(new BlindspotModule.Call[](0));
    }

    function test_revert_BatchSizeInvalid_nine() public {
        BlindspotModule.Call[] memory calls = new BlindspotModule.Call[](9);
        for (uint256 i; i < 9; ++i) {
            calls[i] = _c(address(usdc), 0, _transfer(vendor, 1e6));
        }
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.BatchSizeInvalid.selector, 9));
        _execBatch(calls);
    }

    function test_batch_maxSizeEight_executes() public {
        BlindspotModule.Call[] memory calls = new BlindspotModule.Call[](8);
        for (uint256 i; i < 8; ++i) {
            calls[i] = _c(address(usdc), 0, _transfer(vendor, 1e6));
        }
        _execBatch(calls);
        assertEq(usdc.balanceOf(vendor), 8e6);
    }

    // ------------------------------------------------------------------ per-call checks on every call

    function test_revert_batch_secondCallBadRecipient_nothingMoves() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.RecipientNotAllowed.selector, attacker));
        _execBatch(_calls(_c(address(usdc), 0, _transfer(vendor, 1e6)), _c(address(usdc), 0, _transfer(attacker, 1e6))));
        assertEq(usdc.balanceOf(vendor), 0);
    }

    function test_revert_batch_secondCallForbiddenTarget() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.ForbiddenTarget.selector, address(safe)));
        _execBatch(_calls(_c(address(usdc), 0, _transfer(vendor, 1e6)), _c(address(safe), 0, "")));
    }

    function test_revert_batch_secondCallSpenderNotAllowed() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.SpenderNotAllowed.selector, attacker));
        _execBatch(_calls(_swapCalls(1e6)[0], _c(address(usdc), 0, abi.encodeWithSelector(APPROVE, attacker, 1))));
    }

    function test_revert_batch_AgentNotActive() public {
        vm.prank(attacker);
        vm.expectRevert(BlindspotModule.AgentNotActive.selector);
        module.executeBatch(LABEL, _swapCalls(1e6));
    }

    // ------------------------------------------------------------------ caps once, on the batch total

    function test_revert_batch_outflowCapOnTotal() public {
        BlindspotModule.Call[] memory calls = new BlindspotModule.Call[](3);
        for (uint256 i; i < 3; ++i) {
            calls[i] = _c(address(usdc), 0, _transfer(vendor, 40e6));
        }
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(usdc), 120e6));
        _execBatch(calls);
    }

    function test_batch_dailyCapCountsTotal() public {
        _execBatch(_calls(_c(address(usdc), 0, _transfer(vendor, 40e6)), _c(address(usdc), 0, _transfer(vendor, 40e6))));
        assertEq(module.spentPerDay(keccak256(bytes(LABEL)), address(usdc), block.timestamp / 1 days), 80e6);
        _execBatch(_calls(_c(address(usdc), 0, _transfer(vendor, 90e6)), _c(address(usdc), 0, _transfer(vendor, 10e6))));
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.DailyCapExceeded.selector, address(usdc), 260e6));
        _execBatch(_calls(_c(address(usdc), 0, _transfer(vendor, 40e6)), _c(address(usdc), 0, _transfer(vendor, 40e6))));
    }

    function test_revert_batch_totalEthAboveMaxEth() public {
        // ETH not tracked in tokens: only the batch-wide maxEth pre-check can stop this.
        Policy memory p = _poolPolicy();
        p.tokens[1] = address(dai);
        p.tokens = _drop(p.tokens);
        p.tokenKinds = new uint8[](2);
        p.maxOut = _dropU(p.maxOut);
        p.dailyCap = _dropU(p.dailyCap);
        _setPolicy(p);
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(0), 0.012 ether));
        _execBatch(_calls(_c(vendor, 0.006 ether, ""), _c(vendor, 0.006 ether, "")));
    }

    function _drop(address[] memory a) internal pure returns (address[] memory r) {
        r = new address[](a.length - 1);
        for (uint256 i; i < r.length; ++i) {
            r[i] = a[i];
        }
    }

    function _dropU(uint256[] memory a) internal pure returns (uint256[] memory r) {
        r = new uint256[](a.length - 1);
        for (uint256 i; i < r.length; ++i) {
            r[i] = a[i];
        }
    }

    function test_revert_batch_singleCallEthAboveMaxEth() public {
        vm.expectRevert(abi.encodeWithSelector(BlindspotModule.OutflowExceeded.selector, address(0), 0.02 ether));
        _execBatch(_calls(_c(vendor, 0.02 ether, "")));
    }

    // ------------------------------------------------------------------ reentrancy

    function test_batch_reentrancy_blocked() public {
        BatchReenterer r = new BatchReenterer(module);
        Policy memory p = _defaultPolicy();
        _addTarget(p, address(r), bytes32(0), _sels(0x12345678));
        _setPolicy(p);
        vm.expectRevert(
            abi.encodeWithSelector(
                BlindspotModule.ExecutionFailed.selector,
                abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
            )
        );
        _execBatch(_calls(_c(address(r), 0, hex"12345678")));
    }
}
