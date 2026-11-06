// R1: eth_blockNumber + eth_simulateV1 to the Sepolia RPC through Anon-RPC, from a browser page.
// Option B (approved): the harness fetches the network's worker bundle and runs it only if its keccak256
// matches the on-chain specifier; we additionally refuse unless that hash equals our pinned hash.
import { AnonRpcWorker } from '@anon-rpc/browser-harness';
import { createPublicClient, encodeFunctionData, http, parseAbi, toHex } from 'viem';
import cfg from '../../../config/sepolia.json';

declare const __R1__: { network: 'nox' | 'torJs'; targetRpc: string; bootstrapRpc: string };
type Result = Record<string, unknown> & { ok: boolean; steps: string[] };
const out: Result = { ok: false, steps: [] };
(window as unknown as { __R1: Result }).__R1 = out;
const logEl = document.getElementById('log')!;
// Never show the RPC URLs (they contain the provider key) in anything the user may copy.
const redact = (s: string) =>
  [__R1__.targetRpc, __R1__.bootstrapRpc].filter(Boolean).reduce((acc, u) => acc.split(u).join('<RPC_URL>'), s).replace(/https?:\/\/\S*alchemy\S*/gi, '<RPC_URL>');
const log = (raw: string) => {
  const s = redact(raw);
  out.steps.push(s);
  logEl.textContent += `\n${s}`;
  console.log(`[R1] ${s}`);
};

const net = cfg.anonRpc[__R1__.network];
const specifier = net.specifier as `0x${string}`;

// The real agent payment (SetupFinal): agent -> module.execute("demo", MockUSDC, 0, transfer(vendor1, 1 MockUSDC)),
// mined in block 12071559. Simulated on top of block 12071558 so the result is deterministic.
const SIM_BLOCK = 12071558n;
const execute = encodeFunctionData({
  abi: parseAbi(['function execute(string label, address to, uint256 value, bytes data) returns (bytes)']),
  functionName: 'execute',
  args: [
    'demo',
    cfg.ens.MockUSDC as `0x${string}`,
    0n,
    encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [cfg.payees.vendor1 as `0x${string}`, 1_000_000n] }),
  ],
});
const simulateBody = {
  jsonrpc: '2.0',
  id: 2,
  method: 'eth_simulateV1',
  params: [{ blockStateCalls: [{ calls: [{ from: cfg.agents.demo.address, to: cfg.module, data: execute }] }], validation: false }, toHex(SIM_BLOCK)],
};
const blockNumberBody = { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] };

async function rpc(f: typeof fetch, body: unknown): Promise<{ ms: number; json: any }> {
  const t = performance.now();
  const res = await f(__R1__.targetRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  return { ms: Math.round(performance.now() - t), json };
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what}: timeout after ${ms} ms`)), ms))]);

async function main() {
  log(`network: ${__R1__.network}  specifier: ${specifier}`);
  if (!__R1__.targetRpc || !__R1__.bootstrapRpc) throw new Error('missing RPC URL(s)');

  // Bootstrap provider (excluded traffic): used once by the harness to read the specifier.
  const boot = createPublicClient({ transport: http(__R1__.bootstrapRpc) });
  const rpcProvider = { request: (args: { method: string; params?: unknown[] }) => boot.request(args as never) };

  // Pinned-hash guard (Option B): refuse if the specifier now points at different code.
  const onchain = await boot.readContract({ address: specifier, abi: parseAbi(['function workerHash() view returns (bytes32)']), functionName: 'workerHash' });
  out.onchainWorkerHash = onchain;
  if (!net.pinnedWorkerHash) {
    log(`no pinned hash yet for ${__R1__.network}; on-chain workerHash is ${onchain} (record it, then re-run)`);
    out.needsPin = true;
    return;
  }
  if (onchain.toLowerCase() !== net.pinnedWorkerHash.toLowerCase()) throw new Error(`workerHash changed: on-chain ${onchain} != pinned ${net.pinnedWorkerHash}`);
  log(`workerHash matches pinned ${onchain}`);

  const t0 = performance.now();
  const worker = new AnonRpcWorker({ address: specifier, config: (net.config ?? undefined) as never, preExisting: { rpcProvider } });
  void (async () => {
    for (;;) {
      try {
        const e = await worker.acceptLog();
        console.log(`[worker ${e.level}]`, ...e.args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))));
      } catch {
        return;
      }
    }
  })();
  await withTimeout(worker.ready, 180_000, 'worker.ready');
  out.readyMs = Math.round(performance.now() - t0);
  log(`worker ready after ${out.readyMs} ms`);
  const anonFetch = worker.fetch as unknown as typeof fetch;

  // 1. eth_blockNumber through Anon-RPC
  const bn = await withTimeout(rpc(anonFetch, blockNumberBody), 120_000, 'eth_blockNumber');
  out.blockNumber = bn.json.result;
  log(`eth_blockNumber via ${__R1__.network}: ${bn.json.result ?? JSON.stringify(bn.json.error)} (${bn.ms} ms)`);

  // 2. eth_simulateV1 through Anon-RPC vs the same request sent directly
  const anonSim = await withTimeout(rpc(anonFetch, simulateBody), 120_000, 'eth_simulateV1');
  const directSim = await rpc(fetch, simulateBody);
  const a = anonSim.json.result?.[0]?.calls?.[0];
  const d = directSim.json.result?.[0]?.calls?.[0];
  out.simulate = { anon: a ?? anonSim.json.error, direct: d ?? directSim.json.error, ms: anonSim.ms };
  const same = JSON.stringify(anonSim.json.result) === JSON.stringify(directSim.json.result);
  log(`eth_simulateV1 via ${__R1__.network}: status ${a?.status} gasUsed ${a ? BigInt(a.gasUsed) : '-'} logs ${a?.logs?.length ?? '-'} (${anonSim.ms} ms)`);
  log(`eth_simulateV1 direct:             status ${d?.status} gasUsed ${d ? BigInt(d.gasUsed) : '-'} logs ${d?.logs?.length ?? '-'}`);
  log(`anon result identical to direct result: ${same}`);

  // 3. latency / reliability: 20 sequential eth_blockNumber calls
  const ms: number[] = [];
  let okCalls = 0;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await withTimeout(rpc(anonFetch, { ...blockNumberBody, id: 100 + i }), 60_000, 'call');
      if (r.json.result) okCalls++;
      ms.push(r.ms);
    } catch (e) {
      log(`call ${i + 1} failed: ${(e as Error).message}`);
    }
  }
  ms.sort((x, y) => x - y);
  out.latency = { ok: okCalls, of: 20, p50: ms[Math.floor(ms.length / 2)], p90: ms[Math.floor(ms.length * 0.9)], max: ms[ms.length - 1] };
  log(`20 x eth_blockNumber: ${okCalls}/20 ok, p50 ${ms[Math.floor(ms.length / 2)]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms, max ${ms[ms.length - 1]} ms`);

  out.ok = Boolean(bn.json.result) && a?.status === '0x1' && same && okCalls >= 18;
  worker.close();
}

main()
  .catch((e) => {
    out.error = String((e as Error).message ?? e);
    log(`ERROR: ${out.error}`);
  })
  .finally(() => {
    out.done = true;
    log(`R1 ${__R1__.network}: ${out.ok ? 'PASS' : 'NOT PASSED'}`);
  });
