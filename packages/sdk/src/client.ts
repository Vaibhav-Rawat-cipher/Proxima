import { PROTOCOL, SESSION_TOOLS, parseWalletMessage, randomId, type Address, type AgentToWallet, type EndReason, type SessionTool, type ToolDefinition } from './protocol.js';

/**
 * The wallet ended the session (revoked, locked, closed, disconnected) or refused it. An agent loop must stop:
 * `stopsAgent` lets any loop recognise it (the Blindspot core loop does).
 */
export class SessionRevokedError extends Error {
  override name = 'SessionRevokedError';
  readonly stopsAgent = true;
  constructor(message: string, readonly reason: EndReason | 'denied' | 'not-connected') {
    super(message);
  }
}
/** Runs one tool call over the session and returns its text result. */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

export type SessionInfo = { sessionId: string; ensName: string; agent: Address; tools: ToolDefinition[] };

/**
 * The agent app's side of a session. It accepts messages only from the configured wallet origin, holds no
 * keys, and can only ask the wallet to run tools. When the wallet ends the session (revoke, lock, close),
 * every pending and future call fails with SessionRevokedError, which stops the agent loop.
 */
export class WalletClient {
  private session: SessionInfo | null = null;
  private ended: EndReason | null = null;
  private readonly pendingConnect = new Map<string, { resolve: (s: SessionInfo) => void; reject: (e: Error) => void }>();
  private readonly pendingCalls = new Map<string, { resolve: (c: string) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly o: {
      walletOrigin: string;
      /** Sends to the wallet window with targetOrigin = walletOrigin. */
      post: (msg: AgentToWallet) => void;
      onEnded?: (reason: EndReason) => void;
      onReady?: () => void;
    },
  ) {}

  get info(): SessionInfo | null {
    return this.ended ? null : this.session;
  }
  get endedBy(): EndReason | null {
    return this.ended;
  }

  /** Feed every received message here; anything not from the wallet origin, or malformed, is ignored. */
  handle(origin: string, data: unknown): void {
    if (origin !== this.o.walletOrigin) return;
    const msg = parseWalletMessage(data);
    if (!msg) return;
    switch (msg.kind) {
      case 'ready':
        this.o.onReady?.();
        return;
      case 'session': {
        const p = this.pendingConnect.get(msg.requestId);
        if (!p) return;
        this.pendingConnect.delete(msg.requestId);
        this.session = { sessionId: msg.sessionId, ensName: msg.ensName, agent: msg.agent, tools: msg.tools.filter((t: ToolDefinition) => (SESSION_TOOLS as readonly string[]).includes(t.name)) };
        this.ended = null;
        p.resolve(this.session);
        return;
      }
      case 'rejected': {
        const p = this.pendingConnect.get(msg.requestId);
        this.pendingConnect.delete(msg.requestId);
        p?.reject(new Error(msg.reason));
        return;
      }
      case 'result': {
        const p = this.pendingCalls.get(msg.callId);
        if (!p) return;
        this.pendingCalls.delete(msg.callId);
        if (msg.ok) p.resolve(msg.content);
        else if (msg.code === 'ended' || msg.code === 'denied') {
          p.reject(new SessionRevokedError(msg.error, msg.code === 'denied' ? 'denied' : this.ended ?? 'revoked'));
        } else p.reject(new Error(msg.error));
        return;
      }
      case 'ended':
        if (this.session?.sessionId === msg.sessionId) this.stop(msg.reason);
        return;
    }
  }

  connect(agentName: string): Promise<SessionInfo> {
    const requestId = randomId();
    return new Promise((resolve, reject) => {
      this.pendingConnect.set(requestId, { resolve, reject });
      this.o.post({ protocol: PROTOCOL, kind: 'connect', requestId, agentName });
    });
  }

  /** The agent loop's tool executor over this session. */
  readonly executor: ToolExecutor = (tool, args) => {
    if (this.ended) return Promise.reject(new SessionRevokedError(`The wallet ended the session (${this.ended}).`, this.ended));
    if (!this.session) return Promise.reject(new SessionRevokedError('Not connected to a wallet.', 'not-connected'));
    if (!(SESSION_TOOLS as readonly string[]).includes(tool)) return Promise.reject(new Error(`unknown tool "${tool}"`));
    const callId = randomId();
    const sessionId = this.session.sessionId;
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(callId, { resolve, reject });
      this.o.post({ protocol: PROTOCOL, kind: 'call', sessionId, callId, tool: tool as SessionTool, args });
    });
  };

  disconnect(): void {
    if (this.session && !this.ended) this.o.post({ protocol: PROTOCOL, kind: 'disconnect', sessionId: this.session.sessionId });
    this.stop('disconnected');
  }

  /** Session over (wallet said so, or the wallet window was closed): fail everything still waiting. */
  stop(reason: EndReason): void {
    if (this.ended && this.pendingConnect.size === 0) return;
    this.ended = reason;
    for (const p of this.pendingCalls.values()) p.reject(new SessionRevokedError(`The wallet ended the session (${reason}).`, reason));
    this.pendingCalls.clear();
    for (const p of this.pendingConnect.values()) p.reject(new SessionRevokedError(`The wallet window was closed before the connection was approved (${reason}).`, reason));
    this.pendingConnect.clear();
    this.o.onEnded?.(reason);
  }
}
