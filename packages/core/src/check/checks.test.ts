// Pure-function checks (no chain): calldata decoding, look-alike, claim vs reality, leftovers.
import { encodeFunctionData, parseAbi, type Address } from 'viem';
import { ETH, type Effect } from '@blindspot/shared';
import { describe, expect, it } from 'vitest';
import { argsOf, checkClaimVsReality, decodeCallParties, intendedOutflows, looksLike, selectorOf } from './checks.js';

const A: Address = '0x22dbbC1A9341064b3CA3e7c016D5cc22383dDe41';
const TOKEN: Address = '0x240b0316Df57887DBBE58b586508b19e633a14aa';
const SAFE: Address = '0x308924321a579844C0d7FA46Ea49dBec80a2a3F7';

describe('calldata decoding', () => {
  it('regression: a no-argument function (exactly 4 bytes of calldata) decodes without error', () => {
    const poke = encodeFunctionData({ abi: parseAbi(['function poke()']), functionName: 'poke' });
    expect(argsOf(poke)).toBe('0x');
    expect(decodeCallParties({ to: TOKEN, value: 0n, data: poke })).toEqual({});
    expect(intendedOutflows([{ to: TOKEN, value: 0n, data: poke }], SAFE)).toEqual([]);
  });
  it('selectors: empty calldata, short calldata, normal', () => {
    expect(selectorOf('0x')).toBe('0x00000000');
    expect(selectorOf('0xa905')).toBe('short');
    expect(selectorOf('0xa9059cbb00')).toBe('0xa9059cbb');
  });
  it('recipient of transfer / spender of approve / plain ETH', () => {
    const t = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [A, 5n] });
    const a = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [A, 5n] });
    expect(decodeCallParties({ to: TOKEN, value: 0n, data: t }).recipient).toBe(A);
    expect(decodeCallParties({ to: TOKEN, value: 0n, data: a }).spender).toBe(A);
    expect(decodeCallParties({ to: A, value: 1n, data: '0x' }).recipient).toBe(A);
  });
  it('undecodable arguments throw (reported by the rules check, never ignored)', () => {
    expect(() => decodeCallParties({ to: TOKEN, value: 0n, data: '0xa9059cbb1234' })).toThrow();
  });
});

describe('look-alike', () => {
  it('same first 3 + last 3 hex but different address', () => {
    expect(looksLike('0x22d0000000000000000000000000000000000e41', A)).toBe(true);
    expect(looksLike(A, A)).toBe(false);
    expect(looksLike('0x22e0000000000000000000000000000000000e41', A)).toBe(false);
  });
});

describe('claim vs reality', () => {
  const out = (amount: bigint, to: Address = A): Effect => ({ kind: 'out', token: TOKEN, amount, counterparty: to, source: 'log' });
  const d = (amount: bigint, to: Address = A) => ({ kind: 'out' as const, token: TOKEN, amount, counterparty: to });
  it('exact and within 1% pass; more than 1% fails', () => {
    expect(checkClaimVsReality([d(100n)], [out(100n)]).failures).toEqual([]);
    expect(checkClaimVsReality([d(1000n)], [out(1009n)]).failures).toEqual([]);
    expect(checkClaimVsReality([d(1000n)], [out(1020n)]).failures[0]?.detail).toMatch(/off by more than 1%/);
  });
  it('undeclared effect and declared-but-missing effect both fail', () => {
    const r = checkClaimVsReality([], [out(1n)]);
    expect(r.undeclared).toHaveLength(1);
    expect(checkClaimVsReality([d(1n)], []).failures[0]?.detail).toMatch(/no such effect/);
  });
  it('ETH effects compare like tokens', () => {
    const eth: Effect = { kind: 'out', token: ETH, amount: 10n, counterparty: A, source: 'log' };
    expect(checkClaimVsReality([{ kind: 'out', token: ETH, amount: 10n, counterparty: A }], [eth]).failures).toEqual([]);
  });
});
