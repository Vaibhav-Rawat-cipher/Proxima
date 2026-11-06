// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {IPermissionedResolver} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolver.sol";

import {Policy, PolicyCodec} from "./PolicyCodec.sol";

/// @title TrialProvisioner (Step 3d)
/// @notice Self-serve trial agents for the public demo: `provision(agent)` registers `try<N>.trials.<parent>.eth`
///         to a fresh, browser-generated agent address with ZERO roles and a 24-hour expiry, writes one fixed,
///         tiny policy to its `blindspot.policy` record, and sends a small gas drip.
/// @dev Powers held (granted by the owner, exact ENSv2 roles from the official docs):
///      - `ROLE_REGISTRAR` (root) on the TRIAL registry only: it can register AVAILABLE trial labels, nothing else
///        (no renew, unregister, resolver or subregistry roles; it never touches the demo agent's registry).
///      - `ROLE_SET_DATA` for the key "blindspot.policy" on the TRIAL resolver only (key-scoped roles cover every
///        name of a resolver, so trials get their own resolver: the demo agent's records are out of reach).
///      The policy is set by the owner (validated with PolicyCodec.isValid) and applies to new trials. Trial agents get no roles at all,
///      so they cannot change their policy. Trial payments go through a separate trial Safe + module that reads the
///      trial registry only, so the demo Safe is fully isolated.
///      Limits: one trial per sender per UTC day (the relayer has its own daily quota instead), a global daily cap,
///      fresh agent addresses only, pause switch. The owner unregisters trial names directly on the trial registry.
contract TrialProvisioner {
    string public constant POLICY_KEY = "blindspot.policy";
    uint64 public constant TRIAL_DURATION = 24 hours;

    IPermissionedRegistry public immutable trialRegistry;
    IPermissionedResolver public immutable trialResolver;
    address public immutable owner;
    /// @notice DNS-encoded parent of trial names, e.g. "\x06trials\x0eblindspot-demo\x03eth\x00".
    bytes public parentDns;
    /// @notice The fixed trial policy (ABI-encoded Policy), written to every trial name.
    bytes public policy;

    bool public paused;
    /// @notice Gas-only relayer (serverless). It may call provision() for visitors without Sepolia ETH.
    address public relayer;
    uint256 public globalDailyCap;
    uint256 public relayerDailyQuota;
    uint256 public drip;
    uint256 public trialCount;

    mapping(uint256 day => uint256) public trialsOnDay;
    mapping(uint256 day => uint256) public relayerTrialsOnDay;
    /// @dev day + 1 of the sender's last trial (0 = never).
    mapping(address sender => uint256) public lastSenderDayPlusOne;
    mapping(address agent => bool) public agentUsed;

    event TrialProvisioned(uint256 indexed id, string label, address indexed agent, address indexed sender, uint64 expiry);
    event PausedSet(bool paused);
    event RelayerSet(address relayer);
    event LimitsSet(uint256 globalDailyCap, uint256 relayerDailyQuota);
    event DripSet(uint256 drip);
    event PolicySet(bytes32 policyHash);
    event Withdrawn(address to, uint256 amount);

    error NotOwner();
    error IsPaused();
    error InvalidPolicy();
    error InvalidConfig();
    error InvalidAgent(address agent);
    error AgentAlreadyUsed(address agent);
    error GlobalCapReached(uint256 day);
    error RelayerQuotaReached(uint256 day);
    error SenderLimitReached(address sender, uint256 day);
    error DripFundsEmpty();
    error DripFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        IPermissionedRegistry trialRegistry_,
        IPermissionedResolver trialResolver_,
        bytes memory parentDns_,
        bytes memory policy_,
        address owner_,
        address relayer_,
        uint256 globalDailyCap_,
        uint256 relayerDailyQuota_,
        uint256 drip_
    ) {
        if (address(trialRegistry_) == address(0) || address(trialResolver_) == address(0) || owner_ == address(0)) revert InvalidConfig();
        if (parentDns_.length < 2 || parentDns_[parentDns_.length - 1] != 0x00) revert InvalidConfig();
        if (relayerDailyQuota_ > globalDailyCap_) revert InvalidConfig();
        _checkPolicy(policy_);
        trialRegistry = trialRegistry_;
        trialResolver = trialResolver_;
        owner = owner_;
        parentDns = parentDns_;
        policy = policy_;
        relayer = relayer_;
        globalDailyCap = globalDailyCap_;
        relayerDailyQuota = relayerDailyQuota_;
        drip = drip_;
    }

    receive() external payable {}

    /// @notice Creates a trial agent for `agent` (a fresh address generated in the visitor's browser).
    function provision(address agent) external returns (uint256 id, string memory label) {
        if (paused) revert IsPaused();
        if (agent == address(0) || agent.code.length != 0) revert InvalidAgent(agent);
        if (agentUsed[agent]) revert AgentAlreadyUsed(agent);
        uint256 day = block.timestamp / 1 days;
        if (trialsOnDay[day] >= globalDailyCap) revert GlobalCapReached(day);
        if (msg.sender == relayer && relayer != address(0)) {
            if (relayerTrialsOnDay[day] >= relayerDailyQuota) revert RelayerQuotaReached(day);
            ++relayerTrialsOnDay[day];
        } else {
            if (lastSenderDayPlusOne[msg.sender] == day + 1) revert SenderLimitReached(msg.sender, day);
            lastSenderDayPlusOne[msg.sender] = day + 1;
        }
        if (address(this).balance < drip) revert DripFundsEmpty();
        ++trialsOnDay[day];
        agentUsed[agent] = true;
        id = ++trialCount;
        label = string.concat("try", _toString(id));
        uint64 expiry = uint64(block.timestamp) + TRIAL_DURATION;

        // Zero roles for the agent: it owns the name (the module checks latestOwner) but can change nothing.
        trialRegistry.register(label, agent, IRegistry(address(0)), address(trialResolver), 0, expiry);
        trialResolver.setData(abi.encodePacked(uint8(bytes(label).length), label, parentDns), POLICY_KEY, policy);
        emit TrialProvisioned(id, label, agent, msg.sender, expiry);

        if (drip != 0) {
            // `agent` has no code (checked above), so this transfer cannot re-enter.
            (bool ok,) = payable(agent).call{value: drip}("");
            if (!ok) revert DripFailed();
        }
    }

    // ---------------------------------------------------------------- owner controls
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setRelayer(address relayer_) external onlyOwner {
        relayer = relayer_;
        emit RelayerSet(relayer_);
    }

    function setLimits(uint256 globalDailyCap_, uint256 relayerDailyQuota_) external onlyOwner {
        if (relayerDailyQuota_ > globalDailyCap_) revert InvalidConfig();
        globalDailyCap = globalDailyCap_;
        relayerDailyQuota = relayerDailyQuota_;
        emit LimitsSet(globalDailyCap_, relayerDailyQuota_);
    }

    /// @notice New fixed policy for FUTURE trials (e.g. after replacing a payee). Existing trials keep theirs (24 h).
    function setPolicy(bytes calldata policy_) external onlyOwner {
        _checkPolicy(policy_);
        policy = policy_;
        emit PolicySet(keccak256(policy_));
    }

    function setDrip(uint256 drip_) external onlyOwner {
        drip = drip_;
        emit DripSet(drip_);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert DripFailed();
        emit Withdrawn(to, amount);
    }

    // ---------------------------------------------------------------- helpers
    function _checkPolicy(bytes memory raw) internal pure {
        Policy memory p = PolicyCodec.decode(raw); // reverts on malformed ABI data
        if (!PolicyCodec.isValid(p, raw)) revert InvalidPolicy();
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory b = new bytes(len);
        for (; v != 0; v /= 10) b[--len] = bytes1(uint8(48 + (v % 10)));
        return string(b);
    }
}
