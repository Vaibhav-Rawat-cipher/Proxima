// "Simulate only" (3d fallback, built first): the same execute path with every check and the owner's approval, but it
// never signs or sends. Runs on live Sepolia with NO agent key (the public site's fallback needs none).
import { getAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { withTransportRetry } from '../adapters/rpc.js';
import { staticSources } from '../adapters/static-sources.js';
import { clientFor } from '../chain.js';
import { deploymentFromConfig } from '../deployment.js';
import { MemoryStorage } from '../storage/memory.js';
import { config, directRpc, hasRpc } from '../test/live.js';
import { Trace } from '../trace/trace.js';
import type { ApprovalRequest, RunContext } from './context.js';
import { executeProposal } from './execute.js';
import { runTool } from './tools.js';

describe.skipIf(!hasRpc)('simulate-only mode on live Sepolia (no agent key, nothing sent)', { timeout: 180_000 }, () => {
  const rpc = withTransportRetry(directRpc());
  const client = clientFor(rpc);
  const d = deploymentFromConfig(config);
  const agent = getAddress(config.agents.demo.address) as Address;
  const usdc = getAddress(config.ens.MockUSDC);
  const vendor1 = getAddress(config.payees.vendor1);
  const ctxFor = (approvals: ApprovalRequest[], answer = true): RunContext => ({
    rpc,
    client,
    deployment: d,
    storage: new MemoryStorage(),
    label: 'demo',
    agent,
    trace: new Trace(`sim${Date.now()}`),
    readSource: staticSources({}),
    simulateOnly: true, // and no signer at all
    approve: async (req) => (approvals.push(req), answer),
    proposals: new Map(),
    log: [],
  });
  const propose = async (ctx: RunContext, to: Address, amount: string) =>
    JSON.parse(await runTool(ctx, 'propose', { actions: [{ type: 'transfer', token: usdc, to, amount }], declared_effects: [{ kind: 'out', token: usdc, amount, counterparty: to }], reason: 'test' })) as { proposal_id: string; verdict: string };

  it('an ALLOWed payment is approved as a simulation and reports its effects; nothing is signed or sent', async () => {
    const approvals: ApprovalRequest[] = [];
    const ctx = ctxFor(approvals);
    const nonceBefore = await client.getTransactionCount({ address: agent, blockTag: 'pending' });
    const p = await propose(ctx, vendor1, '12');
    expect(p.verdict).toBe('ALLOW');
    const out = JSON.parse(await runTool(ctx, 'execute', { proposal_id: p.proposal_id }));
    expect(out).toMatchObject({ status: 'simulated', effects: [{ kind: 'out', token: usdc, amount: '12000000', counterparty: vendor1 }] });
    expect(out.note).toMatch(/^SIMULATED/);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.simulated).toBe(true);
    expect(approvals[0]!.from).toBe(agent);
    expect(ctx.proposals.get(p.proposal_id)!.executedTx).toBeUndefined();
    expect(await client.getTransactionCount({ address: agent, blockTag: 'pending' })).toBe(nonceBefore);
  });

  it('a BLOCKed proposal is still refused (simulate-only never loosens a check)', async () => {
    const approvals: ApprovalRequest[] = [];
    const ctx = ctxFor(approvals);
    const p = await propose(ctx, '0x000000000000000000000000000000000000dEaD', '1');
    expect(p.verdict).toBe('BLOCK');
    expect(await executeProposal(ctx, p.proposal_id)).toMatchObject({ status: 'refused', reason: expect.stringMatching(/not allowed \(BLOCK\)/) });
    expect(approvals).toEqual([]);
  });

  it('the owner can decline the simulation too', async () => {
    const ctx = ctxFor([], false);
    const p = await propose(ctx, vendor1, '12');
    expect(await executeProposal(ctx, p.proposal_id)).toMatchObject({ status: 'refused', reason: expect.stringMatching(/did not approve/) });
  });

  it('without simulate-only and without a signer, execute refuses as before', async () => {
    const ctx = { ...ctxFor([]), simulateOnly: false };
    const p = await propose(ctx, vendor1, '12');
    expect(await executeProposal(ctx, p.proposal_id)).toMatchObject({ status: 'refused', reason: expect.stringMatching(/No signer/) });
  });
});
