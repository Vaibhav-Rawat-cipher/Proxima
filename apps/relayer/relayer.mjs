// Gas-only relayer for Step 3d (owner decision 2026-11-06). It holds a little Sepolia ETH and can do exactly ONE
// thing: call TrialProvisioner.provision(agent) for a visitor whose fresh browser key has no gas yet. It never holds
// an agent key or Safe funds. Limits: per-IP rate limit here, its own daily quota on-chain (inside the global cap of
// 100/day), kill switch (RELAYER_ENABLED=false) and the provisioner's own pause. Shaped as a plain handler so the
// same code runs locally (serve.mjs, 127.0.0.1) and later as a serverless function.
import { BaseError, ContractFunctionRevertedError, decodeEventLog, getAddress, isAddress, parseAbi } from 'viem';

export const PROVISIONER_ABI = parseAbi([
  'function provision(address agent) returns (uint256 id, string label)',
  'event TrialProvisioned(uint256 indexed id, string label, address indexed agent, address indexed sender, uint64 expiry)',
  'error IsPaused()',
  'error InvalidAgent(address agent)',
  'error AgentAlreadyUsed(address agent)',
  'error GlobalCapReached(uint256 day)',
  'error RelayerQuotaReached(uint256 day)',
  'error SenderLimitReached(address sender, uint256 day)',
  'error DripFundsEmpty()',
  'error DripFailed()',
]);

const PLAIN = {
  IsPaused: 'Trials are paused by the owner.',
  InvalidAgent: 'That agent address is not a fresh account.',
  AgentAlreadyUsed: 'That agent address already had a trial.',
  GlobalCapReached: "Today's trial limit is reached. Try again tomorrow, or use simulate-only mode.",
  RelayerQuotaReached: "Today's free trials via the relayer are used up. Use your own wallet, or simulate-only mode.",
  SenderLimitReached: 'One trial per sender per day.',
  DripFundsEmpty: 'The trial gas fund is empty (the owner must top it up).',
  DripFailed: 'The gas drip could not be sent.',
};

/** Per-IP limit (trials per 24 h) and a global per-minute limit. In memory: one process (the hosted version uses a store). */
export function createRateLimiter({ perIpPerDay = 2, globalPerMinute = 10, now = () => Date.now() } = {}) {
  const byIp = new Map();
  let recent = [];
  return {
    check(ip) {
      const t = now();
      recent = recent.filter((x) => t - x < 60_000);
      if (recent.length >= globalPerMinute) return { ok: false, reason: 'Too many trial requests right now. Try again in a minute.' };
      const mine = (byIp.get(ip) ?? []).filter((x) => t - x < 86_400_000);
      byIp.set(ip, mine);
      if (mine.length >= perIpPerDay) return { ok: false, reason: `At most ${perIpPerDay} trials per day from one network address.` };
      return { ok: true };
    },
    record(ip) {
      const t = now();
      recent.push(t);
      byIp.set(ip, [...(byIp.get(ip) ?? []), t]);
    },
  };
}

/** Strict request body: exactly {"agent": "0x…"}. */
export function parseRequest(body) {
  let j;
  try {
    j = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return { error: 'Body must be JSON: {"agent": "0x…"}.' };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j) || Object.keys(j).length !== 1 || typeof j.agent !== 'string') return { error: 'Body must be exactly {"agent": "0x…"}.' };
  if (!isAddress(j.agent, { strict: false })) return { error: 'agent is not an address.' };
  return { agent: getAddress(j.agent) };
}

function revertName(e) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? 'reverted';
  }
  return null;
}

/**
 * @param {{ provisioner: `0x${string}`, publicClient: any, walletClient: any, account: any, limiter: ReturnType<typeof createRateLimiter>,
 *           enabled: () => boolean, minBalanceWei?: bigint, trialsParent?: string, dryRun?: boolean }} o
 * `dryRun` simulates only (never sends): used by the live test.
 */
export function createRelayer(o) {
  const minBalance = o.minBalanceWei ?? 100_000_000_000_000n; // 0.0001 ETH
  const parent = o.trialsParent ?? 'trials.blindspot-demo.eth';
  let queue = Promise.resolve(); // one transaction at a time (nonce order)
  const reply = (status, json) => ({ status, json });

  return async function handle({ ip, body }) {
    if (!o.enabled()) return reply(503, { error: 'The relayer is switched off (owner kill switch).' });
    const req = parseRequest(body);
    if (req.error) return reply(400, { error: req.error });
    const lim = o.limiter.check(ip);
    if (!lim.ok) return reply(429, { error: lim.reason });
    if (!o.dryRun) {
      const bal = await o.publicClient.getBalance({ address: o.account.address });
      if (bal < minBalance) return reply(503, { error: 'The relayer is out of gas funds (the owner must top it up).' });
    }
    // Simulate first: a clean, plain reason for every on-chain limit, and nothing is sent if it would revert.
    let sim;
    try {
      sim = await o.publicClient.simulateContract({ address: o.provisioner, abi: PROVISIONER_ABI, functionName: 'provision', args: [req.agent], account: o.account });
    } catch (e) {
      const name = revertName(e);
      if (name) return reply(409, { error: PLAIN[name] ?? `The provisioner refused (${name}).`, code: name });
      return reply(502, { error: `Could not simulate provision(): ${String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]}` });
    }
    const [, label] = sim.result;
    if (o.dryRun) return reply(200, { dryRun: true, label, name: `${label}.${parent}`, agent: req.agent });

    const run = queue.then(async () => {
      const block = await o.publicClient.getBlock();
      const tip = 1_000_000n; // 0.001 gwei (Sepolia)
      const hash = await o.walletClient.writeContract({ ...sim.request, maxPriorityFeePerGas: tip, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + tip });
      const receipt = await o.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') throw new Error(`provision() reverted (tx ${hash})`);
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== o.provisioner.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: PROVISIONER_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === 'TrialProvisioned') return { hash, label: ev.args.label, expiry: Number(ev.args.expiry) };
        } catch {
          /* not our event */
        }
      }
      throw new Error(`no TrialProvisioned event in tx ${hash}`);
    });
    queue = run.catch(() => {});
    try {
      const r = await run;
      o.limiter.record(ip);
      return reply(200, { label: r.label, name: `${r.label}.${parent}`, agent: req.agent, tx: r.hash, expiresAt: new Date(r.expiry * 1000).toISOString() });
    } catch (e) {
      return reply(502, { error: String(e?.shortMessage ?? e?.message ?? e).split('\n')[0] });
    }
  };
}
