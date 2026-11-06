// Hosted gas-only trial relayer (Vercel function on the wallet's own origin: POST /api/provision {"agent":"0x…"}).
// Same handler as the local apps/relayer/serve.mjs. It can only call TrialProvisioner.provision(agent); it never holds
// an agent key or Safe funds. Limits: per-IP limit here (per function instance, best-effort), the provisioner's own
// on-chain caps (global 100/day, relayer quota, one per sender per day), kill switch RELAYER_ENABLED=false.
// Env (Vercel project settings): SEPOLIA_RPC_URL, TRIAL_RELAYER_PRIVATE_KEY, TRIAL_PROVISIONER_ADDRESS,
// RELAYER_ENABLED (optional), RELAYER_PER_IP_DAILY (optional).
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createRateLimiter, createRelayer } from '../../relayer/relayer.mjs';

const env = process.env;
let handle = null;
function relayer() {
  if (handle) return handle;
  if (!env.SEPOLIA_RPC_URL || !env.TRIAL_RELAYER_PRIVATE_KEY || !env.TRIAL_PROVISIONER_ADDRESS) return null;
  const account = privateKeyToAccount(env.TRIAL_RELAYER_PRIVATE_KEY);
  const transport = http(env.SEPOLIA_RPC_URL);
  handle = createRelayer({
    provisioner: getAddress(env.TRIAL_PROVISIONER_ADDRESS),
    publicClient: createPublicClient({ chain: sepolia, transport }),
    walletClient: createWalletClient({ chain: sepolia, transport, account }),
    account,
    enabled: () => (env.RELAYER_ENABLED ?? 'true').toLowerCase() !== 'false',
    limiter: createRateLimiter({ perIpPerDay: Number(env.RELAYER_PER_IP_DAILY ?? 2) }),
  });
  return handle;
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST {"agent":"0x…"}' });
  // Same origin only (the hosted wallet calls /api/provision on itself).
  const origin = req.headers.origin;
  if (origin && origin !== `https://${req.headers.host}`) return res.status(403).json({ error: 'origin not allowed' });
  const h = relayer();
  if (!h) return res.status(503).json({ error: 'The relayer is not configured.' });
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null);
  if (body.length > 1024) return res.status(413).json({ error: 'request too large' });
  const ip = String(req.headers['x-forwarded-for'] ?? req.headers['x-real-ip'] ?? 'unknown').split(',')[0].trim();
  const r = await h({ ip, body });
  return res.status(r.status).json(r.json);
}
