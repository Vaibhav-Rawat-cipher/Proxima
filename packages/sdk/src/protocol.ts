/** An OpenAI-style function tool: name, description, JSON Schema parameters. */
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type Address = `0x${string}`;

/**
 * Session protocol between an outside agent app and the Blindspot wallet (Step 3a). Carried over
 * window.postMessage between two origins (the agent app opens the wallet in a popup). Every message is
 * validated strictly on receipt; anything malformed is ignored.
 *
 * The agent app holds no keys: it can only ask the wallet to run tools. The wallet runs every tool itself
 * (reads are traced as untrusted, proposals are checked, execute signs only ALLOWed proposals after the
 * owner clicks Approve & send). The owner approves the session and can revoke it; locking or closing the
 * wallet ends every session.
 */
export const PROTOCOL = 'blindspot-session/1';

/** Tools an agent may call over a session (SPEC §9 + token_info; read_page comes later). */
export const SESSION_TOOLS = ['get_rules', 'get_balances', 'resolve_name', 'token_info', 'propose', 'execute', 'read_document', 'read_repo', 'run_script'] as const;
export type SessionTool = (typeof SESSION_TOOLS)[number];

/** What the owner is asked to approve (shown verbatim in the wallet). */
export const SESSION_PERMISSIONS = {
  can: ['read the rules on its ENS name', 'read balances and resolve names', 'read documents and repositories through the wallet (marked untrusted)', 'propose transactions (checked against the rules)', 'execute ALLOWED proposals — each one still needs your Approve & send'],
  cannot: ['change the rules', 'sign anything itself (it never sees a key)', 'execute a BLOCKED or ASK_OWNER proposal'],
} as const;

export type EndReason = 'revoked' | 'locked' | 'closed' | 'disconnected';

export type AgentToWallet =
  | { protocol: typeof PROTOCOL; kind: 'connect'; requestId: string; agentName: string }
  | { protocol: typeof PROTOCOL; kind: 'call'; sessionId: string; callId: string; tool: SessionTool; args: Record<string, unknown> }
  | { protocol: typeof PROTOCOL; kind: 'disconnect'; sessionId: string };

export type WalletToAgent =
  | { protocol: typeof PROTOCOL; kind: 'ready' }
  | { protocol: typeof PROTOCOL; kind: 'session'; requestId: string; sessionId: string; ensName: string; agent: Address; tools: ToolDefinition[] }
  | { protocol: typeof PROTOCOL; kind: 'rejected'; requestId: string; reason: string }
  | { protocol: typeof PROTOCOL; kind: 'result'; callId: string; ok: true; content: string }
  | { protocol: typeof PROTOCOL; kind: 'result'; callId: string; ok: false; code: 'ended' | 'denied' | 'tool'; error: string }
  | { protocol: typeof PROTOCOL; kind: 'ended'; sessionId: string; reason: EndReason };

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const keysOnly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => k in o);

/** A display name: printable, no control characters, at most 64 characters. */
export const cleanName = (s: string) => /^[\p{L}\p{N} ._-]{1,64}$/u.test(s);

export function parseAgentMessage(data: unknown): AgentToWallet | null {
  if (!isObj(data) || data.protocol !== PROTOCOL) return null;
  switch (data.kind) {
    case 'connect':
      return keysOnly(data, ['protocol', 'kind', 'requestId', 'agentName']) && isId(data.requestId) && typeof data.agentName === 'string' && cleanName(data.agentName) ? (data as AgentToWallet) : null;
    case 'call':
      return keysOnly(data, ['protocol', 'kind', 'sessionId', 'callId', 'tool', 'args']) &&
        isId(data.sessionId) &&
        isId(data.callId) &&
        typeof data.tool === 'string' &&
        (SESSION_TOOLS as readonly string[]).includes(data.tool) &&
        isObj(data.args) &&
        JSON.stringify(data.args).length <= 64_000
        ? (data as AgentToWallet)
        : null;
    case 'disconnect':
      return keysOnly(data, ['protocol', 'kind', 'sessionId']) && isId(data.sessionId) ? (data as AgentToWallet) : null;
    default:
      return null;
  }
}

export function parseWalletMessage(data: unknown): WalletToAgent | null {
  if (!isObj(data) || data.protocol !== PROTOCOL) return null;
  switch (data.kind) {
    case 'ready':
      return keysOnly(data, ['protocol', 'kind']) ? (data as WalletToAgent) : null;
    case 'session':
      return keysOnly(data, ['protocol', 'kind', 'requestId', 'sessionId', 'ensName', 'agent', 'tools']) && isId(data.requestId) && isId(data.sessionId) && isStr(data.ensName, 255) && isStr(data.agent, 42) && Array.isArray(data.tools)
        ? (data as WalletToAgent)
        : null;
    case 'rejected':
      return keysOnly(data, ['protocol', 'kind', 'requestId', 'reason']) && isId(data.requestId) && isStr(data.reason, 500) ? (data as WalletToAgent) : null;
    case 'result':
      if (!isId(data.callId)) return null;
      if (data.ok === true) return keysOnly(data, ['protocol', 'kind', 'callId', 'ok', 'content']) && typeof data.content === 'string' ? (data as WalletToAgent) : null;
      return keysOnly(data, ['protocol', 'kind', 'callId', 'ok', 'code', 'error']) && data.ok === false && ['ended', 'denied', 'tool'].includes(String(data.code)) && isStr(data.error, 2000) ? (data as WalletToAgent) : null;
    case 'ended':
      return keysOnly(data, ['protocol', 'kind', 'sessionId', 'reason']) && isId(data.sessionId) && ['revoked', 'locked', 'closed', 'disconnected'].includes(String(data.reason)) ? (data as WalletToAgent) : null;
    default:
      return null;
  }
}

/** 128-bit random id (WebCrypto, available in browsers and Node 20+). */
export function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
