// Outside agent app (Step 3a). An ordinary tool-calling LLM agent that holds NO wallet keys and NO funds. It
// connects to the Blindspot wallet with @blindspot/sdk (popup + owner approval + session) and can only ask the
// wallet to run tools.
import { connect, type BlindspotSession } from '@blindspot/sdk';
import { RULES_FIRST, SYSTEM_PROMPT, decryptSecret, encryptSecret, openAiCompatibleLlm, runAgentWith, scriptedLlm, type EncryptedKey, type LlmAdapter, type LlmResponse, type ScriptStep } from '@blindspot/core';
import cfg from '../../../config/sepolia.json';

declare const __AGENT__: { walletUrl: string };
const WALLET_URL = __AGENT__.walletUrl;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ------------------------------------------------------------------ models
type ModelChoice = { label: string; url: string; model: string; keyName: string; keyRequired: boolean; extraBody?: Record<string, unknown> };
const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS: Record<string, ModelChoice> = {
  'groq-120b': { label: 'Groq · openai/gpt-oss-120b (default)', url: GROQ, model: 'openai/gpt-oss-120b', keyName: 'groq', keyRequired: true, extraBody: { reasoning_format: 'hidden' } },
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
function renderKey() {
  const c = choice();
  $('customRow').style.display = c.keyName === 'custom' ? '' : 'none';
  const k = c.keyName;
  $('keyState').innerHTML = unlockedKeys.has(k) ? `<span class="ok">AI key unlocked</span> (memory only)` : storedKey(k) ? 'AI key stored encrypted — enter your passphrase and unlock' : c.keyRequired ? 'No AI key yet — paste it once (encrypted with your passphrase)' : 'Optional for this endpoint (many local servers need no key)';
  $('aiKeyRow').style.display = storedKey(k) ? 'none' : '';
  $('aiUnlockRow').style.display = unlockedKeys.has(k) || !storedKey(k) ? 'none' : '';
  if (typeof renderSteps === 'function' && document.getElementById('steps')) renderSteps();
}
$('model').onchange = renderKey;
$('saveKey').onclick = async () => {
  const k = choice().keyName;
  try {
    const secret = $<HTMLInputElement>('aiKey').value.trim();
    localStorage.setItem(keyStoreName(k), JSON.stringify(await encryptSecret(secret, $<HTMLInputElement>('aiPass').value)));
    unlockedKeys.set(k, secret);
    $<HTMLInputElement>('aiKey').value = '';
    $<HTMLInputElement>('aiPass').value = '';
    note('AI key stored ENCRYPTED in this browser (PBKDF2-SHA256 600k + AES-GCM) and unlocked for this tab.', 'ok');
  } catch (e) {
    note((e as Error).message, 'bad');
  }
  renderKey();
};
$('unlockKey').onclick = async () => {
  const k = choice().keyName;
  try {
    unlockedKeys.set(k, await decryptSecret(storedKey(k)!, $<HTMLInputElement>('aiUnlockPass').value));
    $<HTMLInputElement>('aiUnlockPass').value = '';
  } catch (e) {
    note((e as Error).message, 'bad');
  }
  renderKey();
};
$('forgetKey').onclick = () => {
  const k = choice().keyName;
  localStorage.removeItem(keyStoreName(k));
  unlockedKeys.delete(k);
  renderKey();
};

// ------------------------------------------------------------------ guided start
let showSetup = false;
function renderSteps() {
  const connected = Boolean(session && !session.endedBy);
  const c = choice();
  const keyOk = !c.keyRequired || unlockedKeys.has(c.keyName);
  const ready = connected && keyOk;
  $('hero').style.display = ready && !showSetup ? 'none' : '';
  $('s1').classList.toggle('done', connected);
  $('s2').classList.toggle('done', keyOk);
  $('connect2').style.display = connected ? 'none' : '';
  $('s1done').style.display = connected ? '' : 'none';
  $('aiPill').style.display = keyOk ? '' : 'none';
  ($('run') as HTMLButtonElement).disabled = !ready || running;
  (document.querySelector('footer') as HTMLElement).style.display = ready && !showSetup ? '' : 'none';
  $('hint').textContent = !connected ? 'Step 1: connect your wallet.' : !keyOk ? 'Step 2: unlock the AI.' : 'Your wallet checks every payment against your rules before anything is sent.';
}
$('connect2').onclick = () => $('connect').click();
$('aiPill').onclick = () => {
  showSetup = !showSetup;
  renderSteps();
};

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
  $('connect').style.display = s ? 'none' : '';
  renderSteps();
}
$('connect').onclick = async () => {
  note('Opening the Blindspot wallet… Unlock it if needed, then approve the connection request there.');
  try {
    const s = await connect({ walletUrl: WALLET_URL, agentName: 'Blindspot example agent' });
    session = s;
    lastEnded = null;
    s.onEnded((reason) => {
      lastEnded = reason;
      renderSession();
      note(`The wallet ended the session (${reason}). The agent can no longer act.`, 'warn');
    });
    note('Connected. The wallet approved the session.', 'ok');
    logTool('get_rules (read by the SDK at session start — given to the model as its first message)', s.rules);
  } catch (e) {
    note(`Not connected: ${(e as Error).message}`, 'bad');
  }
  renderSession();
};
$('disconnect').onclick = () => {
  session?.disconnect();
  renderSession();
};

// ------------------------------------------------------------------ chat log (plain words; technical details folded)
const STEP: Record<string, string> = {
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
function add(cls: string, html: string) {
  $('empty').style.display = 'none';
  $('hero').style.display = 'none';
  const li = document.createElement('li');
  li.className = `msg ${cls}`;
  li.innerHTML = html;
  $('log').appendChild(li);
  li.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
const tech = (body: string) => `<details class="tech"><summary>details</summary><pre>${esc(body)}</pre></details>`;
function note(text: string, cls = '') {
  add(`sys ${cls}`, esc(text));
}
function logReply(res: LlmResponse, step: number, scripted: boolean) {
  const m = res.meta;
  const meta = `step ${step} · model ${res.model}${m ? ` · request ${m.requestId} · ${m.usage.total} tokens · ${m.latencyMs} ms` : ''}`;
  if (!res.toolCalls.length) {
    if (res.content) add('assistant', `${scripted ? '<span class="badge">SCRIPTED</span> ' : ''}${esc(res.content)}${tech(`${meta}${m ? `\n\n${m.raw}` : ''}`)}`);
    return;
  }
  for (const c of res.toolCalls)
    add('step', `${scripted ? '<span class="badge">SCRIPTED</span> ' : ''}<b>${esc(STEP[c.name] ?? c.name)}</b>…${tech(`${meta}\n${c.name}(${c.arguments})${m ? `\n\nraw reply:\n${m.raw}` : ''}`)}`);
}
/** The wallet's answer to a tool call, summarised. */
function logTool(name: string, content: string) {
  let line = '✓ Done';
  let cls = 'step';
  try {
    const j = JSON.parse(content) as Record<string, any>;
    if (j.error) {
      line = `✕ ${j.error}`;
    } else if (name === 'propose') {
      line = j.verdict === 'ALLOW' ? '✓ Allowed by your rules' : j.verdict === 'BLOCK' ? `✕ Blocked: ${(j.reasons ?? [])[0] ?? ''}` : `⚠ Needs your approval: ${(j.reasons ?? [])[0] ?? ''}`;
    } else if (name === 'execute') {
      line = j.status === 'sent' ? `✓ Sent — <a href="https://sepolia.etherscan.io/tx/${esc(j.tx)}" target="_blank" rel="noopener">view transaction</a>` : j.status === 'simulated' ? '✓ Simulated — nothing was sent' : `Not sent: ${esc(j.reason ?? '')}`;
      if (j.status === 'sent') return add('step ok', `${line}${tech(content)}`);
    }
  } catch {
    if (name.startsWith('get_rules')) line = '✓ Wallet connected · your rules are loaded';
  }
  add(cls, `${name === 'execute' ? line : esc(line)}${tech(content)}`);
}

// ------------------------------------------------------------------ run
let running = false;
async function run(scripted: boolean) {
  if (running) return;
  const s = session && !session.endedBy ? session : null;
  if (!s) return note('Connect the wallet first.', 'bad');
  let llm: LlmAdapter;
  if (scripted) {
    const usdc = cfg.ens.MockUSDC;
    const vendor1 = cfg.payees.vendor1;
    const script: ScriptStep[] = [
      { tool: 'get_rules' },
      { tool: 'read_document', args: { url: 'invoice-0101' } },
      { tool: 'resolve_name', args: { name: 'vendor1.blindspot-demo.eth' } },
      { tool: 'propose', args: { actions: [{ type: 'transfer', token: usdc, to: vendor1, amount: '12' }], declared_effects: [{ kind: 'out', token: usdc, amount: '12', counterparty: vendor1 }], reason: 'Pay invoice-0101 (12 MockUSDC to vendor1)' } },
      { tool: 'execute', args: { proposal_id: '$lastProposalId' } },
      { final: 'Done with invoice-0101.' },
    ];
    llm = scriptedLlm(script);
  } else {
    const c = choice();
    if (!/^https?:\/\//.test(c.url) || !c.model) return note('Set the endpoint URL and model name.', 'bad');
    const apiKey = unlockedKeys.get(c.keyName);
    if (c.keyRequired && !apiKey) return note('Unlock (or add) the AI key first.', 'bad');
    llm = openAiCompatibleLlm({ url: c.url, model: c.model, fetch: (u, i) => fetch(u, i), timeoutMs: 90_000, ...(apiKey ? { apiKey } : {}), ...(c.extraBody ? { extraBody: c.extraBody } : {}) });
  }
  running = true;
  ($('run') as HTMLButtonElement).disabled = true;
  $('run').textContent = 'Working…';
  ($('runScripted') as HTMLButtonElement).disabled = true;
  const task = $<HTMLTextAreaElement>('task').value.trim();
  add('user', esc(task));
  if (scripted) note('Demo mode: recorded steps replace the AI model; your wallet still checks everything for real.', 'warn');
  try {
    const r = await runAgentWith((name, args) => s.callTool(name, args), llm, task, {
      tools: s.tools,
      systemPrompt: `${SYSTEM_PROMPT} ${RULES_FIRST}`,
      preamble: [s.rulesMessage()],
      hooks: { onModelReply: (res, step) => logReply(res, step, scripted), onToolResult: logTool },
    });
    if (r.stoppedBy !== 'final') note(r.stoppedBy === 'stopped' ? `Stopped: ${r.error}` : r.stoppedBy === 'stepLimit' ? 'Stopped: too many steps.' : `Something went wrong: ${r.error}`, r.stoppedBy === 'stopped' ? 'warn' : 'bad');
  } finally {
    running = false;
    renderSteps();
    $('run').textContent = 'Send';
    ($('runScripted') as HTMLButtonElement).disabled = false;
  }
}
$('run').onclick = () => void run(false);
$('runScripted').onclick = () => void run(true);

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
    void run(false);
  }
});
const toggleDev = (on?: boolean) => {
  const p = $('devPanel');
  p.style.display = (on ?? p.style.display === 'none') ? '' : 'none';
};
if (new URLSearchParams(location.search).has('dev')) toggleDev(true);
addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    toggleDev();
  }
});
$<HTMLSelectElement>('model').value = 'groq-120b'; // default every load (browsers restore old form values)
renderKey();
renderSession();
renderSteps();
