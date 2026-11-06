import { AnonRpcWorker } from '@anon-rpc/browser-harness';
import { RpcTransportError, httpRpcAdapter, meteredRpc, withTransportRetry, type Analytics, type RetryInfo, type RpcAdapter } from '@blindspot/core';
import { createPublicClient, http, parseAbi } from 'viem';
import cfg from '../../../config/sepolia.json';

declare const __WALLET__: { sepoliaRpc: string; mainnetBootstrap: string };

/**
 * Anon-RPC fallback chain (owner decision 2026-11-06): Nox → tor-js → manual "Direct (not anonymous)".
 * - Nox (Sepolia specifier, Sepolia bootstrap read) starts on page load (pre-warm).
 * - If Nox is not ready within ~30 s, or later fails after its retries, tor-js (mainnet specifier, mainnet bootstrap
 *   read, Tor gateways from the specifier's config) takes over automatically.
 * - Direct mode is never automatic: only the owner's click, shown with a red banner, counted as excluded traffic.
 * Both anonymous networks reach the same Sepolia RPC; Option B applies to each: the harness runs a worker bundle only
 * if its keccak matches the on-chain specifier, and we refuse unless that equals our pinned hash.
 */
export type NetworkId = 'nox' | 'torJs';
export const NET_NAME: Record<NetworkId | 'direct', string> = { nox: 'Nox', torJs: 'tor-js', direct: 'Direct (not anonymous)' };
export const DIRECT_MODE_REASON = 'direct mode: owner chose "Direct (not anonymous)"';
export const FALLBACK_REASON = 'broadcast fallback: direct RPC (owner approved)';
const bootstrapReason = (id: NetworkId) => `bootstrap: ${NET_NAME[id]} specifier read (declared)`;

export type ChainStatus =
  | { state: 'starting'; network: NetworkId }
  | { state: 'waiting'; network: NetworkId; attempt: number; maxAttempts: number; error: string; nextInSec: number }
  | { state: 'ready'; network: NetworkId; readyMs: number }
  | { state: 'retrying'; network: NetworkId; info: RetryInfo }
  | { state: 'switching'; from: NetworkId; to: NetworkId; reason: string }
  | { state: 'failed'; message: string }
  | { state: 'direct' };

type Net = { id: NetworkId; rpc: RpcAdapter; readyMs: number };
type Wake = { wake?: () => void };

const SETTINGS: Record<NetworkId, { readyTimeoutMs: number; warmAttempts: number }> = {
  nox: { readyTimeoutMs: 90_000, warmAttempts: 3 }, // ~30 s of "waiting for an exit" before switching
  torJs: { readyTimeoutMs: 180_000, warmAttempts: 18 }, // Tor is slower to build circuits: ~3 min
};

async function startNetwork(id: NetworkId, analytics: Analytics, onStatus: (s: ChainStatus) => void, wake: Wake): Promise<Net> {
  onStatus({ state: 'starting', network: id });
  const net = cfg.anonRpc[id] as { specifier: string; pinnedWorkerHash: string | null; config: unknown };
  const bootUrl = id === 'nox' ? __WALLET__.sepoliaRpc : __WALLET__.mainnetBootstrap;
  if (!bootUrl) throw new Error(`${NET_NAME[id]}: no bootstrap RPC configured (${id === 'torJs' ? 'MAINNET_BOOTSTRAP_RPC_URL' : 'SEPOLIA_RPC_URL'} in .env)`);
  if (!net.pinnedWorkerHash) throw new Error(`${NET_NAME[id]}: no pinned worker hash in config`);
  const boot = createPublicClient({ transport: http(bootUrl) });
  const bootName = { name: `bootstrap (${NET_NAME[id]})`, anonymized: false };
  analytics.recordRpc(bootName, 'eth_call', bootstrapReason(id));
  const onchain = await boot.readContract({ address: net.specifier as `0x${string}`, abi: parseAbi(['function workerHash() view returns (bytes32)']), functionName: 'workerHash' });
  if (onchain.toLowerCase() !== net.pinnedWorkerHash.toLowerCase()) throw new Error(`${NET_NAME[id]} workerHash changed (on-chain ${onchain}, pinned ${net.pinnedWorkerHash}); refusing to run new worker code`);
  const t0 = performance.now();
  const worker = new AnonRpcWorker({
    address: net.specifier,
    ...(net.config ? { config: net.config as never } : {}),
    preExisting: {
      rpcProvider: {
        request: (a: { method: string; params?: unknown[] }) => {
          analytics.recordRpc(bootName, a.method, bootstrapReason(id));
          return boot.request(a as never);
        },
      },
    },
  });
  void (async () => {
    for (;;) {
      try {
        const e = await worker.acceptLog();
        console.log(`[${id} worker ${e.level}]`, ...e.args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))));
      } catch {
        return;
      }
    }
  })();
  const s = SETTINGS[id];
  await Promise.race([worker.ready, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${NET_NAME[id]} did not become ready within ${s.readyTimeoutMs / 1000} s`)), s.readyTimeoutMs))]);
  const readyMs = Math.round(performance.now() - t0);
  const workerFetch = worker.fetch as unknown as typeof fetch;
  const anonFetch = (u: string, i: RequestInit) =>
    Promise.race([workerFetch(u, i), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer through ${NET_NAME[id]} within 60 s`)), 60_000))]);
  const raw = httpRpcAdapter({ name: id, anonymized: true, url: __WALLET__.sepoliaRpc, fetch: (u, i) => anonFetch(u, i) as never });
  let retrying = false;
  const retried = withTransportRetry(raw, {
    delaysMs: [1000, 2000, 4000, 8000, 15000, 30000], // ~1 minute in total per request
    onRetry: (info) => {
      retrying = true;
      onStatus({ state: 'retrying', network: id, info });
    },
  });
  const ready: ChainStatus = { state: 'ready', network: id, readyMs };
  const settled: RpcAdapter = {
    name: id,
    anonymized: true,
    async request(a) {
      try {
        return await retried.request(a);
      } finally {
        if (retrying) {
          retrying = false;
          onStatus(ready);
        }
      }
    },
  };
  // Pre-warm: one cheap read, one try per attempt, every 10 s ("Retry now" wakes it early).
  for (let attempt = 1; ; attempt++) {
    try {
      await raw.request({ method: 'eth_blockNumber' });
      analytics.recordRpc({ name: id, anonymized: true }, 'eth_blockNumber');
      break;
    } catch (e) {
      if (attempt >= s.warmAttempts) throw new Error(`${NET_NAME[id]} had no working route: ${(e as Error).message}`);
      onStatus({ state: 'waiting', network: id, attempt, maxAttempts: s.warmAttempts, error: (e as Error).message, nextInSec: 10 });
      await new Promise<void>((r) => {
        const timer = setTimeout(r, 10_000);
        wake.wake = () => (clearTimeout(timer), r());
      });
    }
  }
  onStatus(ready);
  return { id, rpc: meteredRpc(settled, analytics), readyMs };
}

export type AnonChain = {
  /** Every read and broadcast: the active anonymous network, or Direct after the owner's click. */
  rpc: RpcAdapter;
  /** Owner-approved one-off broadcast fallback (declared). */
  broadcastDirect: RpcAdapter;
  active(): NetworkId | 'direct' | null;
  /** Owner's manual choice: Direct (not anonymous). */
  useDirect(): void;
  /** Leave Direct mode / try the anonymous chain again. */
  retryAnon(): Promise<void>;
  wake(): void;
};

/** `first`: which network to try first (default Nox; "torJs" lets the owner test the fallback directly). */
export function anonChain(analytics: Analytics, onStatus: (s: ChainStatus) => void, onReady: () => void, first: NetworkId = 'nox'): AnonChain {
  const nets: Partial<Record<NetworkId, Net>> = {};
  let primary: NetworkId | null = null;
  let direct = false;
  let starting: Promise<void> | null = null;
  const wake: Wake = {};
  const directRpc = meteredRpc(httpRpcAdapter({ name: 'direct', anonymized: false, url: __WALLET__.sepoliaRpc, fetch: (u, i) => fetch(u, i) as never }), analytics, DIRECT_MODE_REASON);
  const broadcastDirect = meteredRpc(httpRpcAdapter({ name: 'direct (broadcast fallback)', anonymized: false, url: __WALLET__.sepoliaRpc, fetch: (u, i) => fetch(u, i) as never }), analytics, FALLBACK_REASON);

  async function bring(id: NetworkId): Promise<boolean> {
    if (nets[id]) return true;
    try {
      nets[id] = await startNetwork(id, analytics, onStatus, wake);
      return true;
    } catch (e) {
      console.warn(`[anon chain] ${id} failed:`, e);
      lastError = (e as Error).message;
      return false;
    }
  }
  let lastError = '';

  async function start(): Promise<void> {
    const second: NetworkId = first === 'nox' ? 'torJs' : 'nox';
    if (await bring(first)) primary = first;
    else {
      onStatus({ state: 'switching', from: first, to: second, reason: lastError });
      if (await bring(second)) primary = second;
    }
    if (primary) {
      direct = false;
      onReady();
    } else onStatus({ state: 'failed', message: lastError });
  }

  const rpc: RpcAdapter = {
    name: 'anon-chain',
    anonymized: true,
    async request(a) {
      if (direct) return directRpc.request(a);
      if (!primary) throw new Error('No anonymous network is ready (Nox and tor-js both unavailable).');
      try {
        return await nets[primary]!.rpc.request(a);
      } catch (e) {
        if (!(e instanceof RpcTransportError) || direct) throw e;
        // The active network failed after its retries: move to the other anonymous network (never to Direct).
        const other: NetworkId = primary === 'nox' ? 'torJs' : 'nox';
        onStatus({ state: 'switching', from: primary, to: other, reason: e.message });
        if (!(await bring(other))) throw e;
        primary = other;
        return nets[other]!.rpc.request(a);
      }
    },
  };

  starting = start();
  return {
    rpc,
    broadcastDirect,
    active: () => (direct ? 'direct' : primary),
    useDirect() {
      direct = true;
      onStatus({ state: 'direct' });
      onReady();
    },
    async retryAnon() {
      direct = false;
      if (primary) {
        onStatus({ state: 'ready', network: primary, readyMs: nets[primary]!.readyMs });
        return;
      }
      await starting;
      starting = start();
      await starting;
    },
    wake: () => wake.wake?.(),
  };
}

/** Never show RPC URLs (they contain provider keys). */
export const redact = (s: string) =>
  [__WALLET__.sepoliaRpc, __WALLET__.mainnetBootstrap].filter(Boolean).reduce((acc, u) => acc.split(u).join('<RPC_URL>'), s).replace(/https?:\/\/\S*(alchemy|infura|quiknode|ankr)\S*/gi, '<RPC_URL>');
