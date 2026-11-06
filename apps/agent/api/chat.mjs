// Hosted LLM proxy (Vercel function on the agent app's own origin: POST /api/chat, OpenAI-compatible body).
// The ONLY hosted code that reads LLM_API_KEY. Same rules as checks/r3-llm/proxy.mjs: model allowlist, temperature 0,
// no streaming, hidden reasoning, request size cap, per-IP rate limit (per function instance, best-effort).
// Declared backend (README → Privacy and CROPS). Env: LLM_API_KEY, LLM_PER_IP_PER_MINUTE (optional, default 10).
const PROVIDER = { baseUrl: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'] };
const MAX_BODY = 256 * 1024;
const PER_IP = Number(process.env.LLM_PER_IP_PER_MINUTE ?? 10);
const GLOBAL = 60; // requests per minute per instance
const hits = new Map();
let recent = [];

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'POST an OpenAI-compatible chat body' } });
  const origin = req.headers.origin;
  if (origin && origin !== `https://${req.headers.host}`) return res.status(403).json({ error: { message: 'origin not allowed' } });
  const key = process.env.LLM_API_KEY;
  if (!key) return res.status(503).json({ error: { message: 'The hosted AI is not configured.' } });

  const now = Date.now();
  const ip = String(req.headers['x-forwarded-for'] ?? req.headers['x-real-ip'] ?? 'unknown').split(',')[0].trim();
  recent = recent.filter((t) => now - t < 60_000);
  const mine = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (mine.length >= PER_IP || recent.length >= GLOBAL) return res.status(429).json({ error: { message: 'rate limited — try again in a minute' } });
  hits.set(ip, [...mine, now]);
  recent.push(now);

  const body = typeof req.body === 'string' ? JSON.parse(req.body || 'null') : req.body;
  if (!body || typeof body !== 'object' || JSON.stringify(body).length > MAX_BODY) return res.status(400).json({ error: { message: 'invalid or too large request' } });
  const model = body.model ?? PROVIDER.models[0];
  if (!PROVIDER.models.includes(model)) return res.status(400).json({ error: { message: `model not allowed: ${model}` } });

  // The proxy, not the caller, decides these.
  const forward = { ...body, model, temperature: 0, stream: false, reasoning_format: 'hidden' };
  try {
    const upstream = await fetch(`${PROVIDER.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(forward),
      signal: AbortSignal.timeout(55_000),
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader('content-type', 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: { message: `upstream error: ${e.message}` } });
  }
}
