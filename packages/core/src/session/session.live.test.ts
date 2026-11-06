// 3a on live Sepolia: agent client → (postMessage-like bridge) → wallet host → runTool in the wallet (real ENS
// rules, simulation, checks, trace, module-only signer). The approval hook answers NO, so nothing is sent.
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { withTransportRetry } from '../adapters/rpc.js';
import { staticSources } from '../adapters/static-sources.js';
import type { ApprovalRequest, RunContext } from '../agent/context.js';
import { RULES_FIRST, SYSTEM_PROMPT, runAgentWith } from '../agent/loop.js';
import { openAiCompatibleLlm } from '../adapters/llm-http.js';
import { scriptedLlm } from '../agent/scripted.js';
import { runTool } from '../agent/tools.js';
import { clientFor } from '../chain.js';
import { deploymentFromConfig } from '../deployment.js';
import { moduleOnlySigner } from '../keys/signer.js';
import { MemoryStorage } from '../storage/memory.js';
import { config, directRpc, env, hasRpc } from '../test/live.js';
import { Trace } from '../trace/trace.js';
import { SessionRevokedError, WalletClient, rulesMessage } from '@blindspot/sdk';
import { WalletHost } from './wallet-host.js';

const AGENT = 'http://127.0.0.1:5180';
const WALLET = 'http://127.0.0.1:5181';
const canRun = hasRpc && Boolean(env.AGENT_PRIVATE_KEY);

describe.skipIf(!canRun)('3a session on live Sepolia (nothing sent)', { timeout: 180_000 }, () => {
  const rpc = withTransportRetry(directRpc());
  const d = deploymentFromConfig(config);
  const usdc = getAddress(config.ens.MockUSDC);
  const vendor1 = getAddress(config.payees.vendor1);

  function wallet(approvals: ApprovalRequest[]) {
    const contexts = new Map<string, RunContext>(); // one RunContext (trace, proposals) per session
    let client!: WalletClient;
    const host = new WalletHost({
      ensName: 'demo.blindspot-demo.eth',
      agent: getAddress(config.agents.demo.address),
      isLocked: () => false,
      approveConnect: async () => true,
      send: (origin, msg) => origin === AGENT && setTimeout(() => client.handle(WALLET, structuredClone(msg)), 0),
      exec: (s, tool, args) => {
        let ctx = contexts.get(s.id);
        if (!ctx) {
          ctx = {
            rpc,
            client: clientFor(rpc),
            deployment: d,
            storage: new MemoryStorage(),
            label: 'demo',
            agent: getAddress(config.agents.demo.address),
            trace: new Trace(`s${s.id.slice(0, 8)}`),
            readSource: staticSources({ 'invoice-0101': { kind: 'document', content: 'INVOICE #0101 - vendor1.blindspot-demo.eth\nAmount due: 12 MockUSDC\nPay to: vendor1.blindspot-demo.eth' } }),
            signer: moduleOnlySigner(privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex), d.module, d.chainId),
            approve: async (req) => {
              approvals.push(req);
              return false; // never broadcast in tests
            },
            proposals: new Map(),
            log: [],
            knownNames: [config.payeeNames.vendor1, config.payeeNames.vendor2],
          };
          contexts.set(s.id, ctx);
        }
        return runTool(ctx, tool, args);
      },
    });
    client = new WalletClient({ walletOrigin: WALLET, post: (m) => setTimeout(() => void host.handle(AGENT, structuredClone(m)), 0) });
    return { host, client, contexts };
  }
  const pay12 = [
    { tool: 'get_rules' },
    { tool: 'read_document', args: { url: 'invoice-0101' } },
    { tool: 'resolve_name', args: { name: 'vendor1.blindspot-demo.eth' } },
    { tool: 'propose', args: { actions: [{ type: 'transfer', token: usdc, to: vendor1, amount: '12' }], declared_effects: [{ kind: 'out', token: usdc, amount: '12', counterparty: vendor1 }], reason: 'pay invoice-0101' } },
    { tool: 'execute', args: { proposal_id: '$lastProposalId' } },
  ];

  it('the outside agent pays 12 MockUSDC through the wallet: get_rules first, ALLOW, the owner is asked for the exact tx (declined here)', async () => {
    const approvals: ApprovalRequest[] = [];
    const w = wallet(approvals);
    const info = await w.client.connect('Blindspot agent');
    const results: string[] = [];
    const r = await runAgentWith(w.client.executor, scriptedLlm(pay12), 'Pay invoice-0101.', { tools: info.tools, hooks: { onToolResult: (n, c) => results.push(`${n}: ${c.slice(0, 120)}`) } });
    console.log(`[3a live]\n  ${results.join('\n  ')}`);
    const ctx = w.contexts.get(info.sessionId)!;
    expect(r.stoppedBy).toBe('final');
    expect(ctx.trace.events[0]!.tool).toBe('get_rules'); // traced in the wallet, first
    expect(ctx.trace.events.find((e) => e.tool === 'read_document')!.trust).toBe('untrusted');
    expect([...ctx.proposals.values()].map((p) => p.decision.verdict)).toEqual(['ALLOW']);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.to).toBe(d.module);
    expect(results.at(-1)).toMatch(/refused.*did not approve/);
  });

  it('revoking the session in the wallet stops the agent before its next call', async () => {
    const approvals: ApprovalRequest[] = [];
    const w = wallet(approvals);
    const info = await w.client.connect('Blindspot agent');
    const r = await runAgentWith(w.client.executor, scriptedLlm(pay12), 'Pay invoice-0101.', {
      tools: info.tools,
      hooks: { onToolResult: (n) => n === 'resolve_name' && w.host.end(info.sessionId, 'revoked') },
    });
    expect(r.stoppedBy).toBe('stopped');
    expect(r.error).toMatch(/revoked/);
    const ctx = w.contexts.get(info.sessionId)!;
    expect(ctx.trace.events.map((e) => e.tool)).toEqual(['get_rules', 'read_document', 'resolve_name']); // propose never ran
    expect(ctx.proposals.size).toBe(0);
    expect(approvals).toEqual([]);
  });

  it.skipIf(!env.LLM_API_KEY)('(d) rules read at session start are the first message to the model; real gpt-oss-120b run; nothing sent', async () => {
    const approvals: ApprovalRequest[] = [];
    const w = wallet(approvals);
    const info = await w.client.connect('Blindspot example agent');
    const rules = await w.client.executor('get_rules', {}); // exactly what connect() in the SDK does
    const llm = openAiCompatibleLlm({ url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b', fetch: (u, i) => fetch(u, i), apiKey: env.LLM_API_KEY!, extraBody: { reasoning_format: 'hidden' }, timeoutMs: 90_000 });
    const calls: string[] = [];
    const r = await runAgentWith((n, a) => w.client.executor(n, a), llm, 'Pay this week\x27s invoice from vendor1 (document "invoice-0101").', {
      tools: info.tools,
      systemPrompt: `${SYSTEM_PROMPT} ${RULES_FIRST}`,
      preamble: [rulesMessage(info.ensName, rules)],
      hooks: { onToolCall: (n) => calls.push(n), onModelReply: (res, step) => console.log(`[3a rules-first] step ${step} ${res.model} ${res.meta?.requestId} ${res.toolCalls.map((c) => c.name).join(",") || "final"}`) },
    });
    console.log(`[3a rules-first] stoppedBy=${r.stoppedBy} calls=${calls.join(" > ")}`);
    console.log(`[3a rules-first] final: ${(r.final ?? r.error ?? '').slice(0, 600)}`);
    expect(r.stoppedBy).not.toBe('error');
    const ctx = w.contexts.get(info.sessionId)!;
    expect(ctx.trace.events[0]!.tool).toBe('get_rules'); // the wallet read the rules first, before the model ran
    expect(rules).toMatch(/Allowed recipients/);
    // Model behaviour varies run to run (temperature 0 is not deterministic on the provider): logged, not asserted.
    console.log(`[3a rules-first] decisions: ${[...ctx.proposals.values()].map((p) => p.decision.verdict).join(',') || 'none'}`);
    expect([...ctx.proposals.values()].every((p) => p.executedTx === undefined)).toBe(true);
  });
});
