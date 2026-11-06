// Session protocol between the agent app and the wallet. The bridge mimics window.postMessage between two
// origins: every message is copied (structuredClone) and delivered asynchronously with its sender's origin.
import { describe, expect, it } from 'vitest';
import { runAgentWith } from '../agent/loop.js';
import { scriptedLlm } from '../agent/scripted.js';
import { SessionRevokedError, WalletClient } from '@blindspot/sdk';
import { PROTOCOL, parseAgentMessage, parseWalletMessage, SESSION_PERMISSIONS } from '@blindspot/sdk';
import { WalletHost, type ConnectRequest, type Session } from './wallet-host.js';

const AGENT = 'http://127.0.0.1:5180';
const WALLET = 'http://127.0.0.1:5181';
const EVIL = 'http://127.0.0.1:6666';
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { approve?: boolean; locked?: boolean; exec?: (s: Session, tool: string, args: Record<string, unknown>) => Promise<string> } = {}) {
  const requests: ConnectRequest[] = [];
  const execCalls: { session: string; tool: string; args: Record<string, unknown> }[] = [];
  const sentTo: string[] = [];
  const ended: string[] = [];
  let locked = opts.locked ?? false;
  let client!: WalletClient;
  const host = new WalletHost({
    ensName: 'demo.blindspot-demo.eth',
    agent: '0xab5437DcC26cFA763692Ab2e3e6Ee46D11Fc6DF1',
    isLocked: () => locked,
    approveConnect: async (req) => {
      requests.push(req);
      return opts.approve ?? true;
    },
    exec: async (s, tool, args) => {
      execCalls.push({ session: s.id, tool, args });
      return opts.exec ? opts.exec(s, tool, args) : `ran ${tool}`;
    },
    send: (origin, msg) => {
      sentTo.push(origin);
      const copy = structuredClone(msg);
      if (origin === AGENT) setTimeout(() => client.handle(WALLET, copy), 0);
    },
    onEnded: (s) => ended.push(`${s.id}:${s.endedBy}`),
  });
  client = new WalletClient({ walletOrigin: WALLET, post: (msg) => setTimeout(() => void host.handle(AGENT, structuredClone(msg)), 0) });
  return { host, client, requests, execCalls, sentTo, ended, lock: (v: boolean) => (locked = v) };
}

describe('3a session: connect', () => {
  it('needs the owner\'s approval; the request shows the agent origin, the ENS name and what it can and cannot do', async () => {
    const t = setup();
    const info = await t.client.connect('Blindspot agent');
    expect(t.requests).toEqual([{ origin: AGENT, agentName: 'Blindspot agent', ensName: 'demo.blindspot-demo.eth', agent: '0xab5437DcC26cFA763692Ab2e3e6Ee46D11Fc6DF1', permissions: SESSION_PERMISSIONS }]);
    expect(SESSION_PERMISSIONS.cannot).toContain('change the rules');
    expect(info.ensName).toBe('demo.blindspot-demo.eth');
    expect(info.tools.map((x) => x.name).sort()).toEqual(['execute', 'get_balances', 'get_rules', 'propose', 'read_document', 'read_repo', 'resolve_name', 'run_script', 'token_info']);
    expect(t.host.list()).toMatchObject([{ origin: AGENT, active: true }]);
  });
  it('a rejected request creates no session', async () => {
    const t = setup({ approve: false });
    await expect(t.client.connect('agent')).rejects.toThrow(/rejected the connection/);
    expect(t.host.list()).toEqual([]);
  });
  it('a locked wallet refuses to connect without asking', async () => {
    const t = setup({ locked: true });
    await expect(t.client.connect('agent')).rejects.toThrow(/locked/);
    expect(t.requests).toEqual([]);
  });
});

describe('3a session: calls run in the wallet', () => {
  it('tools run inside the wallet for that session and results come back', async () => {
    const t = setup();
    const info = await t.client.connect('agent');
    expect(await t.client.executor('get_rules', {})).toBe('ran get_rules');
    expect(t.execCalls).toEqual([{ session: info.sessionId, tool: 'get_rules', args: {} }]);
  });
  it('a tool error goes back to the model as an error (the run continues)', async () => {
    const t = setup({ exec: async () => Promise.reject(new Error('Proposal x was not allowed')) });
    await t.client.connect('agent');
    await expect(t.client.executor('execute', { proposal_id: 'x' })).rejects.toThrow(/not allowed/);
    await expect(t.client.executor('execute', { proposal_id: 'x' })).rejects.not.toBeInstanceOf(SessionRevokedError);
  });
  it('a stolen session id used from another origin is denied and nothing runs', async () => {
    const t = setup();
    const info = await t.client.connect('agent');
    const replies: unknown[] = [];
    const sendSpy = (t.host as unknown as { o: { send: (o: string, m: unknown) => void } }).o;
    const orig = sendSpy.send;
    sendSpy.send = (o, m) => (o === EVIL ? replies.push(m) : orig(o, m));
    await t.host.handle(EVIL, { protocol: PROTOCOL, kind: 'call', sessionId: info.sessionId, callId: 'evilcall01', tool: 'execute', args: { proposal_id: 'p1' } });
    expect(t.execCalls).toEqual([]);
    expect(replies).toEqual([{ protocol: PROTOCOL, kind: 'result', callId: 'evilcall01', ok: false, code: 'denied', error: 'Unknown session. Connect to the wallet first.' }]);
  });
  it('the agent ignores messages that are not from the wallet origin (a forged "ended" or result with the real ids)', async () => {
    const t = setup();
    const info = await t.client.connect('agent');
    t.client.handle(EVIL, { protocol: PROTOCOL, kind: 'ended', sessionId: info.sessionId, reason: 'revoked' });
    expect(t.client.endedBy).toBeNull();
    expect(await t.client.executor('get_rules', {})).toBe('ran get_rules'); // still connected
  });
  it('malformed messages are ignored on both sides', () => {
    expect(parseAgentMessage({ protocol: PROTOCOL, kind: 'call', sessionId: 'aaaaaaaa', callId: 'bbbbbbbb', tool: 'sign_raw', args: {} })).toBeNull(); // not a session tool
    expect(parseAgentMessage({ protocol: PROTOCOL, kind: 'call', sessionId: 'aaaaaaaa', callId: 'bbbbbbbb', tool: 'execute', args: {}, extra: 1 })).toBeNull();
    expect(parseAgentMessage({ protocol: PROTOCOL, kind: 'connect', requestId: 'aaaaaaaa', agentName: 'evil\u202E<script>' })).toBeNull();
    expect(parseAgentMessage({ protocol: 'other/1', kind: 'connect', requestId: 'aaaaaaaa', agentName: 'x' })).toBeNull();
    expect(parseWalletMessage({ protocol: PROTOCOL, kind: 'result', callId: 'aaaaaaaa', ok: false, code: 'whatever', error: 'x' })).toBeNull();
  });
});

describe('3a session: revoke, lock, close end the session', () => {
  it('revoke: the agent is told, and its next call is refused without running anything', async () => {
    const t = setup();
    const info = await t.client.connect('agent');
    t.host.end(info.sessionId, 'revoked');
    await tick();
    expect(t.client.endedBy).toBe('revoked');
    await expect(t.client.executor('get_rules', {})).rejects.toBeInstanceOf(SessionRevokedError);
    expect(t.execCalls).toEqual([]);
    expect(t.ended).toEqual([`${info.sessionId}:revoked`]);
  });
  it('a call that arrives after revoke (agent not yet told) is refused by the wallet as "ended"', async () => {
    const t = setup();
    const info = await t.client.connect('agent');
    t.host.end(info.sessionId, 'revoked');
    const call = t.client.executor('get_rules', {}); // posted before the "ended" message is delivered
    await expect(call).rejects.toBeInstanceOf(SessionRevokedError);
    expect(t.execCalls).toEqual([]);
  });
  it('revoke while a call waits (e.g. the owner has not clicked Approve & send): the agent gets "ended", not the result', async () => {
    let release!: () => void;
    const t = setup({ exec: () => new Promise((r) => (release = () => r('sent'))) });
    const info = await t.client.connect('agent');
    const call = t.client.executor('execute', { proposal_id: 'p1' });
    await tick();
    t.host.end(info.sessionId, 'revoked');
    release();
    await expect(call).rejects.toBeInstanceOf(SessionRevokedError);
  });
  it('locking or closing the wallet ends every session', async () => {
    const t = setup();
    const a = await t.client.connect('agent');
    t.lock(true);
    t.host.endAll('locked');
    await tick();
    expect(t.client.endedBy).toBe('locked');
    expect(t.host.list()).toMatchObject([{ id: a.sessionId, active: false, endedBy: 'locked' }]);
    const u = setup();
    await u.client.connect('agent');
    u.host.endAll('closed');
    await tick();
    expect(u.client.endedBy).toBe('closed');
  });
  it('the agent app treats a closed wallet window as the end of the session', async () => {
    const t = setup();
    await t.client.connect('agent');
    const pending = t.client.executor('execute', { proposal_id: 'p1' });
    t.client.stop('closed'); // what the app does when it sees the popup closed
    await expect(pending).rejects.toBeInstanceOf(SessionRevokedError);
  });
  it('the agent can disconnect', async () => {
    const t = setup();
    const info = await t.client.connect('agent');
    t.client.disconnect();
    await tick();
    await tick();
    expect(t.host.list()).toMatchObject([{ id: info.sessionId, active: false, endedBy: 'disconnected' }]);
  });
});

describe('3a session: what the wallet itself does after a session ends (no help from the agent side)', () => {
  /** Drives the host directly and records exactly what it sends back to the agent origin. */
  function direct(exec?: () => Promise<string>) {
    const sent: { origin: string; msg: any }[] = [];
    const ran: string[] = [];
    const host = new WalletHost({
      ensName: 'demo.blindspot-demo.eth',
      agent: '0xab5437DcC26cFA763692Ab2e3e6Ee46D11Fc6DF1',
      isLocked: () => false,
      approveConnect: async () => true,
      exec: async (_s, tool) => (ran.push(tool), exec ? exec() : 'ok'),
      send: (origin, msg) => sent.push({ origin, msg }),
    });
    return { host, sent, ran };
  }
  const connectDirect = async (h: ReturnType<typeof direct>) => {
    await h.host.handle(AGENT, { protocol: PROTOCOL, kind: 'connect', requestId: 'req0000001', agentName: 'agent' });
    return h.sent.find((s) => s.msg.kind === 'session')!.msg.sessionId as string;
  };

  it('a call on an ended session never runs, and is answered "ended"', async () => {
    const h = direct();
    const sid = await connectDirect(h);
    h.host.end(sid, 'revoked');
    await h.host.handle(AGENT, { protocol: PROTOCOL, kind: 'call', sessionId: sid, callId: 'call000001', tool: 'execute', args: { proposal_id: 'p1' } });
    expect(h.ran).toEqual([]);
    expect(h.sent.at(-1)!.msg).toMatchObject({ kind: 'result', callId: 'call000001', ok: false, code: 'ended' });
  });

  it('revoked while the tool runs: the wallet sends "ended", never the tool result', async () => {
    let release!: (v: string) => void;
    const h = direct(() => new Promise((r) => (release = r)));
    const sid = await connectDirect(h);
    const call = h.host.handle(AGENT, { protocol: PROTOCOL, kind: 'call', sessionId: sid, callId: 'call000002', tool: 'execute', args: { proposal_id: 'p1' } });
    await tick();
    h.host.end(sid, 'revoked');
    release('{"status":"sent","tx":"0xabc"}');
    await call;
    const answers = h.sent.filter((s) => s.msg.callId === 'call000002').map((s) => s.msg);
    expect(answers).toEqual([{ protocol: PROTOCOL, kind: 'result', callId: 'call000002', ok: false, code: 'ended', error: 'The wallet ended this session (revoked).' }]);
  });
});

describe('(d) rules at session start', () => {
  it('runAgentWith puts the preamble (rules) right after the system prompt, before the task', async () => {
    const seen: string[][] = [];
    const llm = { name: 'probe', chat: async (req: { messages: { role: string; content: string | null }[] }) => (seen.push(req.messages.map((m) => `${m.role}:${m.content}`)), { content: 'ok', toolCalls: [], finishReason: 'stop', model: 'probe' }) };
    await runAgentWith(async () => 'x', llm as never, 'the task', { preamble: ['RULES TEXT'], systemPrompt: 'SYS' });
    expect(seen[0]).toEqual(['system:SYS', 'user:RULES TEXT', 'user:the task']);
  });
});

describe('3a agent loop over a session', () => {
  it('runs the scripted agent through the wallet, and a revoke mid-run stops it before the next call', async () => {
    let t!: ReturnType<typeof setup>;
    let sid = '';
    t = setup({
      exec: async (_s, tool) => {
        if (tool === 'propose') t.host.end(sid, 'revoked'); // the owner revokes while the agent is working
        return tool === 'propose' ? '{"proposal_id":"p1","verdict":"ALLOW","reasons":[]}' : `ran ${tool}`;
      },
    });
    sid = (await t.client.connect('agent')).sessionId;
    const r = await runAgentWith(t.client.executor, scriptedLlm([{ tool: 'get_rules' }, { tool: 'propose', args: { actions: [] } }, { tool: 'execute', args: { proposal_id: '$lastProposalId' } }]), 'pay');
    expect(r.stoppedBy).toBe('stopped');
    expect(t.execCalls.map((c) => c.tool)).toEqual(['get_rules', 'propose']); // execute never ran
  });
});
