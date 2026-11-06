// @blindspot/sdk connect() against the real WalletHost. A fake popup window relays postMessage both ways
// (structuredClone, async, with the wallet origin) — the browser part the SDK relies on.
import { SessionRevokedError, connect } from '@blindspot/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WalletHost } from './wallet-host.js';

const AGENT = 'http://127.0.0.1:5180';
const WALLET_URL = 'http://127.0.0.1:5181/';
const WALLET = 'http://127.0.0.1:5181';
type Listener = (e: { source: unknown; origin: string; data: unknown }) => void;

let listeners: Listener[] = [];
let opens = 0;
let approve: boolean | 'never' = true;
let popup: { closed: boolean; focus: () => void; postMessage: (m: unknown, origin: string) => void } | null;
const host = new WalletHost({
  ensName: 'demo.blindspot-demo.eth',
  agent: '0xab5437DcC26cFA763692Ab2e3e6Ee46D11Fc6DF1',
  isLocked: () => false,
  approveConnect: () => (approve === 'never' ? new Promise<boolean>(() => {}) : Promise.resolve(approve)),
  exec: async (_s, tool) => `wallet ran ${tool}`,
  send: (origin, msg) => {
    if (origin !== AGENT) return;
    const p = popup;
    setTimeout(() => listeners.forEach((l) => l({ source: p, origin: WALLET, data: structuredClone(msg) })), 0);
  },
});
function freshPopup() {
  const p = {
    closed: false,
    focus: () => {},
    postMessage: (m: unknown, origin: string) => {
      if (origin !== WALLET) throw new Error('wrong targetOrigin');
      setTimeout(() => void host.handle(AGENT, structuredClone(m)), 0);
    },
  };
  // the wallet page announces itself once loaded
  setTimeout(() => listeners.forEach((l) => l({ source: p, origin: WALLET, data: { protocol: 'blindspot-session/1', kind: 'ready' } })), 5);
  return p;
}
const g = globalThis as unknown as { window?: unknown };
beforeAll(() => {
  g.window = {
    open: (url: string) => {
      opens++;
      if (url !== WALLET_URL) throw new Error('wrong url');
      if (popup === undefined) return null; // blocked
      popup = freshPopup();
      return popup;
    },
    addEventListener: (_t: string, l: Listener) => listeners.push(l),
    removeEventListener: (_t: string, l: Listener) => (listeners = listeners.filter((x) => x !== l)),
  };
  popup = null;
});
afterAll(() => delete g.window);

describe('@blindspot/sdk connect()', () => {
  it('opens the wallet, gets the owner\'s approval and returns a session with OpenAI-format tools and callTool', async () => {
    const s = await connect({ walletUrl: WALLET_URL, agentName: 'example agent' });
    expect(opens).toBe(1);
    expect(s.ensName).toBe('demo.blindspot-demo.eth');
    // decision (d): the SDK read the rules at session start, through the wallet
    expect(s.rules).toBe('wallet ran get_rules');
    expect(s.rulesMessage()).toMatch(/^Before your task: these are the owner's current rules for demo\.blindspot-demo\.eth[\s\S]*wallet ran get_rules$/);
    expect(s.openAiTools().find((t) => t.function.name === 'get_rules')).toMatchObject({ type: 'function', function: { name: 'get_rules', parameters: { type: 'object' } } });
    expect(await s.callTool('get_rules')).toBe('wallet ran get_rules');
  });

  it('a second connect reuses the open wallet window (re-opening would reload it and lose its unlock)', async () => {
    const s = await connect({ walletUrl: WALLET_URL, agentName: 'example agent' });
    expect(opens).toBe(1);
    expect(await s.callTool('get_balances')).toBe('wallet ran get_balances');
  });

  it('a rejected request throws', async () => {
    approve = false;
    await expect(connect({ walletUrl: WALLET_URL, agentName: 'example agent' })).rejects.toThrow(/rejected/);
    approve = true;
  });

  it('closing the wallet window ends the session: onEnded("closed") and callTool throws SessionRevokedError', async () => {
    const s = await connect({ walletUrl: WALLET_URL, agentName: 'example agent' });
    const ended: string[] = [];
    s.onEnded((r) => ended.push(r));
    popup!.closed = true;
    await new Promise((r) => setTimeout(r, 1200));
    expect(ended).toEqual(['closed']);
    expect(s.endedBy).toBe('closed');
    await expect(s.callTool('get_rules')).rejects.toBeInstanceOf(SessionRevokedError);
  });

  it('closing the wallet while the owner has not answered rejects connect() (it never hangs)', async () => {
    approve = 'never';
    const p = connect({ walletUrl: WALLET_URL, agentName: 'example agent' });
    await new Promise((r) => setTimeout(r, 50));
    popup!.closed = true;
    await expect(p).rejects.toBeInstanceOf(SessionRevokedError);
    approve = true;
  });

  it('a blocked popup throws a clear error', async () => {
    popup = undefined as never;
    await expect(connect({ walletUrl: WALLET_URL, agentName: 'example agent' })).rejects.toThrow(/blocked the wallet popup/);
  });
});
