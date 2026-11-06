import { decodeErrorResult, parseAbi, type Address, type Hex } from 'viem';

/**
 * Plain-language reasons for every BlindspotModule revert (SPEC §13: "on-chain revert names" are one of
 * the four places rules are shown). Signatures must match contracts/src/BlindspotModule.sol; a test
 * fails if the contract declares an error that is missing here.
 *
 * Amounts are raw token units; the UI formats them with token decimals/symbols.
 */
export const MODULE_ERRORS_ABI = parseAbi([
  'error AgentNotActive()',
  'error PolicyMissing()',
  'error ForbiddenTarget(address to)',
  'error TargetNotAllowed(address to)',
  'error CodeHashMismatch(address to)',
  'error SelectorNotAllowed(bytes4 sel)',
  'error RecipientNotAllowed(address r)',
  'error SpenderNotAllowed(address s)',
  'error OutflowExceeded(address token, uint256 amount)',
  'error DailyCapExceeded(address token, uint256 spentToday)',
  'error AllowanceResidue(address token, address spender, uint256 amount)',
  'error OperatorResidue(address token, address operator)',
  'error ApprovalResidue(address token, uint256 tokenId, address approved)',
  'error BatchSizeInvalid(uint256 size)',
  'error ExecutionFailed(bytes returnData)',
  'error InvalidConfig()',
  // OpenZeppelin ReentrancyGuard (inherited by the module)
  'error ReentrancyGuardReentrantCall()',
]);

export type ModuleRevert = {
  /** Error name, or 'Unknown' when the revert data matches no module error. */
  name: string;
  /** Plain-language reason for the owner / judge. */
  reason: string;
  /** Rule from the policy that was broken, when there is one. */
  rule?: string;
  args: readonly unknown[];
};

const ETH = '0x0000000000000000000000000000000000000000';
const asset = (token: Address) => (token.toLowerCase() === ETH ? 'ETH' : `token ${token}`);

type Explainer = (args: readonly unknown[]) => { reason: string; rule?: string };

const EXPLAIN: Record<string, Explainer> = {
  AgentNotActive: () => ({
    reason: "This agent is not active: its ENS name is expired, revoked, or registered to a different key.",
    rule: 'Agent expiry / revoke',
  }),
  PolicyMissing: () => ({
    reason:
      "No valid rules were found on the agent's ENS name (the blindspot.policy record is missing or invalid), so nothing is allowed.",
    rule: 'Rules record',
  }),
  ForbiddenTarget: ([to]) => ({
    reason: `Calls to the wallet's own Safe or to the Blindspot module are never allowed (${to}).`,
    rule: 'Forbidden target',
  }),
  TargetNotAllowed: ([to]) => ({
    reason: `${to} is not on the list of contracts the owner allowed.`,
    rule: 'Allowed contracts',
  }),
  CodeHashMismatch: ([to]) => ({
    reason: `The code at ${to} has changed since the owner allowed it.`,
    rule: 'Allowed contracts (pinned code)',
  }),
  SelectorNotAllowed: ([sel]) => ({
    reason:
      sel === '0x00000000'
        ? 'Sending ETH or an empty call to this address is not allowed.'
        : `Function ${sel} is not one of the functions the owner allowed on this contract.`,
    rule: 'Allowed functions',
  }),
  RecipientNotAllowed: ([r]) => ({
    reason: `${r} is not one of the owner's approved recipients.`,
    rule: 'Allowed recipients',
  }),
  SpenderNotAllowed: ([s]) => ({
    reason: `${s} is not allowed to be given permission to spend or control the wallet's tokens.`,
    rule: 'Allowed spenders',
  }),
  OutflowExceeded: ([token, amount]) => ({
    reason: `This would send ${amount} of ${asset(token as Address)} in one transaction, more than the owner's per-transaction limit.`,
    rule: (token as string).toLowerCase() === ETH ? 'Maximum ETH per transaction' : 'Per-transaction cap',
  }),
  DailyCapExceeded: ([token, spent]) => ({
    reason: `This would bring today's total for ${asset(token as Address)} to ${spent}, above the owner's daily limit.`,
    rule: 'Daily cap',
  }),
  AllowanceResidue: ([token, spender, amount]) => ({
    reason: `This would leave ${spender} allowed to spend ${amount} of ${asset(token as Address)} afterwards. Approvals must be fully used in the same transaction.`,
    rule: 'No leftover approvals',
  }),
  OperatorResidue: ([token, operator]) => ({
    reason: `This would leave ${operator} in control of all of the wallet's ${asset(token as Address)} NFTs afterwards.`,
    rule: 'No leftover approvals',
  }),
  ApprovalResidue: ([token, tokenId, approved]) => ({
    reason: `This would leave ${approved} approved to take NFT #${tokenId} of ${asset(token as Address)} afterwards.`,
    rule: 'No leftover approvals',
  }),
  BatchSizeInvalid: ([size]) => ({
    reason: `A batch must contain between 1 and 8 calls; this one has ${size}.`,
  }),
  ExecutionFailed: () => ({
    reason: 'The transaction failed inside the target contract, so nothing was executed.',
  }),
  InvalidConfig: () => ({
    reason: 'The Blindspot module was deployed with an invalid configuration.',
  }),
  ReentrancyGuardReentrantCall: () => ({
    reason: 'A contract tried to call back into Blindspot during the transaction. This is blocked.',
  }),
};

/** Error names that have an explanation (used by the coverage test). */
export const EXPLAINED_ERRORS: readonly string[] = Object.keys(EXPLAIN);

/**
 * Turn module revert data into a plain-language reason. Fails closed: data that matches no known
 * error is reported as 'Unknown' and must be treated as a block by the caller.
 * For ExecutionFailed, the inner revert is explained too when it is a module error.
 */
export function explainModuleRevert(data: Hex): ModuleRevert {
  let decoded;
  try {
    decoded = decodeErrorResult({ abi: MODULE_ERRORS_ABI, data });
  } catch {
    return {
      name: 'Unknown',
      reason: 'The transaction was rejected for a reason Blindspot does not recognise. It is treated as blocked.',
      args: [],
    };
  }
  const args = decoded.args ?? [];
  // viem's types list only MODULE_ERRORS_ABI names, but at runtime it also decodes Solidity's
  // built-in Error(string) and Panic(uint256) (e.g. the Safe's "GS104"), so widen to string.
  const errorName: string = decoded.errorName;
  const explainer = EXPLAIN[errorName];
  if (!explainer) {
    // Not a module rule: report it plainly and treat it as blocked (fail closed, never throw).
    const detail =
      errorName === 'Error' ? `: "${String(args[0])}"` : errorName === 'Panic' ? ` (panic code ${String(args[0])})` : '';
    return {
      name: errorName,
      reason: `The transaction was rejected by a contract${detail}. It is treated as blocked.`,
      args,
    };
  }
  const { reason, rule } = explainer(args);
  const out: ModuleRevert = { name: decoded.errorName, reason, args, ...(rule ? { rule } : {}) };
  if (decoded.errorName === 'ExecutionFailed') {
    const inner = args[0] as Hex;
    if (inner && inner !== '0x') {
      const innerExplained = explainModuleRevert(inner);
      if (innerExplained.name !== 'Unknown') out.reason = `${out.reason} Inner reason: ${innerExplained.reason}`;
    }
  }
  return out;
}
