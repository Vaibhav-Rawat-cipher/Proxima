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
  rulesOnlySigner,
  updatePolicy,
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
import { ETH, type Decision, type Effect } from '@blindspot/shared';
import { formatEther, formatUnits, getAddress, isAddress, isHex, keccak256, parseAbi, toBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import cfg from '../../../config/sepolia.json';
import { NET_NAME, anonChain, redact, type AnonChain, type ChainStatus } from './anon';
import { sandboxRunner } from './sandbox';
import { walletSources } from './sources';

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

// ------------------------------------------------------------------ owner prompts (connection requests, approvals)
type Prompt = { el: HTMLElement; resolve: (v: boolean) => void; sessionId?: string };
const prompts = new Set<Prompt>();
function ask(title: string, body: string, approveLabel: string, sessionId?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement('section');
    el.className = 'card prompt';
    el.innerHTML = `<h2>${esc(title)}</h2>${body}<div class="row"><button class="primary">${esc(approveLabel)}</button><button class="secondary">Reject</button></div>`;
    const p: Prompt = { el, resolve, ...(sessionId ? { sessionId } : {}) };
    const done = (v: boolean) => {
      prompts.delete(p);
      el.remove();
      resolve(v);
    };
    el.querySelector<HTMLButtonElement>('.primary')!.onclick = () => done(true);
    el.querySelector<HTMLButtonElement>('.secondary')!.onclick = () => done(false);
    prompts.add(p);
    $('prompts').prepend(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.focus();
  });
}
/** Session ended / wallet locked: anything still waiting for the owner is rejected. */
function cancelPrompts(sessionId?: string) {
  for (const p of [...prompts]) {
    if (sessionId && p.sessionId !== sessionId) continue;
    prompts.delete(p);
    p.el.remove();
    p.resolve(false);
  }
}

// ------------------------------------------------------------------ formatting
const who = (a: string) => (NAMES[a.toLowerCase()] ? `${NAMES[a.toLowerCase()]} (${a.slice(0, 6)}…${a.slice(-4)})` : a);
const amount = (token: string, v: bigint) => (DECIMALS[token.toLowerCase()] !== undefined ? `${formatUnits(v, DECIMALS[token.toLowerCase()]!)} ${token === ETH ? 'ETH' : NAMES[token.toLowerCase()] ?? ''}` : `${v} units of ${who(token)}`);
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
        const ok = await ask('Anon-RPC could not broadcast', `<pre>${esc((e as Error).message)}</pre><p>Approve = send this same signed transaction through a <b>direct RPC</b> connection (declared excluded traffic). Reject = do not send.</p>`, 'Send directly');
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

async function approveTx(s: Session, req: ApprovalRequest): Promise<boolean> {
  const fee = formatEther(req.gas * req.maxFeePerGas);
  if (req.simulated)
    return ask(
      `Simulate? (${s.agentName} · ${s.origin})`,
      `${decisionCard(req.decision, s.agentName)}<p class="warn"><b>SIMULATE ONLY</b> — every check ran; approving shows what this transaction would do. Nothing is signed or sent.</p><pre>from   ${req.from} (agent)
to     ${req.to} (BlindspotModule)
call   module.execute — calldata built by Blindspot from the ALLOWED proposal</pre>`,
      'Approve (simulate)',
      s.id,
    );
  const body = `${decisionCard(req.decision, s.agentName)}<details class="tech"><summary>transaction details</summary><pre>from   ${req.from} (agent key, in this wallet)
to     ${req.to} (BlindspotModule)
call   module.execute — calldata built by Blindspot from the ALLOWED proposal
nonce  ${req.nonce}
fee    at most ${fee} ETH
sent through ${esc(NET_NAME[chain?.active() ?? 'nox'])}</pre></details>`;
  return ask(`${s.agentName} wants to send a payment`, body, 'Approve & send', s.id);
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
  isLocked: () => !activeAccount() && !simulateOnly,
  send: (origin, msg) => {
    try {
      window.opener?.postMessage(msg, origin);
    } catch {
      /* the agent window is gone */
    }
  },
  approveConnect: (req) =>
    ask(
      'Connection request',
      `<p><b>${esc(req.agentName)}</b> at <code>${esc(req.origin)}</code> wants to act as <b>${esc(req.ensName)}</b> (${esc(req.agent)}).</p>
       <p>It can:</p><ul>${req.permissions.can.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
       <p>It cannot:</p><ul>${req.permissions.cannot.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
       <p class="muted">You can revoke the session at any time. Locking or closing this wallet ends it.</p>`,
      'Approve connection',
    ),
  exec: async (s, tool, args) => {
    await netReady;
    const ctx = ctxFor(s);
    const argText = JSON.stringify(args);
    activity(`${esc(friendlyTool(tool, args))}<details class="tech"><summary>details</summary><code>${esc(s.agentName)} · ${esc(tool)} ${esc(argText.length > 400 ? `${argText.slice(0, 400)}…` : argText)}</code></details>`);
    const before = ctx.proposals.size;
    const out = await runTool(ctx, tool, args);
    if (tool === 'propose' && ctx.proposals.size > before) {
      const last = [...ctx.proposals.values()].at(-1)!;
      activity(decisionCard(last.decision, s.agentName));
    } else if (tool === 'execute') {
      const r = JSON.parse(out) as { status: string; tx?: string; result?: string; reason?: string; effects?: { kind: string; token: string; amount: string; counterparty: string }[] };
      if (r.status === 'simulated') {
        activity(`<b>SIMULATED — not sent:</b> ${esc((r.effects ?? []).map((e) => effectLine({ ...e, amount: BigInt(e.amount), source: 'log' } as Effect)).join('; ') || 'no effects')}`, 'warn');
        return out;
      }
      activity(r.status === 'sent' ? `sent: <a href="${ETHERSCAN(r.tx!)}" target="_blank" rel="noopener">${esc(r.tx)}</a> — ${esc(r.result)}` : `execute refused: ${esc(r.reason)}`, r.status === 'sent' ? 'ok' : 'warn');
    }
    return out;
  },
  onEnded: (s) => {
    cancelPrompts(s.id);
    contexts.delete(s.id);
    activity(`session with <b>${esc(s.agentName)}</b> ended (${esc(s.endedBy)})`, 'warn');
  },
  onChange: (list) => renderSessions(list),
});

function renderSessions(list: Session[]) {
  const el = $('sessions');
  if (!list.length) {
    el.innerHTML = '<p class="muted" style="margin:0">No apps connected.</p>';
    return;
  }
  el.innerHTML = list
    .slice()
    .reverse()
    .map((s) => `<div class="session ${s.active ? '' : 'ended'}"><div><b>${esc(s.agentName)}</b><br><span class="muted">${esc(s.origin.replace(/^https?:\/\//, ''))} · ${s.active ? 'connected' : `disconnected (${esc(s.endedBy)})`}</span></div>${s.active ? `<button data-revoke="${esc(s.id)}" class="danger">Disconnect</button>` : ''}</div>`)
    .join('');
  el.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((b) => (b.onclick = () => host.end(b.dataset.revoke!, 'revoked')));
}

window.addEventListener('message', (e) => {
  if (!window.opener || e.source !== window.opener) return; // only the window that opened this wallet
  void host.handle(e.origin, e.data);
});
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
function renderLock() {
  const unlocked = Boolean(activeAccount());
  $('keyState').innerHTML = unlocked ? '<span class="ok">● Unlocked</span>' : storedKey() ? '<span class="muted">● Locked — enter your password</span>' : '<span class="muted">Add your agent key once. It is encrypted with your password and never leaves this browser.</span>';
  $('importRow').style.display = storedKey() || profile.kind === 'trial' ? 'none' : '';
  $('unlockRow').style.display = unlocked || !storedKey() ? 'none' : '';
  $('lockRow').style.display = unlocked ? '' : 'none';
  $('importRow2').style.display = $('importRow').style.display;
  const locked = !unlocked && !simulateOnly && profile.kind === 'demo';
  $('lockScreen').style.display = locked ? 'flex' : 'none';
  $('lockTitle').textContent = storedKey() ? 'Welcome back' : 'Set up your agent wallet';
  $('lockSub').textContent = storedKey() ? "Enter your password to unlock your agent's wallet." : 'Paste your agent key once and choose a password. The key is encrypted and never leaves this browser.';
  $('lockForgot').style.display = storedKey() ? '' : 'none';
  if (locked) setTimeout(() => $(storedKey() ? 'pass' : 'pk').focus(), 30);
}
$('importBtn').onclick = async () => {
  const pk = $<HTMLInputElement>('pk').value.trim();
  const pass = $<HTMLInputElement>('pass').value;
  if (!isHex(pk) || pk.length !== 66) return activity('paste the agent private key (0x + 64 hex characters)', 'bad');
  const acct = privateKeyToAccount(pk as Hex);
  if (acct.address !== AGENT) return activity(`that key is ${esc(acct.address)}, but the agent of ${esc(DEMO.ensName)} is ${esc(AGENT)}. Not imported.`, 'bad');
  try {
    localStorage.setItem(KEY_STORE, JSON.stringify(await encryptPrivateKey(pk as Hex, pass)));
    $<HTMLInputElement>('pk').value = '';
    activity('Agent key saved (encrypted in this browser).', 'ok');
    setTimeout(() => $('unlockBtn').click(), 0);
  } catch (e) {
    activity(esc((e as Error).message), 'bad');
  }
  renderLock();
};
$('unlockBtn').onclick = async () => {
  const enc = storedKey();
  if (!enc) return;
  try {
    const acct = privateKeyToAccount(await decryptPrivateKey(enc, $<HTMLInputElement>('pass').value));
    if (acct.address !== AGENT) throw new Error('stored key does not match the agent address');
    agentAccount = acct;
    $<HTMLInputElement>('pass').value = '';
    activity('wallet unlocked (agent key in memory only)', 'ok');
  } catch (e) {
    activity(esc((e as Error).message), 'bad');
  }
  renderLock();
};
$('lockBtn').onclick = () => {
  agentAccount = undefined;
  host.endAll('locked');
  cancelPrompts();
  contexts.clear();
  activity('wallet locked: every session ended', 'warn');
  renderLock();
};
$<HTMLInputElement>('simToggle').onchange = (e) => {
  simulateOnly = (e.target as HTMLInputElement).checked;
  for (const c of contexts.values()) c.simulateOnly = simulateOnly;
  $('simBanner').style.display = simulateOnly ? '' : 'none';
  renderLock();
  activity(simulateOnly ? 'Simulate only: ON — approving runs every check but signs and sends nothing.' : 'Simulate only: OFF — Approve & send sends real transactions.', 'warn');
  if (!simulateOnly && !agentAccount) {
    host.endAll('locked'); // sessions opened without a key cannot continue in real mode
    cancelPrompts();
    contexts.clear();
  }
};
$('forgetBtn').onclick = () => {
  if (!confirm('Delete the encrypted agent key from this browser?')) return;
  localStorage.removeItem(KEY_STORE);
  $('lockBtn').click();
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
  $('rules').innerHTML = `<p class="muted" style="margin:8px 0 0">Read live from the ENS record “blindspot.policy” of ${esc(profile.ensName)} through ${esc(NET_NAME[chain?.active() ?? 'nox'])} · keccak ${esc(rec.keccak.slice(0, 10))}…</p>`;
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
  $('traffic').innerHTML = `This session: <b>${s.rpc.anonymized}</b> requests through Anon-RPC (${served}), <b>${s.rpc.excluded}</b> excluded${s.anonShare === null ? '' : ` — ${s.anonShare}% anonymized`}${reasons ? `<br><span class="muted">excluded: ${reasons}</span>` : ''}${githubReads ? `<br><span class="muted">declared excluded (not RPC): ${githubReads} × GitHub REST API read</span>` : ''}${relayerRequests ? `<br><span class="muted">declared (not RPC): ${relayerRequests} × trial request to the gas-only relayer</span>` : ''}`;
}

// ------------------------------------------------------------------ rules editor (rules key: may ONLY change blindspot.policy)
const RULES_KEY_STORE = 'blindspot.wallet.rulesKey';
let currentRules: { draft: RulesDraft; resolver: Address } | undefined;
let rulesAccount: PrivateKeyAccount | undefined; // memory only, dropped after each save
let pendingDraft: RulesDraft | undefined;
const storedRulesKey = (): EncryptedKey | undefined => {
  try {
    const s = localStorage.getItem(RULES_KEY_STORE);
    return s ? (JSON.parse(s) as EncryptedKey) : undefined;
  } catch {
    return undefined;
  }
};
const inp = (id: string) => $<HTMLInputElement>(id);
const FIELDS = ['rRecipients', 'rPerTx', 'rPerDay', 'rEthOn', 'rEthTx', 'rEthDay', 'rAsk', 'rRate', 'rNewOn'];
let dirty = false;
function renderRulesSummary(_d?: RulesDraft) {
  const list = $<HTMLTextAreaElement>('rRecipients').value.split('\n').map((x) => x.trim()).filter(Boolean);
  $('rRecipSummary').textContent = list.length ? `${list.length} address${list.length > 1 ? 'es' : ''}` : 'Nobody';
}
function renderAddrList() {
  const list = $<HTMLTextAreaElement>('rRecipients').value.split('\n').map((x) => x.trim()).filter(Boolean);
  $('addrList').innerHTML = list.length
    ? list.map((a, i) => `<div class="addr"><span>${esc(a)}</span><button class="pill" data-rm="${i}" title="Remove">✕</button></div>`).join('')
    : '<p class="muted">Nobody can be paid yet.</p>';
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
  renderAddrList();
  $('addrModal').style.display = 'flex';
};
$('addrAdd').onclick = () => {
  const v = inp('addrNew').value.trim();
  if (!isAddress(v, { strict: false })) return activity(`"${esc(v)}" is not an address`, 'bad');
  const list = $<HTMLTextAreaElement>('rRecipients').value.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(getAddress(v));
  inp('addrNew').value = '';
  setRecipients(list);
};
const closeAddr = () => ($('addrModal').style.display = 'none');
$('addrDone').onclick = closeAddr;
$('addrClose').onclick = closeAddr;
function openRules(focus?: string) {
  if (!currentRules || profile.kind !== 'demo') return;
  fillForm(currentRules.draft);
  if (focus) setTimeout(() => $(focus).focus(), 50);
}
function closeRules() {
  pendingDraft = undefined;
  rulesAccount = undefined;
  if (currentRules) fillForm(currentRules.draft);
}
function renderRulesEditor() {
  const demo = profile.kind === 'demo';
  $('ruleRows').style.display = demo && currentRules ? '' : 'none';
  $('rulesImportRow').style.display = storedRulesKey() ? 'none' : '';
  $('rulesUnlockRow').style.display = storedRulesKey() ? '' : 'none';
  $('rulesKeyState').innerHTML = storedRulesKey() ? 'Enter your rules password to save.' : 'First time: add your rules key (it can only change these rules).';
}
function setEditable(id: string, on: boolean) {
  const el = $<HTMLInputElement>(id);
  if (el.type === 'checkbox') el.disabled = !on;
  else el.readOnly = !on;
  el.classList.toggle('editing', on);
  if (on && el.type !== 'checkbox') el.focus();
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
  renderRulesSummary();
  FIELDS.forEach((f) => setEditable(f, false));
  dirty = false;
  $('saveBar').style.display = 'none';
  $('rulesAuth').style.display = 'none';
}
function draftFromForm(): RulesDraft {
  if (!currentRules) throw new Error('the current rules are not loaded yet');
  const base = structuredClone(currentRules.draft);
  const addrs = ($<HTMLTextAreaElement>('rRecipients').value.match(/0x[0-9a-fA-F]{40}/g) ?? []);
  const payees = addrs.map((a) => {
    const g = getAddress(a);
    return NAMES[g.toLowerCase()] ? { address: g, label: NAMES[g.toLowerCase()]! } : { address: g };
  });
  const usdc = base.tokens.find((x) => x.address.toLowerCase() === USDC.toLowerCase());
  if (!usdc) throw new Error('USDC is not in the current rules');
  usdc.maxPerTx = inp('rPerTx').value.trim();
  usdc.perDay = inp('rPerDay').value.trim();
  const rate = Number(inp('rRate').value.trim() || '0');
  if (!Number.isInteger(rate) || rate < 0) throw new Error('payments per hour must be a whole number (0 = no limit)');
  const eth = inp('rEthOn').checked ? { maxPerTx: inp('rEthTx').value.trim(), perDay: inp('rEthDay').value.trim() } : null;
  return { ...base, version: base.version + 1, payees, eth, allowEthToPayees: Boolean(eth), askOwnerAboveUsd: inp('rAsk').value.trim() || '0', rateLimitPerHour: rate, blockNewContracts: inp('rNewOn').checked };
}
/** Live change list while editing; Save stays disabled while the rules are invalid. */
function refreshDiff() {
  if (!currentRules) return;
  try {
    const d = draftFromForm();
    toPolicy(d);
    const changes = diffRules(currentRules.draft, d).filter((c) => !c.startsWith('No changes'));
    pendingDraft = changes.length ? d : undefined;
    $('rulesDiff').innerHTML = changes.length ? `<div class="decision warn"><div class="verdict">${changes.length} change${changes.length > 1 ? 's' : ''}</div><ul>${changes.map((c) => `<li>${esc(c.replace(/^[~+-] /, ''))}</li>`).join('')}</ul></div>` : '<p class="muted">No changes yet.</p>';
    $<HTMLButtonElement>('rulesSave').disabled = !changes.length;
  } catch (e) {
    pendingDraft = undefined;
    $('rulesDiff').innerHTML = `<div class="decision bad"><div class="verdict">✕ Not valid</div><p>${esc((e as Error).message)}</p></div>`;
    $<HTMLButtonElement>('rulesSave').disabled = true;
  }
  $('saveBar').style.display = dirty ? '' : 'none';
}
document.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((b) => (b.onclick = () => setEditable(b.dataset.edit!, true)));
FIELDS.forEach((f) => $(f).addEventListener('input', () => ((dirty = true), refreshDiff())));
FIELDS.forEach((f) => $(f).addEventListener('change', () => ((dirty = true), refreshDiff())));
$('rulesImportBtn').onclick = async () => {
  try {
    const pk = inp('rulesPk').value.trim();
    if (!isHex(pk) || pk.length !== 66) throw new Error('paste the rules key (0x + 64 hex characters)');
    if (privateKeyToAccount(pk as Hex).address === AGENT) throw new Error('that is the agent key, not the rules key');
    localStorage.setItem(RULES_KEY_STORE, JSON.stringify(await encryptPrivateKey(pk as Hex, inp('rulesPass1').value)));
    inp('rulesPk').value = '';
    inp('rulesPass1').value = '';
    activity('Rules key saved (encrypted in this browser).', 'ok');
  } catch (e) {
    activity(esc((e as Error).message), 'bad');
  }
  renderRulesEditor();
};
async function unlockRulesKey(): Promise<boolean> {
  if (rulesAccount) return true;
  if (!rpc || !currentRules || !storedRulesKey()) return false;
  const acct = privateKeyToAccount(await decryptPrivateKey(storedRulesKey()!, inp('rulesPass').value));
  inp('rulesPass').value = '';
  const role = (await clientFor(rpc).readContract({ address: currentRules.resolver, abi: parseAbi(['function roles(uint256,address) view returns (uint256)']), functionName: 'roles', args: [BigInt(keccak256(toBytes('blindspot.policy'))), acct.address] })) as bigint;
  if ((role & (1n << 24n)) === 0n) throw new Error(`this key (${shortAddr(acct.address)}) is not allowed to change the rules — run the GrantRulesKey command first`);
  rulesAccount = acct;
  return true;
}
async function saveRules() {
  const btn = $<HTMLButtonElement>('rulesSave');
  if (!pendingDraft || !rpc || !currentRules) return;
  if (!rulesAccount) {
    $('rulesAuth').style.display = '';
    renderRulesEditor();
    return; // the password prompt appears; Confirm continues the save
  }
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const signer = rulesOnlySigner(rulesAccount, currentRules.resolver, profile.ensName, profile.deployment.chainId);
    const r = await updatePolicy({ rpc, client: clientFor(rpc), deployment: profile.deployment, label: profile.label, signer, policy: toPolicy(pendingDraft) });
    activity(`✓ Your new rules are live on ENS — <a href="${ETHERSCAN(r.hash)}" target="_blank" rel="noopener">view transaction</a>. The next payment follows them.`, 'ok');
    pendingDraft = undefined;
    dirty = false;
    await loadRules();
  } catch (e) {
    activity(`Rules not saved: ${esc((e as Error).message.split('\n')[0])}`, 'bad');
  } finally {
    rulesAccount = undefined; // lock again after every save attempt
    btn.textContent = 'Save changes';
    $('rulesAuth').style.display = 'none';
    renderRulesEditor();
  }
}
$('rulesSave').onclick = () => void saveRules();
$('rulesUnlockBtn').onclick = async () => {
  try {
    if (await unlockRulesKey()) await saveRules();
  } catch (e) {
    activity(esc((e as Error).message), 'bad');
  }
};
$('rulesCancel').onclick = () => closeRules();


// ------------------------------------------------------------------ trial agents (Step 3d)
function switchProfile(p: Profile, why: string) {
  host.endAll('locked'); // a session belongs to one agent identity
  cancelPrompts();
  contexts.clear();
  profile = p;
  $('ensName').textContent = p.ensName;
  activity(why, 'warn');
  renderSessions(host.list());
  renderTrial();
  renderRulesEditor();
  renderLock();
  void loadRules();
}
function renderTrial() {
  const on = profile.kind === 'trial';
  $('trialState').innerHTML = on
    ? `<span class="ok">Active trial agent:</span> <b>${esc(profile.ensName)}</b> <span class="muted">(${esc(profile.agent)}) · key in memory only · expires ${esc(new Date(profile.expiresAt ?? 0).toLocaleString())} · pays from the separate trial Safe</span>`
    : 'No trial agent. The demo agent (presenter key) is active.';
  $('demoBtn').style.display = on ? '' : 'none';
}
$('trialBtn').onclick = async () => {
  const btn = $<HTMLButtonElement>('trialBtn');
  btn.disabled = true;
  try {
    const acct = privateKeyToAccount(generatePrivateKey());
    activity(`trial: a fresh agent key was made in this browser (memory only): ${esc(acct.address)}. Asking the gas-only relayer to register it…`);
    relayerRequests++;
    const res = await fetch(`${__WALLET__.relayerUrl}/provision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: acct.address }) });
    const j = (await res.json()) as { label?: string; name?: string; tx?: string; expiresAt?: string; error?: string };
    if (!res.ok || !j.label || !j.name) throw new Error(j.error ?? `relayer HTTP ${res.status}`);
    trialAccount = acct;
    switchProfile(
      { kind: 'trial', label: j.label, ensName: j.name, agent: acct.address, deployment: trialDeployment, expiresAt: j.expiresAt ?? '' },
      `trial agent ${esc(j.name)} registered for 24 h (zero roles, tiny rules) — <a href="${ETHERSCAN(j.tx ?? '')}" target="_blank" rel="noopener">provision tx</a>. Sessions now act as this name.`,
    );
  } catch (e) {
    activity(`trial not created: ${esc((e as Error).message)} — you can still use “Simulate only”.`, 'bad');
  } finally {
    btn.disabled = false;
  }
};
$('demoBtn').onclick = () => {
  trialAccount = undefined;
  switchProfile(DEMO, `back to the demo agent ${DEMO.ensName}; the trial key was dropped from memory.`);
};

$('pass').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  $(storedKey() ? 'unlockBtn' : 'importBtn').click();
});
$('lockForgot').onclick = (e) => {
  e.preventDefault();
  $('forgetBtn').click();
};
$('lockTrial').onclick = () => $('trialBtn').click();

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
  else $('opener').style.display = '';
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
    $('rules').innerHTML = `<span class="warn">Could not read the rules yet: ${esc((e as Error).message.split('\n')[0])}</span> <button id="rulesRetry">Retry</button>`;
    $('rulesRetry').onclick = () => void loadRules();
  }
}
void init();
