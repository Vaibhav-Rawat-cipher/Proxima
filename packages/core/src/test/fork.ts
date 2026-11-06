// Test-only: start/stop a LOCAL anvil fork of Sepolia (nothing is ever broadcast to Sepolia) and
// helpers to act on it with impersonated accounts.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDeployData, getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { clientFor } from '../chain.js';
import { directRpc, env, hasRpc } from './live.js';

export const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export const ANVIL = resolve(homedir(), '.foundry/bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
export const canFork = hasRpc && existsSync(ANVIL);

export const artifact = (path: string) => JSON.parse(readFileSync(resolve(ROOT, 'contracts/out', path), 'utf8')) as { abi: any[]; bytecode: { object: Hex }; methodIdentifiers: Record<string, string> };

export type Fork = {
  url: string;
  rpc: ReturnType<typeof directRpc>;
  client: PublicClient;
  send: (from: Address, to: Address | undefined, data: Hex, value?: bigint) => Promise<{ contractAddress: Address | null; status: string }>;
  deploy: (from: Address, path: string, args?: unknown[]) => Promise<Address>;
  stop: () => void;
};

export async function startFork(port: number, impersonate: Address[]): Promise<Fork> {
  const url = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(ANVIL, ['--fork-url', env.SEPOLIA_RPC_URL!, '--port', String(port), '--silent'], { stdio: 'ignore' });
  const rpc = directRpc(url);
  for (let i = 0; i < 60; i++) {
    try {
      await rpc.request({ method: 'eth_blockNumber' });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  for (const a of impersonate) {
    await rpc.request({ method: 'anvil_impersonateAccount', params: [a] });
    await rpc.request({ method: 'anvil_setBalance', params: [a, '0xde0b6b3a7640000'] }); // 1 ETH, fork only
  }
  const client = clientFor(rpc);
  const send: Fork['send'] = async (from, to, data, value = 0n) => {
    const hash = (await rpc.request({
      method: 'eth_sendTransaction',
      params: [{ from, ...(to ? { to } : {}), data, value: `0x${value.toString(16)}`, gas: '0x2000000' }],
    })) as Hex;
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`fork tx reverted: ${hash}`);
    return { contractAddress: r.contractAddress ?? null, status: r.status };
  };
  const deploy: Fork['deploy'] = async (from, path, args = []) => {
    const a = artifact(path);
    const r = await send(from, undefined, encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args }));
    return getAddress(r.contractAddress!);
  };
  return { url, rpc, client, send, deploy, stop: () => proc.kill() };
}
