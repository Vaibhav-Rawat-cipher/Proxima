import type { Address, Hex } from 'viem';
import type { Effect } from './effects.js';

/** SPEC §15. One call the agent (or a dapp, or a script) wants the Safe to make. */
export type ProposalCall = { to: Address; value: bigint; data: Hex };

/**
 * SPEC §15 Proposal. `calls` has one entry for BlindspotModule.execute and 2–8 for executeBatch
 * (SPEC §5.2); SPEC's single `tx` is `calls[0]`.
 */
export type Proposal = {
  id: string;
  origin: 'agent' | 'dapp' | 'script';
  calls: ProposalCall[];
  /** What the proposer claims will happen. Compared with the simulated effects (claim vs reality). */
  declaredEffects: Omit<Effect, 'source'>[];
  reason: string;
  /** Trace event ids of the inputs the proposer used (origin trace, 2.4). */
  inputsUsed: string[];
};

export type Verdict = 'ALLOW' | 'BLOCK' | 'ASK_OWNER';

export type CheckName =
  | 'agentActive'
  | 'simulation'
  | 'modulePreview'
  | 'rules'
  | 'claimVsReality'
  | 'noLeftoverApprovals'
  | 'lookAlike'
  | 'proxyUpgrade'
  | 'rateLimit'
  | 'newContract'
  | 'askOwner';

export type FailedCheck = { check: CheckName; rule?: string; detail: string };

export type DecisionOrigin = {
  value: string;
  eventId: string;
  source: string;
  excerpt: string;
  tool?: string;
  path?: string;
  line?: number;
  why?: string;
};

/** SPEC §15 Decision. */
export type Decision = {
  proposalId: string;
  verdict: Verdict;
  /** Every failed check, each with a plain-language detail (BLOCK), or the ask-owner reason (ASK_OWNER). */
  failedChecks: FailedCheck[];
  /** Names of the checks that ran and passed. */
  passedChecks: CheckName[];
  effects: Effect[];
  undeclared: Effect[];
  /** "Where the agent went wrong": the first untrusted input containing a bad value (SPEC §8). */
  origin?: DecisionOrigin;
  /** Every suspicious value that was traced back to an untrusted input. */
  origins?: DecisionOrigin[];
  moduleRevert?: string;
  simulatedAtBlock: bigint;
  anonCalls: number;
};
