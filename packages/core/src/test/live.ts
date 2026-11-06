// Test-only helpers: a REAL direct JSON-RPC adapter to Sepolia (not a mock) and the repo config.
// Test traffic is tooling, not product traffic (the product's rpc adapter is Anon-RPC).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RpcAdapter } from '../adapters/types.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

function readEnv(): Record<string, string> {
  const f = resolve(ROOT, '.env');
  if (!existsSync(f)) return {};
  return Object.fromEntries(
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      }),
  );
}

export const env = readEnv();
export const config = JSON.parse(readFileSync(resolve(ROOT, 'config/sepolia.json'), 'utf8')) as Record<string, any>;
export const hasRpc = Boolean(env.SEPOLIA_RPC_URL);

let id = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Test-only direct JSON-RPC adapter. Transport failures (HTTP 429 / 5xx / empty or non-JSON body, which
 * the provider returns under load) are retried with backoff; JSON-RPC errors are returned as-is, never
 * retried or hidden. The product's rpc adapter is Anon-RPC.
 */
export function directRpc(url = env.SEPOLIA_RPC_URL ?? ''): RpcAdapter {
  return {
    name: 'direct (test)',
    anonymized: false,
    async request({ method, params }) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] });
      let json: { result?: unknown; error?: { code: number; message: string; data?: unknown } } | undefined;
      let lastProblem = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await sleep(400 * 2 ** attempt);
        let res: Response;
        try {
          res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        } catch (e) {
          lastProblem = `network error: ${(e as Error).message}`;
          continue;
        }
        const text = await res.text();
        if (res.status === 429 || res.status >= 500 || text.trim() === '') {
          lastProblem = `HTTP ${res.status}${text.trim() === '' ? ' (empty body)' : ''}`;
          continue;
        }
        try {
          json = JSON.parse(text);
          break;
        } catch {
          lastProblem = `HTTP ${res.status}, non-JSON body`;
        }
      }
      if (!json) throw new Error(`RPC transport failed after 5 attempts (${method}): ${lastProblem}`);
      if (json.error) {
        const err = new Error(json.error.message) as Error & { code?: number; data?: unknown };
        err.code = json.error.code;
        err.data = json.error.data;
        throw err;
      }
      return json.result;
    },
  };
}
