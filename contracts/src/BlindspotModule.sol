// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IDataResolver} from "@ens/contracts/resolvers/profiles/IDataResolver.sol";
import {IExtendedResolver} from "@ens/contracts/resolvers/profiles/IExtendedResolver.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Enum} from "@safe/common/Enum.sol";

import {ISafe} from "./interfaces/ISafe.sol";
import {Policy, PolicyCodec} from "./PolicyCodec.sol";

/// @title BlindspotModule
/// @notice The only path from an agent key to the Safe's funds. Every call re-checks the agent's
///         ENSv2 identity and the owner's rules stored in the agent's ENS data record, executes
///         through the Safe with CALL, then checks outflows, daily caps and leftover approvals.
/// @dev No admin functions: rules live only in ENS, addresses are immutable (SPEC §5.2 Hardening).
contract BlindspotModule is ReentrancyGuard {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    /// @dev Per-execution state shared by the pre-checks, the calls and the post-checks.
    struct Ctx {
        bytes32 labelhash;
        Policy p;
        uint256[] before; // tracked balances before the first call
        address[] targets; // call targets, included in the approval post-checks
        address[] nftApprovalTokens; // ERC-721 approve(spender, tokenId) calls in this execution
        uint256[] nftApprovalIds;
        uint256 nftApprovals;
    }

    string public constant POLICY_KEY = "blindspot.policy";
    uint256 public constant MAX_BATCH = 8;

    // Sensitive selectors decoded in check 6.
    bytes4 internal constant TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 internal constant TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)
    bytes4 internal constant SAFE_TRANSFER_FROM = 0x42842e0e; // safeTransferFrom(address,address,uint256)
    bytes4 internal constant SAFE_TRANSFER_FROM_DATA = 0xb88d4fde; // safeTransferFrom(address,address,uint256,bytes)
    bytes4 internal constant ERC1155_SAFE_TRANSFER_FROM = 0xf242432a; // safeTransferFrom(address,address,uint256,uint256,bytes)
    bytes4 internal constant ERC1155_SAFE_BATCH_TRANSFER_FROM = 0x2eb2c2d6; // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
    bytes4 internal constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant INCREASE_ALLOWANCE = 0x39509351; // increaseAllowance(address,uint256)
    bytes4 internal constant SET_APPROVAL_FOR_ALL = 0xa22cb465; // setApprovalForAll(address,bool)

    /// @dev Selector entry that allows a call with empty calldata (plain ETH transfer) to a payee.
    bytes4 internal constant EMPTY_CALLDATA = 0x00000000;

    ISafe public immutable safe;
    /// @notice The owner's UserRegistry holding agent subnames (e.g. `trader` in `trader.owner.eth`).
    IPermissionedRegistry public immutable agentRegistry;
    /// @notice Namehash of the parent name (e.g. `owner.eth`).
    bytes32 public immutable parentNode;
    /// @notice DNS-encoded parent name (e.g. "\x05owner\x03eth\x00"). Set once in the constructor.
    bytes public parentDnsName;

    /// @notice Outflow per agent labelhash, per token (address(0) = ETH), per UTC day.
    mapping(bytes32 labelhash => mapping(address token => mapping(uint256 day => uint256))) public spentPerDay;

    event Executed(string label, address to, bytes4 selector, uint256[] outflows);
    event BatchExecuted(string label, address[] targets, bytes4[] selectors, uint256[] outflows);

    error AgentNotActive();
    error PolicyMissing();
    error ForbiddenTarget(address to);
    error TargetNotAllowed(address to);
    error CodeHashMismatch(address to);
    error SelectorNotAllowed(bytes4 sel);
    error RecipientNotAllowed(address r);
    error SpenderNotAllowed(address s);
    error OutflowExceeded(address token, uint256 amount);
    error DailyCapExceeded(address token, uint256 spentToday);
    error AllowanceResidue(address token, address spender, uint256 amount);
    error OperatorResidue(address token, address operator);
    error ApprovalResidue(address token, uint256 tokenId, address approved);
    error BatchSizeInvalid(uint256 size);
    error ExecutionFailed(bytes returnData);
    error InvalidConfig();

    constructor(ISafe safe_, IPermissionedRegistry agentRegistry_, bytes memory parentDnsName_) {
        if (address(safe_) == address(0) || address(agentRegistry_) == address(0)) revert InvalidConfig();
        safe = safe_;
        agentRegistry = agentRegistry_;
        parentDnsName = parentDnsName_;
        parentNode = NameCoder.namehash(parentDnsName_, 0); // reverts on malformed DNS encoding
    }

    // ------------------------------------------------------------------
    // Entry points
    // ------------------------------------------------------------------

    /// @notice Execute one call from the Safe under the agent's ENS rules.
    function execute(string calldata label, address to, uint256 value, bytes calldata data)
        external
        nonReentrant
        returns (bytes memory ret)
    {
        Ctx memory c = _begin(label, 1); // 1. identity, 2. rules
        bytes4 sel = _preCheck(c, 0, to, value, data); // 3-7
        ret = _call(to, value, data); // 8
        uint256[] memory outflows = _postCheck(c); // 9
        emit Executed(label, to, sel, outflows); // 10
    }

    /// @notice Execute up to MAX_BATCH calls atomically. Every call gets the per-call checks (3-7);
    ///         the total ETH sent is capped by maxEth; outflow caps, daily caps and the
    ///         no-leftover-approval checks run once after the last call.
    function executeBatch(string calldata label, Call[] calldata calls)
        external
        nonReentrant
        returns (bytes[] memory results)
    {
        uint256 n = calls.length;
        if (n == 0 || n > MAX_BATCH) revert BatchSizeInvalid(n);

        Ctx memory c = _begin(label, n); // 1. identity, 2. rules

        bytes4[] memory sels = new bytes4[](n);
        uint256 totalEth;
        for (uint256 i; i < n; ++i) {
            sels[i] = _preCheck(c, i, calls[i].to, calls[i].value, calls[i].data); // 3-7 per call
            totalEth += calls[i].value;
        }
        if (totalEth > c.p.maxEth) revert OutflowExceeded(address(0), totalEth); // 7 for the whole batch

        results = new bytes[](n);
        for (uint256 i; i < n; ++i) {
            results[i] = _call(calls[i].to, calls[i].value, calls[i].data); // 8
        }

        uint256[] memory outflows = _postCheck(c); // 9, once
        emit BatchExecuted(label, c.targets, sels, outflows); // 10
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function previewPolicy(string calldata label) external view returns (Policy memory) {
        return _loadPolicy(label);
    }

    function isAgentActive(string calldata label, address agent) external view returns (bool) {
        return _isAgentActive(keccak256(bytes(label)), agent);
    }

    /// @notice Decode + validate a raw policy record. Reverts PolicyMissing on empty or invalid rules.
    function decodePolicy(bytes memory raw) public pure returns (Policy memory p) {
        if (raw.length == 0) revert PolicyMissing();
        p = PolicyCodec.decode(raw);
        if (!PolicyCodec.isValid(p, raw)) revert PolicyMissing();
    }

    /// @notice Unwrap a resolver `data(node,key)` result (ABI `bytes`) and decode it as a policy.
    function decodeResolvedPolicy(bytes memory resolveResult) external pure returns (Policy memory) {
        return decodePolicy(abi.decode(resolveResult, (bytes)));
    }

    // ------------------------------------------------------------------
    // Steps
    // ------------------------------------------------------------------

    function _begin(string calldata label, uint256 n) internal view returns (Ctx memory c) {
        c.labelhash = keccak256(bytes(label));
        // 1. Identity
        if (!_isAgentActive(c.labelhash, msg.sender)) revert AgentNotActive();
        // 2. Rules
        c.p = _loadPolicy(label);
        c.targets = new address[](n);
        c.nftApprovalTokens = new address[](n);
        c.nftApprovalIds = new uint256[](n);
        c.before = _balances(c.p);
    }

    function _preCheck(Ctx memory c, uint256 i, address to, uint256 value, bytes calldata data)
        internal
        view
        returns (bytes4 sel)
    {
        Policy memory p = c.p;
        // 3. Shape (operation is always CALL, see _call)
        if (to == address(safe) || to == address(this)) revert ForbiddenTarget(to);

        // 4. Target
        uint256 ti = PolicyCodec.indexOf(p.targets, to);
        if (ti == type(uint256).max) revert TargetNotAllowed(to);
        bytes32 pinned = p.codeHashes[ti];
        if (pinned != bytes32(0) && to.codehash != pinned) revert CodeHashMismatch(to);

        // 5. Function
        sel = _selector(data);
        if (!_containsSelector(p.selectors[ti], sel)) revert SelectorNotAllowed(sel);

        // 6. Sensitive calls
        _checkSensitive(c, to, sel, data);

        // 7. ETH
        if (value > p.maxEth) revert OutflowExceeded(address(0), value);

        c.targets[i] = to;
    }

    /// @dev 8. Always CALL, never DELEGATECALL.
    function _call(address to, uint256 value, bytes calldata data) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = safe.execTransactionFromModuleReturnData(to, value, data, Enum.Operation.Call);
        if (!ok) revert ExecutionFailed(ret);
    }

    /// @dev 9. Outflow caps, daily caps, then no leftover approvals of any kind.
    function _postCheck(Ctx memory c) internal returns (uint256[] memory outflows) {
        outflows = _checkOutflows(c);
        _checkNoApprovalResidue(c);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Reads state fresh on every call; token IDs are never cached (they change on re-registration).
    function _isAgentActive(bytes32 labelhash, address agent) internal view returns (bool) {
        IPermissionedRegistry.State memory s = agentRegistry.getState(uint256(labelhash));
        return s.status == IPermissionedRegistry.Status.REGISTERED && s.latestOwner == agent
            && agent != address(0) && s.expiry > block.timestamp;
    }

    function _loadPolicy(string calldata label) internal view returns (Policy memory p) {
        uint256 len = bytes(label).length;
        if (len == 0 || len > 255) revert PolicyMissing();
        address resolver = agentRegistry.getResolver(label);
        if (resolver == address(0)) revert PolicyMissing();
        bytes memory dnsName = abi.encodePacked(uint8(len), label, parentDnsName);
        bytes32 node = keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));

        bytes memory result;
        try IExtendedResolver(resolver).resolve(dnsName, abi.encodeCall(IDataResolver.data, (node, POLICY_KEY)))
        returns (bytes memory r) {
            result = r;
        } catch {
            revert PolicyMissing();
        }
        try this.decodeResolvedPolicy(result) returns (Policy memory decoded) {
            p = decoded;
        } catch {
            revert PolicyMissing();
        }
    }

    function _selector(bytes calldata data) internal pure returns (bytes4) {
        if (data.length == 0) return EMPTY_CALLDATA;
        if (data.length < 4) revert SelectorNotAllowed(bytes4(0));
        return bytes4(data[:4]);
    }

    function _checkSensitive(Ctx memory c, address to, bytes4 sel, bytes calldata data) internal pure {
        Policy memory p = c.p;
        if (sel == EMPTY_CALLDATA) {
            // Plain ETH transfer: the target itself is the recipient.
            _requirePayee(p, to);
        } else if (sel == TRANSFER) {
            (address r,) = abi.decode(data[4:], (address, uint256));
            _requirePayee(p, r);
        } else if (sel == TRANSFER_FROM || sel == SAFE_TRANSFER_FROM) {
            (, address r,) = abi.decode(data[4:], (address, address, uint256));
            _requirePayee(p, r);
        } else if (sel == SAFE_TRANSFER_FROM_DATA) {
            (, address r,,) = abi.decode(data[4:], (address, address, uint256, bytes));
            _requirePayee(p, r);
        } else if (sel == ERC1155_SAFE_TRANSFER_FROM) {
            (, address r,,,) = abi.decode(data[4:], (address, address, uint256, uint256, bytes));
            _requirePayee(p, r);
        } else if (sel == ERC1155_SAFE_BATCH_TRANSFER_FROM) {
            (, address r,,,) = abi.decode(data[4:], (address, address, uint256[], uint256[], bytes));
            _requirePayee(p, r);
        } else if (sel == APPROVE || sel == INCREASE_ALLOWANCE) {
            (address s, uint256 amountOrId) = abi.decode(data[4:], (address, uint256));
            if (!_contains(p.spenders, s)) revert SpenderNotAllowed(s);
            // ERC-721 approve(spender, tokenId): remember the id for the post-check.
            uint256 k = PolicyCodec.indexOf(p.tokens, to);
            if (sel == APPROVE && k != type(uint256).max && p.tokenKinds[k] == PolicyCodec.KIND_ERC721) {
                c.nftApprovalTokens[c.nftApprovals] = to;
                c.nftApprovalIds[c.nftApprovals] = amountOrId;
                ++c.nftApprovals;
            }
        } else if (sel == SET_APPROVAL_FOR_ALL) {
            (address s,) = abi.decode(data[4:], (address, bool));
            if (!_contains(p.spenders, s) && !_contains(p.operators, s)) revert SpenderNotAllowed(s);
        }
    }

    function _requirePayee(Policy memory p, address r) internal pure {
        if (!_contains(p.payees, r)) revert RecipientNotAllowed(r);
    }

    function _balances(Policy memory p) internal view returns (uint256[] memory b) {
        b = new uint256[](p.tokens.length);
        for (uint256 i; i < p.tokens.length; ++i) {
            b[i] = _balanceOf(p.tokens[i], p.tokenKinds[i]);
        }
    }

    /// @dev ERC-1155 balances are per id and are not measured (the codec forces its caps to 0).
    function _balanceOf(address token, uint8 kind) internal view returns (uint256) {
        if (token == address(0)) return address(safe).balance;
        if (kind == PolicyCodec.KIND_ERC20) return IERC20(token).balanceOf(address(safe));
        if (kind == PolicyCodec.KIND_ERC721) return IERC721(token).balanceOf(address(safe));
        return 0;
    }

    function _checkOutflows(Ctx memory c) internal returns (uint256[] memory outflows) {
        Policy memory p = c.p;
        uint256 day = block.timestamp / 1 days;
        outflows = new uint256[](p.tokens.length);
        for (uint256 i; i < p.tokens.length; ++i) {
            address token = p.tokens[i];
            uint256 afterBal = _balanceOf(token, p.tokenKinds[i]);
            if (afterBal >= c.before[i]) continue;
            uint256 out = c.before[i] - afterBal;
            outflows[i] = out;
            if (out > p.maxOut[i]) revert OutflowExceeded(token, out);
            uint256 spent = spentPerDay[c.labelhash][token][day] + out;
            if (spent > p.dailyCap[i]) revert DailyCapExceeded(token, spent);
            spentPerDay[c.labelhash][token][day] = spent;
        }
    }

    /// @dev For every tracked token: ERC-20 allowance from the Safe is 0 for every call target and
    ///      listed spender; ERC-721/1155 operator approval is off for them unless listed in operators;
    ///      ERC-721 single-token approvals made in this execution are cleared.
    function _checkNoApprovalResidue(Ctx memory c) internal view {
        Policy memory p = c.p;
        for (uint256 i; i < p.tokens.length; ++i) {
            address token = p.tokens[i];
            if (token == address(0)) continue;
            uint8 kind = p.tokenKinds[i];
            for (uint256 j; j < c.targets.length; ++j) {
                _checkResidue(p, token, kind, c.targets[j]);
            }
            for (uint256 j; j < p.spenders.length; ++j) {
                _checkResidue(p, token, kind, p.spenders[j]);
            }
        }
        for (uint256 k; k < c.nftApprovals; ++k) {
            address approved = IERC721(c.nftApprovalTokens[k]).getApproved(c.nftApprovalIds[k]);
            if (approved != address(0)) revert ApprovalResidue(c.nftApprovalTokens[k], c.nftApprovalIds[k], approved);
        }
    }

    function _checkResidue(Policy memory p, address token, uint8 kind, address x) internal view {
        if (kind == PolicyCodec.KIND_ERC20) {
            uint256 a = IERC20(token).allowance(address(safe), x);
            if (a != 0) revert AllowanceResidue(token, x, a);
        } else if (!_contains(p.operators, x)) {
            bool approved = kind == PolicyCodec.KIND_ERC721
                ? IERC721(token).isApprovedForAll(address(safe), x)
                : IERC1155(token).isApprovedForAll(address(safe), x);
            if (approved) revert OperatorResidue(token, x);
        }
    }

    function _contains(address[] memory list, address a) internal pure returns (bool) {
        return PolicyCodec.indexOf(list, a) != type(uint256).max;
    }

    function _containsSelector(bytes4[] memory list, bytes4 s) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == s) return true;
        }
        return false;
    }
}
