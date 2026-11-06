// Swap test on a LOCAL fork only (owner decision): SimplePool is deployed on an anvil fork of Sepolia,
// never on Sepolia. The fork is started and stopped by this test; nothing is ever broadcast to Sepolia.
// Simulated effects of an approve+swap batch must equal the effects of actually executing it on the fork.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDeployData, encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { encodePolicy, ETH, type Policy } from '@blindspot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientFor } from '../chain.js';
import { deploymentFromConfig } from '../deployment.js';
import { dnsEncode } from '../ens/names.js';
import { readPolicy } from '../ens/reader.js';
import { config, directRpc, env, hasRpc } from '../test/live.js';
import { decodeEffects } from './effects.js';
import { simulateProposal } from './simulate.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const ANVIL = resolve(homedir(), '.foundry/bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
const PORT = 8547;
const FORK = `http://127.0.0.1:${PORT}`;
const canRun = hasRpc && existsSync(ANVIL) && existsSync(resolve(ROOT, 'contracts/out/SimplePool.sol/SimplePool.json'));

describe.skipIf(!canRun)('simulation vs real execution: approve + swap on a local fork', { timeout: 180_000 }, () => {
  let anvil: ChildProcess;
  const rpc = directRpc(FORK);
  const client = clientFor(rpc);
  const d = deploymentFromConfig(config);
  const owner = getAddress(config.owner);
  const agent = getAddress(config.agents.demo.address);
  const usdc = getAddress(config.ens.MockUSDC);
  const dai = getAddress(config.ens.MockDAI);
  const agentResolver = getAddress(config.agentResolver);

  const send = async (from: Address, to: Address | undefined, data: Hex) => {
    const hash = (await rpc.request({ method: 'eth_sendTransaction', params: [{ from, ...(to ? { to } : {}), data, gas: '0x2000000' }] })) as Hex;
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`fork tx reverted: ${hash}`);
    return receipt;
  };

  beforeAll(async () => {
    anvil = spawn(ANVIL, ['--fork-url', env.SEPOLIA_RPC_URL!, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      try {
        await rpc.request({ method: 'eth_blockNumber' });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    for (const a of [owner, agent]) await rpc.request({ method: 'anvil_impersonateAccount', params: [a] });
    await rpc.request({ method: 'anvil_setBalance', params: [agent, '0xde0b6b3a7640000'] }); // 1 ETH, fork only
  }, 90_000);

  afterAll(() => {
    anvil?.kill();
  });

  it('simulated effects of approve + swap equal the effects of executing it', async () => {
    // 1. Deploy SimplePool(MockUSDC, MockDAI, 1:1) on the fork and give it MockDAI liquidity.
    const art = JSON.parse(readFileSync(resolve(ROOT, 'contracts/out/SimplePool.sol/SimplePool.json'), 'utf8'));
    const deployed = await send(owner, undefined, encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args: [usdc, dai, 1n, 1n] }));
    const pool = getAddress(deployed.contractAddress!);
    const mint = parseAbi(['function mint(address,uint256)']);
    await send(owner, dai, encodeFunctionData({ abi: mint, functionName: 'mint', args: [pool, 1_000_000_000n] }));

    // 2. Owner updates the agent's rules on ENS (fork only): allow approve on MockUSDC, the pool's swap, pool as spender, track MockDAI.
    const v1 = (await readPolicy(client, d, 'demo')).policy;
    const SWAP = art.methodIdentifiers['swap(address,uint256,uint256)'] as string;
    const poolCode = await client.getCode({ address: pool });
    const policy: Policy = {
      ...v1,
      version: 2,
      targets: [...v1.targets, pool],
      codeHashes: [...v1.codeHashes, keccak256(poolCode!)],
      selectors: [['0xa9059cbb', '0x095ea7b3'], ...v1.selectors.slice(1), [`0x${SWAP}`]],
      spenders: [pool],
      tokens: [...v1.tokens, dai],
      tokenKinds: [...v1.tokenKinds, 0],
      maxOut: [...v1.maxOut, 100_000_000n],
      dailyCap: [...v1.dailyCap, 200_000_000n],
    };
    const setData = parseAbi(['function setData(bytes name, string key, bytes value)']);
    await send(owner, agentResolver, encodeFunctionData({ abi: setData, functionName: 'setData', args: [dnsEncode('demo.blindspot-demo.eth'), 'blindspot.policy', encodePolicy(policy)] }));
    expect((await readPolicy(client, d, 'demo')).policy.version).toBe(2);

    // 3. Simulate the agent's batch.
    const amount = 10_000_000n; // 10 MockUSDC
    const calls = [
      { to: usdc, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [pool, amount] }) },
      { to: pool, value: 0n, data: encodeFunctionData({ abi: art.abi, functionName: 'swap', args: [usdc, amount, amount] }) },
    ];
    const tokens = policy.tokens.map((a, i) => ({ address: a, kind: (policy.tokenKinds[i] ?? 0) as 0 | 1 | 2 }));
    const sim = await simulateProposal(client, { deployment: d, agent, label: 'demo', calls, tokens, spenders: [...policy.spenders, ...policy.targets] });
    expect(sim.success).toBe(true);

    // 4. Execute exactly that calldata from the agent on the fork, and decode the real receipt the same way.
    const receipt = await send(agent, d.module, sim.moduleCalldata);
    const realLogs = receipt.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data }));
    const real = decodeEffects(realLogs, d.safeAddress, tokens.map((t) => t.address), 'receipt');

    // 5. Simulated == real.
    expect(sim.effects).toEqual(real.effects);
    expect(sim.effects).toEqual(
      expect.arrayContaining([
        { kind: 'approve', token: usdc, amount, counterparty: pool, source: 'log' },
        { kind: 'out', token: usdc, amount, counterparty: pool, source: 'log' },
        { kind: 'in', token: dai, amount, counterparty: pool, source: 'log' },
      ]),
    );
    expect(sim.logs.map((l) => ({ ...l, address: getAddress(l.address) }))).toEqual(realLogs.map((l) => ({ ...l, address: getAddress(l.address) })));
    expect(sim.gasUsed).toBe(receipt.gasUsed);
    expect(sim.balancesMatchLogs).toBe(true);
    expect(sim.leftoverAllowances).toEqual([]);
    expect(sim.effects.some((e) => e.token === ETH)).toBe(false);

    // And the real fork state agrees with the simulated post-state.
    const bal = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
    const simUsdc = sim.balances.find((b) => b.token === usdc)!;
    expect(await client.readContract({ address: usdc, abi: bal, functionName: 'balanceOf', args: [d.safeAddress] })).toBe(simUsdc.after);
    expect(await client.readContract({ address: usdc, abi: bal, functionName: 'allowance', args: [d.safeAddress, pool] })).toBe(0n);

    console.log(
      `[swap fork] effects: ${sim.effects.map((e) => `${e.kind} ${e.amount} ${e.token === usdc ? 'MockUSDC' : e.token === dai ? 'MockDAI' : e.token}`).join(', ')} | gasUsed sim ${sim.gasUsed} = real ${receipt.gasUsed} | logs ${sim.logs.length}`,
    );
  });
});
