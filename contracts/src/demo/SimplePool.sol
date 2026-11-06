// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice DEMO ONLY. Honest fixed-rate swap venue between two tokens with equal decimals.
///         Pulls exactly `amountIn` (so an exact approval is fully consumed) and pays out
///         `amountIn * rateNum / rateDen` of the other token from its reserves.
contract SimplePool {
    using SafeERC20 for IERC20;

    IERC20 public immutable tokenA;
    IERC20 public immutable tokenB;
    uint256 public immutable rateNum;
    uint256 public immutable rateDen;

    event Swapped(address indexed trader, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    error UnknownToken(address token);
    error Slippage(uint256 amountOut, uint256 minOut);

    constructor(IERC20 tokenA_, IERC20 tokenB_, uint256 rateNum_, uint256 rateDen_) {
        tokenA = tokenA_;
        tokenB = tokenB_;
        rateNum = rateNum_;
        rateDen = rateDen_;
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minOut) external returns (uint256 amountOut) {
        IERC20 tokenOut;
        if (tokenIn == address(tokenA)) {
            tokenOut = tokenB;
            amountOut = amountIn * rateNum / rateDen;
        } else if (tokenIn == address(tokenB)) {
            tokenOut = tokenA;
            amountOut = amountIn * rateDen / rateNum;
        } else {
            revert UnknownToken(tokenIn);
        }
        if (amountOut < minOut) revert Slippage(amountOut, minOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        tokenOut.safeTransfer(msg.sender, amountOut);
        emit Swapped(msg.sender, tokenIn, amountIn, amountOut);
    }
}
