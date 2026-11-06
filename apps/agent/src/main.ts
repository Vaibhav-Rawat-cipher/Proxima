// Outside agent app (Step 3a). An ordinary tool-calling LLM agent that holds NO wallet keys and NO funds. It
// connects to the Proxima wallet with @blindspot/sdk (popup + owner approval + session) and can only ask the
// wallet to run tools.
import { connect, type BlindspotSession } from '@blindspot/sdk';
import { RULES_FIRST, SYSTEM_PROMPT, decryptSecret, encryptSecret, openAiCompatibleLlm, runAgentWith, type EncryptedKey, type LlmResponse } from '@blindspot/core';

declare const __AGENT__: { walletUrl: string; llmProxyPath: string };
const WALLET_URL = __AGENT__.walletUrl;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ------------------------------------------------------------------ models
type ModelChoice = { label: string; url: string; model: string; keyName: string; keyRequired: boolean; extraBody?: Record<string, unknown> };
const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
/** Hosted site only: Proxima's rate-limited LLM proxy on this app's own origin (declared backend; holds the key). */
const HOSTED: Record<string, ModelChoice> = __AGENT__.llmProxyPath
  ? { blindspot: { label: 'Proxima AI · gpt-oss-120b (free, rate-limited)', url: `${location.origin}${__AGENT__.llmProxyPath}`, model: 'openai/gpt-oss-120b', keyName: 'hosted', keyRequired: false } }
  : {};
const DEFAULT_MODEL = __AGENT__.llmProxyPath ? 'blindspot' : 'groq-120b';
const MODELS: Record<string, ModelChoice> = {
  ...HOSTED,
  'groq-120b': { label: `Groq · openai/gpt-oss-120b${__AGENT__.llmProxyPath ? ' (your key)' : ' (default)'}`, url: GROQ, model: 'openai/gpt-oss-120b', keyName: 'groq', keyRequired: true, extraBody: { reasoning_format: 'hidden' } },
  'groq-20b': { label: 'Groq · openai/gpt-oss-20b', url: GROQ, model: 'openai/gpt-oss-20b', keyName: 'groq', keyRequired: true, extraBody: { reasoning_format: 'hidden' } },
  custom: { label: 'Custom OpenAI-compatible endpoint (incl. local)', url: '', model: '', keyName: 'custom', keyRequired: false },
};
const choice = (): ModelChoice => {
  const c = MODELS[$<HTMLSelectElement>('model').value]!;
  return c.keyName === 'custom' ? { ...c, url: $<HTMLInputElement>('customUrl').value.trim(), model: $<HTMLInputElement>('customModel').value.trim() } : c;
};

// ------------------------------------------------------------------ AI key (encrypted in this browser, memory-only when unlocked)
const keyStoreName = (k: string) => `blindspot.agent.aiKey.${k}`;
const unlockedKeys = new Map<string, string>();
const storedKey = (k: string): EncryptedKey | undefined => {
  try {
    const s = localStorage.getItem(keyStoreName(k));
    return s ? (JSON.parse(s) as EncryptedKey) : undefined;
  } catch {
    return undefined;
  }
};
const keyOkNow = () => {
  const c = choice();
  return !c.keyRequired || unlockedKeys.has(c.keyName);
};
function renderKey() {
  const c = choice();
  $('customRow').style.display = c.keyName === 'custom' ? '' : 'none';
  const k = c.keyName;
  if (k === 'hosted') {
    // Hosted model: no key in the browser at all (the proxy holds it).
    $('keyTitle').textContent = 'AI ready';
    $('keySub').textContent = 'You are using Proxima’s free, rate-limited AI. To use your own key, pick another model below.';
    $('keyState').innerHTML = '';
    for (const id of ['aiKeyRow', 'aiUnlockRow', 'forgetKey']) $(id).style.display = 'none';
    if ($('hint')) renderSteps();
    return;
  }
  const unlocked = unlockedKeys.has(k);
  const stored = Boolean(storedKey(k));
  $('keyTitle').textContent = unlocked ? 'AI ready' : stored ? 'Welcome back' : 'Add your AI key';
  $('keySub').textContent = unlocked
    ? 'Your AI key is unlocked for this tab (memory only).'
    : stored
      ? 'Enter your password to unlock the AI.'
      : c.keyRequired
        ? 'Paste your AI key once and choose a password. The key is encrypted and never leaves this browser.'
        : 'This endpoint may not need a key (many local servers don’t). Add one if it does.';
  $('keyState').innerHTML = unlocked ? '<span class="ok">● AI key unlocked</span>' : '';
  $('aiKeyRow').style.display = stored || unlocked ? 'none' : '';
  $('aiUnlockRow').style.display = unlocked || !stored ? 'none' : '';
  $('forgetKey').style.display = stored ? '' : 'none';
  if ($('hint')) renderSteps(); // keep the setup steps / chat box in sync after every key change
}
$('model').onchange = renderKey;
function keyMsg(text: string, cls = 'bad') {
  $('keyMsg').className = `field-msg ${cls}`;
  $('keyMsg').textContent = text;
  $('keyMsg').style.display = text ? '' : 'none';
}

// ------------------------------------------------------------------ AI key popup (comes up by itself when the AI is needed)
/** A message the owner tried to send before the AI was unlocked: sent as soon as it is. */
let sendAfterUnlock = false;
function openKeyModal() {
  keyMsg('');
  renderKey();
  $('keyModal').style.display = 'flex';
  const c = choice();
  setTimeout(() => $(unlockedKeys.has(c.keyName) ? 'keyClose' : storedKey(c.keyName) ? 'aiUnlockPass' : 'aiKey').focus(), 30);
}
function closeKeyModal() {
  $('keyModal').style.display = 'none';
  sendAfterUnlock = false;
}
/** After a successful unlock / save: close the popup and continue where the owner was. */
function afterUnlock() {
  const resend = sendAfterUnlock;
  closeKeyModal();
  renderKey();
  const box = $<HTMLTextAreaElement>('task');
  if (resend && box.value.trim()) return void run(); // still inside the click / Enter, so the wallet popup may open
  box.focus();
}
$('keyClose').onclick = closeKeyModal;
$('keyModal').addEventListener('mousedown', (e) => {
  if (e.target === $('keyModal')) closeKeyModal();
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('keyModal').style.display !== 'none') closeKeyModal();
});
$('aiPill').onclick = openKeyModal;
$('openKey').onclick = openKeyModal;
$('getStarted').onclick = (e) => {
  if (keyOkNow()) return; // already unlocked: just scroll to the steps
  e.preventDefault();
  openKeyModal();
};

/** Disables a button and shows a busy label while `fn` runs (no double clicks). */
async function busy(btn: HTMLButtonElement, label: string, fn: () => Promise<void>) {
  if (btn.disabled) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}
$('saveKey').onclick = () =>
  void busy($<HTMLButtonElement>('saveKey'), 'Saving…', async () => {
    const c = choice();
    const secret = $<HTMLInputElement>('aiKey').value.trim();
    const pass = $<HTMLInputElement>('aiPass').value;
    if (!secret) return (keyMsg(c.keyName === 'groq' ? 'Paste your Groq API key first (it starts with gsk_).' : 'Paste the API key first.'), $('aiKey').focus());
    if (pass.length < 8) return (keyMsg('Choose a password with at least 8 characters — it encrypts the key in this browser.'), $('aiPass').focus());
    try {
      localStorage.setItem(keyStoreName(c.keyName), JSON.stringify(await encryptSecret(secret, pass)));
      unlockedKeys.set(c.keyName, secret);
      $<HTMLInputElement>('aiKey').value = '';
      $<HTMLInputElement>('aiPass').value = '';
      keyMsg('');
    } catch (e) {
      return keyMsg(`Could not save the key: ${(e as Error).message}`);
    }
    afterUnlock();
  });
$('unlockKey').onclick = () =>
  void busy($<HTMLButtonElement>('unlockKey'), 'Unlocking…', async () => {
    const k = choice().keyName;
    const pass = $<HTMLInputElement>('aiUnlockPass').value;
    if (!pass) return (keyMsg('Enter the password you chose when you saved the AI key.'), $('aiUnlockPass').focus());
    try {
      unlockedKeys.set(k, await decryptSecret(storedKey(k)!, pass));
    } catch {
      keyMsg('Wrong password. Try again.');
      return void $<HTMLInputElement>('aiUnlockPass').select();
    }
    $<HTMLInputElement>('aiUnlockPass').value = '';
    keyMsg('');
    afterUnlock();
  });
$('forgetKey').onclick = (e) => {
  e.preventDefault();
  const k = choice().keyName;
  if (!confirm('Remove the saved AI key from this browser? You can paste it again any time.')) return;
  localStorage.removeItem(keyStoreName(k));
  unlockedKeys.delete(k);
  renderKey();
  keyMsg('Saved key removed. Paste your AI key and choose a new password.', 'ok');
  $('aiKey').focus();
};
const onEnter = (id: string, next: string) =>
  $(id).addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') $(next).click();
  });
$('aiKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('aiPass').focus();
});
onEnter('aiPass', 'saveKey');
onEnter('aiUnlockPass', 'unlockKey');

// ------------------------------------------------------------------ guided start
/** True once the first task was sent: from then on the chat stays on screen. */
let hasChat = false;
function renderSteps() {
  const connected = Boolean(session && !session.endedBy);
  const keyOk = keyOkNow();
  // The landing + steps show until the first message; after that the chat has the whole screen.
  $('hero').style.display = hasChat ? 'none' : '';
  $('s1').classList.toggle('done', connected);
  $('s2').classList.toggle('done', keyOk);
  $('s1done').style.display = connected ? '' : 'none';
  $('s2done').style.display = keyOk ? '' : 'none';
  $('openKey').style.display = keyOk ? 'none' : '';
  $('openKey').textContent = storedKey(choice().keyName) ? 'Unlock AI' : 'Add AI key';
  $('s2text').textContent = keyOk ? 'Your AI key is unlocked for this tab.' : storedKey(choice().keyName) ? 'Your AI key is saved encrypted. Enter your password to unlock it.' : 'Add your AI key once — it is encrypted with a password in this browser.';
  $('aiPill').innerHTML = keyOk ? '<span class="ok">●</span> AI ready' : 'Unlock AI';
  ($('run') as HTMLButtonElement).disabled = running || connecting;
  $('hint').textContent = !keyOk ? 'Press Send — you’ll unlock the AI first.' : !connected ? 'Say “connect my wallet” to start.' : 'Every payment is checked against your rules before sending.';
  $('s2').classList.toggle('now', !keyOk);
  $('s1').classList.toggle('now', keyOk && !connected);
}

// ------------------------------------------------------------------ wallet session (@blindspot/sdk)
let session: BlindspotSession | null = null;
let lastEnded: string | null = null;

function renderSession() {
  const s = session && !session.endedBy ? session : null;
  $('session').innerHTML = s
    ? `<span class="ok">●</span> ${esc(s.ensName)}`
    : lastEnded
      ? `<span class="warn">●</span> Disconnected (${esc(lastEnded)})`
      : 'Not connected';
  $('disconnect').style.display = s ? '' : 'none';
  renderSteps();
}
function connectError(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  if (/did not load in time/i.test(m)) return `the wallet did not open — make sure it is running at ${WALLET_URL}`;
  if (/blocked the wallet popup/i.test(m)) return 'your browser blocked the wallet window — allow pop-ups for this site';
  if (/closed before/i.test(m)) return 'the wallet window was closed before you approved';
  if (/rejected the connection/i.test(m)) return 'you rejected the connection in the wallet';
  return m;
}
let connecting = false;
/** Why the last connect() failed (plain words), for the agent's connect_wallet tool result. */
let lastConnectError = '';
/** One status line for the wallet connection, updated in place instead of piling up notes. */
let connLi: HTMLLIElement | null = null;
function connStatus(text: string, cls = '') {
  const reusable = connLi && connLi.isConnected && (connLi === $('log').lastElementChild || (workEl !== null && connLi.nextElementSibling === workEl));
  if (!reusable) {
    connLi = add(`sys ${cls}`, esc(text));
    return;
  }
  connLi!.className = `msg sys ${cls}`;
  connLi!.textContent = text;
  if ($('hero').style.display !== 'none') {
    $('setupMsg').className = `setup-msg sys ${cls}`;
    $('setupMsg').textContent = text;
    $('setupMsg').style.display = '';
  }
}
/** The SDK call, made by the agent's connect_wallet tool. Must start soon after a click / Enter (browsers only
 *  open pop-ups then): Send, or the "Open wallet to connect" button in the chat. */
async function doConnect(): Promise<boolean> {
  if (connecting) return false;
  connecting = true;
  let ok = false;
  // The chat already shows this attempt (the agent's connect_wallet step + the working line): no extra notes here.
  try {
    const s = await connect({ walletUrl: WALLET_URL, agentName: 'Proxima agent', features: 'popup,width=420,height=740' });
    session = s;
    lastEnded = null;
    s.onEnded((reason) => {
      lastEnded = reason;
      renderSession();
      const why: Record<string, string> = { closed: 'the wallet window was closed', locked: 'the wallet was locked', revoked: 'you disconnected it in the wallet', disconnected: 'you disconnected' };
      connStatus(`Wallet disconnected — ${why[reason] ?? reason}. Ask the agent to connect again to continue.`, 'warn');
    });
    ok = true;
    if (document.body.classList.contains('dev')) add('step', `Rules read at session start${tech(s.rules)}`);
  } catch (e) {
    lastConnectError = connectError(e);
  } finally {
    connecting = false;
  }
  renderSession();
  return ok;
}
$('disconnect').onclick = () => {
  session?.disconnect();
  renderSession();
};

// ------------------------------------------------------------------ chat log (plain words; technical details folded)
const STEP: Record<string, string> = {
  connect_wallet: 'Connecting to your Proxima wallet (SDK connect())',
  disconnect_wallet: 'Disconnecting the wallet',
  get_rules: 'Reading your rules',
  get_balances: 'Checking balances',
  resolve_name: 'Looking up a name',
  token_info: 'Checking a token',
  read_document: 'Reading the document',
  read_repo: 'Reading the repository',
  run_script: 'Running a script (sandboxed)',
  propose: 'Asking the wallet to check a payment',
  execute: 'Sending — approve it in your wallet',
};
function add(cls: string, html: string): HTMLLIElement | null {
  $('empty').style.display = 'none';
  // Status notes during setup show inside the setup steps, so the steps stay visible.
  if (cls.startsWith('sys') && $('hero').style.display !== 'none') {
    $('setupMsg').className = `setup-msg ${cls}`;
    $('setupMsg').innerHTML = html;
    $('setupMsg').style.display = '';
    if (!hasChat) return null; // before the first task, setup notes live in the setup box only (no duplicates)
  }
  if (cls === 'user') {
    hasChat = true;
    $('hero').style.display = 'none';
  }
  const li = document.createElement('li');
  li.className = `msg ${cls}`;
  li.innerHTML = html;
  $('log').appendChild(li);
  if (workEl) $('log').appendChild(workEl); // the "working" line stays last
  (workEl ?? li).scrollIntoView({ behavior: 'smooth', block: 'end' });
  return li;
}
// ------------------------------------------------------------------ "agent is working" line (what it does + elapsed time)
let workEl: HTMLLIElement | null = null;
let workTimer: ReturnType<typeof setInterval> | undefined;
let workStart = 0;
let workLabel = '';
function working(label: string | null) {
  if (label === null) {
    clearInterval(workTimer);
    workEl?.remove();
    workEl = null;
    return;
  }
  workLabel = label;
  if (!workEl) {
    workEl = document.createElement('li');
    workEl.className = 'msg working';
    $('log').appendChild(workEl);
    workStart = Date.now();
    workTimer = setInterval(paintWork, 1000);
  }
  paintWork();
  workEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
function paintWork() {
  if (workEl) workEl.innerHTML = `<span class="spin"></span>${esc(workLabel)} <span class="muted">${Math.round((Date.now() - workStart) / 1000)} s</span>`;
}
/** Technical details: only visible in presenter mode (?dev or Ctrl+Shift+D). The wallet shows the real detail. */
const tech = (body: string) => `<details class="tech"><summary>details</summary><pre>${esc(body)}</pre></details>`;
function note(text: string, cls = '') {
  add(`sys ${cls}`, esc(text));
}
const DONE: Record<string, string> = {
  connect_wallet: '✓ Connected to your Proxima wallet',
  disconnect_wallet: '✓ Disconnected the wallet',
  get_rules: '✓ Read your rules',
  get_balances: '✓ Checked balances',
  resolve_name: '✓ Looked up the name',
  token_info: '✓ Checked the token',
  read_document: '✓ Read the document',
  read_repo: '✓ Read the repository',
  run_script: '✓ Ran the script (sandboxed)',
};
/** Tool lines waiting for their result (one line per step, updated when the wallet answers). */
const pendingSteps = new Map<string, HTMLLIElement[]>();
function logReply(res: LlmResponse, step: number) {
  const m = res.meta;
  const meta = `step ${step} · model ${res.model}${m ? ` · request ${m.requestId} · ${m.usage.total} tokens · ${m.latencyMs} ms` : ''}`;
  if (!res.toolCalls.length) {
    if (res.content) add('assistant', `${esc(res.content)}${tech(`${meta}${m ? `\n\n${m.raw}` : ''}`)}`);
    return;
  }
  for (const c of res.toolCalls) {
    const li = add('step pending', `${esc(STEP[c.name] ?? c.name)}…${tech(`${meta}\n${c.name}(${c.arguments})`)}`);
    if (li) pendingSteps.set(c.name, [...(pendingSteps.get(c.name) ?? []), li]);
  }
}
/** The wallet's answer to a step, in a few words (the full story is in the wallet). */
function logTool(name: string, content: string) {
  let line = DONE[name] ?? '✓ Done';
  let cls = 'step';
  let html = false;
  try {
    const j = JSON.parse(content) as Record<string, any>;
    if (j.error) {
      line = `✕ ${String(j.error).slice(0, 140)}`;
      cls = 'step bad';
    } else if (name === 'connect_wallet' && j.ensName) {
      line = `✓ Connected to ${j.ensName}`;
      cls = 'step ok';
    } else if (name === 'propose') {
      if (j.verdict === 'ALLOW') line = '✓ Your wallet checked the payment';
      else if (j.verdict === 'BLOCK') ((line = '✕ Your wallet blocked this payment — open the wallet to see why'), (cls = 'step bad'));
      else ((line = '⚠ This payment needs your OK in the wallet'), (cls = 'step warn'));
    } else if (name === 'execute') {
      html = true;
      if (j.status === 'sent') ((line = `✓ Payment sent — <a href="https://sepolia.etherscan.io/tx/${esc(j.tx)}" target="_blank" rel="noopener">view transaction</a>`), (cls = 'step ok'));
      else if (j.status === 'simulated') line = '✓ Simulated — nothing was sent';
      else ((line = `Payment not sent${j.reason ? ` — ${esc(String(j.reason).slice(0, 120))}` : ''}`), (cls = 'step warn'));
    }
  } catch {
    /* plain text result */
  }
  const body = `${html ? line : esc(line)}${tech(content)}`;
  const li = pendingSteps.get(name)?.shift();
  if (li) {
    li.className = `msg ${cls}`;
    li.innerHTML = body;
  } else add(cls, body);
}

// ------------------------------------------------------------------ AI requests: retry network hiccups, explain failures
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** fetch for the AI endpoint: a dropped or changed connection (e.g. Wi-Fi switch, ERR_NETWORK_CHANGED) and
 *  "busy" answers (429 / 502 / 503 / 504) are retried a few times before giving up. Nothing else is retried. */
async function aiFetch(url: string, init: RequestInit): Promise<Response> {
  const delays = [1500, 3000, 6000];
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (![429, 502, 503, 504].includes(res.status) || attempt >= delays.length) return res;
      const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || delays[attempt]!, 20_000);
      working(`The AI service is busy — retrying in ${Math.round(wait / 1000)} s (${attempt + 1}/${delays.length})…`);
      await sleep(wait);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || attempt >= delays.length) throw e;
      working(`Connection to the AI service dropped — retrying (${attempt + 1}/${delays.length})…`);
      await sleep(delays[attempt]!);
    }
  }
}
/** Agent / AI errors in plain words. */
function friendlyError(m: string): string {
  if (/failed to fetch|networkerror|load failed|network ?changed/i.test(m)) return 'Could not reach the AI service — your internet connection dropped or changed. Check the connection and press Send again.';
  if (/abort/i.test(m)) return 'The AI service took too long to answer. Press Send to try again.';
  if (/HTTP 401|invalid api key/i.test(m)) return 'The AI key was rejected. Click “AI ready” at the top, remove the key and paste a valid one.';
  if (/HTTP 429/i.test(m)) return 'The AI service is rate-limiting this key. Wait a minute, then press Send again.';
  if (/HTTP 5\d\d/i.test(m)) return 'The AI service is having problems right now. Try again in a moment.';
  return m;
}

// ------------------------------------------------------------------ connection as agent tools
// The agent connects itself: asked to "connect my wallet" (or given a task that needs the wallet), the model calls
// connect_wallet, which runs the SDK's connect() (wallet popup + owner approval + session). The wallet's own tools
// are only offered to the model once a session exists.
const CONNECT_TOOL = {
  name: 'connect_wallet',
  description: "Connect to the owner's Proxima wallet with the Proxima SDK. Opens the wallet; the owner approves the connection there. Returns the agent's ENS name and the owner's current rules. Call this when the user asks to connect, or before any task that needs the wallet.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};
const DISCONNECT_TOOL = {
  name: 'disconnect_wallet',
  description: 'End the current Proxima wallet session. Only call this when the user asks to disconnect.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};
const CONNECT_PROMPT =
  "You reach the owner's wallet only through the Proxima SDK. If the wallet is not connected and the user asks to connect, or the task needs the wallet (rules, balances, documents, payments), call connect_wallet first. If the user only asked to connect, confirm the connection in one short sentence and stop.";
const connectedNow = () => Boolean(session && !session.endedBy);
type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
/** The tools offered to the model right now. */
const currentTools = (): ToolDef[] => (connectedNow() ? [...session!.tools, DISCONNECT_TOOL] : [CONNECT_TOOL]);

/** Browsers only open popups shortly after a click / key press. If the model took longer than that, the
 *  owner clicks one button in the chat and connect() runs from that click. Resolves true once connected. */
function connectViaButton(): Promise<boolean> {
  return new Promise((resolve) => {
    const li = add('sys warn', 'The agent wants to connect to your Proxima wallet. <button class="primary" data-act="open">Open wallet to connect</button> <button data-act="cancel">Not now</button>');
    if (!li) return resolve(false);
    working('Waiting for you to open the wallet…');
    // The agent's connect_wallet step line reports the outcome, so this prompt simply goes away.
    li.querySelector<HTMLButtonElement>('[data-act="open"]')!.onclick = () => {
      li.remove();
      working('Opening your Proxima wallet — unlock it and approve the connection there…');
      void doConnect().then(resolve);
    };
    li.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.onclick = () => {
      li.remove();
      lastConnectError = 'you chose not to open the wallet now';
      resolve(false);
    };
  });
}
async function connectTool(): Promise<string> {
  if (connectedNow()) return JSON.stringify({ connected: true, already: true, ensName: session!.ensName });
  lastConnectError = '';
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  const ok = activation?.isActive ? await doConnect() : await connectViaButton();
  if (!ok || !session) return JSON.stringify({ error: `Not connected — ${lastConnectError || 'unknown reason'}` });
  renderSteps();
  return JSON.stringify({ connected: true, ensName: session.ensName, rules: session.rulesMessage() });
}
/** Runs the model's tool calls: connection tools here, everything else inside the wallet over the session. */
async function agentTool(name: string, args: Record<string, unknown>, tools: ToolDef[]): Promise<string> {
  let out: string;
  if (name === 'connect_wallet') out = await connectTool();
  else if (name === 'disconnect_wallet') {
    if (connectedNow()) session!.disconnect();
    renderSession();
    out = JSON.stringify({ disconnected: true });
  } else if (!connectedNow()) out = JSON.stringify({ error: 'The wallet is not connected. Call connect_wallet first.' });
  else out = await session!.callTool(name, args);
  // From the model's next step on, offer the tools that match the connection state (the loop re-reads this array).
  tools.splice(0, tools.length, ...currentTools());
  return out;
}

// ------------------------------------------------------------------ run
let running = false;
async function run() {
  if (running || connecting) return;
  const typed = $<HTMLTextAreaElement>('task').value.trim();
  if (!typed) return $('task').focus();
  const c = choice();
  const apiKey = unlockedKeys.get(c.keyName);
  if ((c.keyRequired && !apiKey) || !/^https?:\/\//.test(c.url) || !c.model) {
    // The AI isn't ready: the key popup comes up, and this message is sent as soon as it is unlocked.
    openKeyModal();
    sendAfterUnlock = true;
    if (!/^https?:\/\//.test(c.url) || !c.model) keyMsg('Set the AI endpoint URL and model name (under “AI model”).');
    return;
  }
  const llm = openAiCompatibleLlm({ url: c.url, model: c.model, fetch: (u, i) => aiFetch(u, i), timeoutMs: 90_000, ...(apiKey ? { apiKey } : {}), ...(c.extraBody ? { extraBody: c.extraBody } : {}) });
  running = true;
  ($('run') as HTMLButtonElement).disabled = true;
  $('run').textContent = 'Working…';
  add('user', esc(typed));
  $<HTMLTextAreaElement>('task').value = ''; // the message is in the chat now: the box is clear for the next one
  working('The AI is thinking…');
  try {
    // The agent connects itself (connect_wallet → SDK connect()); the wallet's tools appear once it is connected.
    const tools = currentTools();
    const r = await runAgentWith((name, args) => agentTool(name, args, tools), llm, typed, {
      tools,
      systemPrompt: `${SYSTEM_PROMPT} ${CONNECT_PROMPT} ${RULES_FIRST}`,
      preamble: connectedNow() ? [session!.rulesMessage()] : [],
      hooks: {
        onModelReply: (res, step) => {
          logReply(res, step);
          const t = res.toolCalls[0]?.name;
          if (t === 'connect_wallet' && !connectedNow()) working('Opening your Proxima wallet — approve the connection there…');
          else if (t) working(t === 'execute' ? 'Waiting for your approval in the wallet window…' : t === 'propose' ? 'The wallet is simulating and checking the payment…' : `${STEP[t] ?? t} (privately, through the wallet)…`);
        },
        onToolResult: (name, content) => {
          logTool(name, content);
          working('The AI is thinking about the next step…');
        },
      },
    });
    if (r.stoppedBy !== 'final') note(r.stoppedBy === 'stopped' ? `Stopped: ${r.error}` : r.stoppedBy === 'stepLimit' ? 'Stopped: too many steps.' : friendlyError(r.error ?? 'unknown error'), r.stoppedBy === 'stopped' ? 'warn' : 'bad');
  } catch (e) {
    note(friendlyError((e as Error).message), 'bad');
  } finally {
    working(null);
    running = false;
    renderSteps();
    $('run').textContent = 'Send';
  }
}
$('run').onclick = () => void run();

for (const [id, m] of Object.entries(MODELS)) {
  const o = document.createElement('option');
  o.value = id;
  o.textContent = m.label;
  $('model').appendChild(o);
}
document.querySelectorAll<HTMLButtonElement>('[data-task]').forEach((b) => (b.onclick = () => ($<HTMLTextAreaElement>('task').value = b.dataset.task ?? '')));
$<HTMLTextAreaElement>('task').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void run();
  }
});
const toggleDev = (on?: boolean) => {
  const p = $('devPanel');
  p.style.display = (on ?? p.style.display === 'none') ? '' : 'none';
  document.body.classList.toggle('dev', p.style.display === '');
};
if (new URLSearchParams(location.search).has('dev')) toggleDev(true);
addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    toggleDev();
  }
});
$<HTMLSelectElement>('model').value = DEFAULT_MODEL; // default every load (browsers restore old form values)
addEventListener('unhandledrejection', (e) => note(`Something went wrong: ${(e.reason as Error)?.message ?? e.reason}`, 'bad'));
addEventListener('error', (e) => note(`Something went wrong: ${e.message}`, 'bad'));
renderKey();
renderSession();
renderSteps();
// Returning owner with a saved (encrypted) AI key: the password prompt comes up right away.
if (storedKey(choice().keyName) && !keyOkNow()) openKeyModal();
