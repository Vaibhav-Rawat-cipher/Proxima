import { decodeAbiParameters, getAddress, toEventSelector, type Address, type Hex } from 'viem';
import { ETH, type Effect } from '@blindspot/shared';

export type RawLog = { address: Address; topics: Hex[]; data: Hex };

/**
 * Two sources of native-ETH Transfer logs (both use the ERC-20 Transfer(from, to, value) layout):
 *
 * 1. EIP-7708 "ETH Transfers Emit a Log": a real protocol log from SYSTEM_ADDRESS 0xffff…fffe for every
 *    value-carrying tx, CALL and SELFDESTRUCT. It appears in REAL receipts and in simulations on chains
 *    where the EIP is active (observed on Sepolia, reth v2.7.0, and on an anvil 1.9 fork).
 * 2. eth_simulateV1 `traceTransfers: true`: a synthetic SIMULATION-only log from 0xeeee…eeee
 *    (ethereum/execution-apis docs-api/docs/ethsimulatev1-notes.mdx, "ETH transfer logs").
 *
 * A node can emit both for the same transfer (anvil does), so in simulation EIP-7708 logs win when
 * present and the synthetic ones are ignored (never double-counted). simulate.ts also cross-checks ETH
 * with a real balance read, so a missing or unexpected ETH log can never hide an ETH movement.
 */
export const EIP7708_SYSTEM_ADDRESS: Address = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE';
export const SIMULATE_TRACE_ETH_ADDRESS: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** "receipt": ETH only from EIP-7708 logs. "simulation": EIP-7708 if present, else traceTransfers logs. */
export type LogSource = 'receipt' | 'simulation';

export const TOPIC = {
  Transfer: toEventSelector('Transfer(address,address,uint256)'),
  Approval: toEventSelector('Approval(address,address,uint256)'),
  ApprovalForAll: toEventSelector('ApprovalForAll(address,address,bool)'),
  TransferSingle: toEventSelector('TransferSingle(address,address,address,uint256,uint256)'),
  TransferBatch: toEventSelector('TransferBatch(address,address,address,uint256[],uint256[])'),
} as const;

const addr = (topic: Hex | undefined): Address => getAddress(`0x${(topic ?? '0x').slice(-40)}`);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type DecodedLogs = {
  effects: Effect[];
  /** Logs from tracked tokens that are none of the known token events (SPEC §8: fail closed). */
  unknownLogs: RawLog[];
  /** Spenders / operators seen in Approval or ApprovalForAll logs for the Safe. */
  spendersSeen: Address[];
};

/**
 * Turns logs (from eth_simulateV1 or a real receipt) into the Safe's effects. Logs that do not involve
 * the Safe are ignored, except unrecognised logs from tracked tokens, which are reported as unknownLog.
 */
export function decodeEffects(
  logs: RawLog[],
  safe: Address,
  trackedTokens: Address[],
  source: LogSource,
): DecodedLogs {
  const effects: Effect[] = [];
  const unknownLogs: RawLog[] = [];
  const spendersSeen: Address[] = [];
  const tracked = (a: Address) => trackedTokens.some((t) => eq(t, a));
  const has7708 = logs.some((l) => eq(l.address, EIP7708_SYSTEM_ADDRESS));
  const ethEmitter = source === 'receipt' || has7708 ? EIP7708_SYSTEM_ADDRESS : SIMULATE_TRACE_ETH_ADDRESS;
  const ignored = (l: RawLog) => source === 'simulation' && has7708 && eq(l.address, SIMULATE_TRACE_ETH_ADDRESS);

  for (const log of logs) {
    if (ignored(log)) continue; // synthetic duplicate of an EIP-7708 log
    const t0 = log.topics[0];
    const isEth = eq(log.address, ethEmitter);
    const token = isEth ? ETH : getAddress(log.address);

    if (t0 === TOPIC.Transfer && (log.topics.length === 3 || log.topics.length === 4)) {
      const from = addr(log.topics[1]);
      const to = addr(log.topics[2]);
      // ERC-20 / ETH: value in data. ERC-721: tokenId as 4th topic, no data.
      const nft = log.topics.length === 4;
      const amount = nft ? 1n : decodeAbiParameters([{ type: 'uint256' }], log.data)[0];
      const tokenId = nft ? BigInt(log.topics[3]!) : undefined;
      const base = tokenId === undefined ? {} : { tokenId };
      if (eq(from, safe)) effects.push({ kind: 'out', token, amount, counterparty: to, source: 'log', ...base });
      if (eq(to, safe)) effects.push({ kind: 'in', token, amount, counterparty: from, source: 'log', ...base });
      continue;
    }
    if (t0 === TOPIC.Approval && log.topics.length >= 3) {
      const owner = addr(log.topics[1]);
      const spender = addr(log.topics[2]);
      if (eq(owner, safe)) {
        // ERC-20: amount in data. ERC-721: tokenId as 4th topic (approval of one NFT).
        const nft = log.topics.length === 4;
        const amount = nft ? 1n : decodeAbiParameters([{ type: 'uint256' }], log.data)[0];
        effects.push({ kind: 'approve', token, amount, counterparty: spender, source: 'log', ...(nft ? { tokenId: BigInt(log.topics[3]!) } : {}) });
        spendersSeen.push(spender);
      }
      continue;
    }
    if (t0 === TOPIC.ApprovalForAll && log.topics.length === 3) {
      const owner = addr(log.topics[1]);
      const operator = addr(log.topics[2]);
      if (eq(owner, safe)) {
        const [approved] = decodeAbiParameters([{ type: 'bool' }], log.data);
        effects.push({ kind: 'operator', token, amount: approved ? 1n : 0n, counterparty: operator, source: 'log' });
        spendersSeen.push(operator);
      }
      continue;
    }
    if (t0 === TOPIC.TransferSingle && log.topics.length === 4) {
      const from = addr(log.topics[2]);
      const to = addr(log.topics[3]);
      const [id, value] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], log.data);
      if (eq(from, safe)) effects.push({ kind: 'out', token, amount: value, counterparty: to, source: 'log', tokenId: id });
      if (eq(to, safe)) effects.push({ kind: 'in', token, amount: value, counterparty: from, source: 'log', tokenId: id });
      continue;
    }
    if (t0 === TOPIC.TransferBatch && log.topics.length === 4) {
      const from = addr(log.topics[2]);
      const to = addr(log.topics[3]);
      const [ids, values] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], log.data);
      ids.forEach((id, i) => {
        const value = values[i] ?? 0n;
        if (eq(from, safe)) effects.push({ kind: 'out', token, amount: value, counterparty: to, source: 'log', tokenId: id });
        if (eq(to, safe)) effects.push({ kind: 'in', token, amount: value, counterparty: from, source: 'log', tokenId: id });
      });
      continue;
    }
    if (!isEth && tracked(token)) {
      unknownLogs.push(log);
      effects.push({ kind: 'unknownLog', token, amount: 0n, counterparty: token, source: 'log' });
    }
  }
  return { effects, unknownLogs, spendersSeen: [...new Map(spendersSeen.map((s) => [s.toLowerCase(), s])).values()] };
}
