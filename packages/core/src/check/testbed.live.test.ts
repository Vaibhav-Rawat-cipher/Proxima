// 2.3 testbed checks against LIVE Sepolia (test.blindspot-demo.eth). Nothing is sent: proposals are simulated.
import { describe, expect, it } from 'vitest';
import { clientFor } from '../chain.js';
import { deploymentFromConfig } from '../deployment.js';
import { MemoryStorage } from '../storage/memory.js';
import { config, directRpc, hasRpc } from '../test/live.js';
import { TB, scenarios } from '../test/testbed.js';
import { proxyBaselineKey, readImplementation, recordProxyBaseline } from './checks.js';
import { evaluateProposal } from './evaluate.js';

describe.skipIf(!hasRpc || !config.testbed)('testbed checks against live Sepolia', { timeout: 120_000 }, () => {
  const rpc = directRpc();
  const client = clientFor(rpc);
  const d = deploymentFromConfig(config);

  it('testbed wiring: proxyUpgraded points at V2, proxyV1 at V1 (real EIP-1967 slots)', async () => {
    expect((await readImplementation(client, TB.proxyV1))?.toLowerCase()).toBe(TB.depositV1Impl.toLowerCase());
    expect((await readImplementation(client, TB.proxyUpgraded))?.toLowerCase()).toBe(config.testbed.depositV2Impl.toLowerCase());
  });

  for (const s of scenarios()) {
    it(s.name, async () => {
      const storage = new MemoryStorage();
      if (s.baseline?.impl === 'record') await recordProxyBaseline(client, storage, d.chainId, s.baseline.target);
      else if (s.baseline) await storage.set(proxyBaselineKey(d.chainId, s.baseline.target), s.baseline.impl.toLowerCase());
      const dec = await evaluateProposal({ rpc, deployment: d, storage, label: TB.label, agent: TB.agent, proposal: s.proposal });
      console.log(`[live] ${s.name.split(' ')[0]} ${dec.verdict} ${dec.failedChecks.map((f) => `${f.check}: ${f.detail}`).join(' | ') || '(all checks passed)'}`);
      expect(dec.verdict).toBe(s.expect.verdict);
      if (s.expect.failed) expect([...new Set(dec.failedChecks.map((f) => f.check))].sort()).toEqual([...s.expect.failed].sort());
      else expect(dec.failedChecks).toEqual([]);
      if (s.expect.detail) expect(dec.failedChecks.map((f) => f.detail).join(' ')).toMatch(s.expect.detail);
      if (s.expect.modulePreview === 'passes') expect(dec.passedChecks).toContain('modulePreview');
      else expect(dec.passedChecks).not.toContain('modulePreview');
    });
  }
});
