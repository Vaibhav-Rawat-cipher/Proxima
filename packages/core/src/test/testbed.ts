// Testbed scenarios (test.blindspot-demo.eth on Sepolia), shared by the live and the local-fork tests so
// both run exactly the same proposals.
import { encodeFunctionData, getAddress, parseAbi, type Address } from 'viem';
import type { Effect, Proposal, Verdict, CheckName } from '@blindspot/shared';
import { config } from './live.js';

const T = config.testbed;
export const TB = {
  label: T.agentLabel as string,
  agent: getAddress(config.agents.demo.address),
  dai: getAddress(config.ens.MockDAI),
  usdc: getAddress(config.ens.MockUSDC),
  silent: getAddress(T.silentToken),
  proxyV1: getAddress(T.proxyV1),
  proxyUpgraded: getAddress(T.proxyUpgraded),
  depositV1Impl: getAddress(T.depositV1Impl),
  pool: getAddress(T.simplePool),
  vendor1: getAddress(config.payees.vendor1),
};

const erc20 = parseAbi(['function transfer(address,uint256)', 'function approve(address,uint256)']);
const testAbi = parseAbi(['function poke()', 'function deposit(uint256)', 'function swap(address tokenIn, uint256 amountIn, uint256 minOut) returns (uint256)']);
const DAI = 10n ** 18n;
const e = (kind: Effect['kind'], token: Address, amount: bigint, counterparty: Address): Omit<Effect, 'source'> => ({ kind, token, amount, counterparty });
let n = 0;
const proposal = (calls: Proposal['calls'], declared: Proposal['declaredEffects']): Proposal => ({ id: `tb${++n}`, origin: 'agent', calls, declaredEffects: declared, reason: 'testbed', inputsUsed: [] });

export type Scenario = {
  name: string;
  proposal: Proposal;
  /** Proxy baseline to put in wallet storage before evaluating: 'record' = read it from chain now. */
  baseline?: { target: Address; impl: Address | 'record' };
  expect: { verdict: Verdict; failed?: CheckName[]; detail?: RegExp; modulePreview: 'passes' | 'fails' };
};

const deposit = (proxy: Address) =>
  proposal(
    [
      { to: TB.dai, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [proxy, 5n * DAI] }) },
      { to: proxy, value: 0n, data: encodeFunctionData({ abi: testAbi, functionName: 'deposit', args: [5n * DAI] }) },
    ],
    [e('approve', TB.dai, 5n * DAI, proxy), e('out', TB.dai, 5n * DAI, proxy)],
  );

export const scenarios = (): Scenario[] => [
  {
    name: 'A silent token: balance moves without an event -> BLOCK (the module alone would allow it)',
    proposal: proposal([{ to: TB.silent, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [TB.vendor1, 5_000_000n] }) }], [e('out', TB.silent, 5_000_000n, TB.vendor1)]),
    // No event means no evidence of the destination, so claim-vs-reality fails too (two independent checks).
    expect: { verdict: 'BLOCK', failed: ['simulation', 'claimVsReality'], detail: /hidden balance change/, modulePreview: 'passes' },
  },
  {
    name: 'B poke(): unrecognised event from a tracked token -> BLOCK',
    proposal: proposal([{ to: TB.silent, value: 0n, data: encodeFunctionData({ abi: testAbi, functionName: 'poke' }) }], []),
    expect: { verdict: 'BLOCK', failed: ['simulation'], detail: /does not recognise/, modulePreview: 'passes' },
  },
  {
    name: 'C deposit into proxyV1 with its V1 baseline recorded -> ALLOW',
    proposal: deposit(TB.proxyV1),
    baseline: { target: TB.proxyV1, impl: 'record' },
    expect: { verdict: 'ALLOW', modulePreview: 'passes' },
  },
  {
    name: 'D deposit into proxyUpgraded, allowlisted while on V1 -> BLOCK proxyUpgrade (the module alone would allow it)',
    proposal: deposit(TB.proxyUpgraded),
    baseline: { target: TB.proxyUpgraded, impl: TB.depositV1Impl },
    // The malicious V2 sends the deposit to the proxy admin, not the proxy: claim-vs-reality catches it independently.
    expect: { verdict: 'BLOCK', failed: ['proxyUpgrade', 'claimVsReality'], detail: /was upgraded since the owner allowed it/, modulePreview: 'passes' },
  },
  {
    name: 'E deposit into proxyUpgraded with no baseline recorded -> BLOCK proxyUpgrade',
    proposal: deposit(TB.proxyUpgraded),
    expect: { verdict: 'BLOCK', failed: ['proxyUpgrade', 'claimVsReality'], detail: /No baseline is recorded/, modulePreview: 'passes' },
  },
  {
    name: 'F approve + swap 10 MockDAI -> 10 MockUSDC on SimplePool -> ALLOW',
    proposal: proposal(
      [
        { to: TB.dai, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [TB.pool, 10n * DAI] }) },
        { to: TB.pool, value: 0n, data: encodeFunctionData({ abi: testAbi, functionName: 'swap', args: [TB.dai, 10n * DAI, 10_000_000n] }) },
      ],
      [e('approve', TB.dai, 10n * DAI, TB.pool), e('out', TB.dai, 10n * DAI, TB.pool), e('in', TB.usdc, 10_000_000n, TB.pool)],
    ),
    expect: { verdict: 'ALLOW', modulePreview: 'passes' },
  },
  {
    name: 'G isolation: the testbed agent cannot move MockUSDC -> BLOCK',
    proposal: proposal([{ to: TB.usdc, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [TB.vendor1, 1_000_000n] }) }], [e('out', TB.usdc, 1_000_000n, TB.vendor1)]),
    expect: { verdict: 'BLOCK', failed: ['rules', 'modulePreview'], modulePreview: 'fails' },
  },
];
