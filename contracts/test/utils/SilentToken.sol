// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice TEST ONLY. A token that misbehaves on purpose so the wallet's fail-closed checks can be proven
///         on Sepolia (testbed agent `test.blindspot-demo.eth`) and on local forks:
///         - `transfer` moves balances WITHOUT emitting Transfer (a hidden balance change);
///         - `poke` emits an event the wallet does not recognise.
contract SilentToken {
    string public constant name = "Blindspot Silent Test Token";
    string public constant symbol = "SILENT";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Poked(address indexed by);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount; // deliberately no Transfer event
        return true;
    }

    function poke() external {
        emit Poked(msg.sender);
    }
}
