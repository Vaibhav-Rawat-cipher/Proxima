import { AnonRpcWorker } from '@anon-rpc/browser-harness';
import { httpRpcAdapter, withTransportRetry, type RpcAdapter } from '@blindspot/core';
import { createPublicClient, http, parseAbi } from 'viem';
import cfg from '../../../config/sepolia.json';

declare const __E2E__: { sepoliaRpc: string; llmProxy: string };

export const meter = { anon: 0, excluded: 0, excludedWhy: [] as string[] };

/** Counts every request through an adapter (Anon-RPC traffic meter). */
function counted(rpc: RpcAdapter, onRequest: () => void): RpcAdapter {
  return { name: rpc.name, anonymized: rpc.anonymized, request: (a) => (onRequest(), rpc.request(a)) };
}

export type Nox = { rpc: RpcAdapter; direct: RpcAdapter; readyMs: number; workerHash: string };

/**
 * Starts the Nox worker (Option B): the harness fetches the worker bundle and runs it only if its keccak256
 * matches the on-chain specifier — and we refuse to start unless that hash equals our pinned hash.
 * `rpc`    = every read and broadcast, anonymized through Nox (retries transport errors only).
 * `direct` = the explicit, user-clicked fallback for a refused broadcast (counted as excluded traffic).
 */
export async function startNox(): Promise<Nox> {
  const net = cfg.anonRpc.nox;
  const boot = createPublicClient({ transport: http(__E2E__.sepoliaRpc) });
  meter.excluded++;
  meter.excludedWhy.push('bootstrap: workerHash() read of the Nox specifier');
  const onchain = await boot.readContract({ address: net.specifier as `0x${string}`, abi: parseAbi(['function workerHash() view returns (bytes32)']), functionName: 'workerHash' });
  if (onchain.toLowerCase() !== net.pinnedWorkerHash.toLowerCase()) throw new Error(`Nox workerHash changed (on-chain ${onchain}, pinned ${net.pinnedWorkerHash}); refusing to run new worker code`);
  const t0 = performance.now();
  const worker = new AnonRpcWorker({
    address: net.specifier,
    preExisting: {
      rpcProvider: {
        request: (a: { method: string; params?: unknown[] }) => {
          meter.excluded++;
          meter.excludedWhy.push(`bootstrap: ${a.method} (specifier read by the harness)`);
          return boot.request(a as never);
        },
      },
    },
  });
  // Surface the worker's own log lines (bundle fetch, hash check, KPS connection) in the page console.
  void (async () => {
    for (;;) {
      try {
        const e = await worker.acceptLog();
        console.log(`[nox worker ${e.level}]`, ...e.args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))));
      } catch {
        return;
      }
    }
  })();
  await Promise.race([worker.ready, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Nox worker did not become ready within 90 s (see the browser console for [nox worker] lines)')), 90_000))]);
  const readyMs = Math.round(performance.now() - t0);
  const workerFetch = worker.fetch as unknown as typeof fetch;
  // A request that never answers becomes a transport error after 60 s (then the retry policy applies).
  const anonFetch = (u: string, i: RequestInit) =>
    Promise.race([workerFetch(u, i), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no answer through Nox within 60 s')), 60_000))]);
  const rpc = counted(
    withTransportRetry(httpRpcAdapter({ name: 'nox', anonymized: true, url: __E2E__.sepoliaRpc, fetch: (u, i) => anonFetch(u, i) as never })),
    () => meter.anon++,
  );
  const direct = counted(httpRpcAdapter({ name: 'direct (excluded)', anonymized: false, url: __E2E__.sepoliaRpc, fetch: (u, i) => fetch(u, i) as never }), () => meter.excluded++);
  return { rpc, direct, readyMs, workerHash: onchain };
}

export const LLM_PROXY = () => __E2E__.llmProxy;
/** Never show the RPC URL (it contains the provider key) in anything the user may copy. */
export const redact = (s: string) => (__E2E__.sepoliaRpc ? s.split(__E2E__.sepoliaRpc).join('<RPC_URL>') : s).replace(/https?:\/\/\S*alchemy\S*/gi, '<RPC_URL>');
