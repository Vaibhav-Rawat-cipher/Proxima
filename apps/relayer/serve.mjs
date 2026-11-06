// Local gas-only relayer on http://127.0.0.1:8788 (Step 3d). Reads from the repo .env ONLY: SEPOLIA_RPC_URL,
// TRIAL_RELAYER_PRIVATE_KEY, and the optional switches RELAYER_ENABLED (kill switch, default true),
// RELAYER_PER_IP_DAILY (default 2), RELAYER_ALLOWED_ORIGIN (default the local wallet). Never prints a key or URL.
// Its RPC traffic goes directly to the provider (server side, declared in README / CROPS).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createRateLimiter, createRelayer } from './relayer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(here, '../../.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
);
const cfg = JSON.parse(readFileSync(resolve(here, '../../config/sepolia.json'), 'utf8'));
if (!env.SEPOLIA_RPC_URL || !env.TRIAL_RELAYER_PRIVATE_KEY) {
  console.error('Missing SEPOLIA_RPC_URL or TRIAL_RELAYER_PRIVATE_KEY in .env (run: pnpm --filter @blindspot/relayer new-key).');
  process.exit(2);
}
const account = privateKeyToAccount(env.TRIAL_RELAYER_PRIVATE_KEY);
const transport = http(env.SEPOLIA_RPC_URL);
const publicClient = createPublicClient({ chain: sepolia, transport });
const walletClient = createWalletClient({ chain: sepolia, transport, account });
const provisioner = getAddress(cfg.trials.provisioner);
const allowedOrigin = env.RELAYER_ALLOWED_ORIGIN || 'http://127.0.0.1:5181';
const enabled = () => (env.RELAYER_ENABLED ?? 'true').toLowerCase() !== 'false';
const handle = createRelayer({
  provisioner,
  publicClient,
  walletClient,
  account,
  enabled,
  limiter: createRateLimiter({ perIpPerDay: Number(env.RELAYER_PER_IP_DAILY ?? 2) }),
});

const server = createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': allowedOrigin, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'Origin' };
  const send = (status, json) => {
    res.writeHead(status, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify(json));
  };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.method === 'GET' && req.url === '/health') {
    const balance = await publicClient.getBalance({ address: account.address }).catch(() => null);
    return send(200, { enabled: enabled(), relayer: account.address, provisioner, balanceWei: balance?.toString() ?? null });
  }
  if (req.method !== 'POST' || req.url !== '/provision') return send(404, { error: 'POST /provision {"agent":"0x…"} or GET /health' });
  if (req.headers.origin && req.headers.origin !== allowedOrigin) return send(403, { error: 'origin not allowed' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024) return send(413, { error: 'request too large' });
  }
  const ip = req.socket.remoteAddress ?? 'unknown';
  const r = await handle({ ip, body });
  console.log(`${new Date().toISOString()} provision ${r.status} ${r.json.label ?? r.json.code ?? r.json.error ?? ''}`);
  send(r.status, r.json);
});
server.listen(8788, '127.0.0.1', () =>
  console.log(`Gas-only relayer on http://127.0.0.1:8788 (relayer ${account.address}, provisioner ${provisioner}, enabled=${enabled()}, origin ${allowedOrigin}). Ctrl+C to stop.`),
);
