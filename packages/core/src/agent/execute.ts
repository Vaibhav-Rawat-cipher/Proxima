import type { Hex } from 'viem';
import type { Effect } from '@blindspot/shared';
import { evaluateProposal } from '../check/evaluate.js';
import { recordExecution } from '../check/checks.js';
import { moduleCalldata } from '../simulate/simulate.js';
import type { RunContext } from './context.js';

export type ExecuteResult =
  | { status: 'sent'; hash: Hex; receiptStatus: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint }
  | { status: 'refused'; reason: string }
  /** Simulate-only mode: every check ran and the owner approved, but nothing was signed or sent. */
  | { status: 'simulated'; effects: Effect[]; simulatedAtBlock: bigint };

const LOW_TIP = 1_000_000n; // 0.001 gwei (owner preference for Sepolia)

/**
 * execute(id): the ONLY path to a signature (hard rule 1).
 *  1. the proposal must come from this run and its decision must be ALLOW (not BLOCK / ASK_OWNER / unknown / used);
 *  2. it is re-evaluated immediately before signing and must still be ALLOW (no stale approvals);
 *  3. core builds the module calldata itself from the approved calls (the model never supplies bytes);
 *  4. the human approves the exact transaction (ctx.approve), then the signer (which itself refuses any
 *     non-module call) signs, and it is broadcast through the rpc adapter (Anon-RPC).
 */
export async function executeProposal(ctx: RunContext, id: string): Promise<ExecuteResult> {
  const refuse = (reason: string): ExecuteResult => {
    ctx.log.push({ at: Date.now(), kind: 'execute-refused', detail: { id, reason } });
    return { status: 'refused', reason };
  };
  const entry = ctx.proposals.get(id);
  if (!entry) return refuse(`No proposal "${id}" in this run.`);
  if (entry.executedTx) return refuse(`Proposal ${id} was already executed (${entry.executedTx}).`);
  if (entry.decision.verdict !== 'ALLOW') return refuse(`Proposal ${id} was not allowed (${entry.decision.verdict}); only ALLOWed proposals can be executed.`);
  if (!ctx.simulateOnly && !ctx.signer) return refuse('No signer is configured for this run.');
  if (!ctx.approve) return refuse('No approval step is configured: real transactions need explicit approval.');

  const fresh = await evaluateProposal({ rpc: ctx.rpc, deployment: ctx.deployment, storage: ctx.storage, label: ctx.label, agent: ctx.agent, proposal: entry.proposal, trace: ctx.trace });
  if (fresh.verdict !== 'ALLOW') return refuse(`Proposal ${id} is no longer allowed (${fresh.verdict}: ${fresh.failedChecks.map((f) => f.detail).join(' ')}).`);

  const to = ctx.deployment.module;
  const data = moduleCalldata(ctx.label, entry.proposal.calls);
  const from = ctx.signer?.address ?? ctx.agent;
  const [nonce, gasEstimate, block] = await Promise.all([
    ctx.client.getTransactionCount({ address: from, blockTag: 'pending' }),
    ctx.client.estimateGas({ account: from, to, data }),
    ctx.client.getBlock(),
  ]);
  const gas = (gasEstimate * 13n) / 10n;
  const maxPriorityFeePerGas = LOW_TIP;
  const maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas;

  const ok = await ctx.approve({ proposalId: id, decision: fresh, from, to, data, gas, maxFeePerGas, maxPriorityFeePerGas, nonce, ...(ctx.simulateOnly ? { simulated: true } : {}) });
  if (!ok) return refuse('The human did not approve the transaction.');
  if (ctx.simulateOnly) {
    // Never signs, never broadcasts: report what the transaction would do (fresh simulation above).
    ctx.log.push({ at: Date.now(), kind: 'simulated', detail: { id, block: fresh.simulatedAtBlock } });
    return { status: 'simulated', effects: fresh.effects, simulatedAtBlock: fresh.simulatedAtBlock };
  }
  if (!ctx.signer) return refuse('No signer is configured for this run.');

  const raw = await ctx.signer.signModuleCall({ to, data, chainId: ctx.deployment.chainId, nonce, gas, maxFeePerGas, maxPriorityFeePerGas });
  const hash = (await ctx.rpc.request({ method: 'eth_sendRawTransaction', params: [raw] })) as Hex;
  entry.executedTx = hash;
  const receipt = await ctx.client.waitForTransactionReceipt({ hash, pollingInterval: 2_000, timeout: 180_000 });
  await recordExecution(ctx.storage, ctx.deployment.chainId, ctx.label, Number((await ctx.client.getBlock({ blockNumber: receipt.blockNumber })).timestamp));
  ctx.log.push({ at: Date.now(), kind: 'executed', detail: { id, hash, status: receipt.status } });
  return { status: 'sent', hash, receiptStatus: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}
