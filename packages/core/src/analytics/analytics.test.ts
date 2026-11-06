import type { Decision } from '@blindspot/shared';
import { getAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { RpcAdapter } from '../adapters/types.js';
import { withTransportRetry } from '../adapters/rpc.js';
import { staticSources } from '../adapters/static-sources.js';
import { clientFor } from '../chain.js';
import { deploymentFromConfig } from '../deployment.js';
import { MemoryStorage } from '../storage/memory.js';
import { config, directRpc, hasRpc } from '../test/live.js';
import { Trace } from '../trace/trace.js';
import type { RunContext } from '../agent/context.js';
import { runAgent } from '../agent/loop.js';
import { scriptedLlm } from '../agent/scripted.js';
import { Analytics, ANALYTICS_KEY, meteredRpc } from './analytics.js';

/** A local adapter that answers every request with "0x1" (counting tests only; no network). */
const echo = (name: string, anonymized: boolean): RpcAdapter => ({ name, anonymized, request: async () => '0x1' });
const decision = (verdict: Decision['verdict'], failed: Decision['failedChecks'] = [], origin?: Decision['origin']): Decision => ({
  proposalId: 'p',
  verdict,
  failedChecks: failed,
  passedChecks: [],
  effects: [],
  undeclared: [],
  simulatedAtBlock: 0n,
  anonCalls: 0,
  ...(origin ? { origin, origins: [origin] } : {}),
});

describe('2.7 local analytics', () => {
  it('counts anonymized vs excluded RPC traffic, per method, with declared reasons', async () => {
    const a = await Analytics.load(new MemoryStorage());
    const nox = meteredRpc(echo('nox', true), a);
    const boot = meteredRpc(echo('bootstrap', false), a, 'bootstrap: Nox specifier read');
    await nox.request({ method: 'eth_call' });
    await nox.request({ method: 'eth_call' });
    await nox.request({ method: 'eth_sendRawTransaction' });
    await boot.request({ method: 'eth_call' });
    const s = a.summary();
    expect([s.rpc.anonymized, s.rpc.excluded, s.totalRequests, s.anonShare]).toEqual([3, 1, 4, 75]);
    expect(s.rpc.byMethod).toEqual({ eth_call: { anonymized: 2, excluded: 1 }, eth_sendRawTransaction: { anonymized: 1, excluded: 0 } });
    expect(s.rpc.excludedReasons).toEqual({ 'bootstrap: Nox specifier read': 1 });
    expect(s.rpc.byAdapter).toEqual({ nox: 3, bootstrap: 1 });
  });

  it('excluded traffic is never silent: an un-anonymized adapter needs a declared reason', async () => {
    const a = await Analytics.load(new MemoryStorage());
    expect(() => meteredRpc(echo('direct', false), a)).toThrow(/declare why its traffic is excluded/);
    expect(() => a.recordRpc({ name: 'direct', anonymized: false }, 'eth_call')).toThrow(/declared reason/);
    expect(a.summary().anonShare).toBeNull(); // no traffic yet: no made-up percentage
  });

  it('counts decisions, failed checks, broken rules, origins and transactions', async () => {
    const a = await Analytics.load(new MemoryStorage());
    const origin = { value: '5', eventId: 'r:1', source: 'document' as const, excerpt: 'x', tool: 'read_document', line: 6, why: 'y' };
    a.recordDecision(decision('ALLOW'));
    a.recordDecision(decision('BLOCK', [{ check: 'rules', rule: 'Allowed recipients', detail: 'a' }, { check: 'rules', rule: 'Allowed recipients', detail: 'b' }, { check: 'lookAlike', rule: 'Look-alike block', detail: 'c' }], origin));
    a.recordDecision(decision('ASK_OWNER', [{ check: 'askOwner', rule: 'Ask owner above threshold', detail: 'd' }], origin));
    a.recordTx({ status: 'sent', receiptStatus: 'success' });
    a.recordTx({ status: 'sent', receiptStatus: 'reverted' });
    a.recordTx({ status: 'refused' });
    const s = a.summary();
    expect(s.decisions).toEqual({ ALLOW: 1, BLOCK: 1, ASK_OWNER: 1 });
    expect(s.failedChecks).toEqual({ rules: 1, lookAlike: 1, askOwner: 1 }); // once per decision
    expect(s.rulesBroken).toEqual({ 'Allowed recipients': 1, 'Look-alike block': 1, 'Ask owner above threshold': 1 });
    expect(s.origins).toEqual({ document: 2 });
    expect(s.txs).toEqual({ sent: 2, success: 1, reverted: 1, refused: 1 });
  });

  it('persists in the shell storage, never loses concurrent records, and resets', async () => {
    const storage = new MemoryStorage();
    const a = await Analytics.load(storage);
    const nox = meteredRpc(echo('nox', true), a);
    await Promise.all(Array.from({ length: 50 }, () => nox.request({ method: 'eth_call' })));
    await a.flush();
    const b = await Analytics.load(storage);
    expect(b.summary().rpc.anonymized).toBe(50);
    await b.reset();
    expect((await Analytics.load(storage)).summary().totalRequests).toBe(0);
    await storage.set(ANALYTICS_KEY, { garbage: true });
    expect((await Analytics.load(storage)).summary().totalRequests).toBe(0); // corrupt record: start fresh
  });

  it('the JSON export holds counts only: no addresses, hashes, URLs or free text from requests', async () => {
    const a = await Analytics.load(new MemoryStorage(), () => Date.UTC(2026, 10, 6));
    const nox = meteredRpc(echo('nox', true), a);
    await nox.request({ method: 'eth_call', params: [{ to: '0x22dbbC1A9341064b3CA3e7c016D5cc22383dDe41', data: '0xa9059cbb' }] });
    await nox.request({ method: 'https://evil.example/0x22dbbC1A9341064b3CA3e7c016D5cc22383dDe41' }); // junk method: not stored verbatim
    a.recordDecision(decision('BLOCK', [{ check: 'rules', rule: 'Allowed recipients', detail: '0x22dbbC1A9341064b3CA3e7c016D5cc22383dDe41 is not approved' }]));
    const json = a.exportJson();
    expect(json).not.toMatch(/0x[0-9a-fA-F]{8,}/);
    expect(json).not.toMatch(/https?:/);
    expect(json).not.toMatch(/is not approved/);
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({ blindspotAnalytics: 1, exportedAt: '2026-11-06T00:00:00.000Z', totalRequests: 2 });
    expect(Object.keys(parsed.rpc.byMethod).sort()).toEqual(['eth_call', 'other']);
  });
});

describe.skipIf(!hasRpc)('2.7 analytics on a live agent run (scripted agent, live Sepolia, nothing sent)', { timeout: 180_000 }, () => {
  it('every request of the run is metered and the decision is recorded', async () => {
    const a = await Analytics.load(new MemoryStorage());
    // Test traffic goes direct, so it is metered as EXCLUDED with a declared reason (the product meters Nox as anonymized).
    const rpc = meteredRpc(withTransportRetry(directRpc()), a, 'test: direct RPC (not product traffic)');
    let seen = 0;
    const counting: typeof rpc = { name: rpc.name, anonymized: rpc.anonymized, request: (x) => (seen++, rpc.request(x)) };
    const usdc = getAddress(config.ens.MockUSDC) as Address;
    const vendor1 = getAddress(config.payees.vendor1) as Address;
    const ctx: RunContext = {
      rpc: counting,
      client: clientFor(counting),
      deployment: deploymentFromConfig(config),
      storage: new MemoryStorage(),
      label: 'demo',
      agent: getAddress(config.agents.demo.address),
      trace: new Trace(`an${Date.now()}`),
      readSource: staticSources({ 'invoice-0103': { kind: 'document', content: 'INVOICE #0103 - vendor1\nAmount due: 22 MockUSDC' } }),
      proposals: new Map(),
      log: [],
      analytics: a,
    };
    await runAgent(
      ctx,
      scriptedLlm([
        { tool: 'read_document', args: { url: 'invoice-0103' } },
        { tool: 'propose', args: { actions: [{ type: 'transfer', token: usdc, to: vendor1, amount: '22' }], declared_effects: [{ kind: 'out', token: usdc, amount: '22', counterparty: vendor1 }], reason: 'pay invoice-0103' } },
        { tool: 'execute', args: { proposal_id: '$lastProposalId' } },
      ]),
      'Pay invoice-0103.',
    );
    await a.flush();
    const s = a.summary();
    console.log(`[analytics] ${JSON.stringify({ requests: s.totalRequests, byMethod: s.rpc.byMethod, decisions: s.decisions, rulesBroken: s.rulesBroken, origins: s.origins, txs: s.txs })}`);
    expect(s.totalRequests).toBe(seen);
    expect(s.rpc.excluded).toBe(seen);
    expect(s.rpc.excludedReasons).toEqual({ 'test: direct RPC (not product traffic)': seen });
    // The verdict depends on the live daily budget (22 MockUSDC = ASK_OWNER while the day has room, BLOCK by the daily
    // cap once real payments used it): the analytics must match whatever the wallet decided.
    const d = [...ctx.proposals.values()][0]!.decision;
    expect(['ASK_OWNER', 'BLOCK']).toContain(d.verdict);
    expect(s.decisions).toEqual({ ALLOW: 0, BLOCK: d.verdict === 'BLOCK' ? 1 : 0, ASK_OWNER: d.verdict === 'ASK_OWNER' ? 1 : 0 });
    expect(s.rulesBroken).toEqual(Object.fromEntries([...new Set(d.failedChecks.map((f) => f.rule).filter(Boolean))].map((r) => [r, 1])));
    expect(s.origins).toEqual({ document: 1 });
    expect(s.txs).toEqual({ sent: 0, success: 0, reverted: 0, refused: 1 }); // execute refused: not ALLOWed
  });
});
