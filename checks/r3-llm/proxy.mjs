// R3 LLM proxy (local check). The ONLY place that reads LLM_API_KEY.
// Provider-neutral on its public side: it accepts an OpenAI-compatible chat-completions body and
// forwards it to the configured provider (Groq, OpenAI-compatible:
// https://console.groq.com/docs/openai, https://console.groq.com/docs/api-reference).
// Enforces: model allowlist, temperature 0, no streaming, request size cap, simple rate limit.
// Usage: node proxy.mjs   (listens on http://127.0.0.1:8787/v1/chat/completions)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(here, '../../.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const KEY = env.LLM_API_KEY;
if (!KEY) {
  console.error('LLM_API_KEY is missing in .env');
  process.exit(2);
}

export const PROVIDER = {
  name: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], // primary, fallback (llama-3.3-70b-versatile is not available on this Groq key: model_not_found)
};
const PORT = 8787;
const MAX_BODY = 256 * 1024;
const RATE = { windowMs: 60_000, max: 20 }; // per client address
const hits = new Map();

// CORS: only the local milestone check page may call the proxy from a browser.
const ALLOWED_ORIGINS = ['http://127.0.0.1:5175'];
const UPSTREAM_TIMEOUT_MS = 60_000;
const cors = (req) => {
  const origin = req.headers.origin;
  return origin && ALLOWED_ORIGINS.includes(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', vary: 'origin' }
    : {};
};
let currentReq;
const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', ...cors(currentReq) });
  res.end(JSON.stringify(obj));
};

createServer(async (req, res) => {
  currentReq = req;
  if (req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)) return send(res, 403, { error: { message: 'origin not allowed' } });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req));
    return res.end();
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(res, 404, { error: { message: 'not found' } });
  const ip = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE.windowMs);
  if (recent.length >= RATE.max) return send(res, 429, { error: { message: 'rate limited' } });
  hits.set(ip, [...recent, now]);

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return send(res, 413, { error: { message: 'request too large' } });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: { message: 'invalid JSON' } });
  }
  const model = body.model ?? PROVIDER.models[0];
  if (!PROVIDER.models.includes(model)) return send(res, 400, { error: { message: `model not allowed: ${model}` } });

  // The proxy, not the caller, decides these.
  const forward = { ...body, model, temperature: 0, stream: false };
  if (model.startsWith('openai/gpt-oss')) forward.reasoning_format = forward.reasoning_format ?? 'hidden';

  try {
    const upstream = await fetch(`${PROVIDER.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(forward),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json', ...cors(req) });
    res.end(text);
  } catch (e) {
    send(res, 502, { error: { message: `upstream error: ${e.message}` } });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`R3 LLM proxy on http://127.0.0.1:${PORT}/v1/chat/completions (provider ${PROVIDER.name})`));
