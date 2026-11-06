import type { Address } from 'viem';
import type { LlmToolDef } from '../adapters/types.js';
import { TOOL_DEFS } from '../agent/tools.js';
import { PROTOCOL, SESSION_PERMISSIONS, SESSION_TOOLS, parseAgentMessage, randomId, type EndReason, type SessionTool, type WalletToAgent } from '@blindspot/sdk';

export type Session = { id: string; origin: string; agentName: string; createdAt: number; active: boolean; endedBy?: EndReason; calls: number };
export type ConnectRequest = { origin: string; agentName: string; ensName: string; agent: Address; permissions: typeof SESSION_PERMISSIONS };

export type WalletHostOptions = {
  /** Sends a message to the agent window at exactly this origin (postMessage targetOrigin). */
  send: (origin: string, msg: WalletToAgent) => void;
  ensName: string;
  agent: Address;
  /** The owner's decision on a connection request (shown in the wallet UI). */
  approveConnect: (req: ConnectRequest) => Promise<boolean>;
  /** Runs one tool inside the wallet for this session (runTool on the session's own RunContext). */
  exec: (session: Session, tool: SessionTool, args: Record<string, unknown>) => Promise<string>;
  /** UI refresh after any session change. */
  onChange?: (sessions: Session[]) => void;
  /** A session ended: the wallet cancels anything still waiting for the owner for that session. */
  onEnded?: (session: Session) => void;
  /** True while the wallet is locked (no session can be created). */
  isLocked: () => boolean;
  now?: () => number;
};

type Body<T> = T extends unknown ? Omit<T, 'protocol'> : never;
const reply = (origin: string, o: WalletHostOptions, msg: Body<WalletToAgent>) => o.send(origin, { protocol: PROTOCOL, ...msg } as WalletToAgent);

/**
 * The wallet side of a session. Every call must come from the origin that opened the session, on a session
 * that is still active; the tool runs in the wallet. Revoke, lock and window-close end sessions.
 */
export class WalletHost {
  private readonly sessions = new Map<string, Session>();
  readonly tools: LlmToolDef[] = TOOL_DEFS.filter((t) => (SESSION_TOOLS as readonly string[]).includes(t.name));
  constructor(private readonly o: WalletHostOptions) {}

  list(): Session[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  async handle(origin: string, data: unknown): Promise<void> {
    const msg = parseAgentMessage(data);
    if (!msg) return; // malformed or not ours: ignored
    if (msg.kind === 'connect') {
      if (this.o.isLocked()) return reply(origin, this.o, { kind: 'rejected', requestId: msg.requestId, reason: 'The wallet is locked. Unlock it, then connect again.' });
      const ok = await this.o.approveConnect({ origin, agentName: msg.agentName, ensName: this.o.ensName, agent: this.o.agent, permissions: SESSION_PERMISSIONS });
      if (!ok) return reply(origin, this.o, { kind: 'rejected', requestId: msg.requestId, reason: 'The wallet owner rejected the connection.' });
      if (this.o.isLocked()) return reply(origin, this.o, { kind: 'rejected', requestId: msg.requestId, reason: 'The wallet was locked before the connection was approved.' });
      const s: Session = { id: randomId(), origin, agentName: msg.agentName, createdAt: (this.o.now ?? Date.now)(), active: true, calls: 0 };
      this.sessions.set(s.id, s);
      this.changed();
      return reply(origin, this.o, { kind: 'session', requestId: msg.requestId, sessionId: s.id, ensName: this.o.ensName, agent: this.o.agent, tools: this.tools });
    }
    const s = this.sessions.get(msg.sessionId);
    // A session id from another origin is treated exactly like an unknown one (no information leak).
    const mine = s && s.origin === origin ? s : undefined;
    if (msg.kind === 'disconnect') {
      if (mine?.active) this.end(mine.id, 'disconnected');
      return;
    }
    if (!mine) return reply(origin, this.o, { kind: 'result', callId: msg.callId, ok: false, code: 'denied', error: 'Unknown session. Connect to the wallet first.' });
    if (!mine.active) return reply(origin, this.o, { kind: 'result', callId: msg.callId, ok: false, code: 'ended', error: `The wallet ended this session (${mine.endedBy}).` });
    mine.calls++;
    this.changed();
    let result: WalletToAgent;
    try {
      const content = await this.o.exec(mine, msg.tool, msg.args);
      result = { protocol: PROTOCOL, kind: 'result', callId: msg.callId, ok: true, content };
    } catch (e) {
      result = { protocol: PROTOCOL, kind: 'result', callId: msg.callId, ok: false, code: 'tool', error: (e as Error).message.split('\n')[0]!.slice(0, 2000) };
    }
    // If the session ended while the tool ran (e.g. revoked during an approval), the agent gets "ended", not the result.
    if (!mine.active) return reply(origin, this.o, { kind: 'result', callId: msg.callId, ok: false, code: 'ended', error: `The wallet ended this session (${mine.endedBy}).` });
    this.o.send(origin, result);
  }

  /** Ends one session (revoke from the wallet UI, or the agent's disconnect). */
  end(id: string, reason: EndReason): void {
    const s = this.sessions.get(id);
    if (!s || !s.active) return;
    s.active = false;
    s.endedBy = reason;
    reply(s.origin, this.o, { kind: 'ended', sessionId: s.id, reason });
    this.o.onEnded?.({ ...s });
    this.changed();
  }

  /** Lock or window close: every active session ends. */
  endAll(reason: EndReason): void {
    for (const s of this.sessions.values()) if (s.active) this.end(s.id, reason);
  }

  private changed() {
    this.o.onChange?.(this.list());
  }
}
