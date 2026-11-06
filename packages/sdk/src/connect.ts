import { SessionRevokedError, WalletClient } from './client.js';
import type { Address, EndReason, ToolDefinition } from './protocol.js';

/** An OpenAI chat-completions tool entry ({type:"function", function:{…}}). */
export type OpenAiTool = { type: 'function'; function: ToolDefinition };

export type BlindspotSession = {
  /** The ENS name the agent acts as, e.g. demo.blindspot-demo.eth, and its address. */
  readonly ensName: string;
  readonly agent: Address;
  /** The owner's rules, read by the wallet (get_rules) right after the session started. */
  readonly rules: string;
  /** The rules as the agent's first message (owner decision: the agent starts with the rules in context). */
  rulesMessage(): string;
  /** Tool definitions the wallet offers ({name, description, parameters}). */
  readonly tools: ToolDefinition[];
  /** The same tools in OpenAI chat-completions format, ready to pass as `tools`. */
  openAiTools(): OpenAiTool[];
  /** Runs one tool inside the wallet. Throws SessionRevokedError once the wallet ends the session. */
  callTool(name: string, args?: Record<string, unknown>): Promise<string>;
  /** Called once when the session ends (revoked, wallet locked or closed, disconnected). */
  onEnded(cb: (reason: EndReason) => void): void;
  /** Why the session ended, or null while active. */
  readonly endedBy: EndReason | null;
  disconnect(): void;
};

export type ConnectOptions = {
  /** The Blindspot wallet URL, e.g. https://wallet.example/ (its origin is the only one the SDK listens to). */
  walletUrl: string;
  /** Shown to the owner in the connection request (letters, digits, spaces, . _ -; at most 64). */
  agentName: string;
  /** How long to wait for the wallet window to load. Default 20 s. */
  loadTimeoutMs?: number;
  /** Popup window features. */
  features?: string;
};

type WalletWindow = { popup: Window; origin: string; client: WalletClient; endedCbs: ((r: EndReason) => void)[]; ready: Promise<boolean> };
let current: WalletWindow | null = null;

/** Opens the wallet popup, or reuses the one still open (re-opening it would reload it and lose its unlock). */
function walletWindow(opts: ConnectOptions): WalletWindow {
  const origin = new URL(opts.walletUrl).origin;
  if (current && !current.popup.closed && current.origin === origin) {
    current.popup.focus();
    return current;
  }
  const popup = window.open(opts.walletUrl, 'blindspot-wallet', opts.features ?? 'popup,width=560,height=900');
  if (!popup) throw new Error('The browser blocked the wallet popup. Call connect() from a click, or allow popups for this site.');
  let readyResolve!: (v: boolean) => void;
  const w: WalletWindow = {
    popup,
    origin,
    endedCbs: [],
    ready: new Promise<boolean>((r) => {
      readyResolve = r;
      setTimeout(() => r(false), opts.loadTimeoutMs ?? 20_000);
    }),
    client: new WalletClient({
      walletOrigin: origin,
      post: (m) => popup.postMessage(m, origin),
      onReady: () => readyResolve(true),
      onEnded: (r) => w.endedCbs.splice(0).forEach((cb) => cb(r)),
    }),
  };
  const onMessage = (e: MessageEvent) => {
    if (e.source === popup) w.client.handle(e.origin, e.data); // only the wallet window we opened
  };
  window.addEventListener('message', onMessage);
  const watch = setInterval(() => {
    if (!popup.closed) return;
    clearInterval(watch);
    window.removeEventListener('message', onMessage);
    w.client.stop('closed');
    if (current === w) current = null;
  }, 1000);
  current = w;
  return w;
}

/**
 * Opens the Blindspot wallet in a popup (or reuses the open one), asks the owner to approve a session, and
 * resolves with it. Call it from a click handler (browsers block popups otherwise). The agent never receives a
 * key: it can only ask the wallet to run tools; every transaction is checked against the owner's rules on the
 * agent's ENS name and needs the owner's Approve & send in the wallet.
 */
export async function connect(opts: ConnectOptions): Promise<BlindspotSession> {
  const w = walletWindow(opts);
  if (!(await w.ready)) throw new Error('The wallet window did not load in time.');
  const info = await w.client.connect(opts.agentName);
  // Read the owner's rules at session start (runs get_rules inside the wallet, traced there as trusted ENS data).
  const rules = await w.client.executor('get_rules', {});
  const endedCbs = w.endedCbs;
  return {
    ensName: info.ensName,
    agent: info.agent,
    rules,
    rulesMessage: () => rulesMessage(info.ensName, rules),
    tools: info.tools,
    openAiTools: () => info.tools.map((t) => ({ type: 'function' as const, function: t })),
    callTool: (name, args = {}) => w.client.executor(name, args),
    onEnded: (cb) => endedCbs.push(cb),
    get endedBy() {
      return w.client.endedBy;
    },
    disconnect: () => w.client.disconnect(),
  };
}

/** The first message an agent gets: the owner's rules as read by the wallet at session start. */
export function rulesMessage(ensName: string, rules: string): string {
  return `Before your task: these are the owner's current rules for ${ensName}, read by the wallet (get_rules) when this session started. Every transaction is checked against them.

${rules}`;
}

export { SessionRevokedError };
