// Offline tests of the drafter's VALIDATION: the model's answers are given as fixed strings (what a model could
// return), so we can prove every bad answer is rejected. The real model is exercised in policy.live.test.ts.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmRequest } from '../adapters/types.js';
import { draftFromModelJson, draftRulesFromText, type AddressBook } from './drafter.js';
import { RulesError, toPolicy } from './rules.js';

const V1: Address = '0x22dbbC1A9341064b3CA3e7c016D5cc22383dDe41';
const V2: Address = '0xc7F3D37B90d2Ef6dBFD419B71354F74132c619B4';
const USDC: Address = '0x240b0316Df57887DBBE58b586508b19e633a14aa';
const POOL: Address = '0xdf51eA243baBa7F71401aDFf84078d939F7bF21F';
const BOOK: AddressBook = {
  payees: [{ name: 'vendor1', address: V1 }, { name: 'vendor2', address: V2 }],
  tokens: [{ name: 'MockUSDC', address: USDC, decimals: 6 }],
  contracts: [{ name: 'SimplePool', address: POOL, functions: ['swap(address,uint256,uint256)'] }],
};
const TEXT = 'Let the agent pay vendor1 and vendor2 in MockUSDC, at most 25 per payment and 50 a day. Ask me above 20 dollars.';
const good = () => ({
  payees: ['vendor1', 'vendor2'],
  allow_eth_to_payees: false,
  eth: null,
  tokens: [{ token: 'MockUSDC', max_per_tx: '25', per_day: '50', allow: ['transfer'] }],
  contracts: [],
  spenders: [],
  ask_owner_above_usd: '20',
  rate_limit_per_hour: 10,
  block_new_contracts: true,
  unsupported: '',
});

describe('2.6 plain-English drafter: strict validation of the model\'s JSON', () => {
  it('a correct answer becomes a draft that the codec accepts', () => {
    const { draft } = draftFromModelJson(good(), BOOK, TEXT);
    expect(draft.payees).toEqual([{ address: V1, label: 'vendor1' }, { address: V2, label: 'vendor2' }]);
    expect(draft.tokens[0]).toMatchObject({ address: USDC, decimals: 6, maxPerTx: '25', perDay: '50', functions: ['transfer(address,uint256)'] });
    expect(draft.tokens[0]!.codeHash).toBeUndefined(); // resolved from the chain later, never by the model
    const p = toPolicy({ ...draft, tokens: draft.tokens.map((t) => ({ ...t, codeHash: null })) });
    expect(p.askOwnerAbove).toBe(20_000_000n);
  });

  const bad: [string, (j: any) => void, RegExp][] = [
    ['unknown field', (j) => (j.max_everything = '1'), /unknown field "max_everything"/],
    ['missing field', (j) => delete j.unsupported, /missing field "unsupported"/],
    ['name not in the book', (j) => j.payees.push('vendor3'), /not in your address book/],
    ['address not in the request', (j) => j.payees.push('0x1111111111111111111111111111111111111111'), /does not appear in your request/],
    ['token not in the book', (j) => (j.tokens[0].token = 'USDT'), /not a token in your address book/],
    ['unknown allow value', (j) => (j.tokens[0].allow = ['transferFrom']), /must be "transfer" or "approve"/],
    ['number instead of string amount', (j) => (j.tokens[0].max_per_tx = 25), /must be a string/],
    ['exponent amount', (j) => (j.tokens[0].per_day = '5e1'), /not a plain amount/],
    ['cap above daily cap (codec rule)', (j) => (j.tokens[0].max_per_tx = '60'), /exceeds dailyCap/],
    ['boolean as string', (j) => (j.block_new_contracts = 'yes'), /true or false/],
    ['ETH to payees without ETH limits', (j) => (j.allow_eth_to_payees = true), /no ETH limits/],
    ['bad function signature', (j) => j.contracts.push({ contract: 'SimplePool', functions: ['swap'] }), /not a function signature/],
    ['spender that is not a known contract', (j) => j.spenders.push('vendor1'), /not in your address book/],
  ];
  it.each(bad)('rejects: %s', (_, mutate, msg) => {
    const j = good();
    mutate(j);
    expect(() => draftFromModelJson(j, BOOK, TEXT)).toThrow(msg);
  });

  it('accepts a literal address the owner typed, but never a look-alike of a known address', () => {
    const fresh = '0x9999999999999999999999999999999999999999';
    const j = good();
    j.payees.push(fresh);
    expect(draftFromModelJson(j, BOOK, `${TEXT} Also pay ${fresh}.`).draft.payees[2]).toEqual({ address: '0x9999999999999999999999999999999999999999', label: 'address from your request' });
    const twin = `0x${V1.slice(2, 5)}${'7'.repeat(34)}${V1.slice(-3)}`;
    const k = good();
    k.payees.push(twin);
    expect(() => draftFromModelJson(k, BOOK, `${TEXT} vendor1's new address is ${twin}.`)).toThrow(/looks like the known address/);
  });
});

/** A stand-in model that returns fixed answers in order (tests the retry logic, not the model). */
const fixedAnswers = (answers: string[]): LlmAdapter & { requests: LlmRequest[] } => {
  const requests: LlmRequest[] = [];
  return {
    name: 'fixed-answers',
    requests,
    async chat(req) {
      requests.push(structuredClone(req));
      return { content: answers[requests.length - 1] ?? '', toolCalls: [], finishReason: 'stop', model: 'fixed' };
    },
  };
};

describe('2.6 drafter loop', () => {
  it('accepts one ```json fence and sends no tools', async () => {
    const llm = fixedAnswers([`\`\`\`json\n${JSON.stringify(good())}\n\`\`\``]);
    const r = await draftRulesFromText(llm, TEXT, BOOK);
    expect(r.attempts).toBe(1);
    expect(llm.requests[0]!.tools).toEqual([]);
    expect(llm.requests[0]!.messages[0]!.content).toContain(`vendor1: ${V1}`);
  });
  it('gives the model one retry with the exact error, then succeeds', async () => {
    const wrong = { ...good(), payees: ['vendor9'] };
    const llm = fixedAnswers([JSON.stringify(wrong), JSON.stringify(good())]);
    const r = await draftRulesFromText(llm, TEXT, BOOK);
    expect(r.attempts).toBe(2);
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/That draft is invalid: payee: "vendor9" is not in your address book/);
  });
  it('fails closed after two invalid answers', async () => {
    const llm = fixedAnswers(['Sure! Here are your rules: ...', '{"payees": []}']);
    await expect(draftRulesFromText(llm, TEXT, BOOK)).rejects.toThrow(RulesError);
  });
});
