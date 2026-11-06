import { PolicyError } from '@blindspot/shared';
import { describe, expect, it } from 'vitest';
import { clientFor } from '../chain.js';
import { deploymentFromConfig } from '../deployment.js';
import { config, directRpc, hasRpc } from '../test/live.js';
import { dnsEncode } from './names.js';
import { readAgentStatus, readPolicy, readText, resolveName } from './reader.js';

describe('dnsEncode', () => {
  it('matches the DNS encoding the deployed module was constructed with', () => {
    // BlindspotModule constructor arg (Script C): parentDnsName for blindspot-demo.eth
    expect(dnsEncode('blindspot-demo.eth')).toBe('0x0e626c696e6473706f742d64656d6f0365746800');
  });
  it('rejects empty labels', () => {
    expect(() => dnsEncode('a..eth')).toThrow(/invalid label/);
  });
});

describe('deploymentFromConfig', () => {
  it('reads the live config', () => {
    const d = deploymentFromConfig(config);
    expect(d.module).toBe(config.module);
    expect(d.parentName).toBe('blindspot-demo.eth');
  });
  it('fails on a missing field', () => {
    expect(() => deploymentFromConfig({ ...config, module: null })).toThrow(/module is missing/);
  });
});

// Live Sepolia (real RPC, real ENSv2 contracts, the real Step 1 deployment). Skipped without SEPOLIA_RPC_URL.
// Live RPC reads take 0.5-5 s each (the Universal Resolver walks the registry tree), so allow 30 s per test.
describe.skipIf(!hasRpc)('ENS reader against live Sepolia', { timeout: 30_000 }, () => {
  const client = clientFor(directRpc());
  const d = deploymentFromConfig(config);
  const agent = config.agents.demo.address as `0x${string}`;

  it('agent status: demo is active for the agent key', async () => {
    const s = await readAgentStatus(client, d, 'demo', agent);
    expect(s).toMatchObject({ name: 'demo.blindspot-demo.eth', status: 'REGISTERED', active: true });
    expect(s.owner.toLowerCase()).toBe(agent.toLowerCase());
  });

  it('agent status: another key is not the agent (fail closed)', async () => {
    const s = await readAgentStatus(client, d, 'demo', config.owner);
    expect(s.active).toBe(false);
    expect(s.reason).toMatch(/belongs to/);
  });

  it('agent status: an unregistered label is not active', async () => {
    const s = await readAgentStatus(client, d, 'not-an-agent-xyz', agent);
    expect(s).toMatchObject({ status: 'AVAILABLE', active: false });
    expect(s.reason).toMatch(/not registered/);
  });

  it('agent status: expired is not active', async () => {
    const live = await readAgentStatus(client, d, 'demo', agent);
    const s = await readAgentStatus(client, d, 'demo', agent, live.expiry + 1n);
    expect(s.active).toBe(false);
    expect(s.reason).toMatch(/expired/);
  });

  it('policy: demo rules are the current record (keccak in config) and decode to the owner rules', async () => {
    const r = await readPolicy(client, d, 'demo');
    expect(r.keccak).toBe(config.agents.demo.policyKeccak);
    expect(r.resolver.toLowerCase()).toBe(config.agentResolver.toLowerCase());
    expect(r.policy.payees.map((p) => p.toLowerCase())).toEqual([config.payees.vendor1, config.payees.vendor2].map((p: string) => p.toLowerCase()));
    expect(r.policy.maxOut).toEqual([25_000_000n, 2_000_000_000_000_000n]);
    expect(r.policy.dailyCap).toEqual([100_000_000n, 5_000_000_000_000_000n]); // daily cap raised 50 → 100 by the owner (2026-11-06)
  });

  it('policy: a name with a resolver but no rules fails closed', async () => {
    await expect(readPolicy(client, d, 'vendor1')).rejects.toThrow(PolicyError);
    await expect(readPolicy(client, d, 'vendor1')).rejects.toThrow(/empty/);
  });

  it('policy: an unregistered name fails closed (no resolver)', async () => {
    await expect(readPolicy(client, d, 'not-an-agent-xyz')).rejects.toThrow(/no resolver/);
  });

  it('resolve_name: demo, vendor1 and vendor2 resolve via the Universal Resolver', async () => {
    expect((await resolveName(client, d, 'demo.blindspot-demo.eth'))?.toLowerCase()).toBe(agent.toLowerCase());
    expect((await resolveName(client, d, 'vendor1.blindspot-demo.eth'))?.toLowerCase()).toBe(config.payees.vendor1.toLowerCase());
    expect((await resolveName(client, d, 'vendor2.blindspot-demo.eth'))?.toLowerCase()).toBe(config.payees.vendor2.toLowerCase());
  });

  it('resolve_name: an unknown name returns null', async () => {
    expect(await resolveName(client, d, 'nobody-here-xyz.blindspot-demo.eth')).toBeNull();
  });

  it('agent-context (ENSIP-26) text record', async () => {
    expect(await readText(client, d, 'demo.blindspot-demo.eth', 'agent-context')).toMatch(/^# demo\.blindspot-demo\.eth/);
    expect(await readText(client, d, 'nobody-here-xyz.blindspot-demo.eth', 'agent-context')).toBe('');
  });
});
