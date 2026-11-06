import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { POLICY_ABI, PolicyError, decodePolicy, encodePolicy, type Policy } from './policy.js';
import { SAMPLE_POLICY } from './policy.fixture.js';

const withChange = (patch: Partial<Policy>): Policy => ({ ...SAMPLE_POLICY, ...patch });

describe('policy codec', () => {
  it('round-trips the sample policy', () => {
    const decoded = decodePolicy(encodePolicy(SAMPLE_POLICY));
    expect(decoded).toEqual({
      ...SAMPLE_POLICY,
      // viem returns checksummed addresses
      targets: decoded.targets,
      payees: decoded.payees,
      spenders: decoded.spenders,
      operators: decoded.operators,
      tokens: decoded.tokens,
    });
    expect(decoded.targets.map((a) => a.toLowerCase())).toEqual(SAMPLE_POLICY.targets);
    expect(decoded.tokens.map((a) => a.toLowerCase())).toEqual(SAMPLE_POLICY.tokens);
  });

  it('matches the committed Solidity fixture byte for byte', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(fileURLToPath(import.meta.url), '../../../../contracts/test/fixtures/policy.json'), 'utf8'),
    ) as { encoded: Hex };
    expect(encodePolicy(SAMPLE_POLICY)).toBe(fixture.encoded);
  });

  it('rejects an empty record', () => {
    expect(() => decodePolicy('0x')).toThrow(PolicyError);
  });

  it('rejects garbage bytes', () => {
    expect(() => decodePolicy('0xdeadbeef')).toThrow(PolicyError);
  });

  it('rejects trailing bytes (non-canonical)', () => {
    expect(() => decodePolicy(`${encodePolicy(SAMPLE_POLICY)}00`)).toThrow(PolicyError);
  });

  it('rejects mismatched target arrays', () => {
    expect(() => encodePolicy(withChange({ codeHashes: [] }))).toThrow(/codeHashes length/);
    expect(() => encodePolicy(withChange({ selectors: [[]] }))).toThrow(/selectors length/);
  });

  it('rejects mismatched token arrays', () => {
    expect(() => encodePolicy(withChange({ maxOut: [1n] }))).toThrow(/maxOut length/);
    expect(() => encodePolicy(withChange({ dailyCap: [1n] }))).toThrow(/dailyCap length/);
  });

  it('rejects maxOut above dailyCap', () => {
    expect(() => encodePolicy(withChange({ maxOut: [10n ** 18n, 1n, 1n] }))).toThrow(/exceeds dailyCap/);
  });

  it('rejects mismatched tokenKinds', () => {
    expect(() => encodePolicy(withChange({ tokenKinds: [0, 0] }))).toThrow(/tokenKinds length/);
  });

  it('rejects an unknown token kind', () => {
    expect(() => encodePolicy(withChange({ tokenKinds: [0, 0, 3 as never] }))).toThrow(/must be 0, 1 or 2/);
  });

  it('rejects ETH (address 0) with a non-ERC20 kind', () => {
    expect(() => encodePolicy(withChange({ tokenKinds: [0, 1, 1] }))).toThrow(/is ETH/);
  });

  it('rejects ERC-1155 caps (not enforceable on-chain)', () => {
    expect(() => encodePolicy(withChange({ tokenKinds: [0, 0, 2] }))).toThrow(/ERC-1155/);
    expect(() =>
      encodePolicy(withChange({ tokenKinds: [0, 0, 2], maxOut: [100_000_000n, 10n ** 16n, 0n], dailyCap: [500_000_000n, 5n * 10n ** 16n, 0n] })),
    ).not.toThrow();
  });

  it('rejects a token-moving function on a contract not listed in tokens', () => {
    // target 0x2222.. (not a token) gains approve()
    expect(() => encodePolicy(withChange({ selectors: [['0xa9059cbb'], ['0x095ea7b3'], ['0xa22cb465']] }))).toThrow(
      /targets\[1\] allows a token-moving function/,
    );
    // every listed token-moving selector is covered
    for (const sel of ['0xa9059cbb', '0x23b872dd', '0x42842e0e', '0xb88d4fde', '0xf242432a', '0x2eb2c2d6', '0x095ea7b3', '0x39509351', '0xa22cb465'] as const)
      expect(() => encodePolicy(withChange({ selectors: [['0xa9059cbb'], [sel], ['0xa22cb465']] }))).toThrow(
        /token-moving/,
      );
  });

  it('rejects version 0', () => {
    expect(() => encodePolicy(withChange({ version: 0 }))).toThrow(/version/);
  });

  it('rejects inconsistent data that is valid ABI', () => {
    const bad = encodeAbiParameters(POLICY_ABI, [{ ...SAMPLE_POLICY, codeHashes: [] }]);
    expect(() => decodePolicy(bad)).toThrow(/codeHashes length/);
  });
});
