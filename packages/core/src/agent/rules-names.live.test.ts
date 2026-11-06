// A2 (owner decision 2026-11-06): get_rules lists recipients with ENS names, each shown only after the wallet
// forward-resolves the name to exactly that address. Live Sepolia (real ENSv2 names).
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { withTransportRetry } from '../adapters/rpc.js';
import { clientFor } from '../chain.js';
import { deploymentFromConfig } from '../deployment.js';
import { MemoryStorage } from '../storage/memory.js';
import { config, directRpc, hasRpc } from '../test/live.js';
import { Trace } from '../trace/trace.js';
import type { RunContext } from './context.js';
import { runTool } from './tools.js';

describe.skipIf(!hasRpc)('get_rules with verified ENS names (live Sepolia)', { timeout: 120_000 }, () => {
  const rpc = withTransportRetry(directRpc());
  const ctx = (knownNames?: string[]): RunContext => ({
    rpc,
    client: clientFor(rpc),
    deployment: deploymentFromConfig(config),
    storage: new MemoryStorage(),
    label: 'demo',
    agent: getAddress(config.agents.demo.address),
    trace: new Trace(`n${Date.now()}`),
    proposals: new Map(),
    log: [],
    ...(knownNames ? { knownNames } : {}),
  });
  const v1 = getAddress(config.payees.vendor1);
  const v2 = getAddress(config.payees.vendor2);

  it('shows each recipient with the ENS name that resolves to it', async () => {
    const out = await runTool(ctx([config.payeeNames.vendor1, config.payeeNames.vendor2]), 'get_rules', {});
    expect(out).toContain(`Allowed recipients: vendor1.blindspot-demo.eth (${v1}), vendor2.blindspot-demo.eth (${v2})`);
  });

  it('never shows a name that does not resolve to that exact address (unknown, wrong or missing names → address only)', async () => {
    // vendor2's name resolves to vendor2, not vendor1; a made-up name resolves to nothing; vendor1 has no name in the list
    const out = await runTool(ctx(['nonexistent-xyz.blindspot-demo.eth', config.payeeNames.vendor2]), 'get_rules', {});
    expect(out).toContain(`Allowed recipients: ${v1}, vendor2.blindspot-demo.eth (${v2})`);
    expect(out).not.toContain('nonexistent-xyz');
  });

  it('without known names, recipients are addresses only (as before)', async () => {
    expect(await runTool(ctx(), 'get_rules', {})).toContain(`Allowed recipients: ${v1}, ${v2}`);
  });
});
