import { getAddress, isAddress, type Address } from 'viem';
import type { LlmAdapter, LlmMessage } from '../adapters/types.js';
import { looksLike } from '../check/checks.js';
import { RulesError, toPolicy, type Labeled, type RulesDraft } from './rules.js';

/**
 * Plain-English rules helper (2.6). The LLM only DRAFTS: its JSON is validated strictly (exact keys, names
 * from the owner's address book, amounts as plain decimals), turned into a RulesDraft and checked by the same
 * codec rules as the module. Nothing is written anywhere: the owner reviews describeRules() and signs.
 *
 * Addresses: the model refers to entries of the owner's address book by name. A literal address is accepted
 * only if it appears verbatim in the owner's own request, and never if it looks like a known address
 * (same first and last 3 hex characters).
 */
export type AddressBook = {
  payees: { name: string; address: Address }[];
  /** ERC-20 tokens (decimals from chain or config). */
  tokens: { name: string; address: Address; decimals: number }[];
  /** Routers, vaults and other contracts the owner knows. */
  contracts: { name: string; address: Address; functions?: string[] }[];
};
export type DraftFromText = { draft: RulesDraft; unsupported: string; modelOutput: string; attempts: number };

const KEYS = ['payees', 'allow_eth_to_payees', 'eth', 'tokens', 'contracts', 'spenders', 'ask_owner_above_usd', 'rate_limit_per_hour', 'block_new_contracts', 'unsupported'] as const;
const TOKEN_KEYS = ['token', 'max_per_tx', 'per_day', 'allow'] as const;
const CONTRACT_KEYS = ['contract', 'functions'] as const;
const ETH_KEYS = ['max_per_tx', 'per_day'] as const;
const ALLOW: Record<string, string> = { transfer: 'transfer(address,uint256)', approve: 'approve(address,uint256)' };

export function drafterSystemPrompt(book: AddressBook): string {
  const lines = (xs: { name: string; address: Address }[]) => (xs.length ? xs.map((x) => `- ${x.name}: ${x.address}`).join('\n') : '- (none)');
  return [
    'You turn a wallet owner\'s plain-English request into draft spending rules for their AI agent. Output ONLY one JSON object, no prose.',
    'The owner reviews and signs the result; you never decide on your own. If something is unclear or cannot be expressed, leave it out and explain it in "unsupported".',
    '',
    'Refer to addresses by the NAME from the address book. A literal 0x address is allowed only if the owner wrote it in the request.',
    'Approved recipients (payees):',
    lines(book.payees),
    'Tokens (ERC-20):',
    lines(book.tokens),
    'Contracts:',
    book.contracts.length ? book.contracts.map((c) => `- ${c.name}: ${c.address}${c.functions?.length ? ` (functions: ${c.functions.join(', ')})` : ''}`).join('\n') : '- (none)',
    '',
    'JSON shape (every key required; amounts are strings in token units like "25" or "0.5"):',
    '{',
    '  "payees": [names],                        // who may receive payments',
    '  "allow_eth_to_payees": false,             // plain ETH payments to those payees',
    '  "eth": null or {"max_per_tx": "0.01", "per_day": "0.05"},',
    '  "tokens": [{"token": name, "max_per_tx": "25", "per_day": "50", "allow": ["transfer"] }],  // allow: "transfer" (pay payees) and/or "approve" (let a spender use it)',
    '  "contracts": [{"contract": name, "functions": ["deposit(uint256)"]}],  // non-token contracts the agent may call, with exact Solidity signatures',
    '  "spenders": [names],                      // contracts that may be approved to spend tokens',
    '  "ask_owner_above_usd": "20",              // "0" = never ask',
    '  "rate_limit_per_hour": 10,                // 0 = no limit',
    '  "block_new_contracts": true,',
    '  "unsupported": ""                         // anything requested that these rules cannot express',
    '}',
    'Defaults when the owner says nothing: ask_owner_above_usd "20", rate_limit_per_hour 10, block_new_contracts true, eth null, no contracts, no spenders.',
  ].join('\n');
}

const fail = (m: string): never => {
  throw new RulesError(m);
};
function exactKeys(o: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) fail(`${what} must be an object`);
  const rec = o as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (!keys.includes(k)) fail(`${what}: unknown field "${k}"`);
  for (const k of keys) if (!(k in rec)) fail(`${what}: missing field "${k}"`);
  return rec;
}
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : fail(`${what} must be a string`));
const arr = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : fail(`${what} must be a list`));

/** Strips one optional ```json fence; anything else around the JSON is rejected by JSON.parse. */
function parseJson(text: string): unknown {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  try {
    return JSON.parse(m ? m[1]! : t);
  } catch {
    return fail('the model did not return valid JSON');
  }
}

/** Validates the model's JSON against the owner's book and request. Exported for tests and for re-checking edits. */
export function draftFromModelJson(json: unknown, book: AddressBook, ownerText: string): { draft: RulesDraft; unsupported: string } {
  const o = exactKeys(json, KEYS, 'rules');
  const known = [...book.payees, ...book.tokens, ...book.contracts].map((x) => x.address);
  const literal = (s: string, what: string): Labeled => {
    if (!isAddress(s, { strict: false })) fail(`${what}: "${s}" is not in your address book`);
    if (!ownerText.toLowerCase().includes(s.toLowerCase())) fail(`${what}: ${s} is not in your address book and does not appear in your request`);
    const twin = known.find((k) => looksLike(s as Address, k));
    if (twin) fail(`${what}: ${s} looks like the known address ${twin} but is a different address`);
    return { address: getAddress(s), label: 'address from your request' };
  };
  const pick = <T extends { name: string; address: Address }>(entries: T[], v: unknown, what: string): Labeled & { entry?: T } => {
    const s = str(v, what).trim();
    const byName = entries.find((e) => e.name.toLowerCase() === s.toLowerCase());
    if (byName) return { address: getAddress(byName.address), label: byName.name, entry: byName };
    const byAddr = entries.find((e) => e.address.toLowerCase() === s.toLowerCase());
    if (byAddr) return { address: getAddress(byAddr.address), label: byAddr.name, entry: byAddr };
    return literal(s, what);
  };
  const plain = (x: Labeled & { entry?: unknown }): Labeled => ({ address: x.address, ...(x.label ? { label: x.label } : {}) });

  const payees = arr(o.payees, 'payees').map((v) => plain(pick(book.payees, v, 'payee')));
  const spenders = arr(o.spenders, 'spenders').map((v) => plain(pick(book.contracts, v, 'spender')));
  const tokens = arr(o.tokens, 'tokens').map((v, i) => {
    const t = exactKeys(v, TOKEN_KEYS, `tokens[${i}]`);
    const name = str(t.token, `tokens[${i}].token`);
    const entry = book.tokens.find((e) => e.name.toLowerCase() === name.trim().toLowerCase() || e.address.toLowerCase() === name.trim().toLowerCase());
    if (!entry) fail(`tokens[${i}]: "${name}" is not a token in your address book`);
    const allow = arr(t.allow, `tokens[${i}].allow`).map((a) => ALLOW[str(a, `tokens[${i}].allow`)] ?? fail(`tokens[${i}].allow: "${String(a)}" must be "transfer" or "approve"`));
    return { address: getAddress(entry!.address), label: entry!.name, kind: 'erc20' as const, decimals: entry!.decimals, maxPerTx: str(t.max_per_tx, `tokens[${i}].max_per_tx`), perDay: str(t.per_day, `tokens[${i}].per_day`), functions: [...new Set(allow)] };
  });
  const contracts = arr(o.contracts, 'contracts').map((v, i) => {
    const c = exactKeys(v, CONTRACT_KEYS, `contracts[${i}]`);
    const picked = plain(pick(book.contracts, c.contract, `contracts[${i}].contract`));
    return { ...picked, functions: arr(c.functions, `contracts[${i}].functions`).map((f) => str(f, `contracts[${i}].functions`)) };
  });
  let eth: RulesDraft['eth'] = null;
  if (o.eth !== null) {
    const e = exactKeys(o.eth, ETH_KEYS, 'eth');
    eth = { maxPerTx: str(e.max_per_tx, 'eth.max_per_tx'), perDay: str(e.per_day, 'eth.per_day') };
  }
  if (typeof o.allow_eth_to_payees !== 'boolean') fail('allow_eth_to_payees must be true or false');
  if (typeof o.block_new_contracts !== 'boolean') fail('block_new_contracts must be true or false');
  if (typeof o.rate_limit_per_hour !== 'number') fail('rate_limit_per_hour must be a number');
  const draft: RulesDraft = {
    version: 1,
    payees,
    allowEthToPayees: o.allow_eth_to_payees as boolean,
    eth,
    tokens,
    contracts,
    spenders,
    operators: [],
    rateLimitPerHour: o.rate_limit_per_hour as number,
    askOwnerAboveUsd: str(o.ask_owner_above_usd, 'ask_owner_above_usd'),
    blockNewContracts: o.block_new_contracts as boolean,
  };
  // Structural check now (code hashes are resolved from the chain later): same validation as the module's codec.
  toPolicy({ ...draft, tokens: draft.tokens.map((t) => ({ ...t, codeHash: null })), contracts: draft.contracts.map((c) => ({ ...c, codeHash: null })) });
  return { draft, unsupported: str(o.unsupported, 'unsupported') };
}

/**
 * Asks the model for a draft; if its JSON fails validation, it gets ONE retry with the exact error.
 * Throws RulesError if the second answer is invalid too (fail closed: no half-valid rules).
 */
export async function draftRulesFromText(llm: LlmAdapter, ownerText: string, book: AddressBook): Promise<DraftFromText> {
  const messages: LlmMessage[] = [
    { role: 'system', content: drafterSystemPrompt(book) },
    { role: 'user', content: ownerText },
  ];
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await llm.chat({ messages, tools: [] });
    const text = res.content ?? '';
    try {
      const { draft, unsupported } = draftFromModelJson(parseJson(text), book, ownerText);
      return { draft, unsupported, modelOutput: text, attempts: attempt };
    } catch (e) {
      if (!(e instanceof RulesError) && !(e instanceof Error && e.name === 'PolicyError')) throw e;
      lastError = e.message;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That draft is invalid: ${lastError}. Return the corrected JSON object only.` });
    }
  }
  throw new RulesError(`the model could not produce valid rules: ${lastError}`);
}
