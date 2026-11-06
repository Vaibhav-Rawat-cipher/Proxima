// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice DEMO ONLY. Looks like a vault: takes deposits, mints ~0 shares (assets / 1e12), and
///         has no withdraw. The depositor loses the assets.
contract EvilVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;

    constructor(IERC20 asset_) ERC20("Blue Chip Yield Vault", "bcyUSDC") {
        asset = asset_;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        asset.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets / 1e12;
        _mint(receiver, shares);
    }
}
