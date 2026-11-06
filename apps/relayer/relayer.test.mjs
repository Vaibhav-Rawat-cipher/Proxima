// Relayer rules (request shape, per-IP and global limits, kill switch, only provision()) and a LIVE dry run against
// the deployed TrialProvisioner on Sepolia (simulation only: nothing is sent, the throwaway key holds nothing).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeFunctionData, getAddress, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { PROVISIONER_ABI, createRateLimiter, createRelayer, parseRequest } from './relayer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(here, '../../.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
);
const cfg = JSON.parse(readFileSync(resolve(here, '../../config/sepolia.json'), 'utf8'));
const AGENT = '0x1111111111111111111111111111111111111111';

describe('request shape (strict)', () => {
  it('accepts exactly {"agent": address}', () => {
    expect(parseRequest(JSON.stringify({ agent: AGENT.toLowerCase() }))).toEqual({ agent: getAddress(AGENT) });
  });
  it.each([
    ['not JSON', 'agent=0x1'],
    ['extra field', JSON.stringify({ agent: AGENT, to: AGENT })],
    ['not an address', JSON.stringify({ agent: 'vitalik.eth' })],
    ['array', '[1]'],
    ['missing agent', '{}'],
  ])('rejects %s', (_, body) => expect(parseRequest(body).error).toBeTruthy());
});

describe('rate limits', () => {
  it('per IP per 24 h, then the next day again', () => {
    let t = 0;
    const l = createRateLimiter({ perIpPerDay: 2, globalPerMinute: 100, now: () => t });
    l.record('1.1.1.1');
    l.record('1.1.1.1');
    expect(l.check('1.1.1.1').ok).toBe(false);
    expect(l.check('2.2.2.2').ok).toBe(true);
    t += 86_400_001;
    expect(l.check('1.1.1.1').ok).toBe(true);
  });
  it('global per minute', () => {
    let t = 0;
    const l = createRateLimiter({ perIpPerDay: 100, globalPerMinute: 3, now: () => t });
    for (const ip of ['a', 'b', 'c']) l.record(ip);
    expect(l.check('d')).toMatchObject({ ok: false, reason: expect.stringMatching(/minute/) });
    t += 60_001;
    expect(l.check('d').ok).toBe(true);
  });
});

/** Records what the relayer would sign: the request MUST be provision(agent) on the provisioner and nothing else. */
function harness({ enabled = true, balance = 10n ** 18n, simulate } = {}) {
  const sent = [];
  const account = privateKeyToAccount(generatePrivateKey());
  const provisioner = getAddress(cfg.trials.provisioner);
  const publicClient = {
    getBalance: async () => balance,
    getBlock: async () => ({ baseFeePerGas: 15n }),
    simulateContract: simulate ?? (async (args) => ({ result: [7n, 'try7'], request: { ...args, account } })),
    waitForTransactionReceipt: async () => ({ status: 'success', logs: [] }),
  };
  const walletClient = { writeContract: async (req) => (sent.push(req), '0xabc') };
  const handle = createRelayer({ provisioner, publicClient, walletClient, account, enabled: () => enabled, limiter: createRateLimiter({ perIpPerDay: 1 }) });
  return { handle, sent, provisioner };
}

describe('relayer handler', () => {
  it('kill switch: refuses everything when off', async () => {
    const h = harness({ enabled: false });
    expect(await h.handle({ ip: 'x', body: JSON.stringify({ agent: AGENT }) })).toMatchObject({ status: 503 });
    expect(h.sent).toEqual([]);
  });
  it('out of gas funds: refuses before simulating', async () => {
    const h = harness({ balance: 1n });
    expect(await h.handle({ ip: 'x', body: JSON.stringify({ agent: AGENT }) })).toMatchObject({ status: 503, json: { error: expect.stringMatching(/out of gas funds/) } });
  });
  it('only ever signs provision(agent) on the provisioner, with a low tip', async () => {
    const h = harness();
    await h.handle({ ip: 'x', body: JSON.stringify({ agent: AGENT }) });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].address).toBe(h.provisioner);
    expect(h.sent[0].functionName).toBe('provision');
    expect(h.sent[0].args).toEqual([getAddress(AGENT)]);
    expect(h.sent[0].maxPriorityFeePerGas).toBe(1_000_000n);
  });
  it('a refused provision (on-chain limit) is reported plainly and nothing is sent', async () => {
    const { BaseError, ContractFunctionRevertedError } = await import('viem');
    const err = new ContractFunctionRevertedError({ abi: PROVISIONER_ABI, functionName: 'provision', data: '0x' });
    err.data = { errorName: 'RelayerQuotaReached', args: [1n] };
    const h = harness({ simulate: async () => Promise.reject(new BaseError('reverted', { cause: err })) });
    expect(await h.handle({ ip: 'x', body: JSON.stringify({ agent: AGENT }) })).toMatchObject({ status: 409, json: { code: 'RelayerQuotaReached', error: expect.stringMatching(/used up/) } });
    expect(h.sent).toEqual([]);
  });
});

describe.skipIf(!env.SEPOLIA_RPC_URL)('LIVE dry run against the deployed TrialProvisioner (nothing sent)', { timeout: 60_000 }, () => {
  it('simulates provision() for a fresh agent and returns the next tryN.trials.blindspot-demo.eth', async () => {
    const publicClient = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
    const account = privateKeyToAccount(generatePrivateKey()); // throwaway, unfunded: simulation only
    const handle = createRelayer({ provisioner: getAddress(cfg.trials.provisioner), publicClient, walletClient: null, account, enabled: () => true, limiter: createRateLimiter(), dryRun: true });
    const agent = privateKeyToAccount(generatePrivateKey()).address;
    const count = await publicClient.readContract({ address: cfg.trials.provisioner, abi: [{ type: 'function', name: 'trialCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], functionName: 'trialCount' });
    const r = await handle({ ip: 'test', body: JSON.stringify({ agent }) });
    console.log(`[relayer live dry run] ${JSON.stringify(r.json)}`);
    expect(r).toMatchObject({ status: 200, json: { dryRun: true, label: `try${count + 1n}`, name: `try${count + 1n}.trials.blindspot-demo.eth`, agent } });
  });
  it('the provisioner refuses a contract address as an agent (reported plainly)', async () => {
    const publicClient = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
    const handle = createRelayer({ provisioner: getAddress(cfg.trials.provisioner), publicClient, walletClient: null, account: privateKeyToAccount(generatePrivateKey()), enabled: () => true, limiter: createRateLimiter(), dryRun: true });
    const r = await handle({ ip: 'test2', body: JSON.stringify({ agent: cfg.ens.MockUSDC }) });
    expect(r).toMatchObject({ status: 409, json: { code: 'InvalidAgent' } });
  });
});

void decodeFunctionData;
