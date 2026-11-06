import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { ETH, explainModuleRevert, type Effect, type ModuleRevert } from '@blindspot/shared';
import type { Deployment } from '../deployment.js';
import { decodeEffects, type RawLog } from './effects.js';

const moduleAbi = parseAbi([
  'function execute(string label, address to, uint256 value, bytes data) returns (bytes)',
  'function executeBatch(string label, (address to, uint256 value, bytes data)[] calls) returns (bytes[])',
]);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
const nftAbi = parseAbi(['function isApprovedForAll(address,address) view returns (bool)']);

export type Call = { to: Address; value: bigint; data: Hex };
/** 0 = ERC-20 (or ETH at address(0)), 1 = ERC-721, 2 = ERC-1155 (same as Policy.tokenKinds). */
export type TrackedToken = { address: Address; kind: 0 | 1 | 2 };

export type SimulationInput = {
  deployment: Deployment;
  agent: Address;
  label: string;
  calls: Call[];
  /** Tokens whose balances / approvals are checked (normally policy.tokens). ETH is always traced. */
  tokens: TrackedToken[];
  /** Addresses whose leftover approvals are read after the call (normally policy.spenders + targets). */
  spenders: Address[];
  /** Simulate on top of this block (default: latest). */
  block?: bigint;
};

export type SimulationResult = {
  /** The module call succeeded in simulation. */
  success: boolean;
  /** Plain-language revert when it did not (module errors, Safe/token errors, or Unknown = fail closed). */
  revert?: ModuleRevert & { data: Hex };
  gasUsed: bigint;
  /** Block the simulation ran on top of (simulated block number = block + 1). */
  baseBlock: bigint;
  /** Effects from logs (and postState corrections when balances disagree with the logs). */
  effects: Effect[];
  unknownLogs: RawLog[];
  balances: { token: Address; before: bigint; after: bigint }[];
  /** True when every tracked token's balance change equals the net of its log effects. */
  balancesMatchLogs: boolean;
  leftoverAllowances: { token: Address; spender: Address; amount: bigint }[];
  leftoverOperators: { token: Address; operator: Address }[];
  logs: RawLog[];
  /** The exact calldata to module.execute / executeBatch (what the agent would sign). */
  moduleCalldata: Hex;
};

export function moduleCalldata(label: string, calls: Call[]): Hex {
  if (calls.length === 0) throw new Error('no calls');
  if (calls.length === 1) {
    const c = calls[0]!;
    return encodeFunctionData({ abi: moduleAbi, functionName: 'execute', args: [label, c.to, c.value, c.data] });
  }
  return encodeFunctionData({ abi: moduleAbi, functionName: 'executeBatch', args: [label, calls] });
}

type SimCall = { status: Hex; gasUsed: Hex; returnData: Hex; logs?: RawLog[]; error?: { code: number; message: string; data?: Hex } };
type SimBlock = { number: Hex; calls: SimCall[] };

/**
 * SPEC §8 simulation: one eth_simulateV1 request, one simulated block —
 *   [balanceOf(safe) per tracked token] -> module.execute/executeBatch from the agent ->
 *   [balanceOf(safe) again, allowance(safe, x), isApprovedForAll(safe, x)].
 * ETH movements come from traceTransfers. If logs reveal a spender we did not read, re-simulate once
 * with it included (so leftover approvals are always measured, never assumed).
 */
export async function simulateProposal(client: PublicClient, input: SimulationInput): Promise<SimulationResult> {
  const first = await runOnce(client, input, input.spenders);
  const known = new Set(input.spenders.map((s) => s.toLowerCase()));
  const extra = first.spendersSeen.filter((s) => !known.has(s.toLowerCase()));
  if (extra.length === 0) return first.result;
  return (await runOnce(client, input, [...input.spenders, ...extra])).result;
}

async function runOnce(client: PublicClient, input: SimulationInput, spenders: Address[]) {
  const safe = input.deployment.safeAddress;
  const erc20 = input.tokens.filter((t) => t.kind === 0 && t.address !== ETH);
  const nft721 = input.tokens.filter((t) => t.kind === 1);
  const nftAll = input.tokens.filter((t) => t.kind === 1 || t.kind === 2);
  const balanceTokens = [...erc20, ...nft721]; // ERC-1155 balances are per id: not measured (honest limit)
  const candidates = dedupe([...spenders]);
  const from = input.agent;
  const read = (to: Address, data: Hex) => ({ from, to, data });

  // ETH is always measured: a balance-reader contract placed by a simulation-only state override.
  const balanceRead = (t: TrackedToken) =>
    t.address === ETH
      ? read(ETH_BALANCE_READER, encodeAbiParameters([{ type: 'address' }], [safe]))
      : read(t.address, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [safe] }));
  const measured: TrackedToken[] = [{ address: ETH, kind: 0 }, ...balanceTokens];
  const pre = measured.map(balanceRead);
  const calldata = moduleCalldata(input.label, input.calls);
  const main = { from, to: input.deployment.module, data: calldata };
  const post = measured.map(balanceRead);
  const allowanceReads = erc20.flatMap((t) => candidates.map((s) => ({ t, s, call: read(t.address, encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [safe, s] })) })));
  const operatorReads = nftAll.flatMap((t) => candidates.map((s) => ({ t, s, call: read(t.address, encodeFunctionData({ abi: nftAbi, functionName: 'isApprovedForAll', args: [safe, s] })) })));

  const calls = [...pre, main, ...post, ...allowanceReads.map((r) => r.call), ...operatorReads.map((r) => r.call)];
  const blockTag = input.block === undefined ? 'latest' : numberToHex(input.block);
  const blocks = (await client.request({
    method: 'eth_simulateV1' as never,
    params: [
      { blockStateCalls: [{ stateOverrides: { [ETH_BALANCE_READER]: { code: ETH_BALANCE_READER_CODE } }, calls }], traceTransfers: true, validation: false },
      blockTag,
    ] as never,
  })) as unknown as SimBlock[];
  const out = blocks[0]?.calls ?? [];
  if (out.length !== calls.length) throw new Error(`eth_simulateV1 returned ${out.length} results for ${calls.length} calls`);

  const word = (c: SimCall | undefined, type: 'uint256' | 'bool') => {
    if (!c || c.status !== '0x1') throw new Error('a balance/approval read failed in simulation (fail closed)');
    return decodeAbiParameters([{ type }], c.returnData)[0] as bigint | boolean;
  };
  let i = 0;
  const before = pre.map(() => word(out[i++], 'uint256') as bigint);
  const m = out[i++]!;
  const after = post.map(() => word(out[i++], 'uint256') as bigint);
  const allowances = allowanceReads.map((r) => ({ token: r.t.address, spender: r.s, amount: word(out[i++], 'uint256') as bigint }));
  const operators = operatorReads.map((r) => ({ token: r.t.address, operator: r.s, on: word(out[i++], 'bool') as boolean }));

  const success = m.status === '0x1';
  const logs = (m.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data }));
  const decoded = decodeEffects(success ? logs : [], safe, input.tokens.map((t) => t.address), 'simulation');
  const effects = [...decoded.effects];

  // Cross-check balance changes (ETH included) against the logs; any difference becomes a postState effect.
  const balances = measured.map((t, k) => ({ token: t.address, before: before[k]!, after: after[k]! }));
  let balancesMatchLogs = true;
  if (success) {
    for (const b of balances) {
      const logNet = decoded.effects
        .filter((e) => e.token.toLowerCase() === b.token.toLowerCase() && (e.kind === 'in' || e.kind === 'out'))
        .reduce((acc, e) => acc + (e.kind === 'in' ? e.amount : -e.amount), 0n);
      const delta = b.after - b.before;
      if (delta !== logNet) {
        balancesMatchLogs = false;
        const diff = delta - logNet;
        effects.push({ kind: diff < 0n ? 'out' : 'in', token: b.token, amount: diff < 0n ? -diff : diff, counterparty: b.token, source: 'postState' });
      }
    }
  }

  const revertData = m.returnData && m.returnData !== '0x' ? m.returnData : (m.error?.data ?? '0x');
  const result: SimulationResult = {
    success,
    ...(success ? {} : { revert: { ...explainModuleRevert(revertData), data: revertData } }),
    gasUsed: BigInt(m.gasUsed),
    baseBlock: BigInt(blocks[0]!.number) - 1n,
    effects,
    unknownLogs: decoded.unknownLogs,
    balances,
    balancesMatchLogs,
    leftoverAllowances: success ? allowances.filter((a) => a.amount !== 0n) : [],
    leftoverOperators: success ? operators.filter((o) => o.on).map(({ token, operator }) => ({ token, operator })) : [],
    logs,
    moduleCalldata: calldata,
  };
  return { result, spendersSeen: decoded.spendersSeen };
}

const dedupe = (xs: Address[]) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()];

/**
 * Simulation-only helper contract (eth_simulateV1 stateOverrides; never deployed):
 *   PUSH1 0 CALLDATALOAD BALANCE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN  ->  returns balance(address arg).
 */
export const ETH_BALANCE_READER: Address = '0x00000000000000000000000000000000b1a5ba1e';
export const ETH_BALANCE_READER_CODE: Hex = '0x6000353160005260206000f3';
