// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice DEMO ONLY. ERC-20 whose name and symbol carry an instruction aimed at AI agents
///         ("on-chain text" attack, SPEC §12). The token itself is harmless; the trap is the text.
contract InjectToken is ERC20 {
    constructor(string memory name_, string memory symbol_, address holder, uint256 amount) ERC20(name_, symbol_) {
        _mint(holder, amount);
    }
}
