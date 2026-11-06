/**
 * Platform adapters (SPEC §7.1). packages/core never calls chrome.*, window, fetch or key material
 * directly: each shell (playground, extension) implements these interfaces.
 */

/** JSON-RPC transport (EIP-1193 style). In the product this is the Anon-RPC harness (Nox / tor-js). */
export interface RpcAdapter {
  /** Short label for traffic accounting, e.g. "nox", "tor-js", "direct (test)". */
  readonly name: string;
  /** True when requests are anonymized (counts toward the Anon-RPC traffic share). */
  readonly anonymized: boolean;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Persistent key-value state (JSON values). Keys are never stored here unencrypted (shell's job). */
export interface StorageAdapter {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Provider-neutral tool-calling chat model (OpenAI-compatible shapes; Groq in the playground). */
export type LlmToolDef = {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
};
export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
export type LlmToolCall = { id: string; name: string; /** raw JSON string from the model */ arguments: string };
export type LlmRequest = {
  messages: LlmMessage[];
  tools: LlmToolDef[];
  toolChoice?: 'auto' | 'required' | 'none';
};
export type LlmResponse = {
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string;
  model: string;
  /** For the live AI log (HTTP adapters only): provider request id, token usage, latency, raw reply body. */
  meta?: { requestId: string; usage: { prompt: number; completion: number; total: number }; latencyMs: number; raw: string };
};
export interface LlmAdapter {
  readonly name: string;
  chat(req: LlmRequest): Promise<LlmResponse>;
}

/** Reads untrusted content for the agent (pages, documents, repositories). */
export type SourceKind = 'page' | 'document' | 'repo';
export type SourceRead = { kind: SourceKind; url: string; content: string; files?: { path: string; content: string }[] };
export interface ReadSourceAdapter {
  read(kind: SourceKind, url?: string): Promise<SourceRead>;
}

/** Runs untrusted script text in a sandbox with no keys; only `propose()` is exposed to it. */
export interface RunScriptAdapter {
  run(path: string, code: string, api: { propose: (input: unknown) => Promise<unknown> }): Promise<{ output: string }>;
}
