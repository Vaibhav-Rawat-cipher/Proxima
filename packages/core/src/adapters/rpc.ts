import { keccak256, type Hex } from 'viem';
import type { RpcAdapter } from './types.js';

/**
 * A failure to get ANY answer from the node: network error, timeout, HTTP 429 / 5xx, empty or non-JSON body.
 * Shells' rpc adapters throw this for transport problems so the retry policy can tell them apart from
 * JSON-RPC errors (reverts, invalid params), which are real answers and are never retried.
 */
export class RpcTransportError extends Error {
  override name = 'RpcTransportError';
}

/** A JSON-RPC error object returned by the node: a real answer. */
export class RpcResponseError extends Error {
  override name = 'RpcResponseError';
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message);
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * JSON-RPC over an injected fetch (direct RPC, or the Anon-RPC harness's anonymized `worker.fetch`).
 * Classifies every failure as RpcTransportError or RpcResponseError.
 */
export function httpRpcAdapter(opts: { name: string; anonymized: boolean; url: string; fetch: Fetch }): RpcAdapter {
  let id = 0;
  return {
    name: opts.name,
    anonymized: opts.anonymized,
    async request({ method, params }) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] });
      let res: { status: number; text(): Promise<string> };
      try {
        res = await opts.fetch(opts.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      } catch (e) {
        throw new RpcTransportError(`${method}: network error (${(e as Error).message})`);
      }
      const text = await res.text().catch(() => '');
      if (res.status === 429 || res.status >= 500) throw new RpcTransportError(`${method}: HTTP ${res.status}`);
      if (text.trim() === '') throw new RpcTransportError(`${method}: empty response (HTTP ${res.status})`);
      let json: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      try {
        json = JSON.parse(text);
      } catch {
        throw new RpcTransportError(`${method}: non-JSON response (HTTP ${res.status})`);
      }
      if (json.error) throw new RpcResponseError(json.error.message, json.error.code, json.error.data);
      return json.result;
    },
  };
}

/**
 * Retry policy (owner decision): retry ONLY transport errors, with backoff (default 0.5 / 1 / 2 / 4 s);
 * JSON-RPC errors pass straight through; when retries run out the error propagates (callers fail closed).
 * eth_sendRawTransaction: before resending, check by hash whether the first send landed, so the same
 * signed transaction is never pushed twice.
 */
export type RetryInfo = { method: string; attempt: number; delayMs: number; error: string };
export function withTransportRetry(
  rpc: RpcAdapter,
  opts: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void>; /** Called before each retry (e.g. "retrying through Nox…"). */ onRetry?: (info: RetryInfo) => void } = {},
): RpcAdapter {
  const delays = opts.delaysMs ?? [500, 1000, 2000, 4000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    name: rpc.name,
    anonymized: rpc.anonymized,
    async request(args) {
      const isBroadcast = args.method === 'eth_sendRawTransaction';
      const txHash = isBroadcast ? keccak256((args.params?.[0] ?? '0x') as Hex) : undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          return await rpc.request(args);
        } catch (e) {
          if (!(e instanceof RpcTransportError) || attempt >= delays.length) throw e;
          opts.onRetry?.({ method: args.method, attempt: attempt + 1, delayMs: delays[attempt]!, error: e.message });
          await sleep(delays[attempt]!);
          if (txHash) {
            const seen = await rpc.request({ method: 'eth_getTransactionByHash', params: [txHash] }).catch(() => null);
            if (seen) return txHash; // the first send landed: do not push it again
          }
        }
      }
    },
  };
}
