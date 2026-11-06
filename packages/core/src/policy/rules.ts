import { formatUnits, getAddress, isAddress, keccak256, parseUnits, toFunctionSelector, type Address, type Hex, type PublicClient } from 'viem';
import { ASK_OWNER_DECIMALS, ETH, TOKEN_MOVING_SELECTORS, validatePolicy, type Policy, type TokenKind } from '@blindspot/shared';
import { readImplementation } from '../check/checks.js';

/**
 * The rule editor's model (2.6). The owner edits rules in human units (token amounts, function signatures,
 * labelled addresses); `toPolicy` turns them into the exact `Policy` the module enforces and the shared codec
 * validates. Nothing here writes to ENS: the owner reviews `describeRules` / `diffRules` and signs the record.
 */
export type Labeled = { address: Address; label?: string };
export type DraftTokenKind = 'erc20' | 'erc721' | 'erc1155';
export type DraftToken = Labeled & {
  kind: DraftTokenKind;
  /** 0 for NFTs (amounts are counts). */
  decimals: number;
  /** Decimal strings in token units, e.g. "25". ERC-1155: must be "0" (amounts are not capped on-chain). */
  maxPerTx: string;
  perDay: string;
  /** Functions the agent may call on the token contract itself, e.g. "transfer(address,uint256)". Empty = caps only. */
  functions: string[];
  /** keccak256 of the token's code; null = not pinned (proxy); undefined = not resolved yet (see resolveCodeHashes). */
  codeHash?: Hex | null;
};
export type DraftContract = Labeled & { functions: string[]; codeHash?: Hex | null };
export type RulesDraft = {
  version: number;
  /** Who may receive tokens (transfer recipients) and, if allowEthToPayees, plain ETH. */
  payees: Labeled[];
  allowEthToPayees: boolean;
  /** Native ETH limits (per transaction and per day, in ETH); null = the agent may not send ETH. */
  eth: { maxPerTx: string; perDay: string } | null;
  tokens: DraftToken[];
  /** Non-token contracts the agent may call (routers, vaults), with the allowed functions. */
  contracts: DraftContract[];
  /** Who may be approved to spend tokens (must be used up in the same transaction: no leftover approvals). */
  spenders: Labeled[];
  /** NFT operators allowed to remain approved-for-all. */
  operators: Labeled[];
  /** Wallet-only rules. */
  rateLimitPerHour: number;
  /** USD; "0" = never ask. */
  askOwnerAboveUsd: string;
  blockNewContracts: boolean;
};

export class RulesError extends Error {
  override name = 'RulesError';
}

const EMPTY: Hex = '0x00000000';
const ZERO32: Hex = `0x${'0'.repeat(64)}`;
const KIND: Record<DraftTokenKind, TokenKind> = { erc20: 0, erc721: 1, erc1155: 2 };
const KIND_NAME: DraftTokenKind[] = ['erc20', 'erc721', 'erc1155'];
const lc = (a: string) => a.toLowerCase();

/** Readable names for the selectors the module decodes (and the plain-ETH marker). */
export const KNOWN_FUNCTIONS: Record<string, string> = {
  '0x00000000': 'plain ETH transfer (empty call)',
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x42842e0e': 'safeTransferFrom(address,address,uint256)',
  '0xb88d4fde': 'safeTransferFrom(address,address,uint256,bytes)',
  '0xf242432a': 'safeTransferFrom(address,address,uint256,uint256,bytes)',
  '0x2eb2c2d6': 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x39509351': 'increaseAllowance(address,uint256)',
  '0xa22cb465': 'setApprovalForAll(address,bool)',
};

/** "transfer(address,uint256)" or "0xa9059cbb" → lowercase 4-byte selector. Throws RulesError otherwise. */
export function selectorFor(fn: string): Hex {
  const s = fn.trim();
  if (/^0x[0-9a-fA-F]{8}$/.test(s)) return lc(s) as Hex;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*\([A-Za-z0-9_,\[\]() ]*\)$/.test(s)) throw new RulesError(`"${fn}" is not a function signature like "transfer(address,uint256)" or a 4-byte selector`);
  try {
    return lc(toFunctionSelector(s)) as Hex;
  } catch {
    throw new RulesError(`"${fn}" is not a valid function signature`);
  }
}
const functionName = (sel: Hex) => KNOWN_FUNCTIONS[lc(sel)] ?? sel;

/** Strict decimal-string amount → base units. Rejects signs, exponents, and more decimals than the token has. */
export function parseAmount(s: string, decimals: number, what: string): bigint {
  const t = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new RulesError(`${what}: "${s}" is not a plain amount like "25" or "0.5"`);
  if ((t.split('.')[1] ?? '').length > decimals) throw new RulesError(`${what}: "${s}" has more than ${decimals} decimals`);
  return parseUnits(t, decimals);
}

const addr = (a: string, what: string): Address => {
  if (!isAddress(a, { strict: false })) throw new RulesError(`${what}: "${a}" is not an address`);
  return getAddress(a);
};
const noDuplicates = (list: Labeled[], what: string) => {
  const seen = new Set<string>();
  for (const x of list) {
    if (seen.has(lc(x.address))) throw new RulesError(`${what}: ${x.address} is listed twice`);
    seen.add(lc(x.address));
  }
};

/** Draft → the exact Policy (validated by the shared codec, same rules as PolicyCodec.isValid). */
export function toPolicy(d: RulesDraft): Policy {
  for (const [what, list] of [['payees', d.payees], ['tokens', d.tokens], ['contracts', d.contracts], ['spenders', d.spenders], ['operators', d.operators]] as const) {
    list.forEach((x) => addr(x.address, what));
    noDuplicates(list, what);
  }
  if (d.tokens.some((t) => lc(t.address) === ETH)) throw new RulesError('tokens: use the "eth" setting for native ETH, not a token entry');
  if (d.contracts.some((c) => d.tokens.some((t) => lc(t.address) === lc(c.address)))) throw new RulesError('contracts: a token belongs in "tokens" (with its functions), not in "contracts"');
  if (d.allowEthToPayees && !d.eth) throw new RulesError('plain ETH payments are allowed but no ETH limits are set');
  if (!Number.isInteger(d.rateLimitPerHour) || d.rateLimitPerHour < 0) throw new RulesError('rateLimitPerHour must be a whole number ≥ 0 (0 = no limit)');

  const targets: Address[] = [];
  const codeHashes: Hex[] = [];
  const selectors: Hex[][] = [];
  const addTarget = (a: Labeled, fns: string[], codeHash: Hex | null | undefined) => {
    if (codeHash === undefined) throw new RulesError(`the code hash of ${a.label ?? a.address} is not resolved yet (resolveCodeHashes reads it from the chain)`);
    const sels = [...new Set(fns.map(selectorFor))];
    if (sels.length === 0) throw new RulesError(`${a.label ?? a.address}: list at least one allowed function`);
    targets.push(getAddress(a.address));
    codeHashes.push(codeHash ?? ZERO32);
    selectors.push(sels);
  };
  for (const t of d.tokens) if (t.functions.length) addTarget(t, t.functions, t.codeHash);
  for (const c of d.contracts) addTarget(c, c.functions, c.codeHash);
  if (d.allowEthToPayees)
    for (const p of d.payees) {
      const i = targets.findIndex((t) => lc(t) === lc(p.address));
      if (i < 0) {
        targets.push(getAddress(p.address));
        codeHashes.push(ZERO32);
        selectors.push([EMPTY]);
      } else if (!selectors[i]!.includes(EMPTY)) selectors[i]!.push(EMPTY);
    }

  const tokens: Address[] = d.tokens.map((t) => getAddress(t.address));
  const tokenKinds: TokenKind[] = d.tokens.map((t) => {
    if (!(t.kind in KIND)) throw new RulesError(`${t.label ?? t.address}: kind must be erc20, erc721 or erc1155`);
    return KIND[t.kind];
  });
  const maxOut = d.tokens.map((t) => parseAmount(t.maxPerTx, t.decimals, `${t.label ?? t.address} per transaction`));
  const dailyCap = d.tokens.map((t) => parseAmount(t.perDay, t.decimals, `${t.label ?? t.address} per day`));
  let maxEth = 0n;
  if (d.eth) {
    maxEth = parseAmount(d.eth.maxPerTx, 18, 'ETH per transaction');
    tokens.push(ETH);
    tokenKinds.push(0);
    maxOut.push(maxEth);
    dailyCap.push(parseAmount(d.eth.perDay, 18, 'ETH per day'));
  }

  const p: Policy = {
    version: d.version,
    targets,
    codeHashes,
    selectors,
    payees: d.payees.map((x) => getAddress(x.address)),
    spenders: d.spenders.map((x) => getAddress(x.address)),
    operators: d.operators.map((x) => getAddress(x.address)),
    tokens,
    tokenKinds,
    maxOut,
    dailyCap,
    maxEth,
    rateLimitPerHour: d.rateLimitPerHour,
    askOwnerAbove: parseAmount(d.askOwnerAboveUsd, ASK_OWNER_DECIMALS, 'ask-owner threshold (USD)'),
    blockNewContracts: d.blockNewContracts,
  };
  validatePolicy(p);
  return p;
}

/** What the editor needs to show a Policy in human units: decimals per token and the owner's labels. */
export type RulesInfo = { decimals: Record<string, number>; labels?: Record<string, string> };

/**
 * Policy → draft. Throws RulesError when the policy uses a layout the editor cannot show faithfully
 * (checked by re-encoding: the draft must reproduce the exact same bytes).
 */
export function fromPolicy(p: Policy, info: RulesInfo): RulesDraft {
  validatePolicy(p);
  const label = (a: Address): Labeled => (info.labels?.[lc(a)] ? { address: a, label: info.labels[lc(a)]! } : { address: a });
  const ethI = p.tokens.findIndex((t) => lc(t) === ETH);
  const isPayee = (a: string) => p.payees.some((x) => lc(x) === lc(a));
  const draft: RulesDraft = {
    version: p.version,
    payees: p.payees.map(label),
    allowEthToPayees: false,
    eth: ethI >= 0 ? { maxPerTx: formatUnits(p.maxOut[ethI]!, 18), perDay: formatUnits(p.dailyCap[ethI]!, 18) } : null,
    tokens: [],
    contracts: [],
    spenders: p.spenders.map(label),
    operators: p.operators.map(label),
    rateLimitPerHour: p.rateLimitPerHour,
    askOwnerAboveUsd: formatUnits(p.askOwnerAbove, ASK_OWNER_DECIMALS),
    blockNewContracts: p.blockNewContracts,
  };
  const tokenTarget = new Map<string, number>();
  p.targets.forEach((t, i) => {
    const sels = p.selectors[i]!;
    const hash = /^0x0+$/.test(p.codeHashes[i]!) ? null : p.codeHashes[i]!;
    if (p.tokens.some((x) => lc(x) === lc(t))) tokenTarget.set(lc(t), i);
    else if (isPayee(t) && hash === null && sels.length === 1 && lc(sels[0]!) === EMPTY) draft.allowEthToPayees = true;
    else draft.contracts.push({ ...label(t), functions: sels.map(functionName), codeHash: hash });
  });
  p.tokens.forEach((t, k) => {
    if (k === ethI) return;
    const kind = KIND_NAME[p.tokenKinds[k]!]!;
    const decimals = kind === 'erc20' ? info.decimals[lc(t)] : 0;
    if (decimals === undefined) throw new RulesError(`decimals of token ${t} are needed to show its caps`);
    const ti = tokenTarget.get(lc(t));
    const hash = ti === undefined || /^0x0+$/.test(p.codeHashes[ti]!) ? null : p.codeHashes[ti]!;
    draft.tokens.push({ ...label(t), kind, decimals, maxPerTx: formatUnits(p.maxOut[k]!, decimals), perDay: formatUnits(p.dailyCap[k]!, decimals), functions: ti === undefined ? [] : p.selectors[ti]!.map(functionName), codeHash: hash });
  });
  // Plain-ETH markers ("plain ETH transfer (empty call)") are stored as the empty selector.
  const unname = (fns: string[]) => fns.map((f) => (f === KNOWN_FUNCTIONS[EMPTY] ? EMPTY : f));
  draft.tokens.forEach((t) => (t.functions = unname(t.functions)));
  draft.contracts.forEach((c) => (c.functions = unname(c.functions)));
  if (ethI >= 0 && p.maxEth !== p.maxOut[ethI]) throw new RulesError('the ETH per-call limit differs from the ETH outflow cap; the editor shows one ETH limit');
  if (ethI < 0 && p.maxEth !== 0n) throw new RulesError('an ETH per-call limit is set without an ETH outflow cap');
  if (!samePolicyMeaning(toPolicy(draft), p)) throw new RulesError('these rules use a layout the editor cannot show faithfully');
  return draft;
}

/**
 * True if two policies allow exactly the same things. The module looks targets, payees, spenders, operators
 * and tokens up by address, so list ORDER (and selector order) does not change what is enforced; every
 * address, code hash, selector, cap and wallet-only setting must match.
 */
export function samePolicyMeaning(a: Policy, b: Policy): boolean {
  const norm = (p: Policy) => ({
    version: p.version,
    targets: p.targets.map((t, i) => `${lc(t)}|${lc(p.codeHashes[i]!)}|${[...new Set(p.selectors[i]!.map(lc))].sort().join(',')}`).sort(),
    payees: p.payees.map(lc).sort(),
    spenders: p.spenders.map(lc).sort(),
    operators: p.operators.map(lc).sort(),
    tokens: p.tokens.map((t, i) => `${lc(t)}|${p.tokenKinds[i]}|${p.maxOut[i]}|${p.dailyCap[i]}`).sort(),
    rest: `${p.maxEth}|${p.rateLimitPerHour}|${p.askOwnerAbove}|${p.blockNewContracts}`,
  });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

const who = (x: Labeled) => (x.label ? `${x.label} (${x.address})` : x.address);
const list = (xs: Labeled[]) => (xs.length ? xs.map(who).join(', ') : 'none');

/** Plain-language summary for the owner to review before signing. */
export function describeRules(d: RulesDraft): string[] {
  const out: string[] = [];
  const anything = d.tokens.some((t) => t.functions.length) || d.contracts.length > 0 || d.allowEthToPayees;
  if (!anything) out.push('Read-only: the agent may not make any transaction (BlindspotModule rejects every call).');
  out.push(`Approved recipients: ${list(d.payees)}.`);
  out.push(d.eth ? `ETH: at most ${d.eth.maxPerTx} per transaction and ${d.eth.perDay} per day${d.allowEthToPayees ? '; plain ETH payments to approved recipients are allowed' : ''}.` : 'ETH: the agent may not send ETH.');
  for (const t of d.tokens) {
    const caps = t.kind === 'erc1155' ? 'amounts are not capped on-chain (ERC-1155)' : `at most ${t.maxPerTx} per transaction and ${t.perDay} per day`;
    const fns = t.functions.length ? `; may call ${t.functions.map((f) => functionName(selectorFor(f))).join(', ')}` : '';
    out.push(`Token ${who(t)} [${t.kind}]: ${caps}${fns}${t.functions.length ? (t.codeHash ? ' (code pinned)' : ' (proxy: upgrades checked by the wallet)') : ''}.`);
  }
  for (const c of d.contracts) out.push(`Contract ${who(c)}: may call ${c.functions.map((f) => functionName(selectorFor(f))).join(', ')}${c.codeHash ? ' (code pinned)' : ' (proxy: upgrades checked by the wallet)'}.`);
  out.push(`May be approved to spend tokens (only within one transaction): ${list(d.spenders)}.`);
  if (d.operators.length) out.push(`NFT operators allowed to stay approved: ${list(d.operators)}.`);
  out.push(Number(d.askOwnerAboveUsd) > 0 ? `Ask the owner before paying more than ${d.askOwnerAboveUsd} USD in stablecoins.` : 'Never ask the owner (no approval threshold).');
  out.push(d.rateLimitPerHour > 0 ? `At most ${d.rateLimitPerHour} transactions per hour.` : 'No hourly transaction limit.');
  out.push(d.blockNewContracts ? 'Contracts younger than about 7 days are blocked.' : 'New contracts are not blocked.');
  return out;
}

/** What changes between two rule sets, in plain language (shown next to the new record before signing). */
export function diffRules(before: RulesDraft, after: RulesDraft): string[] {
  const out: string[] = [];
  const byAddr = <T extends Labeled>(xs: T[]) => new Map(xs.map((x) => [lc(x.address), x]));
  const setDiff = (what: string, a: Labeled[], b: Labeled[]) => {
    const A = byAddr(a);
    const B = byAddr(b);
    for (const [k, x] of B) if (!A.has(k)) out.push(`+ ${what}: ${who(x)}`);
    for (const [k, x] of A) if (!B.has(k)) out.push(`- ${what}: ${who(x)}`);
  };
  const fnKey = (fns: string[]) => fns.map(selectorFor).sort().join(',');
  setDiff('approved recipient', before.payees, after.payees);
  setDiff('spender', before.spenders, after.spenders);
  setDiff('NFT operator', before.operators, after.operators);
  setDiff('token', before.tokens, after.tokens);
  setDiff('contract', before.contracts, after.contracts);
  const A = byAddr(before.tokens);
  for (const t of after.tokens) {
    const o = A.get(lc(t.address));
    if (!o) continue;
    if (o.maxPerTx !== t.maxPerTx || o.perDay !== t.perDay) out.push(`~ ${who(t)} caps: ${o.maxPerTx}/tx, ${o.perDay}/day → ${t.maxPerTx}/tx, ${t.perDay}/day`);
    if (fnKey(o.functions) !== fnKey(t.functions)) out.push(`~ ${who(t)} functions: ${o.functions.join(', ') || 'none'} → ${t.functions.join(', ') || 'none'}`);
    if ((o.codeHash ?? null) !== (t.codeHash ?? null)) out.push(`~ ${who(t)} code pin: ${o.codeHash ?? 'not pinned'} → ${t.codeHash ?? 'not pinned'}`);
  }
  const C = byAddr(before.contracts);
  for (const c of after.contracts) {
    const o = C.get(lc(c.address));
    if (!o) continue;
    if (fnKey(o.functions) !== fnKey(c.functions)) out.push(`~ ${who(c)} functions: ${o.functions.join(', ')} → ${c.functions.join(', ')}`);
    if ((o.codeHash ?? null) !== (c.codeHash ?? null)) out.push(`~ ${who(c)} code pin: ${o.codeHash ?? 'not pinned'} → ${c.codeHash ?? 'not pinned'}`);
  }
  const eth = (e: RulesDraft['eth']) => (e ? `${e.maxPerTx}/tx, ${e.perDay}/day` : 'not allowed');
  if (eth(before.eth) !== eth(after.eth)) out.push(`~ ETH: ${eth(before.eth)} → ${eth(after.eth)}`);
  if (before.allowEthToPayees !== after.allowEthToPayees) out.push(`~ plain ETH to approved recipients: ${before.allowEthToPayees ? 'allowed' : 'not allowed'} → ${after.allowEthToPayees ? 'allowed' : 'not allowed'}`);
  if (before.askOwnerAboveUsd !== after.askOwnerAboveUsd) out.push(`~ ask the owner above: ${before.askOwnerAboveUsd} USD → ${after.askOwnerAboveUsd} USD`);
  if (before.rateLimitPerHour !== after.rateLimitPerHour) out.push(`~ transactions per hour: ${before.rateLimitPerHour || 'no limit'} → ${after.rateLimitPerHour || 'no limit'}`);
  if (before.blockNewContracts !== after.blockNewContracts) out.push(`~ block new contracts: ${before.blockNewContracts ? 'yes' : 'no'} → ${after.blockNewContracts ? 'yes' : 'no'}`);
  return out.length ? out : ['No changes.'];
}

/**
 * Fills every unresolved code hash from the chain (SPEC: pin code only for non-proxy targets).
 * A target with an EIP-1967 implementation is a proxy → not pinned (null); the owner must then record its
 * implementation baseline (recordProxyBaseline) so the wallet can detect upgrades. A target without code fails.
 */
export async function resolveCodeHashes(client: PublicClient, d: RulesDraft): Promise<{ draft: RulesDraft; proxies: Address[] }> {
  const proxies: Address[] = [];
  const resolve = async <T extends Labeled & { codeHash?: Hex | null }>(x: T, needed: boolean): Promise<T> => {
    if (!needed || x.codeHash !== undefined) return x;
    const code = await client.getCode({ address: x.address });
    if (!code || code === '0x') throw new RulesError(`${x.label ?? x.address} has no contract code on this chain`);
    const impl = await readImplementation(client, x.address).catch(() => null);
    if (impl) proxies.push(getAddress(x.address));
    return { ...x, codeHash: impl ? null : keccak256(code) };
  };
  const tokens = [];
  for (const t of d.tokens) tokens.push(await resolve(t, t.functions.length > 0));
  const contracts = [];
  for (const c of d.contracts) contracts.push(await resolve(c, true));
  return { draft: { ...d, tokens, contracts }, proxies };
}

/** True if a function list would let the agent move or approve tokens (the target must then be a capped token). */
export const movesTokens = (fns: string[]) => fns.some((f) => TOKEN_MOVING_SELECTORS.includes(selectorFor(f)));
