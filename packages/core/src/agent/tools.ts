import { encodeFunctionData, formatUnits, getAddress, isAddress, parseAbi, parseUnits, type Address } from 'viem';
import { ASK_OWNER_DECIMALS, ETH, type Effect, type Proposal, type ProposalCall } from '@blindspot/shared';
import type { LlmToolDef } from '../adapters/types.js';
import { evaluateProposal } from '../check/evaluate.js';
import { readTokenMetadata } from '../chain-reads.js';
import { readPolicy, resolveName } from '../ens/reader.js';
import type { RunContext } from './context.js';
import { executeProposal } from './execute.js';

const str = { type: 'string' } as const;

/** SPEC §9 tools (+ token_info). JSON Schemas follow the OpenAI-compatible tool format. */
export const TOOL_DEFS: LlmToolDef[] = [
  { name: 'read_page', description: 'Read the text of a web page (the open page if no url is given).', parameters: { type: 'object', properties: { url: str }, required: [] } },
  { name: 'read_document', description: 'Read a document (invoice, email, PDF text) by url.', parameters: { type: 'object', properties: { url: str }, required: ['url'] } },
  { name: 'read_repo', description: 'Read the files of a code repository by url.', parameters: { type: 'object', properties: { url: str }, required: ['url'] } },
  { name: 'run_script', description: 'Run a script from a repository in a sandbox (no keys, no network except propose). Returns its output.', parameters: { type: 'object', properties: { path: str }, required: ['path'] } },
  { name: 'token_info', description: 'Read a token\'s name, symbol and decimals from the chain.', parameters: { type: 'object', properties: { token: { type: 'string', description: 'token contract address' } }, required: ['token'] } },
  { name: 'get_rules', description: "Read the owner's rules for this agent from its ENS name. Call this before proposing any transaction.", parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'get_balances', description: "Read the wallet's (Safe's) balances.", parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'resolve_name', description: 'Resolve an ENS name (e.g. vendor1.blindspot-demo.eth) to an address.', parameters: { type: 'object', properties: { name: str }, required: ['name'] } },
  {
    name: 'propose',
    description:
      'Propose a transaction from the wallet. Blindspot simulates it, checks it against the owner\'s rules and returns ALLOW, BLOCK or ASK_OWNER with reasons. Declare exactly who receives what.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'What to do, in order (1 to 8 actions).',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['transfer'] },
              token: { type: 'string', description: 'token contract address, or "ETH"' },
              to: { type: 'string', description: 'recipient address (resolve ENS names with resolve_name first)' },
              amount: { type: 'string', description: 'amount in token units, e.g. "12" or "12.5"' },
            },
            required: ['type', 'token', 'to', 'amount'],
          },
        },
        declared_effects: {
          type: 'array',
          description: 'What will happen to the wallet, e.g. [{kind:"out", token, amount:"12", counterparty}]',
          items: {
            type: 'object',
            properties: { kind: { type: 'string', enum: ['out', 'in', 'approve', 'operator'] }, token: str, amount: str, counterparty: str },
            required: ['kind', 'token', 'amount', 'counterparty'],
          },
        },
        reason: str,
      },
      required: ['actions', 'declared_effects', 'reason'],
    },
  },
  { name: 'execute', description: 'Execute a proposal that Blindspot ALLOWED. Pass the proposal_id returned by propose.', parameters: { type: 'object', properties: { proposal_id: str }, required: ['proposal_id'] } },
];

export class ToolInputError extends Error {
  override name = 'ToolInputError';
}

const tokenAddress = (s: string): Address => {
  if (s.trim().toUpperCase() === 'ETH') return ETH;
  if (!isAddress(s, { strict: false })) throw new ToolInputError(`"${s}" is not a token address (or "ETH")`);
  return getAddress(s);
};
const addressArg = (s: string, what: string): Address => {
  if (!isAddress(s, { strict: false })) throw new ToolInputError(`${what} "${s}" is not an address; use resolve_name for ENS names`);
  return getAddress(s);
};
const transferAbi = parseAbi(['function transfer(address,uint256)']);

async function decimalsOf(ctx: RunContext, token: Address): Promise<number> {
  return token === ETH ? 18 : (await readTokenMetadata(ctx.client, token)).decimals;
}

/**
 * Owner decision A2: recipients are shown with their ENS names, but a name is shown ONLY if the wallet forward-resolves
 * it (through the run's rpc = Anon-RPC) to exactly that address. Names come from the wallet's owner-configured list.
 */
export async function verifiedNames(ctx: RunContext, addresses: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const wanted = new Set(addresses.map((a) => a.toLowerCase()));
  for (const name of ctx.knownNames ?? []) {
    const addr = await resolveName(ctx.client, ctx.deployment, name).catch(() => null);
    if (addr && wanted.has(addr.toLowerCase()) && !out[addr.toLowerCase()]) out[addr.toLowerCase()] = name;
  }
  return out;
}

let proposalCounter = 0;

/** Runs one tool. Every READ tool records its exact output in the trace BEFORE returning it. */
export async function runTool(ctx: RunContext, name: string, args: Record<string, unknown>): Promise<string> {
  const d = ctx.deployment;
  switch (name) {
    case 'read_page':
    case 'read_document': {
      if (!ctx.readSource) throw new ToolInputError(`${name} is not available in this run`);
      const kind = name === 'read_page' ? 'page' : 'document';
      const r = await ctx.readSource.read(kind, args.url as string | undefined);
      ctx.trace.record(name, kind, { url: r.url }, r.content);
      return r.content;
    }
    case 'read_repo': {
      if (!ctx.readSource) throw new ToolInputError('read_repo is not available in this run');
      const r = await ctx.readSource.read('repo', String(args.url));
      const files = r.files ?? [{ path: '(repo)', content: r.content }];
      ctx.trace.recordFiles('read_repo', 'repo', { url: r.url }, files);
      return files.map((f) => `=== ${f.path} ===\n${f.content}`).join('\n\n');
    }
    case 'run_script': {
      if (!ctx.runScript || !ctx.readSource) throw new ToolInputError('run_script is not available in this run');
      const path = String(args.path);
      const src = await ctx.readSource.read('repo', path);
      const out = await ctx.runScript.run(path, src.content, { propose: async (input) => runTool(ctx, 'propose', input as Record<string, unknown>) });
      ctx.trace.record('run_script', 'script', { path }, out.output);
      return out.output;
    }
    case 'token_info': {
      const token = tokenAddress(String(args.token));
      const m = await readTokenMetadata(ctx.client, token);
      const text = `name: ${m.name}\nsymbol: ${m.symbol}\ndecimals: ${m.decimals}`;
      ctx.trace.record('token_info', 'token', { token }, text);
      return text;
    }
    case 'get_rules': {
      const { policy: p, name: ensName } = await readPolicy(ctx.client, d, ctx.label);
      const named = await verifiedNames(ctx, p.payees);
      const recipients = p.payees.map((a) => (named[a.toLowerCase()] ? `${named[a.toLowerCase()]} (${a})` : a));
      const lines = [`Rules for ${ensName} (from its ENS record "blindspot.policy", version ${p.version}):`, `Allowed recipients: ${recipients.join(', ')}`];
      for (const [i, t] of p.tokens.entries()) {
        const meta = t === ETH ? { symbol: 'ETH', decimals: 18 } : await readTokenMetadata(ctx.client, t);
        lines.push(`${meta.symbol} (${t}): at most ${formatUnits(p.maxOut[i]!, meta.decimals)} per transaction, ${formatUnits(p.dailyCap[i]!, meta.decimals)} per day`);
      }
      lines.push(`Owner approval needed above ${formatUnits(p.askOwnerAbove, ASK_OWNER_DECIMALS)} USD in stablecoins; at most ${p.rateLimitPerHour} transactions per hour.`);
      const text = lines.join('\n');
      ctx.trace.record('get_rules', 'ens', { name: ensName }, text);
      return text;
    }
    case 'get_balances': {
      const { policy: p } = await readPolicy(ctx.client, d, ctx.label);
      const lines = [`Wallet (Safe) ${d.safeAddress}:`];
      for (const t of p.tokens) {
        if (t === ETH) {
          lines.push(`ETH: ${formatUnits(await ctx.client.getBalance({ address: d.safeAddress }), 18)}`);
          continue;
        }
        const meta = await readTokenMetadata(ctx.client, t);
        const bal = await ctx.client.readContract({ address: t, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [d.safeAddress] });
        lines.push(`${meta.symbol} (${t}): ${formatUnits(bal, meta.decimals)}`);
      }
      const text = lines.join('\n');
      ctx.trace.record('get_balances', 'chain', {}, text);
      return text;
    }
    case 'resolve_name': {
      const ensName = String(args.name);
      const a = await resolveName(ctx.client, d, ensName);
      const text = a ? `${ensName} -> ${a}` : `${ensName} does not resolve`;
      ctx.trace.record('resolve_name', 'ens', { name: ensName }, text);
      return text;
    }
    case 'propose': {
      const actions = (args.actions ?? []) as { type: string; token: string; to: string; amount: string }[];
      const declaredIn = (args.declared_effects ?? []) as { kind: Effect['kind']; token: string; amount: string; counterparty: string }[];
      const calls: ProposalCall[] = [];
      for (const a of actions) {
        if (a.type !== 'transfer') throw new ToolInputError(`unsupported action type "${a.type}"`);
        const token = tokenAddress(a.token);
        const to = addressArg(a.to, 'recipient');
        const amount = parseUnits(String(a.amount), await decimalsOf(ctx, token));
        calls.push(token === ETH ? { to, value: amount, data: '0x' } : { to: token, value: 0n, data: encodeFunctionData({ abi: transferAbi, functionName: 'transfer', args: [to, amount] }) });
      }
      const declaredEffects: Proposal['declaredEffects'] = [];
      for (const e of declaredIn) {
        const token = tokenAddress(e.token);
        declaredEffects.push({ kind: e.kind, token, amount: parseUnits(String(e.amount), await decimalsOf(ctx, token)), counterparty: addressArg(e.counterparty, 'counterparty') });
      }
      const id = `${ctx.trace.runId}-p${++proposalCounter}`;
      const proposal: Proposal = { id, origin: 'agent', calls, declaredEffects, reason: String(args.reason ?? ''), inputsUsed: ctx.trace.events.map((e) => e.id) };
      const decision = await evaluateProposal({ rpc: ctx.rpc, deployment: d, storage: ctx.storage, label: ctx.label, agent: ctx.agent, proposal, trace: ctx.trace });
      ctx.proposals.set(id, { proposal, decision });
      ctx.analytics?.recordDecision(decision);
      ctx.log.push({ at: Date.now(), kind: 'decision', detail: { id, verdict: decision.verdict, failedChecks: decision.failedChecks, origin: decision.origin } });
      return JSON.stringify({
        proposal_id: id,
        verdict: decision.verdict,
        reasons: decision.failedChecks.map((f) => f.detail),
        ...(decision.origin ? { where_the_value_came_from: { source: decision.origin.source, excerpt: decision.origin.excerpt } } : {}),
      });
    }
    case 'execute': {
      const r = await executeProposal(ctx, String(args.proposal_id));
      ctx.analytics?.recordTx(r);
      if (r.status === 'simulated')
        return JSON.stringify({
          status: 'simulated',
          note: 'SIMULATED — every check ran and the owner approved, but nothing was signed or sent (simulate-only mode).',
          effects: r.effects.map((x) => ({ kind: x.kind, token: x.token, amount: x.amount.toString(), counterparty: x.counterparty })),
          simulated_at_block: r.simulatedAtBlock.toString(),
        });
      return JSON.stringify(r.status === 'sent' ? { status: 'sent', tx: r.hash, result: r.receiptStatus } : r);
    }
    default:
      throw new ToolInputError(`unknown tool "${name}"`);
  }
}
