// The HTTP LLM adapter against a real local HTTP server that answers like Groq (body shape captured from a real
// Groq reply on 2026-11-06: id, usage, x_groq.id). Checks what is sent and what the live AI log gets.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openAiCompatibleLlm } from './llm-http.js';

let server: Server | undefined;
afterEach(() => server?.close());
async function serve(reply: unknown) {
  const got: { headers: Record<string, unknown>; body: any }[] = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    got.push({ headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/chat/completions`, got };
}
const groqReply = {
  id: 'chatcmpl-52cea981-4273-46a5-ac49-ab2d5ee55afe',
  model: 'openai/gpt-oss-120b',
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_rules', arguments: '{}' } }] } }],
  usage: { prompt_tokens: 73, completion_tokens: 20, total_tokens: 93 },
  x_groq: { id: 'req_01m6qe5tgpe11b3zncbk2g7mcp' },
};

describe('openAiCompatibleLlm', () => {
  it('sends temperature 0, no streaming, the key as a Bearer header and provider extras; returns request id, tokens, latency, raw reply', async () => {
    const { url, got } = await serve(groqReply);
    const llm = openAiCompatibleLlm({ url, model: 'openai/gpt-oss-120b', fetch: (u, i) => fetch(u, i), apiKey: 'gsk_test', extraBody: { reasoning_format: 'hidden' } });
    const res = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'get_rules', description: 'd', parameters: { type: 'object', properties: {} } }] });
    expect(got[0]!.headers.authorization).toBe('Bearer gsk_test');
    expect(got[0]!.body).toMatchObject({ model: 'openai/gpt-oss-120b', temperature: 0, stream: false, reasoning_format: 'hidden', tool_choice: 'auto' });
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'get_rules', arguments: '{}' }]);
    expect(res.meta).toMatchObject({ requestId: 'req_01m6qe5tgpe11b3zncbk2g7mcp', usage: { prompt: 73, completion: 20, total: 93 } });
    expect(res.meta!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(res.meta!.raw)).toEqual(groqReply);
  });
  it('a plain completion sends no tools and no tool_choice; no key = no Authorization header; other providers use the body id', async () => {
    const { url, got } = await serve({ ...groqReply, x_groq: undefined, choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
    const res = await openAiCompatibleLlm({ url, model: 'm', fetch: (u, i) => fetch(u, i) }).chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(got[0]!.body).not.toHaveProperty('tools');
    expect(got[0]!.body).not.toHaveProperty('tool_choice');
    expect(got[0]!.headers).not.toHaveProperty('authorization');
    expect(res.meta!.requestId).toBe('chatcmpl-52cea981-4273-46a5-ac49-ab2d5ee55afe');
  });
});
