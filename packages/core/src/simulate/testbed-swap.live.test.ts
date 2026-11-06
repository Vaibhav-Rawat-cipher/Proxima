// The REAL testbed swap on Sepolia (2.3): re-simulate the exact batch on the block before it was mined and
// compare every effect, every log and the gas with its real receipt.
import { getAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { clientFor } from '../chain.js';
import { deploymentFromConfig } from '../deployment.js';
import { readPolicy } from '../ens/reader.js';
import { config, directRpc, hasRpc } from '../test/live.js';
import { TB, scenarios } from '../test/testbed.js';
import { decodeEffects } from './effects.js';
import { moduleCalldata, simulateProposal } from './simulate.js';

const REAL_SWAP_TX = config.testbed?.txs?.agentSwap as Hex | undefined;

describe.skipIf(!hasRpc || !REAL_SWAP_TX)('real testbed swap: simulated == real', { timeout: 120_000 }, () => {
  const client = clientFor(directRpc());
  const d = deploymentFromConfig(config);

  it('the real executeBatch(approve + swap) matches its simulation exactly', async () => {
    const tx = await client.getTransaction({ hash: REAL_SWAP_TX! });
    const receipt = await client.getTransactionReceipt({ hash: REAL_SWAP_TX! });
    const F = scenarios().find((s) => s.name.startsWith('F '))!;
    // The real transaction carried exactly scenario F's calldata, from the agent, to the module.
    expect(getAddress(tx.from)).toBe(TB.agent);
    expect(getAddress(tx.to!)).toBe(getAddress(d.module));
    expect(tx.input).toBe(moduleCalldata(TB.label, F.proposal.calls));

    const { policy } = await readPolicy(client, d, TB.label);
    const tokens = policy.tokens.map((a, i) => ({ address: a, kind: (policy.tokenKinds[i] ?? 0) as 0 | 1 | 2 }));
    const sim = await simulateProposal(client, {
      deployment: d,
      agent: TB.agent,
      label: TB.label,
      calls: F.proposal.calls,
      tokens,
      spenders: [...policy.spenders, ...policy.targets],
      block: receipt.blockNumber - 1n,
    });
    const realLogs = receipt.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data }));
    const real = decodeEffects(realLogs, d.safeAddress, tokens.map((t) => t.address), 'receipt');

    expect(receipt.status).toBe('success');
    expect(sim.success).toBe(true);
    expect(sim.effects).toEqual(real.effects);
    expect(sim.effects).toEqual([
      { kind: 'approve', token: TB.dai, amount: 10n * 10n ** 18n, counterparty: TB.pool, source: 'log' },
      { kind: 'out', token: TB.dai, amount: 10n * 10n ** 18n, counterparty: TB.pool, source: 'log' },
      { kind: 'in', token: TB.usdc, amount: 10_000_000n, counterparty: TB.pool, source: 'log' },
    ]);
    expect(sim.logs.map((l) => ({ ...l, address: getAddress(l.address) }))).toEqual(realLogs.map((l) => ({ ...l, address: getAddress(l.address) })));
    expect(sim.gasUsed).toBe(receipt.gasUsed);
    expect(sim.balancesMatchLogs).toBe(true);
    expect(sim.leftoverAllowances).toEqual([]);
    console.log(`[real swap] block ${receipt.blockNumber}: effects identical (${sim.effects.length}), logs identical (${sim.logs.length}), gasUsed sim ${sim.gasUsed} = real ${receipt.gasUsed}`);
  });
});
