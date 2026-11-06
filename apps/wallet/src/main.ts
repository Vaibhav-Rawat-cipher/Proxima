// Blindspot wallet (Step 3a, presenter mode). Holds the agent key (encrypted at rest, memory-only when
// unlocked), reads the rules from ENS, runs every tool and check for connected agent apps, and broadcasts only
// after the owner clicks Approve & send. All reads and broadcasts go through Anon-RPC (Nox, then tor-js);
// "Direct (not anonymous)" only by the owner's click, with a banner.
import { PROTOCOL } from '@blindspot/sdk';
import {
  Analytics,
  Trace,
  WalletHost,
  clientFor,
  decryptPrivateKey,
  deploymentFromConfig,
  describeRules,
  encryptPrivateKey,
  fromPolicy,
  diffRules,
  toPolicy,
  policyUpdateCalldata,
  type RulesDraft,
  moduleOnlySigner,
  readDecimals,
  readPolicy,
  runTool,
  type ApprovalRequest,
  type EncryptedKey,
  type RpcAdapter,
  type RunContext,
  type Session,
  type StorageAdapter,
  type Deployment,
  MemoryStorage,
} from '@blindspot/core';
import { ETH, encodePolicy, type Decision, type Effect } from '@blindspot/shared';
import { formatEther, formatUnits, getAddress, isAddress, isHex, keccak256, parseAbi, toBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import cfg from '../../../config/sepolia.json';
import { NET_NAME, anonChain, redact, type AnonChain, type ChainStatus } from './anon';
import { sandboxRunner } from './sandbox';
import { walletSources } from './sources';
import { connectOwnerWallet, hasBrowserWallet, onOwnerWalletChange, ownerWallet, sendFromOwnerWallet, waitForReceipt } from './owner-wallet';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => redact(String(s)).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
declare const __WALLET__: { relayerUrl: string };
// Agent profiles: the presenter's demo agent, or a self-serve trial agent (Step 3d) on the trial registry / Safe / module.
type Profile = { kind: 'demo' | 'trial'; label: string; ensName: string; agent: Address; deployment: Deployment; expiresAt?: string };
const demoDeployment = deploymentFromConfig(cfg as never);
const trialDeployment: Deployment = {
  ...demoDeployment,
  parentName: cfg.trials.parentName,
  agentRegistry: getAddress(cfg.trials.trialRegistry),
  safeAddress: getAddress(cfg.trials.trialSafe),
  module: getAddress(cfg.trials.trialModule),
};
const DEMO: Profile = { kind: 'demo', label: 'demo', ensName: `demo.${cfg.parentName}`, agent: getAddress(cfg.agents.demo.address), deployment: demoDeployment };
let profile: Profile = DEMO;
const AGENT = DEMO.agent; // the demo agent (its key is the one imported below)
const USDC = getAddress(cfg.ens.MockUSDC);
const NAMES: Record<string, string> = { [USDC.toLowerCase()]: 'MockUSDC', [getAddress(cfg.payees.vendor1).toLowerCase()]: 'vendor1', [getAddress(cfg.payees.vendor2).toLowerCase()]: 'vendor2' };
const DECIMALS: Record<string, number> = { [USDC.toLowerCase()]: 6, [ETH]: 18 };
const ETHERSCAN = (h: string) => `https://sepolia.etherscan.io/tx/${h}`;
const KEY_STORE = 'blindspot.wallet.agentKey';

// ------------------------------------------------------------------ wallet storage (rate limit, proxy baselines, analytics)
const store: StorageAdapter = {
  async get<T>(k: string) {
    try {
      const v = localStorage.getItem(`blindspot.wallet.${k}`);
      return v === null ? undefined : (JSON.parse(v) as T);
    } catch {
      return undefined;
    }
  },
  async set(k, v) {
    localStorage.setItem(`blindspot.wallet.${k}`, JSON.stringify(v));
  },
  async delete(k) {
    localStorage.removeItem(`blindspot.wallet.${k}`);
  },
};

// ------------------------------------------------------------------ activity log
function activity(html: string, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = `<span class="time">${new Date().toLocaleTimeString()}</span> ${html}`;
  $('activity').prepend(li);
}
/** A message the owner sees right away (toast on top of every tab), also kept in Activity. */
function notify(html: string, cls: '' | 'ok' | 'bad' | 'warn' = '', log = true) {
  if (log) activity(html, cls);
  const t = document.createElement('div');
  t.className = `toast ${cls}`;
  t.innerHTML = `<span>${html}</span><button class="pill" title="Dismiss">✕</button>`;
  const close = () => t.remove();
  t.querySelector('button')!.onclick = close;
  $('toasts').prepend(t);
  while ($('toasts').children.length > 3) $('toasts').lastElementChild!.remove();
  setTimeout(close, cls === 'bad' ? 9000 : 5000);
}
const errText = (e: unknown) => redact((e as Error)?.message ?? String(e)).split('\n')[0]!.slice(0, 300);
window.addEventListener('error', (e) => notify(`Something went wrong: ${esc(e.message)}`, 'bad'));
window.addEventListener('unhandledrejection', (e) => notify(`Something went wrong: ${esc(errText(e.reason))}`, 'bad'));
/** Disables a button and shows a busy label while `fn` runs. */
async function busy<T>(btn: HTMLButtonElement, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (btn.disabled) return undefined;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ------------------------------------------------------------------ owner prompts (connection requests, approvals)
type Prompt = { el: HTMLElement; resolve: (v: boolean) => void; sessionId?: string };
const prompts = new Set<Prompt>();
type SheetOpts = {
  /** Small line on top: the requesting app (origin) — like MetaMask's site pill. */
  site?: string;
  title: string;
  /** Main content (already escaped HTML). */
  body: string;
  confirm: string;
  /** Omit for an information sheet with one button. */
  reject?: string;
  danger?: boolean;
  sessionId?: string;
};
/** One request at a time, full-screen, buttons fixed at the bottom (MetaMask-style). Esc = reject. */
function sheet(o: SheetOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement('section');
    el.className = 'prompt sx';
    el.innerHTML = `<div class="sx-head">${o.site ? `<span class="sx-site"><i></i>${esc(o.site.replace(/^https?:\/\//, ''))}</span>` : '<span></span>'}<span class="sx-net">Sepolia</span></div>
      <div class="sx-scroll"><div class="sx-title">${esc(o.title)}</div>${o.body}</div>
      <div class="sx-count"></div>
      <div class="sx-actions">${o.reject ? `<button class="secondary">${esc(o.reject)}</button>` : ''}<button class="primary ${o.danger ? 'danger-fill' : ''}">${esc(o.confirm)}</button></div>`;
    const p: Prompt = { el, resolve, ...(o.sessionId ? { sessionId: o.sessionId } : {}) };
    const done = (v: boolean) => {
      if (!prompts.has(p)) return;
      prompts.delete(p);
      el.remove();
      renderPromptCount();
      resolve(v);
    };
    el.querySelector<HTMLButtonElement>('.primary')!.onclick = () => done(true);
    const rej = el.querySelector<HTMLButtonElement>('.secondary');
    if (rej) rej.onclick = () => done(false);
    (el as HTMLElement & { _reject?: () => void })._reject = () => done(!o.reject);
    prompts.add(p);
    $('prompts').append(el); // first come, first shown
    renderPromptCount();
    window.focus();
  });
}
function renderPromptCount() {
  const list = [...$('prompts').children] as HTMLElement[];
  list.forEach((el, i) => (el.querySelector('.sx-count')!.textContent = i === 0 && list.length > 1 ? `1 of ${list.length} requests` : ''));
  document.body.classList.toggle('modal-open', list.length > 0);
}
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const first = $('prompts').firstElementChild as (HTMLElement & { _reject?: () => void }) | null;
  first?._reject?.();
});
/** Session ended / wallet locked: anything still waiting for the owner is rejected. */
function cancelPrompts(sessionId?: string) {
  for (const p of [...prompts]) {
    if (sessionId && p.sessionId !== sessionId) continue;
    prompts.delete(p);
    p.el.remove();
    p.resolve(false);
  }
  renderPromptCount();
}

// ------------------------------------------------------------------ formatting
const who = (a: string) => (NAMES[a.toLowerCase()] ? `${NAMES[a.toLowerCase()]} (${a.slice(0, 6)}…${a.slice(-4)})` : a);
const amount = (token: string, v: bigint) => (DECIMALS[token.toLowerCase()] !== undefined ? `${formatUnits(v, DECIMALS[token.toLowerCase()]!)} ${token === ETH ? 'ETH' : token.toLowerCase() === USDC.toLowerCase() ? 'USDC' : NAMES[token.toLowerCase()] ?? ''}` : `${v} units of ${who(token)}`);
const effectLine = (e: Effect) =>
  e.kind === 'out' ? `sends ${amount(e.token, e.amount)} to ${who(e.counterparty)}` : e.kind === 'in' ? `receives ${amount(e.token, e.amount)} from ${who(e.counterparty)}` : e.kind === 'approve' ? `approves ${who(e.counterparty)} for ${amount(e.token, e.amount)}` : `${e.kind} ${who(e.counterparty)}`;
function decisionCard(d: Decision, sessionName: string): string {
  const cls = d.verdict === 'ALLOW' ? 'ok' : d.verdict === 'BLOCK' ? 'bad' : 'warn';
  const headline = d.verdict === 'ALLOW' ? '✓ Allowed by your rules' : d.verdict === 'BLOCK' ? '✕ Blocked' : '⚠ Needs your approval';
  const reasons = d.failedChecks.length ? `<ul>${d.failedChecks.map((f) => `<li>${f.rule ? `<b>${esc(f.rule)}:</b> ` : ''}${esc(f.detail)}</li>`).join('')}</ul>` : '';
  const effects = d.effects.length ? `<p>What it does: ${d.effects.filter((e) => e.kind !== 'unknownLog').map((e) => esc(effectLine(e))).join('; ')}</p>` : '';
  const origin = d.origin ? `<p class="origin">Where it went wrong: from the <b>${esc(d.origin.source)}</b>${d.origin.line ? ` line ${d.origin.line}` : ''}: “${esc(d.origin.excerpt)}”</p>` : '';
  return `<div class="decision ${cls}"><div class="verdict">${headline}</div>${reasons}${origin}${effects}<details class="tech"><summary>details</summary><code>proposal ${esc(d.proposalId)} · ${esc(sessionName)} · checks passed: ${esc(d.passedChecks.join(', '))}</code></details></div>`;
}

// ------------------------------------------------------------------ state
let analytics: Analytics;
let chain: AnonChain | undefined;
let rpc: RpcAdapter | undefined;
let agentAccount: PrivateKeyAccount | undefined; // memory only
/** Trial agent key: made in this browser, memory only (lost on reload; a new trial is one click). */
let trialAccount: PrivateKeyAccount | undefined;
const activeAccount = () => (profile.kind === 'trial' ? trialAccount : agentAccount);
let relayerRequests = 0;
/** "Simulate only": every check + owner approval, but nothing is signed or sent (works without an agent key). */
let simulateOnly = false;
let resolveNet!: () => void;
const netReady = new Promise<void>((r) => (resolveNet = r));
let githubReads = 0;
const contexts = new Map<string, RunContext>();
const sources = walletSources(() => githubReads++);
const sandbox = sandboxRunner();

/** Broadcasts go through the active network; only if that fails, the owner may approve one direct broadcast (declared). */
function withBroadcastFallback(c: AnonChain): RpcAdapter {
  return {
    name: c.rpc.name,
    anonymized: true,
    async request(a) {
      if (a.method !== 'eth_sendRawTransaction' || c.active() === 'direct') return c.rpc.request(a);
      try {
        return await c.rpc.request(a);
      } catch (e) {
        activity(`broadcast through ${esc(NET_NAME[c.active() ?? 'nox'])} failed: ${esc((e as Error).message)}`, 'bad');
        const ok = await sheet({
          title: 'Private network could not send this',
          body: `<p>The payment is signed, but the anonymous network failed to deliver it:</p><pre>${esc(errText(e))}</pre><p>You can send the <b>same signed transaction</b> through a direct connection. The RPC provider will see your IP address (counted as declared, non-private traffic).</p>`,
          confirm: 'Send directly',
          reject: "Don't send",
          danger: true,
        });
        if (!ok) throw e;
        return c.broadcastDirect.request(a);
      }
    },
  };
}

function ctxFor(s: Session): RunContext {
  let ctx = contexts.get(s.id);
  if (ctx) return ctx;
  if (!rpc) throw new Error('Anon-RPC is not ready yet.');
  const account = activeAccount();
  if (!account && !simulateOnly) throw new Error('The wallet is locked.');
  const client = clientFor(rpc);
  ctx = {
    rpc,
    client,
    deployment: profile.deployment,
    storage: store,
    label: profile.label,
    agent: profile.agent,
    trace: new Trace(`w${s.id.slice(0, 8)}`),
    readSource: sources,
    runScript: sandbox,
    ...(account ? { signer: moduleOnlySigner(account, profile.deployment.module, profile.deployment.chainId) } : {}),
    simulateOnly,
    knownNames: Object.values(cfg.payeeNames).filter((n): n is string => typeof n === 'string' && n.endsWith('.eth')),
    approve: (req) => approveTx(s, req),
    proposals: new Map(),
    log: [],
    analytics,
  };
  contexts.set(s.id, ctx);
  return ctx;
}

/** Permission lines from the SDK, in the words this wallet uses on its buttons. */
const plainPerm = (x: string) =>
  x.replace(/execute ALLOWED proposals — each one still needs your Approve & send/i, 'ask to pay — every payment is checked and needs your Confirm')
    .replace(/propose transactions \(checked against the rules\)/i, 'propose payments (checked against your rules)')
    .replace(/execute a BLOCKED or ASK_OWNER proposal/i, 'send a payment your rules block, or one you did not confirm')
    .replace(/read the rules on its ENS name/i, 'read your rules on ENS');
const nameOf = (a: string) => NAMES[a.toLowerCase()];
const row = (k: string, v: string) => `<div class="sx-row"><span>${esc(k)}</span><span>${v}</span></div>`;
const addrHtml = (a: string) => (nameOf(a) ? `<b>${esc(nameOf(a))}</b> <span class="muted">${esc(shortAddr(a))}</span>` : `<span class="mono">${esc(shortAddr(a))}</span>`);
/** Verdict + reasons + "where it went wrong", in plain words. */
function verdictHtml(d: Decision): string {
  const cls = d.verdict === 'ALLOW' ? 'ok' : d.verdict === 'BLOCK' ? 'bad' : 'warn';
  const head = d.verdict === 'ALLOW' ? '✓ Checked — fits your rules' : d.verdict === 'BLOCK' ? '✕ Breaks your rules' : '⚠ Needs your OK — above your approval limit';
  const reasons = d.failedChecks.length ? `<ul>${d.failedChecks.map((f) => `<li>${esc(f.detail)}</li>`).join('')}</ul>` : '';
  const origin = d.origin ? `<div class="sx-origin"><b>Where it came from:</b> ${esc(d.origin.source)}${d.origin.line ? `, line ${d.origin.line}` : ''}<br><q>${esc(d.origin.excerpt)}</q></div>` : '';
  return `<div class="sx-verdict ${cls}"><div>${head}</div>${reasons}${origin}</div>`;
}
/** The payment, as MetaMask would show it: big amount, to, fee, and the check result. */
function paymentBody(d: Decision, extra: string): string {
  const outs = d.effects.filter((e) => e.kind === 'out');
  const main = outs[0];
  const big = main ? `<div class="sx-amount">${esc(amount(main.token, main.amount).trim())}</div>` : '<div class="sx-amount">—</div>';
  const more = outs.length > 1 ? `<p class="muted" style="text-align:center;margin:0">+ ${outs.length - 1} more transfer${outs.length > 2 ? 's' : ''}</p>` : '';
  const others = d.effects.filter((e) => e.kind !== 'out' && e.kind !== 'unknownLog');
  return `${big}${more}${verdictHtml(d)}<div class="sx-rows">${row('From', `<b>${esc(profile.ensName)}</b>`)}${main ? row('To', addrHtml(main.counterparty)) : ''}${others.map((e) => row('Also', esc(effectLine(e)))).join('')}${extra}</div>`;
}
async function approveTx(s: Session, req: ApprovalRequest): Promise<boolean> {
  const fee = Number(formatEther(req.gas * req.maxFeePerGas));
  const tech = `<details class="tech"><summary>Transaction details</summary><pre>from   ${req.from} (agent key)
to     ${req.to} (BlindspotModule)
call   module.execute (built by Blindspot from the checked request)
nonce  ${req.nonce}
proposal ${req.decision.proposalId}</pre></details>`;
  if (req.simulated)
    return sheet({
      site: s.origin,
      title: 'Payment request · simulate only',
      body: `${paymentBody(req.decision, row('Mode', '<span class="warn">Simulate only — nothing is signed or sent</span>'))}${tech}`,
      confirm: 'Simulate',
      reject: 'Reject',
      sessionId: s.id,
    });
  return sheet({
    site: s.origin,
    title: `${s.agentName} wants to pay`,
    body: `${paymentBody(req.decision, `${row('Network fee', `≤ ${fee < 0.0001 ? '0.0001' : fee.toFixed(5)} SepoliaETH`)}${row('Sent via', `${esc(NET_NAME[chain?.active() ?? 'nox'])} <span class="muted">(private)</span>`)}`)}${tech}`,
    confirm: 'Confirm',
    reject: 'Reject',
    sessionId: s.id,
  });
}
/** Not a question: Blindspot stopped a request. Shown on top so the owner sees why (does not block the agent). */
function showBlocked(d: Decision, s: Session) {
  void sheet({ site: s.origin, title: 'Blindspot blocked a payment', body: `${paymentBody(d, '')}<p class="muted" style="margin-top:10px">Nothing was signed. The agent was told it is not allowed.</p>`, confirm: 'Got it', sessionId: s.id });
}

const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
/** What the agent is doing, in plain words (the raw call stays under "details"). */
function friendlyTool(tool: string, a: Record<string, unknown>): string {
  const s = (k: string) => String(a[k] ?? '');
  switch (tool) {
    case 'get_rules': return 'The agent read your rules';
    case 'get_balances': return 'The agent checked your balances';
    case 'resolve_name': return `The agent looked up ${s('name')}`;
    case 'token_info': return `The agent checked a token (${shortAddr(s('token'))})`;
    case 'read_document': return `The agent opened a document (${s('url')})`;
    case 'read_repo': return `The agent opened a code repository`;
    case 'run_script': return `The agent ran a script in a sandbox`;
    case 'propose': return 'The agent asked to make a payment — checking it…';
    case 'execute': return 'The agent asked to send the payment';
    default: return `The agent used ${tool}`;
  }
}

// ------------------------------------------------------------------ session host
const host = new WalletHost({
  get ensName() {
    return profile.ensName;
  },
  get agent() {
    return profile.agent;
  },
  isLocked: () => isLocked(),
  send: (origin, msg) => {
    try {
      window.opener?.postMessage(msg, origin);
    } catch {
      /* the agent window is gone */
    }
  },
  approveConnect: (req) =>
    sheet({
      site: req.origin,
      title: 'Connect this app?',
      body: `<p class="sx-sub"><b>${esc(req.agentName)}</b> wants to use your agent account</p>
        <div class="sx-account"><div class="avatar"></div><div><b>${esc(req.ensName)}</b><br><span class="muted">${esc(shortAddr(req.agent))} · protected by your rules</span></div></div>
        <div class="sx-perms">${req.permissions.can.map((x) => `<div class="yes">✓ ${esc(plainPerm(x))}</div>`).join('')}${req.permissions.cannot.map((x) => `<div class="no">✕ ${esc(plainPerm(x))}</div>`).join('')}</div>
        <p class="muted">You can disconnect it at any time. Locking or closing this wallet also disconnects it.</p>`,
      confirm: 'Connect',
      reject: 'Cancel',
    }),
  exec: async (s, tool, args) => {
    await netReady;
    const ctx = ctxFor(s);
    const argText = JSON.stringify(args);
    activity(`${esc(friendlyTool(tool, args))}<details class="tech"><summary>details</summary><code>${esc(s.agentName)} · ${esc(tool)} ${esc(argText.length > 400 ? `${argText.slice(0, 400)}…` : argText)}</code></details>`);
    const before = ctx.proposals.size;
    let out: string;
    try {
      out = await runTool(ctx, tool, args);
    } catch (e) {
      activity(`✕ ${esc(friendlyTool(tool, args))} — failed: ${esc(errText(e))}`, 'bad');
      throw e;
    }
    if (tool === 'propose' && ctx.proposals.size > before) {
      const last = [...ctx.proposals.values()].at(-1)!;
      activity(decisionCard(last.decision, s.agentName));
      if (last.decision.verdict === 'BLOCK') showBlocked(last.decision, s);
    } else if (tool === 'execute') {
      const r = JSON.parse(out) as { status: string; tx?: string; result?: string; reason?: string; effects?: { kind: string; token: string; amount: string; counterparty: string }[] };
      if (r.status === 'simulated') {
        notify(`<b>Simulated — nothing was sent:</b> ${esc((r.effects ?? []).map((e) => effectLine({ ...e, amount: BigInt(e.amount), source: 'log' } as Effect)).join('; ') || 'no effects')}`, 'warn');
        return out;
      }
      if (r.status === 'sent') notify(`✓ Payment sent — <a href="${ETHERSCAN(r.tx!)}" target="_blank" rel="noopener">view on Etherscan</a>`, 'ok');
      else activity(`Not sent: ${esc(r.reason)}`, 'warn');
    }
    return out;
  },
  onEnded: (s) => {
    cancelPrompts(s.id);
    contexts.delete(s.id);
    notify(`<b>${esc(s.agentName)}</b> is disconnected (${esc(s.endedBy)}).`, 'warn');
  },
  onChange: (list) => renderSessions(list),
});

const AGENT_APP = 'http://127.0.0.1:5180/';
/** "What do I do next?" on Home, for every state of the flow. */
function renderGuide() {
  const active = host.list().filter((s) => s.active);
  const el = $('guide');
  let html: string;
  if (queuedConnects.length) html = '<b>An app is waiting to connect.</b><br><span class="muted">Approve the connection request to continue.</span>';
  else if (active.length) html = `<span class="ok">✓ Connected to <b>${esc(active[0]!.agentName)}</b>.</span><br><span class="muted">Go back to the agent app and give it a task. Every payment it asks for is checked here and pops up for your approval.</span>`;
  else if (!window.opener) html = `<b>Next: connect an agent.</b><br><span class="muted">This wallet opens from an agent app. Open <a href="${AGENT_APP}" target="_blank" rel="noopener">the agent app</a> and ask the agent to <b>“connect my wallet”</b>.</span>`;
  else html = '<b>Waiting for the agent app…</b><br><span class="muted">A connection request appears here in a moment. If nothing happens, ask the agent to connect again.</span>';
  el.innerHTML = html;
}
function renderSessions(list: Session[]) {
  const el = $('sessions');
  renderGuide();
  if (!list.length) {
    el.innerHTML = '<p class="muted" style="margin:0">No apps connected yet.</p>';
    return;
  }
  el.innerHTML = list
    .slice()
    .reverse()
    .map((s) => `<div class="session ${s.active ? '' : 'ended'}"><div><b>${esc(s.agentName)}</b><br><span class="muted">${esc(s.origin.replace(/^https?:\/\//, ''))} · ${s.active ? 'connected' : `disconnected (${esc(s.endedBy)})`}</span></div>${s.active ? `<button data-revoke="${esc(s.id)}" class="danger">Disconnect</button>` : ''}</div>`)
    .join('');
  el.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((b) => (b.onclick = () => host.end(b.dataset.revoke!, 'revoked')));
}

/** Connection requests that arrive while the wallet is locked wait here until the owner unlocks (instead of failing). */
const queuedConnects: { origin: string; data: unknown }[] = [];
const isLocked = () => !activeAccount() && !simulateOnly;
window.addEventListener('message', (e) => {
  if (!window.opener || e.source !== window.opener) return; // only the window that opened this wallet
  const d = e.data as { protocol?: unknown; kind?: unknown } | null;
  if (d && typeof d === 'object' && d.protocol === PROTOCOL && d.kind === 'connect' && isLocked()) {
    queuedConnects.push({ origin: e.origin, data: e.data });
    renderLock();
    renderGuide();
    return;
  }
  void host.handle(e.origin, e.data);
});
/** After unlock / simulate / trial: hand waiting connection requests to the session host. */
function flushConnects() {
  if (isLocked()) return;
  for (const q of queuedConnects.splice(0)) void host.handle(q.origin, q.data);
  renderGuide();
}
window.addEventListener('pagehide', () => host.endAll('closed'));

// ------------------------------------------------------------------ keys
const storedKey = (): EncryptedKey | undefined => {
  try {
    const s = localStorage.getItem(KEY_STORE);
    return s ? (JSON.parse(s) as EncryptedKey) : undefined;
  } catch {
    return undefined;
  }
};
function lockMsg(text: string, cls: '' | 'ok' | 'bad' | 'warn' = 'bad') {
  const el = $('lockMsg');
  el.className = `lock-msg ${cls}`;
  el.textContent = text;
  el.style.display = text ? '' : 'none';
}
function renderLock() {
  const unlocked = Boolean(activeAccount());
  $('keyState').innerHTML = unlocked
    ? `<span class="ok">● Unlocked</span> <span class="muted">— ${profile.kind === 'trial' ? 'trial key in memory only' : 'agent key in memory only'}</span>`
    : simulateOnly
      ? '<span class="warn">● Simulate only</span> <span class="muted">— no key needed; nothing is signed or sent.</span>'
      : storedKey()
        ? '<span class="muted">● Locked</span>'
        : '<span class="muted">No agent key added yet.</span>';
  $('importRow').style.display = storedKey() || profile.kind === 'trial' ? 'none' : '';
  $('unlockRow').style.display = unlocked || !storedKey() ? 'none' : '';
  $('lockRow').style.display = unlocked ? '' : 'none';
  $('importRow2').style.display = $('importRow').style.display;
  const locked = !unlocked && !simulateOnly && profile.kind === 'demo';
  const wasHidden = $('lockScreen').style.display === 'none';
  $('lockScreen').style.display = locked ? 'flex' : 'none';
  $('lockTitle').textContent = storedKey() ? 'Welcome back' : 'Set up your agent wallet';
  $('lockSub').textContent = storedKey() ? "Enter your password to unlock your agent's wallet." : 'Paste your agent key once and choose a password (at least 8 characters). The key is encrypted and never leaves this browser.';
  $('lockForgot').style.display = storedKey() ? '' : 'none';
  $('lockWaiting').style.display = locked && queuedConnects.length ? '' : 'none';
  if (queuedConnects.length) {
    const name = String((queuedConnects[0]!.data as { agentName?: unknown }).agentName ?? 'An app').slice(0, 64);
    $('lockWaiting').textContent = `${name} wants to connect — enter your password, then approve the request.`;
  }
  if (locked && wasHidden) {
    lockMsg('');
    setTimeout(() => $(storedKey() ? 'pass' : 'pk').focus(), 30);
  }
}
async function unlockWith(pass: string): Promise<boolean> {
  const enc = storedKey();
  if (!enc) return false;
  if (!pass) {
    lockMsg('Enter your password.');
    $('pass').focus();
    return false;
  }
  try {
    const acct = privateKeyToAccount(await decryptPrivateKey(enc, pass));
    if (acct.address !== AGENT) throw new Error(`The stored key belongs to ${shortAddr(acct.address)}, not to the agent of ${DEMO.ensName}. Use "Forgot password?" and add the right key.`);
    agentAccount = acct;
    $<HTMLInputElement>('pass').value = '';
    lockMsg('');
    activity('Wallet unlocked (agent key in memory only).', 'ok');
    renderLock();
    flushConnects();
    return true;
  } catch (e) {
    const m = errText(e);
    lockMsg(/wrong passphrase/i.test(m) ? 'Wrong password. Try again.' : m);
    $<HTMLInputElement>('pass').select();
    return false;
  }
}
$('importBtn').onclick = () =>
  void busy($<HTMLButtonElement>('importBtn'), 'Saving…', async () => {
    const pk = $<HTMLInputElement>('pk').value.trim();
    const pass = $<HTMLInputElement>('pass').value;
    if (!pk) return lockMsg('Paste the agent key first.');
    if (!isHex(pk) || pk.length !== 66) return lockMsg('That is not a private key. It should start with 0x followed by 64 letters/numbers.');
    if (pass.length < 8) {
      $('pass').focus();
      return lockMsg('Choose a password with at least 8 characters.');
    }
    let acct: PrivateKeyAccount;
    try {
      acct = privateKeyToAccount(pk as Hex);
    } catch {
      return lockMsg('That key is not valid. Check that you copied all of it.');
    }
    if (acct.address !== AGENT) return lockMsg(`That key is for ${shortAddr(acct.address)}, but the agent of ${DEMO.ensName} is ${shortAddr(AGENT)}. Paste the agent's key (AGENT_PRIVATE_KEY).`);
    try {
      localStorage.setItem(KEY_STORE, JSON.stringify(await encryptPrivateKey(pk as Hex, pass)));
    } catch (e) {
      return lockMsg(`Could not save the key: ${errText(e)}`);
    }
    $<HTMLInputElement>('pk').value = '';
    activity('Agent key saved (encrypted in this browser).', 'ok');
    await unlockWith(pass);
    renderLock();
  });
$('unlockBtn').onclick = () => void busy($<HTMLButtonElement>('unlockBtn'), 'Unlocking…', () => unlockWith($<HTMLInputElement>('pass').value));
$('lockBtn').onclick = () => {
  agentAccount = undefined;
  host.endAll('locked');
  cancelPrompts();
  contexts.clear();
  activity('Wallet locked: every session ended.', 'warn');
  renderLock();
};
function setSimulate(on: boolean) {
  simulateOnly = on;
  $<HTMLInputElement>('simToggle').checked = on;
  for (const c of contexts.values()) c.simulateOnly = simulateOnly;
  $('simBanner').style.display = simulateOnly ? '' : 'none';
  if (!simulateOnly && !activeAccount()) {
    host.endAll('locked'); // sessions opened without a key cannot continue in real mode
    cancelPrompts();
    contexts.clear();
  }
  renderLock();
  notify(simulateOnly ? 'Simulate only is ON — every check runs, but nothing is signed or sent.' : 'Simulate only is OFF — Approve &amp; send sends real transactions.', 'warn');
  flushConnects();
}
$<HTMLInputElement>('simToggle').onchange = (e) => setSimulate((e.target as HTMLInputElement).checked);
$('lockSimulate').onclick = (e) => {
  e.preventDefault();
  setSimulate(true);
};
$('forgetBtn').onclick = () => {
  if (!storedKey()) return notify('No agent key is stored in this browser.', 'warn', false);
  if (!confirm('Delete the encrypted agent key from this browser? You will need to paste the key again.')) return;
  localStorage.removeItem(KEY_STORE);
  $('lockBtn').click();
  notify('The stored agent key was removed from this browser.', 'ok');
  renderLock();
};

// ------------------------------------------------------------------ Anon-RPC chain + rules + traffic
function showChain(s: ChainStatus) {
  const dot = $('netDot');
  const label = $('netLabel');
  dot.className = `dot ${s.state === 'ready' ? 'ok' : s.state === 'failed' || s.state === 'direct' ? 'bad' : ''}`;
  label.textContent = s.state === 'ready' ? `Private connection (${NET_NAME[s.network]})` : s.state === 'direct' ? 'Direct (not private)' : s.state === 'failed' ? 'No private connection' : 'Connecting privately…';
  const el = $('nox');
  const banner = $('directBanner');
  banner.style.display = s.state === 'direct' ? '' : 'none';
  const directBtn = '<button id="useDirect" class="danger">Use Direct (not anonymous)</button>';
  if (s.state === 'starting') el.innerHTML = `<span class="warn">Starting Anon-RPC (${NET_NAME[s.network]})… (pre-warming)</span>`;
  else if (s.state === 'ready') el.innerHTML = `<span class="ok">Anon-RPC ready: ${NET_NAME[s.network]}</span> <span class="muted">in ${s.readyMs} ms · worker hash matches the pinned hash</span>`;
  else if (s.state === 'waiting') el.innerHTML = `<span class="warn">Waiting for a ${NET_NAME[s.network]} route… (attempt ${s.attempt}/${s.maxAttempts}, next try in ${s.nextInSec} s)</span> <button id="chainWake">Retry now</button><br><span class="muted">${esc(s.error.slice(0, 200))}</span>`;
  else if (s.state === 'retrying') el.innerHTML = `<span class="warn">Retrying through ${NET_NAME[s.network]}… (attempt ${s.info.attempt}, ${esc(s.info.method)}, next try in ${s.info.delayMs / 1000} s)</span> <span class="muted">${esc(s.info.error.slice(0, 160))}</span>`;
  else if (s.state === 'switching') el.innerHTML = `<span class="warn">${NET_NAME[s.from]} unavailable — switching to ${NET_NAME[s.to]} (still Anon-RPC)…</span><br><span class="muted">${esc(s.reason.slice(0, 200))}</span>`;
  else if (s.state === 'failed') el.innerHTML = `<span class="bad">No anonymous network available (Nox and tor-js): ${esc(s.message.slice(0, 200))}</span><br><button id="chainRetry">Try Anon-RPC again</button> ${directBtn}`;
  else el.innerHTML = '<span class="bad">Direct mode (not anonymous)</span> <button id="chainRetry">Back to Anon-RPC</button>';
  if (s.state !== 'direct' && s.state !== 'failed') el.innerHTML += `<div class="muted" style="margin-top:6px">Manual fallback: ${directBtn}</div>`;
  const w = document.getElementById('chainWake');
  if (w) w.onclick = () => chain?.wake();
  const r = document.getElementById('chainRetry');
  if (r) r.onclick = () => void chain?.retryAnon();
  const d = document.getElementById('useDirect');
  if (d) d.onclick = () => {
    if (confirm('Direct mode sends every request straight to the RPC provider: it sees your IP and what you read. Continue?')) chain?.useDirect();
  };
}
async function showRules() {
  if (!rpc) return;
  const client = clientFor(rpc);
  const rec = await readPolicy(client, profile.deployment, profile.label);
  const decimals = await readDecimals(client, rec.policy.tokens.filter((t) => t.toLowerCase() !== ETH));
  const draft = fromPolicy(rec.policy, { decimals, labels: NAMES });
  currentRules = { draft, resolver: rec.resolver };
  if (!dirty) fillForm(draft);
  renderRulesSummary(draft);
  renderRulesEditor();
  void showBalance(client);
  const trial = profile.kind === 'trial' ? `<p style="margin:0 0 8px">Trial accounts use small fixed rules (read only):</p><ul>${describeRules(draft).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
  $('rules').innerHTML = `${trial}<p class="muted" style="margin:8px 0 0">Read live from the ENS record “blindspot.policy” of ${esc(profile.ensName)} through ${esc(NET_NAME[chain?.active() ?? 'nox'])} · keccak ${esc(rec.keccak.slice(0, 10))}…</p>`;
}
async function showBalance(client: ReturnType<typeof clientFor>) {
  try {
    const safe = profile.deployment.safeAddress;
    const usdc = (await client.readContract({ address: USDC, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [safe] })) as bigint;
    $('balance').textContent = `${Number(formatUnits(usdc, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`;
    $('balanceSub').textContent = `${profile.kind === 'trial' ? 'Trial wallet' : 'Wallet'} ${shortAddr(safe)} · test USDC on Sepolia`;
  } catch {
    $('balanceSub').textContent = 'Balance unavailable right now';
  }
}
function showTraffic() {
  if (!analytics) return;
  const s = analytics.summary();
  const by = s.rpc.byAdapter;
  const served = (['nox', 'torJs'] as const).map((id) => `${NET_NAME[id]} ${by[id] ?? 0}`).join(' · ');
  const reasons = Object.entries(s.rpc.excludedReasons).map(([k, v]) => `${v} × ${esc(k)}`).join(' · ');
  $('traffic').innerHTML = `This session: <b>${s.rpc.anonymized}</b> requests through Anon-RPC (${served}), <b>${s.rpc.excluded}</b> excluded${s.anonShare === null ? '' : ` — ${s.anonShare}% anonymized`}${reasons ? `<br><span class="muted">excluded: ${reasons}</span>` : ''}${githubReads ? `<br><span class="muted">declared excluded (not RPC): ${githubReads} × GitHub REST API read</span>` : ''}${relayerRequests ? `<br><span class="muted">declared (not RPC): ${relayerRequests} × trial request to the gas-only relayer</span>` : ''}${ownerTxs ? `<br><span class="muted">declared owner setup (not Anon-RPC): ${ownerTxs} × rules update sent and confirmed by your browser wallet</span>` : ''}`;
}

// ------------------------------------------------------------------ rules editor
// Changing the rules works like any dapp: the owner's own browser wallet (MetaMask, …) shows the ENS record update
// and the owner confirms it there. No key is pasted and no password is asked in this wallet.
let currentRules: { draft: RulesDraft; resolver: Address } | undefined;
let pendingDraft: RulesDraft | undefined;
let saving = false;
let ownerTxs = 0; // declared traffic: rules updates sent through the owner's own browser wallet
const inp = (id: string) => $<HTMLInputElement>(id);
const FIELDS = ['rRecipients', 'rPerTx', 'rPerDay', 'rEthOn', 'rEthTx', 'rEthDay', 'rAsk', 'rRate', 'rNewOn'];
let dirty = false;
const recipients = () => $<HTMLTextAreaElement>('rRecipients').value.split('\n').map((x) => x.trim()).filter(Boolean);
function renderRulesSummary(_d?: RulesDraft) {
  const list = recipients();
  $('rRecipSummary').textContent = list.length ? `${list.length} address${list.length > 1 ? 'es' : ''}` : 'Nobody';
  const eth = inp('rEthOn').checked;
  $('rowEthTx').style.display = eth ? '' : 'none';
  $('rowEthDay').style.display = eth ? '' : 'none';
}
function addrMsg(text: string) {
  $('addrMsg').textContent = text;
  $('addrMsg').style.display = text ? '' : 'none';
}
function renderAddrList() {
  const list = recipients();
  $('addrList').innerHTML = list.length
    ? list.map((a, i) => `<div class="addr"><span>${esc(NAMES[a.toLowerCase()] ? `${NAMES[a.toLowerCase()]} · ${a}` : a)}</span><button class="pill" data-rm="${i}" title="Remove">✕</button></div>`).join('')
    : '<p class="muted">Nobody can be paid yet. Add an address below.</p>';
  document.querySelectorAll<HTMLElement>('[data-rm]').forEach((b) => {
    b.onclick = () => {
      list.splice(Number(b.dataset.rm), 1);
      setRecipients(list);
    };
  });
}
function setRecipients(list: string[]) {
  $<HTMLTextAreaElement>('rRecipients').value = list.join('\n');
  dirty = true;
  refreshDiff();
  renderRulesSummary();
  renderAddrList();
}
$('recipBtn').onclick = () => {
  if (saving) return;
  renderAddrList();
  addrMsg('');
  $('addrModal').style.display = 'flex';
  setTimeout(() => inp('addrNew').focus(), 30);
};
$('rRecipSummary').onclick = () => $('recipBtn').click();
$('addrAdd').onclick = () => {
  const v = inp('addrNew').value.trim();
  if (!v) return addrMsg('Paste an address first (0x…).');
  if (!isAddress(v, { strict: false })) return addrMsg(`"${v.slice(0, 50)}" is not an address. It should start with 0x followed by 40 letters/numbers.`);
  const list = recipients();
  if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return addrMsg('That address is already on the list.');
  list.push(getAddress(v));
  inp('addrNew').value = '';
  addrMsg('');
  setRecipients(list);
};
inp('addrNew').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('addrAdd').click();
});
const closeAddr = () => ($('addrModal').style.display = 'none');
$('addrDone').onclick = closeAddr;
$('addrClose').onclick = closeAddr;
$('addrModal').addEventListener('click', (e) => {
  if (e.target === $('addrModal')) closeAddr();
});
function closeRules() {
  if (saving) return;
  pendingDraft = undefined;
  if (currentRules) fillForm(currentRules.draft);
  saveStatus('');
}
function renderOwner() {
  const w = ownerWallet();
  $('ownerRow').innerHTML = w
    ? `Saving asks <b>${esc(w.name)}</b> (${esc(shortAddr(w.address))}) to confirm.`
    : hasBrowserWallet()
      ? 'Saving opens your browser wallet (e.g. MetaMask) to confirm the change — use the owner account.'
      : '<span class="warn">No browser wallet found.</span> Install MetaMask (or another wallet) with the owner account to change the rules.';
}
onOwnerWalletChange(() => renderOwner());
function renderRulesEditor() {
  const demo = profile.kind === 'demo';
  $('ruleRows').style.display = demo && currentRules ? '' : 'none';
  renderOwner();
}
function setEditable(id: string, on: boolean) {
  const el = $<HTMLInputElement>(id);
  if (el.type === 'checkbox') el.disabled = !on;
  else el.readOnly = !on;
}
function fillForm(d: RulesDraft) {
  const usdc = d.tokens.find((x) => x.address.toLowerCase() === USDC.toLowerCase());
  $<HTMLTextAreaElement>('rRecipients').value = d.payees.map((p) => p.address).join('\n');
  inp('rPerTx').value = usdc?.maxPerTx ?? '0';
  inp('rPerDay').value = usdc?.perDay ?? '0';
  inp('rEthOn').checked = Boolean(d.eth);
  inp('rEthTx').value = d.eth?.maxPerTx ?? '0';
  inp('rEthDay').value = d.eth?.perDay ?? '0';
  inp('rAsk').value = d.askOwnerAboveUsd;
  inp('rRate').value = String(d.rateLimitPerHour);
  inp('rNewOn').checked = d.blockNewContracts;
  FIELDS.forEach((f) => setEditable(f, true)); // fields are edited in place: tap a value and type
  dirty = false;
  renderRulesSummary();
  $('saveBar').style.display = 'none';
  $('rulesTabDot').style.display = 'none';
}
function draftFromForm(): RulesDraft {
  if (!currentRules) throw new Error('the current rules are not loaded yet');
  const base = structuredClone(currentRules.draft);
  const addrs = $<HTMLTextAreaElement>('rRecipients').value.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  const payees = addrs.map((a) => {
    const g = getAddress(a);
    return NAMES[g.toLowerCase()] ? { address: g, label: NAMES[g.toLowerCase()]! } : { address: g };
  });
  const usdc = base.tokens.find((x) => x.address.toLowerCase() === USDC.toLowerCase());
  if (!usdc) throw new Error('USDC is not in the current rules');
  const num = (id: string, what: string) => {
    const v = inp(id).value.trim();
    if (!v) throw new Error(`${what}: enter an amount (0 is allowed).`);
    if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${what}: "${v}" is not a number like 25 or 0.5.`);
    return v;
  };
  usdc.maxPerTx = num('rPerTx', 'Max per payment');
  usdc.perDay = num('rPerDay', 'Max per day');
  if (Number(usdc.perDay) < Number(usdc.maxPerTx)) throw new Error('Max per day must be at least the max per payment.');
  const rateText = inp('rRate').value.trim() || '0';
  if (!/^\d+$/.test(rateText)) throw new Error('Payments per hour must be a whole number (0 = no limit).');
  const rate = Number(rateText);
  const eth = inp('rEthOn').checked ? { maxPerTx: num('rEthTx', 'ETH per payment'), perDay: num('rEthDay', 'ETH per day') } : null;
  if (eth && Number(eth.perDay) < Number(eth.maxPerTx)) throw new Error('ETH per day must be at least the ETH per payment.');
  const ask = inp('rAsk').value.trim() || '0';
  if (!/^\d+(\.\d+)?$/.test(ask)) throw new Error(`Ask me above: "${ask}" is not a number like 20 (0 = never ask).`);
  return { ...base, version: base.version + 1, payees, eth, allowEthToPayees: Boolean(eth), askOwnerAboveUsd: ask, rateLimitPerHour: rate, blockNewContracts: inp('rNewOn').checked };
}
/** Live change list while editing; Save stays disabled while the rules are invalid. */
function refreshDiff() {
  if (!currentRules || saving) return;
  renderRulesSummary();
  try {
    const d = draftFromForm();
    toPolicy(d);
    const changes = diffRules(currentRules.draft, d).filter((c) => !c.startsWith('No changes'));
    pendingDraft = changes.length ? d : undefined;
    $('rulesDiff').innerHTML = changes.length ? `<div class="decision warn"><div class="verdict">${changes.length} unsaved change${changes.length > 1 ? 's' : ''}</div><ul>${changes.map((c) => `<li>${esc(c.replace(/^[~+-] /, ''))}</li>`).join('')}</ul></div>` : '<p class="muted">No changes — the values match your saved rules.</p>';
    $<HTMLButtonElement>('rulesSave').disabled = !changes.length;
  } catch (e) {
    pendingDraft = undefined;
    $('rulesDiff').innerHTML = `<div class="decision bad"><div class="verdict">✕ Fix this before saving</div><p>${esc(errText(e))}</p></div>`;
    $<HTMLButtonElement>('rulesSave').disabled = true;
  }
  $('saveBar').style.display = dirty ? '' : 'none';
  $('rulesTabDot').style.display = dirty && pendingDraft ? '' : 'none';
}
document.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((b) =>
  (b.onclick = () => {
    const el = $<HTMLInputElement>(b.dataset.edit!);
    if (el.type === 'checkbox') {
      el.checked = !el.checked;
      el.dispatchEvent(new Event('change'));
    } else {
      el.focus();
      el.select();
    }
  }),
);
const edited = () => {
  if (saving) return;
  dirty = true;
  saveStatus('');
  refreshDiff();
};
FIELDS.forEach((f) => $(f).addEventListener('input', edited));
FIELDS.forEach((f) => $(f).addEventListener('change', edited));
['rPerTx', 'rPerDay', 'rEthTx', 'rEthDay', 'rAsk', 'rRate'].forEach((f) =>
  $(f).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$<HTMLButtonElement>('rulesSave').disabled) $('rulesSave').click();
  }),
);
function saveStatus(html: string, cls = '') {
  $('saveStatus').innerHTML = html ? `<div class="decision ${cls}">${html}</div>` : '';
}
function setSaving(on: boolean) {
  saving = on;
  FIELDS.forEach((f) => setEditable(f, !on));
  $<HTMLButtonElement>('rulesSave').disabled = on || !pendingDraft;
  $<HTMLButtonElement>('rulesCancel').disabled = on;
  $<HTMLButtonElement>('recipBtn').disabled = on;
  $('rulesSave').textContent = on ? 'Saving…' : 'Save changes';
}
async function saveRules() {
  if (saving) return;
  refreshDiff();
  if (!pendingDraft) return saveStatus('Nothing to save yet — change a value first.', 'warn');
  if (!rpc || !currentRules) return saveStatus('Still connecting privately — try again in a moment.', 'warn');
  const draft = pendingDraft;
  setSaving(true);
  let hash: Hex | undefined;
  try {
    const policy = toPolicy(draft);
    const client = clientFor(rpc);
    saveStatus('<b>1/3</b> Connecting your browser wallet… <span class="muted">(approve this site in the wallet window if asked)</span>');
    const w = ownerWallet() ?? (await connectOwnerWallet());
    renderOwner();
    const data = policyUpdateCalldata(profile.ensName, policy);
    // Who may write this record is decided on-chain by the resolver's ENSv2 roles (ROLE_SET_DATA on
    // "blindspot.policy", or the same role at the root resource). Check that first for an exact message.
    const ROLE_SET_DATA = 1n << 24n;
    const rolesAbi = parseAbi(['function roles(uint256,address) view returns (uint256)']);
    const resource = BigInt(keccak256(toBytes('blindspot.policy')));
    const [rRole, rootRole] = await Promise.all(
      [resource, 0n].map((r) => client.readContract({ address: currentRules!.resolver, abi: rolesAbi, functionName: 'roles', args: [r, w.address] }).catch(() => null) as Promise<bigint | null>),
    );
    const allowed = rRole === null && rootRole === null ? null : ((rRole ?? 0n) | (rootRole ?? 0n)) & ROLE_SET_DATA ? true : false;
    if (allowed === false)
      throw new Error(`The account ${shortAddr(w.address)} selected in ${w.name} has no permission to change the rules of ${profile.ensName}. In ${w.name}, switch to the owner account (${shortAddr(cfg.owner)}) or the rules-key account, then save again.`);
    const balance = await client.getBalance({ address: w.address }).catch(() => null);
    if (balance === 0n) throw new Error(`The account ${shortAddr(w.address)} has no Sepolia ETH to pay the small network fee. Send it a little test ETH (e.g. from a Sepolia faucet), then save again.`);
    let gas: bigint;
    try {
      gas = await client.estimateGas({ account: w.address, to: currentRules.resolver, data });
    } catch (e) {
      throw new Error(`Sepolia would reject this update from ${shortAddr(w.address)}: ${errText(e)}`);
    }
    saveStatus(`<b>2/3</b> Confirm the change in <b>${esc(w.name)}</b>. <span class="muted">It updates the “blindspot.policy” record of ${esc(profile.ensName)} on Sepolia (a small gas fee in test ETH).</span>`);
    hash = await sendFromOwnerWallet(w, { to: currentRules.resolver, data, gas: (gas * 13n) / 10n });
    ownerTxs++;
    const link = `<a href="${ETHERSCAN(hash)}" target="_blank" rel="noopener">view transaction</a>`;
    saveStatus(`<b>3/3</b> Sent — waiting for Sepolia to confirm (usually 10–30 s)… ${link}`);
    const r = await waitForReceipt(w, hash);
    if (r.status !== 'success') throw new Error(`The update was rejected on-chain — ${w.name}'s account may not have permission to change these rules.`);
    // Read the record back through Anon-RPC until it holds exactly the new rules (nodes can lag a few seconds).
    const expected = keccak256(encodePolicy(policy));
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      ok = await readPolicy(client, profile.deployment, profile.label).then((x) => x.keccak === expected).catch(() => false);
      if (!ok) await new Promise((res) => setTimeout(res, 3000));
    }
    pendingDraft = undefined;
    dirty = false;
    if (ok) {
      saveStatus(`✓ Saved. Your new rules are live on ENS — the agent's next payment follows them. ${link}`, 'ok');
      notify(`✓ New rules are live on ENS — ${link}`, 'ok');
    } else {
      saveStatus(`✓ Confirmed on Sepolia. The rules view will refresh once the network catches up. ${link}`, 'ok');
      notify(`Rules update confirmed — ${link}`, 'ok');
    }
    setSaving(false);
    await loadRules();
    $('saveBar').style.display = '';
    $('rulesDiff').innerHTML = '';
  } catch (e) {
    const m = errText(e);
    saveStatus(`✕ Not saved: ${esc(m)}${hash ? ` — <a href="${ETHERSCAN(hash)}" target="_blank" rel="noopener">transaction</a>` : ''}`, 'bad');
    activity(`Rules not saved: ${esc(m)}`, 'bad');
    setSaving(false);
    refreshDiff();
  }
}
$('rulesSave').onclick = () => void saveRules();
$('rulesCancel').onclick = () => closeRules();

// ------------------------------------------------------------------ trial agents (Step 3d)
function switchProfile(p: Profile, why: string) {
  host.endAll('locked'); // a session belongs to one agent identity
  cancelPrompts();
  contexts.clear();
  profile = p;
  dirty = false;
  pendingDraft = undefined;
  currentRules = undefined;
  saveStatus('');
  $('rules').innerHTML = 'Loading the rules of this account…';
  $('balance').textContent = '—';
  $('ensName').textContent = p.ensName;
  activity(why, 'warn');
  renderSessions(host.list());
  renderTrial();
  renderRulesEditor();
  renderLock();
  flushConnects();
  void loadRules();
}
function renderTrial() {
  const on = profile.kind === 'trial';
  $('trialState').innerHTML = on
    ? `<span class="ok">Active trial agent:</span> <b>${esc(profile.ensName)}</b> <span class="muted">(${esc(profile.agent)}) · key in memory only · expires ${esc(new Date(profile.expiresAt ?? 0).toLocaleString())} · pays from the separate trial Safe</span>`
    : 'No trial agent. The demo agent (presenter key) is active.';
  $('demoBtn').style.display = on ? '' : 'none';
}
async function startTrial(): Promise<void> {
  const acct = privateKeyToAccount(generatePrivateKey());
  activity(`Trial: a fresh agent key was made in this browser (memory only): ${esc(acct.address)}. Asking the gas-only relayer to register it…`);
  relayerRequests++;
  let res: Response;
  try {
    res = await fetch(`${__WALLET__.relayerUrl}/provision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: acct.address }) });
  } catch {
    throw new Error('The trial service is not reachable. Start it with “corepack pnpm --filter @blindspot/relayer serve”, or use Simulate only.');
  }
  const j = (await res.json().catch(() => ({}))) as { label?: string; name?: string; tx?: string; expiresAt?: string; error?: string };
  if (!res.ok || !j.label || !j.name) throw new Error(j.error ?? `the trial service answered HTTP ${res.status}`);
  trialAccount = acct;
  switchProfile(
    { kind: 'trial', label: j.label, ensName: j.name, agent: acct.address, deployment: trialDeployment, expiresAt: j.expiresAt ?? '' },
    `Trial account ${esc(j.name)} is ready for 24 h (tiny fixed rules) — <a href="${ETHERSCAN(j.tx ?? '')}" target="_blank" rel="noopener">registration tx</a>. Connected apps now act as this name.`,
  );
  notify(`✓ Trial account <b>${esc(j.name)}</b> is ready. Connect the agent app to start.`, 'ok', false);
}
$('trialBtn').onclick = () =>
  void busy($<HTMLButtonElement>('trialBtn'), 'Creating your trial account…', () =>
    startTrial().catch((e) => notify(`Trial not created: ${esc(errText(e))}`, 'bad')),
  );
$('lockTrial').onclick = () =>
  void busy($<HTMLButtonElement>('lockTrial'), 'Creating your trial account… (up to 30 s)', async () => {
    lockMsg('');
    await startTrial().catch((e) => lockMsg(`Trial not created: ${errText(e)}`));
  });
$('demoBtn').onclick = () => {
  trialAccount = undefined;
  switchProfile(DEMO, `back to the demo agent ${DEMO.ensName}; the trial key was dropped from memory.`);
};

for (const id of ['pass', 'pk'])
  $(id).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (id === 'pk') return $('pass').focus();
    $(storedKey() ? 'unlockBtn' : 'importBtn').click();
  });
$('lockForgot').onclick = (e) => {
  e.preventDefault();
  $('forgetBtn').click();
};

// ------------------------------------------------------------------ tabs (Home · Activity · Rules · Settings)
let currentTab = 'home';
let unseen = 0;
function showTab(name: string) {
  currentTab = name;
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((s) => (s.style.display = s.dataset.tab === name ? '' : 'none'));
  document.querySelectorAll<HTMLElement>('[data-tab-btn]').forEach((b) => b.classList.toggle('on', b.dataset.tabBtn === name));
  if (name === 'activity') {
    unseen = 0;
    $('actBadge').style.display = 'none';
  }
  window.scrollTo({ top: 0 });
}
document.querySelectorAll<HTMLElement>('[data-tab-btn]').forEach((b) => (b.onclick = () => showTab(b.dataset.tabBtn!)));
new MutationObserver(() => {
  if (currentTab === 'activity') return;
  unseen++;
  $('actBadge').textContent = String(unseen);
  $('actBadge').style.display = '';
}).observe($('activity'), { childList: true });
showTab('home');

async function init() {
  renderTrial();
  renderRulesEditor();
  renderLock();
  renderSessions([]);
  analytics = await Analytics.load(new MemoryStorage()); // the meter counts this wallet session only
  setInterval(showTraffic, 1000);
  if (window.opener) window.opener.postMessage({ protocol: PROTOCOL, kind: 'ready' }, '*'); // carries no data
  chain = anonChain(analytics, showChain, () => {
    rpc = withBroadcastFallback(chain!);
    resolveNet();
    void loadRules();
  }, new URLSearchParams(location.search).get('net') === 'torJs' ? 'torJs' : 'nox');
}
async function loadRules() {
  try {
    await showRules();
  } catch (e) {
    $('rules').innerHTML = `<span class="warn">Could not read your rules from ENS right now: ${esc(errText(e))}</span><div class="row"><button id="rulesRetry">Try again</button></div>`;
    $('rulesRetry').onclick = () => void loadRules();
  }
}
void init();
