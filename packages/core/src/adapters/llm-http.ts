import type { LlmAdapter, LlmMessage, LlmRequest, LlmResponse } from './types.js';

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * Provider-neutral LLM adapter over an OpenAI-compatible chat-completions endpoint (the Blindspot LLM
 * proxy, which holds the provider key). Request/response shapes follow Groq's documented
 * OpenAI-compatible tool calling: tools [{type:"function", function:{name, description, parameters}}],
 * response choices[0].message.tool_calls[{id, type:"function", function:{name, arguments}}],
 * tool results as {role:"tool", tool_call_id, content}. `fetch` is injected by the shell.
 */
export function openAiCompatibleLlm(opts: {
  url: string;
  model: string;
  fetch: Fetch;
  timeoutMs?: number;
  /** Sent as "Authorization: Bearer …" when calling a provider directly (the agent app). Never logged. */
  apiKey?: string;
  /** Default 0 (SPEC: temperature 0). */
  temperature?: number;
  /** Provider-specific fields, e.g. Groq's reasoning_format for gpt-oss models. */
  extraBody?: Record<string, unknown>;
}): LlmAdapter {
  const toWire = (m: LlmMessage) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant')
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
      };
    return { role: m.role, content: m.content };
  };
  return {
    name: `openai-compatible:${opts.model}`,
    async chat(req: LlmRequest): Promise<LlmResponse> {
      const body = {
        ...opts.extraBody,
        model: opts.model,
        temperature: opts.temperature ?? 0,
        stream: false,
        messages: req.messages.map(toWire),
        // A plain completion (no tools, e.g. the rules drafter) sends neither field.
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: req.toolChoice ?? 'auto' }
          : {}),
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
      let status: number;
      let text: string;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
      const t0 = Date.now();
      try {
        const res = await opts.fetch(opts.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
        status = res.status;
        text = await res.text();
      } finally {
        clearTimeout(timer);
      }
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`LLM: non-JSON response (HTTP ${status})`);
      }
      if (status !== 200 || json.error) {
        const err = new Error(`LLM error (HTTP ${status}): ${json.error?.message ?? 'unknown'}`) as Error & { failedGeneration?: unknown };
        if (json.error?.failed_generation) err.failedGeneration = json.error.failed_generation;
        throw err;
      }
      const msg = json.choices?.[0]?.message ?? {};
      const u = json.usage ?? {};
      return {
        content: msg.content ?? null,
        toolCalls: (msg.tool_calls ?? []).map((c: any) => ({ id: String(c.id), name: String(c.function?.name ?? ''), arguments: String(c.function?.arguments ?? '{}') })),
        finishReason: String(json.choices?.[0]?.finish_reason ?? ''),
        model: String(json.model ?? opts.model),
        meta: {
          // Groq puts its request id in the body (x_groq.id): its x-request-id header is not exposed to browsers.
          requestId: String(json.x_groq?.id ?? json.id ?? ''),
          usage: { prompt: Number(u.prompt_tokens ?? 0), completion: Number(u.completion_tokens ?? 0), total: Number(u.total_tokens ?? 0) },
          latencyMs: Date.now() - t0,
          raw: text,
        },
      };
    },
  };
}
