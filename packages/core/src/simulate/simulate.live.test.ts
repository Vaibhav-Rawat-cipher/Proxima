import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from 'viem';
import { ETH } from '@blindspot/shared';
import { describe, expect, it } from 'vitest';
import { clientFor } from '../chain.js';
import { deploymentFromConfig } from '../deployment.js';
import { readPolicy } from '../ens/reader.js';
import { config, directRpc, hasRpc } from '../test/live.js';
import { decodeEffects } from './effects.js';
import { simulateProposal, type SimulationInput } from './simulate.js';

// The real agent payment from Step 1 (SetupFinal): 1 MockUSDC from the Safe to vendor1, mined in block 12071559.
const REAL_PAYMENT_TX: Hex = '0x691588f6442e62396f9f83d80af55f3f17f2a5559398f78289a9a8d5c13a08de';
const transfer = (to: Address, amount: bigint) =>
  encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [to, amount] });

describe.skipIf(!hasRpc)('simulation against live Sepolia', { timeout: 60_000 }, () => {
  const client = clientFor(directRpc());
  const d = deploymentFromConfig(config);
  const agent = config.agents.demo.address as Address;
  const vendor1 = getAddress(config.payees.vendor1);
  const usdc = getAddress(config.ens.MockUSDC);

  async function inputFor(calls: SimulationInput['calls'], block?: bigint): Promise<SimulationInput> {
    const { policy } = await readPolicy(client, d, 'demo');
    return {
      deployment: d,
      agent,
      label: 'demo',
      calls,
      tokens: policy.tokens.map((a, i) => ({ address: a, kind: (policy.tokenKinds[i] ?? 0) as 0 | 1 | 2 })),
      spenders: [...policy.spenders, ...policy.targets],
      ...(block === undefined ? {} : { block }),
    };
  }

  it('simulated effects equal the real effects of the real agent payment (clean transfer)', async () => {
    const receipt = await client.getTransactionReceipt({ hash: REAL_PAYMENT_TX });
    const baseBlock = receipt.blockNumber - 1n;
    const sim = await simulateProposal(client, await inputFor([{ to: usdc, value: 0n, data: transfer(vendor1, 1_000_000n) }], baseBlock));

    // What actually happened on-chain, decoded with the same decoder.
    const realLogs = receipt.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data }));
    const real = decodeEffects(realLogs, d.safeAddress, [usdc, ETH], 'receipt');

    expect(sim.success).toBe(true);
    expect(sim.baseBlock).toBe(baseBlock);
    expect(sim.effects).toEqual(real.effects);
    expect(sim.effects).toEqual([{ kind: 'out', token: usdc, amount: 1_000_000n, counterparty: vendor1, source: 'log' }]);
    expect(sim.logs.map((l) => ({ ...l, address: getAddress(l.address) }))).toEqual(realLogs.map((l) => ({ ...l, address: getAddress(l.address) })));
    expect(sim.gasUsed).toBe(receipt.gasUsed);
    expect(sim.balances).toEqual([
      { token: ETH, before: 10_000_000_000_000_000n, after: 10_000_000_000_000_000n }, // Safe ETH unchanged
      { token: usdc, before: 100_000_000n, after: 99_000_000n },
    ]);
    expect(sim.balancesMatchLogs).toBe(true);
    expect(sim.leftoverAllowances).toEqual([]);
    expect(sim.unknownLogs).toEqual([]);
  });

  it('an allowed payment simulates as success on current state (and is never sent)', async () => {
    const sim = await simulateProposal(client, await inputFor([{ to: usdc, value: 0n, data: transfer(vendor1, 2_000_000n) }]));
    expect(sim.success).toBe(true);
    expect(sim.effects).toEqual([{ kind: 'out', token: usdc, amount: 2_000_000n, counterparty: vendor1, source: 'log' }]);
  });

  it('an unlisted recipient is a failed simulation with the module reason', async () => {
    const attacker: Address = '0x000000000000000000000000000000000000dEaD';
    const sim = await simulateProposal(client, await inputFor([{ to: usdc, value: 0n, data: transfer(attacker, 1_000_000n) }]));
    expect(sim.success).toBe(false);
    expect(sim.revert?.name).toBe('RecipientNotAllowed');
    expect(sim.revert?.rule).toBe('Allowed recipients');
    expect(sim.effects).toEqual([]);
  });

  it('an over-cap payment is a failed simulation with OutflowExceeded', async () => {
    const sim = await simulateProposal(client, await inputFor([{ to: usdc, value: 0n, data: transfer(vendor1, 26_000_000n) }]));
    expect(sim.success).toBe(false);
    expect(sim.revert?.name).toBe('OutflowExceeded');
  });

  it('a batch of two payments simulates both effects', async () => {
    const vendor2 = getAddress(config.payees.vendor2);
    const sim = await simulateProposal(
      client,
      await inputFor([
        { to: usdc, value: 0n, data: transfer(vendor1, 1_000_000n) },
        { to: usdc, value: 0n, data: transfer(vendor2, 2_000_000n) },
      ]),
    );
    expect(sim.success).toBe(true);
    expect(sim.effects).toEqual([
      { kind: 'out', token: usdc, amount: 1_000_000n, counterparty: vendor1, source: 'log' },
      { kind: 'out', token: usdc, amount: 2_000_000n, counterparty: vendor2, source: 'log' },
    ]);
    expect(sim.balancesMatchLogs).toBe(true);
  });

  it('a plain ETH payment to a payee shows as an ETH effect (traceTransfers)', async () => {
    const sim = await simulateProposal(client, await inputFor([{ to: vendor1, value: 1_000_000_000_000_000n, data: '0x' }]));
    expect(sim.success).toBe(true);
    expect(sim.effects).toEqual([{ kind: 'out', token: ETH, amount: 1_000_000_000_000_000n, counterparty: vendor1, source: 'log' }]);
    // and the real balance read agrees with the traced ETH log
    const eth = sim.balances.find((b) => b.token === ETH)!;
    expect(eth.before - eth.after).toBe(1_000_000_000_000_000n);
    expect(sim.balancesMatchLogs).toBe(true);
  });

  it('EIP-7708 is live on Sepolia: a real ETH transfer receipt carries the SYSTEM_ADDRESS Transfer log', async () => {
    // Step 1 (SetupFinal): owner -> agent 0.005 ETH, a plain value transfer with no contract logs.
    const receipt = await client.getTransactionReceipt({ hash: '0xc30cc2feaac6f59b9ccd5edf5589829a82bc7419fff13cb7ef3df4c1363fa568' });
    const realLogs = receipt.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data }));
    const owner = getAddress(config.owner);
    const r = decodeEffects(realLogs, owner, [], 'receipt');
    expect(r.effects).toEqual([{ kind: 'out', token: ETH, amount: 5_000_000_000_000_000n, counterparty: getAddress(agent), source: 'log' }]);
  });
});
