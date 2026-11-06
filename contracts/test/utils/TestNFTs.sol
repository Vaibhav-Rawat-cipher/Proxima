// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Plain OpenZeppelin ERC-721 with open minting (test asset).
contract TestERC721 is ERC721 {
    constructor() ERC721("Test NFT", "TNFT") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// @notice Plain OpenZeppelin ERC-1155 with open minting (test asset).
contract TestERC1155 is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}
