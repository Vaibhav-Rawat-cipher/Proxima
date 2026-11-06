import { formatUnits, type Address } from 'viem';
import { ASK_OWNER_DECIMALS, ETH, PolicyError, type CheckName, type Decision, type FailedCheck, type Policy, type Proposal } from '@blindspot/shared';
import type { RpcAdapter, StorageAdapter } from '../adapters/types.js';
import { clientFor } from '../chain.js';
import type { Deployment } from '../deployment.js';
import { readAgentStatus, readPolicy } from '../ens/reader.js';
import { simulateProposal } from '../simulate/simulate.js';
import { readDecimals } from '../chain-reads.js';
import { explainOrigins, suspiciousValues, type Trace } from '../trace/trace.js';
import {
  checkAgentActive,
  checkClaimVsReality,
  checkLookAlike,
  checkModulePreview,
  checkNewContract,
  checkNoLeftoverApprovals,
  checkProxyUpgrade,
  checkRateLimit,
  checkRules,
  checkSimulation,
  intendedOutflows,
  readCodeHashes,
  readSpentToday,
  type CheckOutcome,
} from './checks.js';

export type EvaluateInput = {
  rpc: RpcAdapter;
  deployment: Deployment;
  storage: StorageAdapter;
  label: string;
  agent: Address;
  proposal: Proposal;
  /** Tokens whose outflow counts toward the owner's "ask me above $X" (USD stablecoins). Default: MockUSDC. */
  askOwnerTokens?: Address[];
  /** The run's trace: when given, BLOCK / ASK_OWNER decisions get the untrusted origin of every bad value. */
  trace?: Trace;
};

function attachOrigins(decision: Decision, trace: Trace | undefined, policy: Policy, proposal: Proposal, safe: Address, decimals: Record<string, number>): Decision {
  if (!trace || decision.verdict === 'ALLOW') return decision;
  const origins = explainOrigins(trace, suspiciousValues(policy, proposal, decision, safe, decimals)).map((o) => ({
    value: o.value,
    eventId: o.eventId,
    source: o.source,
    excerpt: o.excerpt,
    tool: o.tool,
    line: o.line,
    why: o.why,
    ...(o.path === undefined ? {} : { path: o.path }),
  }));
  return origins.length ? { ...decision, origin: origins[0]!, origins } : decision;
}

/**
 * A stablecoin amount in the threshold's unit (USD with ASK_OWNER_DECIMALS decimals). Rounds UP when a token
 * has more decimals, so a payment a fraction above the threshold still asks the owner.
 */
export function toUsdUnits(amount: bigint, decimals: number): bigint {
  if (decimals === ASK_OWNER_DECIMALS) return amount;
  if (decimals < ASK_OWNER_DECIMALS) return amount * 10n ** BigInt(ASK_OWNER_DECIMALS - decimals);
  const f = 10n ** BigInt(decimals - ASK_OWNER_DECIMALS);
  return (amount + f - 1n) / f;
}

/** Counts requests through the rpc adapter (for the Anon-RPC traffic meter). */
function counting(rpc: RpcAdapter) {
  let n = 0;
  const wrapped: RpcAdapter = {
    name: rpc.name,
    anonymized: rpc.anonymized,
    request: (args) => {
      n++;
      return rpc.request(args);
    },
  };
  return { wrapped, count: () => n };
}

/**
 * SPEC §8: identity → rules from ENS → simulation → every check → ALLOW / BLOCK / ASK_OWNER.
 * Any failed check, or any error while gathering evidence, is a BLOCK (fail closed).
 */
export async function evaluateProposal(input: EvaluateInput): Promise<Decision> {
  const { deployment: d, storage, label, agent, proposal } = input;
  const meter = counting(input.rpc);
  const client = clientFor(meter.wrapped);
  const failed: FailedCheck[] = [];
  const passed: CheckName[] = [];
  const take = (o: CheckOutcome) => (o.failures.length ? failed.push(...o.failures) : passed.push(o.check));
  const base = (verdict: Decision['verdict'], extra: Partial<Decision> = {}): Decision => ({
    proposalId: proposal.id,
    verdict,
    failedChecks: failed,
    passedChecks: passed,
    effects: [],
    undeclared: [],
    simulatedAtBlock: 0n,
    anonCalls: meter.wrapped.anonymized ? meter.count() : 0,
    ...extra,
  });

  if (proposal.calls.length === 0 || proposal.calls.length > 8) {
    failed.push({ check: 'rules', detail: `A proposal must contain 1 to 8 calls; this one has ${proposal.calls.length}.` });
    return base('BLOCK');
  }

  // 1. identity
  const latest = await client.getBlock();
  take(checkAgentActive(await readAgentStatus(client, d, label, agent, latest.timestamp)));

  // 2. rules from ENS (fail closed)
  let policy: Policy;
  try {
    policy = (await readPolicy(client, d, label)).policy;
  } catch (e) {
    failed.push({ check: 'rules', rule: 'Rules record', detail: e instanceof PolicyError ? `No valid rules: ${e.message}.` : `The rules could not be read: ${(e as Error).message}` });
    return base('BLOCK', { anonCalls: meter.wrapped.anonymized ? meter.count() : 0 });
  }

  // 3. simulation (fail closed on any error)
  let sim;
  try {
    sim = await simulateProposal(client, {
      deployment: d,
      agent,
      label,
      calls: proposal.calls,
      tokens: policy.tokens.map((a, i) => ({ address: a, kind: (policy.tokenKinds[i] ?? 0) as 0 | 1 | 2 })),
      spenders: [...policy.spenders, ...policy.targets],
      block: latest.number,
    });
  } catch (e) {
    failed.push({ check: 'simulation', detail: `The transaction could not be simulated, so it is blocked: ${(e as Error).message.split('\n')[0]}` });
    return base('BLOCK', { anonCalls: meter.wrapped.anonymized ? meter.count() : 0 });
  }

  // 4. every check
  const codeHashes = await readCodeHashes(client, proposal.calls.map((c) => c.to));
  const spentToday = await readSpentToday(client, d.module, label, policy.tokens.filter((_, i) => policy.tokenKinds[i] !== 2), latest.timestamp);
  take(checkSimulation(sim));
  take(checkModulePreview(sim));
  // If the module would revert there are no real effects; the cap rules then use the calls' intended outflows.
  const capEffects = sim.success ? sim.effects : intendedOutflows(proposal.calls, d.safeAddress);
  take(checkRules(policy, proposal.calls, capEffects, codeHashes, spentToday));
  // When the wallet's rules check already explains the module's revert (same rule), state the reason once and
  // keep the module preview as a short on-chain confirmation (the check itself still counts as failed).
  const preview = failed.find((f) => f.check === 'modulePreview');
  if (preview?.rule && failed.some((f) => f.check === 'rules' && f.rule === preview.rule))
    preview.detail = `BlindspotModule would also reject this on-chain (${sim.revert?.name ?? 'revert'}).`;
  // Claim vs reality and leftover approvals only apply when something would actually happen.
  const claim = sim.success ? checkClaimVsReality(proposal.declaredEffects, sim.effects) : { check: 'claimVsReality' as const, failures: [], undeclared: [] };
  if (sim.success) {
    take(claim);
    take(checkNoLeftoverApprovals(sim));
  }
  take(checkLookAlike(policy, proposal.calls, sim.success ? sim.effects : capEffects));
  take(await checkProxyUpgrade(client, storage, d.chainId, policy, proposal.calls, codeHashes));
  take(await checkRateLimit(storage, d.chainId, label, policy, Number(latest.timestamp)));
  take(await checkNewContract(client, policy, proposal.calls, codeHashes, latest.number));

  const extra: Partial<Decision> = {
    effects: sim.effects,
    undeclared: claim.undeclared,
    simulatedAtBlock: sim.baseBlock,
    ...(sim.revert ? { moduleRevert: sim.revert.name } : {}),
    anonCalls: meter.wrapped.anonymized ? meter.count() : 0,
  };
  const decimals = input.trace ? await readDecimals(client, [...sim.effects.map((e) => e.token), ...intendedOutflows(proposal.calls, d.safeAddress).map((e) => e.token)]) : {};
  if (failed.length) return attachOrigins(base('BLOCK', extra), input.trace, policy, proposal, d.safeAddress, decimals);

  // 5. ask owner: valid, but above the owner's approval threshold
  const askTokens = input.askOwnerTokens ?? [d.ens.MockUSDC];
  const askOut = sim.effects.filter((e) => e.kind === 'out' && e.token !== ETH && askTokens.some((t) => t.toLowerCase() === e.token.toLowerCase()));
  const askDecimals = askOut.length ? await readDecimals(client, askOut.map((e) => e.token)) : {};
  const usdOut = askOut.reduce((a, e) => a + toUsdUnits(e.amount, askDecimals[e.token.toLowerCase()] ?? 0), 0n);
  if (policy.askOwnerAbove > 0n && usdOut > policy.askOwnerAbove) {
    failed.push({
      check: 'askOwner',
      rule: 'Ask owner above threshold',
      detail: `This pays ${formatUnits(usdOut, ASK_OWNER_DECIMALS)} USD in stablecoins, above the owner's approval threshold of ${formatUnits(policy.askOwnerAbove, ASK_OWNER_DECIMALS)} USD. The owner must approve it.`,
    });
    return attachOrigins(base('ASK_OWNER', extra), input.trace, policy, proposal, d.safeAddress, decimals);
  }
  passed.push('askOwner');
  return base('ALLOW', extra);
}
