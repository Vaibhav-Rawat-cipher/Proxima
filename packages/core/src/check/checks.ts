import { decodeAbiParameters, keccak256, parseAbi, size, slice, type Address, type Hex, type PublicClient } from 'viem';
import { ETH, type CheckName, type Effect, type FailedCheck, type Policy, type ProposalCall } from '@blindspot/shared';
import type { StorageAdapter } from '../adapters/types.js';
import type { AgentStatus } from '../ens/reader.js';
import type { SimulationResult } from '../simulate/simulate.js';

/** One check's outcome. `failures` empty = passed. */
export type CheckOutcome = { check: CheckName; failures: FailedCheck[] };
const ok = (check: CheckName): CheckOutcome => ({ check, failures: [] });
const fail = (check: CheckName, detail: string, rule?: string): FailedCheck => (rule ? { check, rule, detail } : { check, detail });
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const has = (list: readonly string[], a: string) => list.some((x) => eq(x, a));
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Selectors the module decodes (BlindspotModule.sol, PolicyCodec.isTokenMoving).
export const SEL = {
  EMPTY: '0x00000000',
  TRANSFER: '0xa9059cbb',
  TRANSFER_FROM: '0x23b872dd',
  SAFE_TRANSFER_FROM: '0x42842e0e',
  SAFE_TRANSFER_FROM_DATA: '0xb88d4fde',
  ERC1155_SAFE_TRANSFER_FROM: '0xf242432a',
  ERC1155_SAFE_BATCH_TRANSFER_FROM: '0x2eb2c2d6',
  APPROVE: '0x095ea7b3',
  INCREASE_ALLOWANCE: '0x39509351',
  SET_APPROVAL_FOR_ALL: '0xa22cb465',
} as const;

export const selectorOf = (data: Hex): Hex | 'short' => (size(data) === 0 ? SEL.EMPTY : size(data) < 4 ? 'short' : slice(data, 0, 4));
/** Calldata after the selector ('0x' for no-argument functions; viem's slice throws on an empty range). */
export const argsOf = (data: Hex): Hex => (size(data) > 4 ? slice(data, 4) : '0x');

/** Recipient / spender a call names, decoded like the module does. Throws on undecodable arguments. */
export function decodeCallParties(call: ProposalCall): { recipient?: Address; spender?: Address; operator?: Address } {
  const sel = selectorOf(call.data);
  const args = sel === 'short' || sel === SEL.EMPTY ? '0x' : argsOf(call.data);
  switch (sel) {
    case SEL.EMPTY:
      return { recipient: call.to };
    case SEL.TRANSFER:
      return { recipient: decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], args)[0] };
    case SEL.TRANSFER_FROM:
    case SEL.SAFE_TRANSFER_FROM:
      return { recipient: decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], args)[1] };
    case SEL.SAFE_TRANSFER_FROM_DATA:
      return { recipient: decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], args)[1] };
    case SEL.ERC1155_SAFE_TRANSFER_FROM:
      return { recipient: decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], args)[1] };
    case SEL.ERC1155_SAFE_BATCH_TRANSFER_FROM:
      return { recipient: decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256[]' }, { type: 'uint256[]' }, { type: 'bytes' }], args)[1] };
    case SEL.APPROVE:
    case SEL.INCREASE_ALLOWANCE:
      return { spender: decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], args)[0] };
    case SEL.SET_APPROVAL_FOR_ALL:
      return { operator: decodeAbiParameters([{ type: 'address' }, { type: 'bool' }], args)[0] };
    default:
      return {};
  }
}

/**
 * What the calls INTEND to move out of the Safe, decoded from calldata like the module does (ETH value,
 * transfer, transferFrom/safeTransferFrom from the Safe). Used for the cap rules when the simulation
 * reverts and therefore has no effects, so the owner still sees which cap is broken.
 */
export function intendedOutflows(calls: ProposalCall[], safe: Address): Effect[] {
  const out: Effect[] = [];
  for (const c of calls) {
    if (c.value > 0n) out.push({ kind: 'out', token: ETH, amount: c.value, counterparty: c.to, source: 'postState' });
    const sel = selectorOf(c.data);
    if (sel === 'short' || sel === SEL.EMPTY) continue;
    try {
      const args = argsOf(c.data);
      if (sel === SEL.TRANSFER) {
        const [to, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], args);
        out.push({ kind: 'out', token: c.to, amount, counterparty: to, source: 'postState' });
      } else if (sel === SEL.TRANSFER_FROM || sel === SEL.SAFE_TRANSFER_FROM) {
        const [from, to, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], args);
        if (eq(from, safe)) out.push({ kind: 'out', token: c.to, amount: sel === SEL.SAFE_TRANSFER_FROM ? 1n : amount, counterparty: to, source: 'postState' });
      }
    } catch {
      /* undecodable: reported by checkRules */
    }
  }
  return out;
}

// ---------------------------------------------------------------- 1. agent active
export function checkAgentActive(status: AgentStatus): CheckOutcome {
  return status.active ? ok('agentActive') : { check: 'agentActive', failures: [fail('agentActive', status.reason ?? 'The agent is not active.', 'Agent expiry / revoke')] };
}

// ---------------------------------------------------------------- 2. fail closed on anything unclassified
export function checkSimulation(sim: SimulationResult): CheckOutcome {
  const f: FailedCheck[] = [];
  for (const l of sim.unknownLogs)
    f.push(fail('simulation', `A tracked token (${short(l.address)}) emitted an event Blindspot does not recognise, so its effect cannot be verified.`));
  if (sim.success && !sim.balancesMatchLogs) {
    for (const e of sim.effects.filter((x) => x.source === 'postState'))
      f.push(fail('simulation', `The ${e.token === ETH ? 'ETH' : `token ${short(e.token)}`} balance changes by ${e.amount} ${e.kind === 'out' ? 'out of' : 'into'} the Safe without a matching event: a hidden balance change.`));
  }
  return { check: 'simulation', failures: f };
}

// ---------------------------------------------------------------- 3. module preview (the on-chain guarantee, simulated)
export function checkModulePreview(sim: SimulationResult): CheckOutcome {
  if (sim.success) return ok('modulePreview');
  const r = sim.revert;
  return { check: 'modulePreview', failures: [fail('modulePreview', `BlindspotModule would revert: ${r?.reason ?? 'unknown reason'}`, r?.rule)] };
}

// ---------------------------------------------------------------- 4. rules (wallet mirror of the on-chain rules; lists every broken rule)
export type CodeHashes = Record<string, Hex | null>; // target -> keccak(code) or null if no code
export function checkRules(p: Policy, calls: ProposalCall[], effects: Effect[], codeHashes: CodeHashes, spentToday: Record<string, bigint>): CheckOutcome {
  const f: FailedCheck[] = [];
  let ethTotal = 0n;
  for (const [i, c] of calls.entries()) {
    const n = calls.length > 1 ? ` (call ${i + 1})` : '';
    const ti = p.targets.findIndex((t) => eq(t, c.to));
    if (ti < 0) {
      f.push(fail('rules', `${short(c.to)} is not on the list of contracts the owner allowed${n}.`, 'Allowed contracts'));
      continue;
    }
    const pinned = p.codeHashes[ti]!;
    if (!/^0x0+$/.test(pinned) && !eq(codeHashes[c.to.toLowerCase()] ?? '0x', pinned))
      f.push(fail('rules', `The code at ${short(c.to)} has changed since the owner allowed it${n}.`, 'Allowed contracts (pinned code)'));
    const sel = selectorOf(c.data);
    if (sel === 'short' || !has(p.selectors[ti] ?? [], sel)) {
      f.push(fail('rules', sel === SEL.EMPTY ? `Sending ETH or an empty call to ${short(c.to)} is not allowed${n}.` : `Function ${sel} is not allowed on ${short(c.to)}${n}.`, 'Allowed functions'));
    }
    let parties: ReturnType<typeof decodeCallParties>;
    try {
      parties = decodeCallParties(c);
    } catch {
      f.push(fail('rules', `The arguments of call ${i + 1} cannot be decoded, so its recipient cannot be checked.`, 'Allowed recipients'));
      continue;
    }
    if (parties.recipient && !has(p.payees, parties.recipient)) f.push(fail('rules', `${parties.recipient} is not one of the owner's approved recipients${n}.`, 'Allowed recipients'));
    if (parties.spender && !has(p.spenders, parties.spender)) f.push(fail('rules', `${parties.spender} is not allowed to be approved to spend the wallet's tokens${n}.`, 'Allowed spenders'));
    if (parties.operator && !has(p.spenders, parties.operator) && !has(p.operators, parties.operator))
      f.push(fail('rules', `${parties.operator} is not allowed to control the wallet's NFTs${n}.`, 'Allowed spenders'));
    if (c.value > p.maxEth) f.push(fail('rules', `Call ${i + 1} sends ${c.value} wei of ETH, above the owner's limit of ${p.maxEth} wei per transaction.`, 'Maximum ETH per transaction'));
    ethTotal += c.value;
  }
  if (calls.length > 1 && ethTotal > p.maxEth) f.push(fail('rules', `The batch sends ${ethTotal} wei of ETH in total, above the owner's limit of ${p.maxEth} wei.`, 'Maximum ETH per transaction'));

  // Outflow caps, measured on the simulated effects (what actually leaves the Safe).
  p.tokens.forEach((token, k) => {
    if (p.tokenKinds[k] === 2) return; // ERC-1155 amounts are not tracked (SPEC §15 honest limit)
    const out = effects.filter((e) => e.kind === 'out' && eq(e.token, token)).reduce((a, e) => a + e.amount, 0n);
    if (out === 0n) return;
    const what = token === ETH ? 'ETH' : `token ${short(token)}`;
    if (out > p.maxOut[k]!) f.push(fail('rules', `This sends ${out} of ${what}, more than the owner's per-transaction cap of ${p.maxOut[k]}.`, token === ETH ? 'Maximum ETH per transaction' : 'Per-transaction cap'));
    const spent = spentToday[token.toLowerCase()] ?? 0n;
    if (spent + out > p.dailyCap[k]!) f.push(fail('rules', `This would bring today's total for ${what} to ${spent + out}, above the owner's daily cap of ${p.dailyCap[k]}.`, 'Daily cap'));
  });
  return { check: 'rules', failures: f };
}

// ---------------------------------------------------------------- 5. claim vs reality
export function checkClaimVsReality(declared: Omit<Effect, 'source'>[], effects: Effect[]): CheckOutcome & { undeclared: Effect[] } {
  const f: FailedCheck[] = [];
  const left = [...declared];
  const undeclared: Effect[] = [];
  const describe = (e: Omit<Effect, 'source'>) => `${e.kind} ${e.amount} of ${e.token === ETH ? 'ETH' : short(e.token)} ${e.kind === 'in' ? 'from' : 'to'} ${short(e.counterparty)}`;
  for (const e of effects.filter((x) => x.kind !== 'unknownLog')) {
    const i = left.findIndex((d) => d.kind === e.kind && eq(d.token, e.token) && eq(d.counterparty, e.counterparty) && (d.tokenId ?? null) === (e.tokenId ?? null));
    if (i < 0) {
      undeclared.push(e);
      f.push(fail('claimVsReality', `Undeclared effect: the transaction would ${describe(e)}, which the agent did not declare.`));
      continue;
    }
    const d = left.splice(i, 1)[0]!;
    const diff = d.amount > e.amount ? d.amount - e.amount : e.amount - d.amount;
    if (diff * 100n > d.amount) f.push(fail('claimVsReality', `The agent declared ${d.amount} but the transaction would actually move ${e.amount} (${describe(e)}): off by more than 1%.`));
  }
  for (const d of left) f.push(fail('claimVsReality', `The agent declared "${describe(d)}" but the simulation shows no such effect.`));
  return { check: 'claimVsReality', failures: f, undeclared };
}

// ---------------------------------------------------------------- 6. no leftover approvals
export function checkNoLeftoverApprovals(sim: SimulationResult): CheckOutcome {
  const f = [
    ...sim.leftoverAllowances.map((a) => fail('noLeftoverApprovals', `${a.spender} would still be allowed to spend ${a.amount} of token ${short(a.token)} afterwards.`, 'No leftover approvals')),
    ...sim.leftoverOperators.map((o) => fail('noLeftoverApprovals', `${o.operator} would still control all of the wallet's ${short(o.token)} NFTs afterwards.`, 'No leftover approvals')),
  ];
  return { check: 'noLeftoverApprovals', failures: f };
}

// ---------------------------------------------------------------- 7. look-alike addresses (first 3 + last 3 hex)
export function looksLike(a: Address, b: Address): boolean {
  const x = a.toLowerCase().slice(2);
  const y = b.toLowerCase().slice(2);
  return x !== y && x.slice(0, 3) === y.slice(0, 3) && x.slice(-3) === y.slice(-3);
}
export function checkLookAlike(p: Policy, calls: ProposalCall[], effects: Effect[]): CheckOutcome {
  const known = [...p.payees, ...p.spenders, ...p.targets];
  const seen = new Set<string>();
  const candidates: Address[] = [];
  const addC = (a: Address | undefined) => {
    if (a && !seen.has(a.toLowerCase())) {
      seen.add(a.toLowerCase());
      candidates.push(a);
    }
  };
  for (const c of calls) {
    addC(c.to);
    try {
      const pt = decodeCallParties(c);
      addC(pt.recipient);
      addC(pt.spender);
      addC(pt.operator);
    } catch {
      /* undecodable calls are reported by checkRules */
    }
  }
  for (const e of effects) if (e.kind !== 'unknownLog') addC(e.counterparty);
  const f: FailedCheck[] = [];
  for (const a of candidates) {
    if (has(known, a)) continue;
    const twin = known.find((k) => looksLike(a, k));
    if (twin) f.push(fail('lookAlike', `${a} looks like the known address ${twin} (same first and last characters) but is a different address.`, 'Look-alike block'));
  }
  return { check: 'lookAlike', failures: f };
}

// ---------------------------------------------------------------- 8. proxy upgrade (EIP-1967 slot vs baseline in wallet storage)
/** bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1) */
export const EIP1967_IMPL_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const proxyBaselineKey = (chainId: number, target: Address) => `proxyBaseline:${chainId}:${target.toLowerCase()}`;

export async function readImplementation(client: PublicClient, target: Address): Promise<Address | null> {
  const word = await client.getStorageAt({ address: target, slot: EIP1967_IMPL_SLOT });
  if (!word || /^0x0*$/.test(word)) return null;
  return `0x${word.slice(-40)}` as Address;
}

/** Owner action: record the current implementation of an allowlisted, unpinned (proxy) target. */
export async function recordProxyBaseline(client: PublicClient, storage: StorageAdapter, chainId: number, target: Address): Promise<Address> {
  const impl = await readImplementation(client, target);
  if (!impl) throw new Error(`${target} has no EIP-1967 implementation slot; it cannot be allowlisted as a proxy`);
  await storage.set(proxyBaselineKey(chainId, target), impl.toLowerCase());
  return impl;
}

export async function checkProxyUpgrade(client: PublicClient, storage: StorageAdapter, chainId: number, p: Policy, calls: ProposalCall[], codeHashes: CodeHashes): Promise<CheckOutcome> {
  const f: FailedCheck[] = [];
  const targets = [...new Set(calls.map((c) => c.to.toLowerCase()))];
  for (const t of targets) {
    const ti = p.targets.findIndex((x) => eq(x, t));
    if (ti < 0) continue; // not allowlisted: reported by checkRules
    if (!/^0x0+$/.test(p.codeHashes[ti]!)) continue; // pinned code: no upgrade possible
    if (codeHashes[t] === null) continue; // no code (an EOA payee): nothing to upgrade
    const impl = await readImplementation(client, t as Address);
    if (!impl) {
      f.push(fail('proxyUpgrade', `${short(t)} is an allowed contract without pinned code and without an EIP-1967 implementation slot, so an upgrade could not be detected.`, 'Proxy upgrade check'));
      continue;
    }
    const baseline = await storage.get<string>(proxyBaselineKey(chainId, t as Address));
    if (!baseline) f.push(fail('proxyUpgrade', `No baseline is recorded for the proxy ${short(t)}: the owner must record its current implementation before the agent can use it.`, 'Proxy upgrade check'));
    else if (!eq(baseline, impl)) f.push(fail('proxyUpgrade', `The proxy ${short(t)} was upgraded since the owner allowed it (implementation ${short(baseline)} → ${short(impl)}).`, 'Proxy upgrade check'));
  }
  return { check: 'proxyUpgrade', failures: f };
}

// ---------------------------------------------------------------- 9. rate limit (wallet-only)
export const rateKey = (chainId: number, label: string) => `executions:${chainId}:${label}`;
export async function recordExecution(storage: StorageAdapter, chainId: number, label: string, atSec: number): Promise<void> {
  const list = (await storage.get<number[]>(rateKey(chainId, label))) ?? [];
  await storage.set(rateKey(chainId, label), [...list.filter((t) => atSec - t < 3600), atSec]);
}
export async function checkRateLimit(storage: StorageAdapter, chainId: number, label: string, p: Policy, nowSec: number): Promise<CheckOutcome> {
  const list = ((await storage.get<number[]>(rateKey(chainId, label))) ?? []).filter((t) => nowSec - t < 3600);
  if (p.rateLimitPerHour === 0 || list.length < p.rateLimitPerHour) return ok('rateLimit');
  return { check: 'rateLimit', failures: [fail('rateLimit', `The agent already made ${list.length} transactions in the last hour; the owner's limit is ${p.rateLimitPerHour} per hour.`, 'Rate limit')] };
}

// ---------------------------------------------------------------- 10. new contracts (wallet-only)
/** ~7 days of 12 s blocks. */
export const NEW_CONTRACT_AGE_BLOCKS = 50_400n;
export async function checkNewContract(client: PublicClient, p: Policy, calls: ProposalCall[], codeHashes: CodeHashes, latestBlock: bigint): Promise<CheckOutcome> {
  if (!p.blockNewContracts) return ok('newContract');
  const f: FailedCheck[] = [];
  const past = latestBlock > NEW_CONTRACT_AGE_BLOCKS ? latestBlock - NEW_CONTRACT_AGE_BLOCKS : 0n;
  for (const t of [...new Set(calls.map((c) => c.to.toLowerCase()))]) {
    if (codeHashes[t] === null) continue; // EOA
    try {
      const old = await client.getCode({ address: t as Address, blockNumber: past });
      if (!old || old === '0x') f.push(fail('newContract', `${short(t)} is a new contract (it did not exist about 7 days ago); the owner blocks new contracts.`, 'Block new contracts'));
    } catch {
      f.push(fail('newContract', `The age of contract ${short(t)} could not be verified, so it is treated as new.`, 'Block new contracts'));
    }
  }
  return { check: 'newContract', failures: f };
}

// ---------------------------------------------------------------- helpers used by evaluate
const moduleAbi = parseAbi(['function spentPerDay(bytes32,address,uint256) view returns (uint256)']);
export async function readSpentToday(client: PublicClient, module: Address, label: string, tokens: Address[], dayTimestamp: bigint): Promise<Record<string, bigint>> {
  const day = dayTimestamp / 86400n;
  const lh = keccak256(new TextEncoder().encode(label));
  const out: Record<string, bigint> = {};
  for (const t of tokens) out[t.toLowerCase()] = await client.readContract({ address: module, abi: moduleAbi, functionName: 'spentPerDay', args: [lh, t, day] });
  return out;
}

export async function readCodeHashes(client: PublicClient, addrs: Address[]): Promise<CodeHashes> {
  const out: CodeHashes = {};
  for (const a of [...new Set(addrs.map((x) => x.toLowerCase()))]) {
    const code = await client.getCode({ address: a as Address });
    out[a] = code && code !== '0x' ? keccak256(code) : null;
  }
  return out;
}
