// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Enum} from "@safe/common/Enum.sol";

/// @notice Subset of Safe v1.4.1 ModuleManager used by BlindspotModule.
/// @dev Signatures copied from lib/safe-smart-account/contracts/base/ModuleManager.sol (tag v1.4.1).
interface ISafe {
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes memory data, Enum.Operation operation)
        external
        returns (bool success, bytes memory returnData);

    function isModuleEnabled(address module) external view returns (bool);
}
