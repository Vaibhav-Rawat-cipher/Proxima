import { encodeAbiParameters, pad, type Address, type Hex } from 'viem';
import { ETH } from '@blindspot/shared';
import { describe, expect, it } from 'vitest';
import { EIP7708_SYSTEM_ADDRESS, SIMULATE_TRACE_ETH_ADDRESS, TOPIC, decodeEffects, type RawLog } from './effects.js';

// decodeEffects is a pure function over log data; these logs are built with the real event encodings.
const SAFE: Address = '0x308924321a579844C0d7FA46Ea49dBec80a2a3F7';
const TOKEN: Address = '0x240b0316Df57887DBBE58b586508b19e633a14aa';
const NFT: Address = '0x5555555555555555555555555555555555555555';
const MULTI: Address = '0x6666666666666666666666666666666666666666';
const A: Address = '0x22dbbC1A9341064b3CA3e7c016D5cc22383dDe41';
const B: Address = '0xc7F3D37B90d2Ef6dBFD419B71354F74132c619B4';
const t = (a: Address) => pad(a, { size: 32 }).toLowerCase() as Hex;
const u = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n]);
const log = (address: Address, topics: Hex[], data: Hex = '0x'): RawLog => ({ address, topics, data });
const ethOut = (emitter: Address, amount: bigint) => log(emitter, [TOPIC.Transfer, t(SAFE), t(A)], u(amount));

describe('decodeEffects: tokens', () => {
  it('ERC-20 transfer out of and into the Safe', () => {
    const r = decodeEffects([log(TOKEN, [TOPIC.Transfer, t(SAFE), t(A)], u(5n)), log(TOKEN, [TOPIC.Transfer, t(B), t(SAFE)], u(7n))], SAFE, [TOKEN], 'receipt');
    expect(r.effects).toEqual([
      { kind: 'out', token: TOKEN, amount: 5n, counterparty: A, source: 'log' },
      { kind: 'in', token: TOKEN, amount: 7n, counterparty: B, source: 'log' },
    ]);
  });

  it('approvals: ERC-20 Approval, ERC-721 single approval, ApprovalForAll on and off', () => {
    const r = decodeEffects(
      [
        log(TOKEN, [TOPIC.Approval, t(SAFE), t(A)], u(99n)),
        log(NFT, [TOPIC.Approval, t(SAFE), t(B), pad('0x07', { size: 32 })]),
        log(NFT, [TOPIC.ApprovalForAll, t(SAFE), t(A)], encodeAbiParameters([{ type: 'bool' }], [true])),
        log(NFT, [TOPIC.ApprovalForAll, t(SAFE), t(B)], encodeAbiParameters([{ type: 'bool' }], [false])),
      ],
      SAFE,
      [TOKEN, NFT],
      'receipt',
    );
    expect(r.effects).toEqual([
      { kind: 'approve', token: TOKEN, amount: 99n, counterparty: A, source: 'log' },
      { kind: 'approve', token: NFT, amount: 1n, counterparty: B, source: 'log', tokenId: 7n },
      { kind: 'operator', token: NFT, amount: 1n, counterparty: A, source: 'log' },
      { kind: 'operator', token: NFT, amount: 0n, counterparty: B, source: 'log' },
    ]);
    expect(r.spendersSeen).toEqual([A, B]);
  });

  it('ERC-721 transfer (tokenId in topics)', () => {
    const r = decodeEffects([log(NFT, [TOPIC.Transfer, t(SAFE), t(A), pad('0x2a', { size: 32 })])], SAFE, [NFT], 'receipt');
    expect(r.effects).toEqual([{ kind: 'out', token: NFT, amount: 1n, counterparty: A, source: 'log', tokenId: 42n }]);
  });

  it('ERC-1155 TransferSingle and TransferBatch', () => {
    const single = log(MULTI, [TOPIC.TransferSingle, t(A), t(SAFE), t(B)], encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [3n, 4n]));
    const batch = log(MULTI, [TOPIC.TransferBatch, t(A), t(SAFE), t(B)], encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[1n, 2n], [10n, 20n]]));
    const r = decodeEffects([single, batch], SAFE, [MULTI], 'receipt');
    expect(r.effects).toEqual([
      { kind: 'out', token: MULTI, amount: 4n, counterparty: B, source: 'log', tokenId: 3n },
      { kind: 'out', token: MULTI, amount: 10n, counterparty: B, source: 'log', tokenId: 1n },
      { kind: 'out', token: MULTI, amount: 20n, counterparty: B, source: 'log', tokenId: 2n },
    ]);
  });

  it('fails closed: an unrecognised log from a tracked token becomes unknownLog', () => {
    const weird = log(TOKEN, ['0x1234567812345678123456781234567812345678123456781234567812345678'], '0x');
    const r = decodeEffects([weird], SAFE, [TOKEN], 'simulation');
    expect(r.unknownLogs).toEqual([weird]);
    expect(r.effects).toEqual([{ kind: 'unknownLog', token: TOKEN, amount: 0n, counterparty: TOKEN, source: 'log' }]);
  });

  it('ignores logs that do not involve the Safe or a tracked token', () => {
    const r = decodeEffects(
      [log(TOKEN, [TOPIC.Transfer, t(A), t(B)], u(1n)), log(A, ['0x1234567812345678123456781234567812345678123456781234567812345678'])],
      SAFE,
      [TOKEN],
      'simulation',
    );
    expect(r.effects).toEqual([]);
    expect(r.unknownLogs).toEqual([]);
  });
});

describe('decodeEffects: native ETH (EIP-7708 vs eth_simulateV1 traceTransfers)', () => {
  const one = [{ kind: 'out', token: ETH, amount: 10n ** 15n, counterparty: A, source: 'log' }];

  it('real receipt: the EIP-7708 SYSTEM_ADDRESS log is ETH', () => {
    expect(decodeEffects([ethOut(EIP7708_SYSTEM_ADDRESS, 10n ** 15n)], SAFE, [TOKEN], 'receipt').effects).toEqual(one);
  });

  it('real receipt: a 0xeeee… log is not ETH (traceTransfers logs never appear in receipts)', () => {
    const r = decodeEffects([ethOut(SIMULATE_TRACE_ETH_ADDRESS, 10n ** 15n)], SAFE, [TOKEN], 'receipt');
    expect(r.effects.every((e) => e.token !== ETH)).toBe(true);
  });

  it('simulation, node emits both (anvil): counted once, never twice', () => {
    const r = decodeEffects([ethOut(SIMULATE_TRACE_ETH_ADDRESS, 10n ** 15n), ethOut(EIP7708_SYSTEM_ADDRESS, 10n ** 15n)], SAFE, [TOKEN], 'simulation');
    expect(r.effects).toEqual(one);
  });

  it('simulation, node emits only EIP-7708 (reth on Sepolia)', () => {
    expect(decodeEffects([ethOut(EIP7708_SYSTEM_ADDRESS, 10n ** 15n)], SAFE, [TOKEN], 'simulation').effects).toEqual(one);
  });

  it('simulation, node emits only traceTransfers logs (chain without EIP-7708)', () => {
    expect(decodeEffects([ethOut(SIMULATE_TRACE_ETH_ADDRESS, 10n ** 15n)], SAFE, [TOKEN], 'simulation').effects).toEqual(one);
  });
});
