import { decodePolicy, encodePolicy, PolicyError, type Policy } from '@blindspot/shared';
import { SAMPLE_POLICY } from '../../../shared/src/policy.fixture.js';
import { parseEther, zeroAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { toUsdUnits } from '../check/evaluate.js';
import { PRESETS, type PresetInput } from './presets.js';
import { describeRules, diffRules, fromPolicy, parseAmount, RulesError, samePolicyMeaning, selectorFor, toPolicy, type RulesDraft } from './rules.js';

const USDC: Address = '0x240b0316Df57887DBBE58b586508b19e633a14aa';
const DAI: Address = '0xF6FAC8a58a0BE13B9197F27c41b73162fe32572b';
const V1: Address = '0x22dbbC1A9341064b3CA3e7c016D5cc22383dDe41';
const V2: Address = '0xc7F3D37B90d2Ef6dBFD419B71354F74132c619B4';
const ROUTER: Address = '0xdf51eA243baBa7F71401aDFf84078d939F7bF21F';
const H: Hex = `0x${'ab'.repeat(32)}`;
const ZERO32: Hex = `0x${'0'.repeat(64)}`;
const INFO = { decimals: { [USDC.toLowerCase()]: 6, [DAI.toLowerCase()]: 18 }, labels: { [V1.toLowerCase()]: 'vendor1', [V2.toLowerCase()]: 'vendor2', [USDC.toLowerCase()]: 'MockUSDC' } };

const paymentsInput: PresetInput = {
  payees: [{ address: V1, label: 'vendor1' }, { address: V2, label: 'vendor2' }],
  tokens: [{ address: USDC, label: 'MockUSDC', decimals: 6, maxPerTx: '25', perDay: '50' }],
  eth: { maxPerTx: '0.002', perDay: '0.005' },
};
/** Fill unresolved code hashes the way resolveCodeHashes would for non-proxy targets (offline). */
const pinAll = (d: RulesDraft, hash: Hex = H): RulesDraft => ({
  ...d,
  tokens: d.tokens.map((t) => ({ ...t, codeHash: t.codeHash === undefined ? hash : t.codeHash })),
  contracts: d.contracts.map((c) => ({ ...c, codeHash: c.codeHash === undefined ? hash : c.codeHash })),
});

describe('2.6 presets → exact Policy', () => {
  it('"Payments only" reproduces the deployed demo rules layout field for field (scripts/setup/src/plan.ts)', () => {
    const p = toPolicy(pinAll(PRESETS.payments.build({ ...paymentsInput, askOwnerAboveUsd: '20', rateLimitPerHour: 10, blockNewContracts: true })));
    const expected: Policy = {
      version: 1,
      targets: [USDC, V1, V2],
      codeHashes: [H, ZERO32, ZERO32],
      selectors: [['0xa9059cbb'], ['0x00000000'], ['0x00000000']],
      payees: [V1, V2],
      spenders: [],
      operators: [],
      tokens: [USDC, zeroAddress],
      tokenKinds: [0, 0],
      maxOut: [25_000_000n, parseEther('0.002')],
      dailyCap: [50_000_000n, parseEther('0.005')],
      maxEth: parseEther('0.002'),
      rateLimitPerHour: 10,
      askOwnerAbove: 20_000_000n,
      blockNewContracts: true,
    };
    expect(p).toEqual(expected);
    expect(encodePolicy(p)).toBe(encodePolicy(expected));
  });

  it('every preset encodes, decodes and comes back through the editor unchanged (byte for byte)', () => {
    const inputs: Record<string, PresetInput> = {
      payments: paymentsInput,
      trading: { contract: { address: ROUTER, label: 'SimplePool', functions: ['swap(address,uint256,uint256)'] }, tokens: [{ address: USDC, decimals: 6, maxPerTx: '10', perDay: '30' }, { address: DAI, decimals: 18, maxPerTx: '10', perDay: '30' }] },
      'defi-deposits': { contract: { address: ROUTER, label: 'Vault', functions: ['deposit(uint256)', 'withdraw(uint256)'] }, tokens: [{ address: USDC, decimals: 6, maxPerTx: '100', perDay: '200' }] },
      'read-only': {},
    };
    for (const [id, input] of Object.entries(inputs)) {
      const draft = pinAll(PRESETS[id as keyof typeof PRESETS].build(input));
      const bytes = encodePolicy(toPolicy(draft));
      const back = fromPolicy(decodePolicy(bytes), INFO);
      expect(encodePolicy(toPolicy(back)), id).toBe(bytes);
      expect(diffRules(draft, back), id).toEqual(['No changes.']);
    }
  });

  it('trading / deposits approve only the router or vault, and the token must be capped (codec rule)', () => {
    const p = toPolicy(pinAll(PRESETS.trading.build({ contract: { address: ROUTER, functions: ['swap(address,uint256,uint256)'] }, tokens: [{ address: USDC, decimals: 6, maxPerTx: '10', perDay: '30' }] })));
    expect(p.spenders).toEqual([ROUTER]);
    expect(p.selectors[0]).toEqual(['0x095ea7b3']);
    expect(p.tokens).toEqual([USDC]);
    expect(p.maxEth).toBe(0n);
    expect(() => PRESETS.trading.build({ tokens: [] })).toThrow(/needs the router/);
  });

  it('editing a preset draft never changes the caller\'s input', () => {
    const input = structuredClone(paymentsInput);
    const d = PRESETS.payments.build(input);
    d.payees.push({ address: ROUTER });
    d.payees[0]!.label = 'changed';
    d.tokens[0]!.maxPerTx = '1';
    d.eth!.perDay = '9';
    expect(input).toEqual(paymentsInput);
  });

  it('"Read-only" allows nothing and says so', () => {
    const d = PRESETS['read-only'].build({});
    const p = toPolicy(d);
    expect([p.targets, p.payees, p.tokens, p.spenders]).toEqual([[], [], [], []]);
    expect(p.maxEth).toBe(0n);
    expect(describeRules(d)[0]).toMatch(/^Read-only/);
  });
});

describe('2.6 rule editor validation (fail closed)', () => {
  const ok = () => pinAll(PRESETS.payments.build(paymentsInput));
  it.each([
    ['too many decimals', (d: RulesDraft) => (d.tokens[0]!.maxPerTx = '1.0000001'), /more than 6 decimals/],
    ['not a plain amount', (d: RulesDraft) => (d.tokens[0]!.perDay = '5e1'), /not a plain amount/],
    ['negative amount', (d: RulesDraft) => (d.askOwnerAboveUsd = '-1'), /not a plain amount/],
    ['duplicate payee', (d: RulesDraft) => d.payees.push({ address: V1 }), /listed twice/],
    ['ETH as a token', (d: RulesDraft) => d.tokens.push({ address: zeroAddress, kind: 'erc20', decimals: 18, maxPerTx: '1', perDay: '1', functions: [] }), /use the "eth" setting/],
    ['ETH to payees without limits', (d: RulesDraft) => (d.eth = null), /no ETH limits/],
    ['unresolved code hash', (d: RulesDraft) => delete d.tokens[0]!.codeHash, /not resolved yet/],
    ['bad signature', (d: RulesDraft) => (d.tokens[0]!.functions = ['transfer address']), /not a function signature/],
    ['contract with no functions', (d: RulesDraft) => d.contracts.push({ address: ROUTER, functions: [], codeHash: H }), /at least one allowed function/],
    ['bad address', (d: RulesDraft) => (d.payees[0]!.address = '0x1234' as Address), /not an address/],
  ])('%s', (_, mutate, msg) => {
    const d = ok();
    mutate(d);
    expect(() => toPolicy(d)).toThrow(msg);
  });
  it('codec rules still apply: per-transaction cap above the daily cap', () => {
    const d = ok();
    d.tokens[0]!.maxPerTx = '60';
    expect(() => toPolicy(d)).toThrow(PolicyError);
  });
  it('codec rules still apply: a contract allowed to call transfer must be a capped token', () => {
    const d = ok();
    d.contracts.push({ address: ROUTER, functions: ['transfer(address,uint256)'], codeHash: H });
    expect(() => toPolicy(d)).toThrow(/not listed in tokens/);
  });
});

describe('2.6 fromPolicy / samePolicyMeaning', () => {
  it('shows the shared sample policy (interleaved targets, NFT, operator) with the same meaning', () => {
    const info = { decimals: { '0x1111111111111111111111111111111111111111': 6 } };
    const d = fromPolicy(SAMPLE_POLICY, info);
    expect(samePolicyMeaning(toPolicy(d), SAMPLE_POLICY)).toBe(true);
    expect(d.contracts.map((c) => c.functions)).toEqual([['0x12345678']]);
    expect(d.tokens.find((t) => t.kind === 'erc721')?.functions).toEqual(['setApprovalForAll(address,bool)']);
  });
  it('detects any difference in meaning', () => {
    const b: Policy = { ...SAMPLE_POLICY, payees: [...SAMPLE_POLICY.payees].reverse(), targets: [...SAMPLE_POLICY.targets] };
    expect(samePolicyMeaning(SAMPLE_POLICY, b)).toBe(true); // order only
    expect(samePolicyMeaning(SAMPLE_POLICY, { ...SAMPLE_POLICY, maxOut: [100_000_001n, 10n ** 16n, 1n] })).toBe(false);
    expect(samePolicyMeaning(SAMPLE_POLICY, { ...SAMPLE_POLICY, selectors: [['0xa9059cbb'], ['0x12345678'], ['0xa22cb465']] })).toBe(false);
    expect(samePolicyMeaning(SAMPLE_POLICY, { ...SAMPLE_POLICY, blockNewContracts: false })).toBe(false);
  });
  it('refuses rules it cannot show faithfully (ETH per-call limit ≠ ETH outflow cap)', () => {
    expect(() => fromPolicy({ ...SAMPLE_POLICY, maxEth: 1n }, { decimals: { '0x1111111111111111111111111111111111111111': 6 } })).toThrow(RulesError);
  });
  it('refuses rules that would silently widen in the editor (plain ETH allowed to only ONE of two recipients)', () => {
    const p = toPolicy(pinAll(PRESETS.payments.build(paymentsInput)));
    const onlyV1: Policy = { ...p, targets: p.targets.slice(0, 2), codeHashes: p.codeHashes.slice(0, 2), selectors: p.selectors.slice(0, 2) };
    expect(() => fromPolicy(onlyV1, INFO)).toThrow(/cannot show faithfully/);
  });
  it('needs token decimals to show caps', () => {
    expect(() => fromPolicy(SAMPLE_POLICY, { decimals: {} })).toThrow(/decimals of token/);
  });
});

describe('2.6 owner review text', () => {
  it('describes the payments rules in plain language with full addresses', () => {
    const lines = describeRules(pinAll(PRESETS.payments.build(paymentsInput)));
    expect(lines).toContain(`Approved recipients: vendor1 (${V1}), vendor2 (${V2}).`);
    expect(lines).toContain('ETH: at most 0.002 per transaction and 0.005 per day; plain ETH payments to approved recipients are allowed.');
    expect(lines).toContain(`Token MockUSDC (${USDC}) [erc20]: at most 25 per transaction and 50 per day; may call transfer(address,uint256) (code pinned).`);
    expect(lines).toContain('Ask the owner before paying more than 20 USD in stablecoins.');
  });
  it('lists every change between two rule sets', () => {
    const a = pinAll(PRESETS.payments.build(paymentsInput));
    const b = structuredClone(a);
    b.payees.push({ address: ROUTER, label: 'new shop' });
    b.tokens[0]!.perDay = '40';
    b.askOwnerAboveUsd = '10';
    b.eth = null;
    b.allowEthToPayees = false;
    expect(diffRules(a, b)).toEqual([
      `+ approved recipient: new shop (${ROUTER})`,
      `~ MockUSDC (${USDC}) caps: 25/tx, 50/day → 25/tx, 40/day`,
      '~ ETH: 0.002/tx, 0.005/day → not allowed',
      '~ plain ETH to approved recipients: allowed → not allowed',
      '~ ask the owner above: 20 USD → 10 USD',
    ]);
  });
});

describe('helpers', () => {
  it('selectorFor', () => {
    expect(selectorFor('transfer(address,uint256)')).toBe('0xa9059cbb');
    expect(selectorFor('0xA9059CBB')).toBe('0xa9059cbb');
    expect(() => selectorFor('transfer')).toThrow(RulesError);
  });
  it('parseAmount', () => {
    expect(parseAmount('12.5', 6, 'x')).toBe(12_500_000n);
    expect(() => parseAmount('.5', 6, 'x')).toThrow(RulesError);
  });
  it('toUsdUnits converts stablecoin amounts to the 6-decimal threshold unit, rounding up', () => {
    expect(toUsdUnits(22_000_000n, 6)).toBe(22_000_000n);
    expect(toUsdUnits(22n * 10n ** 18n, 18)).toBe(22_000_000n);
    expect(toUsdUnits(20n * 10n ** 18n + 1n, 18)).toBe(20_000_001n); // a hair above 20 still asks
    expect(toUsdUnits(2200n, 2)).toBe(22_000_000n);
  });
});
