// Offline regression: the same testbed scenarios on a LOCAL anvil fork of Sepolia (nothing is broadcast to
// Sepolia). On the fork we can also EXECUTE each proposal from the agent: scenarios the module alone
// allows (A, B, D) really succeed on-chain, which shows the wallet layer is what catches them; for the
// allowed ones (C, F) the real receipt's effects must equal the simulated effects.
import { getAddress, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deploymentFromConfig } from '../deployment.js';
import { decodeEffects } from '../simulate/effects.js';
import { moduleCalldata, simulateProposal } from '../simulate/simulate.js';
import { readPolicy } from '../ens/reader.js';
import { MemoryStorage } from '../storage/memory.js';
import { canFork, startFork, type Fork } from '../test/fork.js';
import { config } from '../test/live.js';
import { TB, scenarios } from '../test/testbed.js';
import { proxyBaselineKey, recordProxyBaseline } from './checks.js';
import { evaluateProposal } from './evaluate.js';

describe.skipIf(!canFork || !config.testbed)('testbed scenarios on a local fork (with real execution)', { timeout: 300_000 }, () => {
  let fork: Fork;
  const d = deploymentFromConfig(config);

  beforeAll(async () => {
    fork = await startFork(8548, [TB.agent]);
  }, 120_000);
  afterAll(() => fork?.stop());

  for (const s of scenarios()) {
    it(s.name, async () => {
      const storage = new MemoryStorage();
      if (s.baseline?.impl === 'record') await recordProxyBaseline(fork.client, storage, d.chainId, s.baseline.target);
      else if (s.baseline) await storage.set(proxyBaselineKey(d.chainId, s.baseline.target), s.baseline.impl.toLowerCase());

      const dec = await evaluateProposal({ rpc: fork.rpc, deployment: d, storage, label: TB.label, agent: TB.agent, proposal: s.proposal });
      expect(dec.verdict).toBe(s.expect.verdict);
      if (s.expect.failed) expect([...new Set(dec.failedChecks.map((f) => f.check))].sort()).toEqual([...s.expect.failed].sort());

      const { policy } = await readPolicy(fork.client, d, TB.label);
      const tokens = policy.tokens.map((a, i) => ({ address: a, kind: (policy.tokenKinds[i] ?? 0) as 0 | 1 | 2 }));
      const data = moduleCalldata(TB.label, s.proposal.calls);

      if (s.expect.modulePreview === 'fails') {
        await expect(fork.send(TB.agent, d.module, data)).rejects.toThrow(/reverted/);
        return;
      }
      // The module alone accepts it: execute for real on the fork.
      const sim = await simulateProposal(fork.client, { deployment: d, agent: TB.agent, label: TB.label, calls: s.proposal.calls, tokens, spenders: [...policy.spenders, ...policy.targets] });
      const hash = (await fork.rpc.request({ method: 'eth_sendTransaction', params: [{ from: TB.agent, to: d.module, data, gas: '0x2000000' }] })) as Hex;
      const receipt = await fork.client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      const real = decodeEffects(
        receipt.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data })),
        d.safeAddress,
        tokens.map((t) => t.address),
        'receipt',
      );
      // Log-sourced effects equal the receipt (postState effects only exist in simulation, e.g. the silent token).
      expect(sim.effects.filter((e) => e.source === 'log')).toEqual(real.effects);
      expect(sim.gasUsed).toBe(receipt.gasUsed);
      console.log(`[fork] ${s.name.split(' ')[0]} wallet=${dec.verdict} module-on-chain=success effects=${real.effects.map((e) => `${e.kind}:${e.amount}->${getAddress(e.counterparty).slice(0, 6)}`).join(',') || 'none (no events)'} gas=${receipt.gasUsed}`);
    });
  }
});
