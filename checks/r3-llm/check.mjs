// R3 check (SPEC §18): one tool-calling request through the proxy returns a well-formed tool call.
// Uses Blindspot's real agent tool shapes (SPEC §9). Prints no secrets (the proxy holds the key).
// Usage: node proxy.mjs (in one terminal), then: node check.mjs [model]
const PROXY = 'http://127.0.0.1:8787/v1/chat/completions';
const model = process.argv[2] ?? 'openai/gpt-oss-120b';

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_rules',
      description: "Read the owner's rules for this agent from its ENS name (allowed recipients, caps, functions). Call this before proposing any transaction.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose',
      description: 'Propose a transaction from the wallet. Declare exactly who receives what. Blindspot checks it and returns ALLOW, BLOCK or ASK_OWNER.',
      parameters: {
        type: 'object',
        properties: {
          tx: {
            type: 'object',
            properties: { to: { type: 'string' }, value: { type: 'string', description: 'wei, decimal string' }, data: { type: 'string', description: '0x calldata' } },
            required: ['to', 'value', 'data'],
          },
          declared_effects: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['out', 'in', 'approve', 'operator'] },
                token: { type: 'string' },
                amount: { type: 'string' },
                counterparty: { type: 'string' },
              },
              required: ['kind', 'token', 'amount', 'counterparty'],
            },
          },
          reason: { type: 'string' },
        },
        required: ['tx', 'declared_effects', 'reason'],
      },
    },
  },
];

const messages = [
  { role: 'system', content: 'You manage a crypto wallet for its owner. Always call get_rules before proposing any transaction. Every transaction goes through propose.' },
  { role: 'user', content: 'Pay this week\'s invoice from vendor1.blindspot-demo.eth: 1 MockUSDC.' },
];

const t0 = Date.now();
const res = await fetch(PROXY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }) });
const ms = Date.now() - t0;
const json = await res.json();
const choice = json.choices?.[0];
const calls = choice?.message?.tool_calls ?? [];
console.log(`HTTP ${res.status} in ${ms} ms, model ${json.model ?? model}, finish_reason ${choice?.finish_reason}`);
if (json.error) console.log('error:', JSON.stringify(json.error).slice(0, 500));

let ok = res.status === 200 && choice?.finish_reason === 'tool_calls' && calls.length > 0;
for (const c of calls) {
  let args;
  try {
    args = JSON.parse(c.function.arguments || '{}');
  } catch {
    ok = false;
  }
  const known = tools.some((t) => t.function.name === c.function?.name);
  if (!known || c.type !== 'function' || !c.id) ok = false;
  console.log(`tool_call id=${c.id} type=${c.type} name=${c.function?.name} args=${JSON.stringify(args)} ${known ? '' : '(UNKNOWN TOOL)'}`);
}
console.log(`usage: ${JSON.stringify(json.usage ?? {})}`);
console.log(`R3 ${model}: ${ok ? 'PASS (a well-formed tool call was returned)' : 'NOT PASSED'}`);
process.exit(ok ? 0 : 1);
