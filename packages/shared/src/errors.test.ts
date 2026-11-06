import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeErrorResult, parseAbi, toFunctionSelector, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { EXPLAINED_ERRORS, MODULE_ERRORS_ABI, explainModuleRevert } from './errors.js';

const MODULE_SRC = resolve(fileURLToPath(import.meta.url), '../../../../contracts/src/BlindspotModule.sol');
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

/** `error Name(type a, type b);` declarations in the Solidity source, normalised to `Name(type,type)`. */
function declaredErrors(): string[] {
  const src = readFileSync(MODULE_SRC, 'utf8');
  return [...src.matchAll(/^\s*error\s+(\w+)\(([^)]*)\);/gm)].map(([, name, params]) => {
    const types = (params ?? '')
      .split(',')
      .map((p) => p.trim().split(/\s+/)[0])
      .filter(Boolean);
    return `${name}(${types.join(',')})`;
  });
}

const abiSignature = (name: string) => {
  const e = MODULE_ERRORS_ABI.find((x) => x.name === name)!;
  return `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
};

describe('module error explanations', () => {
  it('covers every custom error declared in BlindspotModule.sol, with matching signatures', () => {
    const declared = declaredErrors();
    expect(declared.length).toBe(16);
    for (const sig of declared) {
      const name = sig.slice(0, sig.indexOf('('));
      expect(EXPLAINED_ERRORS, `missing explanation for ${name}`).toContain(name);
      expect(abiSignature(name), `signature drift for ${name}`).toBe(sig);
    }
  });

  it('gives a non-empty plain-language reason for every error', () => {
    const sample: Record<string, readonly unknown[]> = {
      ForbiddenTarget: [A],
      TargetNotAllowed: [A],
      CodeHashMismatch: [A],
      SelectorNotAllowed: ['0x12345678'],
      RecipientNotAllowed: [A],
      SpenderNotAllowed: [A],
      OutflowExceeded: [A, 5n],
      DailyCapExceeded: [A, 5n],
      AllowanceResidue: [A, B, 5n],
      OperatorResidue: [A, B],
      ApprovalResidue: [A, 1n, B],
      BatchSizeInvalid: [9n],
      ExecutionFailed: ['0x'],
    };
    for (const e of MODULE_ERRORS_ABI) {
      const data = encodeErrorResult({ abi: MODULE_ERRORS_ABI, errorName: e.name, args: (sample[e.name] ?? []) as never });
      const r = explainModuleRevert(data);
      expect(r.name).toBe(e.name);
      expect(r.reason.length).toBeGreaterThan(20);
      expect(r.reason).not.toMatch(/undefined/);
    }
  });

  it('explains with the decoded values', () => {
    const data = encodeErrorResult({ abi: MODULE_ERRORS_ABI, errorName: 'RecipientNotAllowed', args: [A] });
    expect(explainModuleRevert(data)).toMatchObject({
      name: 'RecipientNotAllowed',
      rule: 'Allowed recipients',
      reason: `${A} is not one of the owner's approved recipients.`,
    });
    const eth = encodeErrorResult({
      abi: MODULE_ERRORS_ABI,
      errorName: 'OutflowExceeded',
      args: ['0x0000000000000000000000000000000000000000', 10n],
    });
    expect(explainModuleRevert(eth).rule).toBe('Maximum ETH per transaction');
    const empty = encodeErrorResult({ abi: MODULE_ERRORS_ABI, errorName: 'SelectorNotAllowed', args: ['0x00000000'] });
    expect(explainModuleRevert(empty).reason).toMatch(/Sending ETH/);
  });

  it('explains the inner reason of ExecutionFailed (e.g. reentrancy)', () => {
    const inner = encodeErrorResult({ abi: MODULE_ERRORS_ABI, errorName: 'ReentrancyGuardReentrantCall' });
    const data = encodeErrorResult({ abi: MODULE_ERRORS_ABI, errorName: 'ExecutionFailed', args: [inner] });
    expect(explainModuleRevert(data).reason).toMatch(/call back into Blindspot/);
  });

  it('fails closed on Solidity built-in Error(string) and Panic(uint256) without throwing', () => {
    // Error("GS104") as the Safe reverts when a non-module calls execTransactionFromModule
    const gs104 = encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['GS104'] });
    expect(explainModuleRevert(gs104)).toMatchObject({ name: 'Error', reason: expect.stringMatching(/"GS104".*treated as blocked/) });
    const panic = encodeErrorResult({ abi: parseAbi(['error Panic(uint256)']), errorName: 'Panic', args: [0x11n] });
    expect(explainModuleRevert(panic)).toMatchObject({ name: 'Panic', reason: expect.stringMatching(/panic code 17.*treated as blocked/) });
    // nested inside ExecutionFailed: outer reason stays, no throw
    const outer = encodeErrorResult({ abi: MODULE_ERRORS_ABI, errorName: 'ExecutionFailed', args: [gs104] });
    expect(explainModuleRevert(outer).name).toBe('ExecutionFailed');
  });

  it('fails closed on unknown revert data', () => {
    const unknown = toFunctionSelector('SomethingElse()') as Hex;
    expect(explainModuleRevert(unknown)).toMatchObject({ name: 'Unknown' });
    expect(explainModuleRevert('0x').name).toBe('Unknown');
    expect(explainModuleRevert('0x08c379a0').reason).toMatch(/treated as blocked/);
  });
});
