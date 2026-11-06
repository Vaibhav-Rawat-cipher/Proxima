// Retry policy against a REAL local HTTP server that misbehaves on purpose (429, 5xx, empty body,
// non-JSON) — transport errors are retried, JSON-RPC errors never are, broadcasts are never pushed twice.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { keccak256 } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcResponseError, RpcTransportError, httpRpcAdapter, withTransportRetry } from './rpc.js';

type Reply = { status: number; body: string };
let server: Server | undefined;
afterEach(() => server?.close());

async function serve(handler: (req: { method: string; params: unknown[] }, n: number) => Reply, onRetry?: Parameters<typeof withTransportRetry>[1] extends infer O ? (O extends { onRetry?: infer R } ? R : never) : never) {
  let n = 0;
  const calls: string[] = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const j = JSON.parse(raw);
    calls.push(j.method);
    const r = handler(j, ++n);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(r.body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const rpc = withTransportRetry(httpRpcAdapter({ name: 'test', anonymized: true, url, fetch: (u, i) => fetch(u, i) }), { sleep: async () => {}, ...(onRetry ? { onRetry } : {}) });
  return { rpc, calls };
}
const ok = (result: unknown): Reply => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });

describe('transport retry policy', () => {
  it('reports every retry (for the "retrying through Nox…" state), and never a JSON-RPC error', async () => {
    const seen: { method: string; attempt: number; delayMs: number }[] = [];
    const { rpc } = await serve((_, n) => (n <= 2 ? { status: 503, body: 'down' } : ok('0x12')), (i) => seen.push({ method: i.method, attempt: i.attempt, delayMs: i.delayMs }));
    expect(await rpc.request({ method: 'eth_blockNumber' })).toBe('0x12');
    expect(seen).toEqual([{ method: 'eth_blockNumber', attempt: 1, delayMs: 500 }, { method: 'eth_blockNumber', attempt: 2, delayMs: 1000 }]);
    const none: unknown[] = [];
    const r2 = await serve(() => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }) }), (i) => none.push(i));
    await r2.rpc.request({ method: 'eth_call', params: [] }).catch(() => {});
    expect(none).toEqual([]);
  });

  it('retries HTTP 429 and succeeds', async () => {
    const { rpc, calls } = await serve((_, n) => (n === 1 ? { status: 429, body: 'slow down' } : ok('0x10')));
    expect(await rpc.request({ method: 'eth_blockNumber' })).toBe('0x10');
    expect(calls).toHaveLength(2);
  });

  it('retries an empty body and a non-JSON body', async () => {
    const { rpc, calls } = await serve((_, n) => (n === 1 ? { status: 200, body: '' } : n === 2 ? { status: 200, body: '<html>' } : ok('0x11')));
    expect(await rpc.request({ method: 'eth_blockNumber' })).toBe('0x11');
    expect(calls).toHaveLength(3);
  });

  it('gives up after 4 retries (5 attempts) with a transport error', async () => {
    const { rpc, calls } = await serve(() => ({ status: 503, body: 'down' }));
    await expect(rpc.request({ method: 'eth_blockNumber' })).rejects.toBeInstanceOf(RpcTransportError);
    expect(calls).toHaveLength(5);
  });

  it('never retries a JSON-RPC error (a real answer, e.g. a revert)', async () => {
    const { rpc, calls } = await serve(() => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x1234' } }) }));
    const err = await rpc.request({ method: 'eth_call', params: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcResponseError);
    expect(err.data).toBe('0x1234');
    expect(calls).toEqual(['eth_call']);
  });

  it('broadcast: if the first send landed, it is not pushed again', async () => {
    const raw = '0x02f8aa0102030405';
    const { rpc, calls } = await serve((req, n) => {
      if (req.method === 'eth_sendRawTransaction') return n === 1 ? { status: 502, body: 'gateway' } : ok(keccak256(raw));
      if (req.method === 'eth_getTransactionByHash') return ok({ hash: keccak256(raw) });
      return ok(null);
    });
    expect(await rpc.request({ method: 'eth_sendRawTransaction', params: [raw] })).toBe(keccak256(raw));
    expect(calls).toEqual(['eth_sendRawTransaction', 'eth_getTransactionByHash']);
  });

  it('broadcast: if the first send did not land, it is resent (same signed bytes)', async () => {
    const raw = '0x02f8aa0102030406';
    const { rpc, calls } = await serve((req, n) => {
      if (req.method === 'eth_sendRawTransaction') return n === 1 ? { status: 502, body: 'gateway' } : ok(keccak256(raw));
      return ok(null); // eth_getTransactionByHash: not found
    });
    expect(await rpc.request({ method: 'eth_sendRawTransaction', params: [raw] })).toBe(keccak256(raw));
    expect(calls).toEqual(['eth_sendRawTransaction', 'eth_getTransactionByHash', 'eth_sendRawTransaction']);
  });
});
