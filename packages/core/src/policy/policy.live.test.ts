// 2.6 on live Sepolia (and the real model): the editor and the presets reproduce the DEPLOYED rules byte for
// byte, code hashes come from the chain (proxies stay unpinned), and a real gpt-oss-120b draft validates.
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePolicy } from '@blindspot/shared';
import { getAddress, keccak256, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAiCompatibleLlm } from '../adapters/llm-http.js';
import { withTransportRetry } from '../adapters/rpc.js';
import { clientFor } from '../chain.js';
import { readDecimals } from '../chain-reads.js';
import { deploymentFromConfig } from '../deployment.js';
import { readPolicy } from '../ens/reader.js';
import { config, directRpc, env, hasRpc } from '../test/live.js';
import { draftRulesFromText, type AddressBook } from './drafter.js';
import { PRESETS } from './presets.js';
import { describeRules, diffRules, fromPolicy, resolveCodeHashes, toPolicy } from './rules.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const USDC = getAddress(config.ens.MockUSDC) as Address;
const V1 = getAddress(config.payees.vendor1) as Address;
const V2 = getAddress(config.payees.vendor2) as Address;

describe.skipIf(!hasRpc)('2.6 rules editor on live Sepolia', { timeout: 120_000 }, () => {
  const client = clientFor(withTransportRetry(directRpc()));
  const d = deploymentFromConfig(config);

  it('the deployed demo rules come back through the editor unchanged (same bytes, same keccak as config)', async () => {
    const rec = await readPolicy(client, d, 'demo');
    expect(rec.keccak).toBe(config.agents.demo.policyKeccak);
    const decimals = await readDecimals(client, rec.policy.tokens.filter((t) => !/^0x0+$/.test(t)));
    const draft = fromPolicy(rec.policy, { decimals, labels: { [V1.toLowerCase()]: 'vendor1', [V2.toLowerCase()]: 'vendor2', [USDC.toLowerCase()]: 'MockUSDC' } });
    expect(encodePolicy(toPolicy(draft))).toBe(rec.raw);
    console.log(`[rules] demo.blindspot-demo.eth, as the owner sees it:\n  ${describeRules(draft).join('\n  ')}`);
  });

  it('the "Payments only" preset + code hashes read from the chain = the deployed record, byte for byte', async () => {
    const rec = await readPolicy(client, d, 'demo');
    const built = PRESETS.payments.build({
      payees: [{ address: V1, label: 'vendor1' }, { address: V2, label: 'vendor2' }],
      tokens: [{ address: USDC, label: 'MockUSDC', decimals: 6, maxPerTx: '25', perDay: '100' }],
      eth: { maxPerTx: '0.002', perDay: '0.005' },
      askOwnerAboveUsd: '20',
      rateLimitPerHour: 10,
      blockNewContracts: true,
    });
    const { draft, proxies } = await resolveCodeHashes(client, built);
    expect(proxies).toEqual([]); // MockUSDC is not an EIP-1967 proxy → pinned
    const bytes = encodePolicy(toPolicy(draft));
    expect(bytes).toBe(rec.raw);
    expect(keccak256(bytes)).toBe(config.agents.demo.policyKeccak);
  });

  it('code hashes: a proxy stays unpinned (wallet checks upgrades), a plain contract is pinned, an EOA is refused', async () => {
    const tb = config.testbed;
    const { draft, proxies } = await resolveCodeHashes(client, {
      ...PRESETS['read-only'].build({}),
      contracts: [
        { address: getAddress(tb.proxyV1), label: 'proxyV1', functions: ['deposit(uint256)'] },
        { address: getAddress(tb.depositV1Impl), label: 'depositV1Impl', functions: ['deposit(uint256)'] },
      ],
    });
    expect(proxies).toEqual([getAddress(tb.proxyV1)]);
    expect(draft.contracts[0]!.codeHash).toBeNull();
    const code = await client.getCode({ address: getAddress(tb.depositV1Impl) });
    expect(draft.contracts[1]!.codeHash).toBe(keccak256(code!));
    await expect(resolveCodeHashes(client, { ...PRESETS['read-only'].build({}), contracts: [{ address: V1, functions: ['deposit(uint256)'] }] })).rejects.toThrow(/has no contract code/);
  });
});

const canLlm = hasRpc && Boolean(env.LLM_API_KEY);
describe.skipIf(!canLlm)('2.6 plain-English drafter with the real model (gpt-oss-120b via the local proxy)', { timeout: 180_000 }, () => {
  let proxy: ChildProcess;
  beforeAll(async () => {
    proxy = spawn(process.execPath, [resolve(ROOT, 'checks/r3-llm/proxy.mjs')], { stdio: 'ignore' });
    for (let i = 0; i < 30; i++) {
      try {
        await fetch('http://127.0.0.1:8787/x', { method: 'POST' });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });
  afterAll(() => proxy?.kill());

  it('drafts the demo rules from a plain-English request; the result validates and matches the deployed rules', async () => {
    const client = clientFor(withTransportRetry(directRpc()));
    const rec = await readPolicy(client, deploymentFromConfig(config), 'demo');
    const book: AddressBook = {
      payees: [{ name: 'vendor1', address: V1 }, { name: 'vendor2', address: V2 }],
      tokens: [{ name: 'MockUSDC', address: USDC, decimals: 6 }],
      contracts: [{ name: 'SimplePool', address: getAddress(config.testbed.simplePool), functions: ['swap(address,uint256,uint256)'] }],
    };
    const text =
      'My agent pays my two suppliers, vendor1 and vendor2. Let it send them MockUSDC, at most 25 per payment and 100 per day, ' +
      'and small amounts of ETH: at most 0.002 ETH per payment and 0.005 per day. Ask me before anything above 20 dollars. ' +
      'At most 10 transactions an hour, and never touch brand-new contracts.';
    const llm = openAiCompatibleLlm({ url: 'http://127.0.0.1:8787/v1/chat/completions', model: 'openai/gpt-oss-120b', fetch: (u, i) => fetch(u, i) });
    const r = await draftRulesFromText(llm, text, book);
    const { draft } = await resolveCodeHashes(client, r.draft);
    console.log(`[drafter] attempts=${r.attempts} unsupported="${r.unsupported}"\n  ${describeRules(draft).join('\n  ')}`);
    const deployed = fromPolicy(rec.policy, { decimals: { [USDC.toLowerCase()]: 6 }, labels: { [V1.toLowerCase()]: 'vendor1', [V2.toLowerCase()]: 'vendor2', [USDC.toLowerCase()]: 'MockUSDC' } });
    console.log(`[drafter] difference from the deployed rules: ${diffRules(deployed, draft).join(' | ')}`);
    // The request states every rule of the deployed record, so the draft must mean exactly the same thing.
    expect(encodePolicy(toPolicy(draft))).toBe(rec.raw);
  });
});
