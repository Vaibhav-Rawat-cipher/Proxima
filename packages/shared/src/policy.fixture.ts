import type { Policy } from './policy.js';

/**
 * Deterministic sample policy shared by the TS tests and the Solidity round-trip test
 * (contracts/test/fixtures/policy.json is generated from it by `pnpm --filter @blindspot/shared fixture`).
 * Addresses are arbitrary test values, not deployments.
 */
export const SAMPLE_POLICY: Policy = {
  version: 3,
  targets: [
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
    '0x5555555555555555555555555555555555555555',
  ],
  codeHashes: [
    '0xabababababababababababababababababababababababababababababababab',
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000000000000000000000000000000',
  ],
  selectors: [['0xa9059cbb', '0x095ea7b3'], ['0x12345678'], ['0xa22cb465']],
  payees: ['0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444'],
  spenders: ['0x2222222222222222222222222222222222222222'],
  operators: ['0x6666666666666666666666666666666666666666'],
  tokens: [
    '0x1111111111111111111111111111111111111111',
    '0x0000000000000000000000000000000000000000',
    '0x5555555555555555555555555555555555555555',
  ],
  tokenKinds: [0, 0, 1],
  maxOut: [100_000_000n, 10n ** 16n, 1n],
  dailyCap: [500_000_000n, 5n * 10n ** 16n, 2n],
  maxEth: 10n ** 16n,
  rateLimitPerHour: 10,
  askOwnerAbove: 50_000_000n,
  blockNewContracts: true,
};
