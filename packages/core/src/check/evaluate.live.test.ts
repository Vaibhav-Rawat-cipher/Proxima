// 2.3 checks -> decision, against LIVE Sepolia (real demo agent, real ENS rules, real module simulation).
// Nothing is sent: every proposal is only simulated.
import { encodeFunctionData, getAddress, parseAbi, type Address } from 'viem';
import { ETH, type Effect, type Proposal } from '@blindspot/shared';
import { describe, expect, it } from 'vitest';
import { clientFor } from '../chain.js';
import { deploymentFromConfig } from '../deployment.js';
import { readPolicy } from '../ens/reader.js';
import { MemoryStorage } from '../storage/memory.js';
import { config, directRpc, hasRpc } from '../test/live.js';
import {
  checkNewContract,
  checkProxyUpgrade,
  checkRules,
  looksLike,
  proxyBaselineKey,
  readCodeHashes,
  readImplementation,
  recordExecution,
  recordProxyBaseline,
} from './checks.js';
import { evaluateProposal } from './evaluate.js';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const transfer = (to: Address, amount: bigint) =>
  encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [to, amount] });

describe.skipIf(!hasRpc)('checks -> decision against live Sepolia', { timeout: 120_000 }, () => {
  const rpc = directRpc();
  const client = clientFor(rpc);
  const d = deploymentFromConfig(config);
  const agent = getAddress(config.agents.demo.address);
  const owner = getAddress(config.owner);
  const usdc = getAddress(config.ens.MockUSDC);
  const vendor1 = getAddress(config.payees.vendor1);
  const vendor2 = getAddress(config.payees.vendor2);
  let n = 0;

  const pay = (to: Address, amount: bigint) => ({ to: usdc, value: 0n, data: transfer(to, amount) });
  const out = (token: Address, amount: bigint, counterparty: Address): Omit<Effect, 'source'> => ({ kind: 'out', token, amount, counterparty });
  const propose = (calls: Proposal['calls'], declared: Proposal['declaredEffects']): Proposal => ({ id: `p${++n}`, origin: 'agent', calls, declaredEffects: declared, reason: 'test', inputsUsed: [] });
  const evaluate = (p: Proposal, opts: { storage?: MemoryStorage; agentKey?: Address; label?: string } = {}) =>
    evaluateProposal({ rpc, deployment: d, storage: opts.storage ?? new MemoryStorage(), label: opts.label ?? 'demo', agent: opts.agentKey ?? agent, proposal: p });
  const checksOf = (dec: Awaited<ReturnType<typeof evaluate>>) => dec.failedChecks.map((f) => f.check);

  // ------------------------------------------------------------------ ALLOW
  it('ALLOW: 5 MockUSDC to vendor1, declared correctly — every check passes', async () => {
    const dec = await evaluate(propose([pay(vendor1, USDC(5))], [out(usdc, USDC(5), vendor1)]));
    expect(dec.verdict).toBe('ALLOW');
    expect(dec.failedChecks).toEqual([]);
    expect(dec.passedChecks).toEqual(['agentActive', 'simulation', 'modulePreview', 'rules', 'claimVsReality', 'noLeftoverApprovals', 'lookAlike', 'proxyUpgrade', 'rateLimit', 'newContract', 'askOwner']);
    expect(dec.effects).toEqual([{ kind: 'out', token: usdc, amount: USDC(5), counterparty: vendor1, source: 'log' }]);
  });

  it('ALLOW: batch of two payments (5 + 5) declared correctly', async () => {
    const dec = await evaluate(propose([pay(vendor1, USDC(5)), pay(vendor2, USDC(5))], [out(usdc, USDC(5), vendor1), out(usdc, USDC(5), vendor2)]));
    expect(dec.verdict).toBe('ALLOW');
  });

  it('ALLOW: 0.001 ETH to vendor1 (plain ETH payment)', async () => {
    const dec = await evaluate(propose([{ to: vendor1, value: 10n ** 15n, data: '0x' }], [out(ETH, 10n ** 15n, vendor1)]));
    expect(dec.verdict).toBe('ALLOW');
  });

  it('ALLOW: declared amount within 1% of reality (4.99 declared, 5 actual)', async () => {
    const dec = await evaluate(propose([pay(vendor1, USDC(5))], [out(usdc, USDC(4.99), vendor1)]));
    expect(dec.verdict).toBe('ALLOW');
  });

  // ------------------------------------------------------------------ ASK_OWNER
  it('ASK_OWNER: 21 MockUSDC is within the on-chain caps but above the owner threshold (20)', async () => {
    const dec = await evaluate(propose([pay(vendor1, USDC(21))], [out(usdc, USDC(21), vendor1)]));
    expect(dec.verdict).toBe('ASK_OWNER');
    expect(dec.failedChecks).toEqual([expect.objectContaining({ check: 'askOwner', rule: 'Ask owner above threshold' })]);
    expect(dec.passedChecks).toContain('modulePreview'); // the module itself would allow it
  });

  // ------------------------------------------------------------------ BLOCK: rules (+ the module agrees)
  it('BLOCK: unlisted recipient — rules and module preview both fail', async () => {
    const attacker: Address = '0x000000000000000000000000000000000000dEaD';
    const dec = await evaluate(propose([pay(attacker, USDC(1))], [out(usdc, USDC(1), attacker)]));
    expect(dec.verdict).toBe('BLOCK');
    expect(dec.moduleRevert).toBe('RecipientNotAllowed');
    expect(dec.failedChecks).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'rules', rule: 'Allowed recipients' }), expect.objectContaining({ check: 'modulePreview' })]));
  });

  it('BLOCK: 26 MockUSDC — over the per-transaction cap (25)', async () => {
    const dec = await evaluate(propose([pay(vendor1, USDC(26))], [out(usdc, USDC(26), vendor1)]));
    expect(dec.verdict).toBe('BLOCK');
    expect(dec.moduleRevert).toBe('OutflowExceeded');
    expect(dec.failedChecks).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'rules', rule: 'Per-transaction cap' })]));
  });

  it('BLOCK: batch total 15 + 15 = 30 exceeds the per-transaction cap', async () => {
    const dec = await evaluate(propose([pay(vendor1, USDC(15)), pay(vendor2, USDC(15))], [out(usdc, USDC(15), vendor1), out(usdc, USDC(15), vendor2)]));
    expect(dec.verdict).toBe('BLOCK');
    expect(dec.failedChecks.some((f) => f.rule === 'Per-transaction cap')).toBe(true);
  });

  it('BLOCK: 0.003 ETH exceeds the max ETH per transaction (0.002)', async () => {
    const dec = await evaluate(propose([{ to: vendor1, value: 3n * 10n ** 15n, data: '0x' }], [out(ETH, 3n * 10n ** 15n, vendor1)]));
    expect(dec.verdict).toBe('BLOCK');
    expect(dec.failedChecks.some((f) => f.rule === 'Maximum ETH per transaction')).toBe(true);
  });

  it('daily cap: with 40 already spent today, 25 more breaks the daily cap (50) — real policy', async () => {
    const { policy } = await readPolicy(client, d, 'demo');
    const effects: Effect[] = [{ kind: 'out', token: usdc, amount: USDC(25), counterparty: vendor1, source: 'log' }];
    const r = checkRules(policy, [pay(vendor1, USDC(25))], effects, await readCodeHashes(client, [usdc]), { [usdc.toLowerCase()]: USDC(40) });
    expect(r.failures).toEqual([expect.objectContaining({ rule: 'Daily cap' })]);
    const r2 = checkRules(policy, [pay(vendor1, USDC(25))], effects, await readCodeHashes(client, [usdc]), { [usdc.toLowerCase()]: USDC(25) });
    expect(r2.failures).toEqual([]);
  });

  // ------------------------------------------------------------------ BLOCK: claim vs reality
  it('BLOCK: declared amount off by more than 1% (4.9 declared, 5 actual)', async () => {
    const dec = await evaluate(propose([pay(vendor1, USDC(5))], [out(usdc, USDC(4.9), vendor1)]));
    expect(dec.verdict).toBe('BLOCK');
    expect(dec.failedChecks).toEqual([expect.objectContaining({ check: 'claimVsReality' })]);
    expect(dec.failedChecks[0]!.detail).toMatch(/off by more than 1%/);
  });

  it('BLOCK: undeclared effect (pays vendor1 but declares vendor2)', async () => {
    const dec = await evaluate(propose([pay(vendor1, USDC(5))], [out(usdc, USDC(5), vendor2)]));
    expect(dec.verdict).toBe('BLOCK');
    expect(dec.undeclared).toEqual([{ kind: 'out', token: usdc, amount: USDC(5), counterparty: vendor1, source: 'log' }]);
    expect(dec.failedChecks.map((f) => f.detail).join(' ')).toMatch(/Undeclared effect.*did not declare/);
  });

  // ------------------------------------------------------------------ BLOCK: look-alike
  it('BLOCK: a look-alike of vendor1 (same first 3 and last 3 hex characters)', async () => {
    const fake = getAddress(`0x${vendor1.slice(2, 5)}${'0'.repeat(34)}${vendor1.slice(-3)}`);
    expect(looksLike(fake, vendor1)).toBe(true);
    const dec = await evaluate(propose([pay(fake, USDC(5))], [out(usdc, USDC(5), fake)]));
    expect(dec.verdict).toBe('BLOCK');
    expect(checksOf(dec)).toEqual(expect.arrayContaining(['lookAlike', 'rules', 'modulePreview']));
    expect(dec.failedChecks.find((f) => f.check === 'lookAlike')!.detail).toMatch(new RegExp(`looks like the known address ${vendor1}`, 'i'));
  });

  // ------------------------------------------------------------------ BLOCK: identity, rules record
  it('BLOCK: a key that is not the agent (agent identity)', async () => {
    const dec = await evaluate(propose([pay(vendor1, USDC(1))], [out(usdc, USDC(1), vendor1)]), { agentKey: owner });
    expect(dec.verdict).toBe('BLOCK');
    expect(checksOf(dec)).toContain('agentActive');
    expect(dec.moduleRevert).toBe('AgentNotActive');
  });

  it('BLOCK (fail closed): a name without a rules record', async () => {
    const dec = await evaluate(propose([pay(vendor1, USDC(1))], [out(usdc, USDC(1), vendor1)]), { label: 'vendor1' });
    expect(dec.verdict).toBe('BLOCK');
    expect(dec.failedChecks).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'rules', rule: 'Rules record' })]));
  });

  it('BLOCK: empty proposal', async () => {
    expect((await evaluate(propose([], []))).verdict).toBe('BLOCK');
  });

  // ------------------------------------------------------------------ wallet-only rules
  it('BLOCK: rate limit (10 executions already in the last hour)', async () => {
    const storage = new MemoryStorage();
    const now = Number((await client.getBlock()).timestamp);
    for (let i = 0; i < 10; i++) await recordExecution(storage, d.chainId, 'demo', now - 60 * i);
    const dec = await evaluate(propose([pay(vendor1, USDC(1))], [out(usdc, USDC(1), vendor1)]), { storage });
    expect(dec.verdict).toBe('BLOCK');
    expect(dec.failedChecks).toEqual([expect.objectContaining({ check: 'rateLimit' })]);
  });

  it('new contracts: the Safe (deployed in Step 1) is new; MockUSDC is not', async () => {
    const { policy } = await readPolicy(client, d, 'demo');
    const latest = await client.getBlockNumber();
    const calls = [{ to: d.safeAddress, value: 0n, data: '0x' as const }, pay(vendor1, 1n)];
    const r = await checkNewContract(client, { ...policy, blockNewContracts: true }, calls, await readCodeHashes(client, [d.safeAddress, usdc]), latest);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.detail).toMatch(/new contract/);
    const off = await checkNewContract(client, { ...policy, blockNewContracts: false }, calls, {}, latest);
    expect(off.failures).toEqual([]);
  });

  it('proxy upgrade: real EIP-1967 slot of the live UserRegistry proxy; no baseline / baseline / changed', async () => {
    const proxy = getAddress(config.agentRegistry);
    const impl = await readImplementation(client, proxy);
    expect(impl).not.toBeNull();
    const { policy } = await readPolicy(client, d, 'demo');
    const p = { ...policy, targets: [proxy], codeHashes: [`0x${'00'.repeat(32)}` as const], selectors: [['0x12345678' as const]] };
    const calls = [{ to: proxy, value: 0n, data: '0x12345678' as const }];
    const hashes = await readCodeHashes(client, [proxy]);
    const storage = new MemoryStorage();

    const none = await checkProxyUpgrade(client, storage, d.chainId, p, calls, hashes);
    expect(none.failures[0]?.detail).toMatch(/No baseline is recorded/);

    await recordProxyBaseline(client, storage, d.chainId, proxy);
    expect((await checkProxyUpgrade(client, storage, d.chainId, p, calls, hashes)).failures).toEqual([]);

    await storage.set(proxyBaselineKey(d.chainId, proxy), '0x1111111111111111111111111111111111111111'); // allowlisted under a different implementation
    const changed = await checkProxyUpgrade(client, storage, d.chainId, p, calls, hashes);
    expect(changed.failures[0]?.detail).toMatch(/was upgraded since the owner allowed it/);
  });
});
