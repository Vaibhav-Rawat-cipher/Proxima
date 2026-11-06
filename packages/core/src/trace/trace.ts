import { getAddress, isAddress, type Address } from 'viem';
import { ETH, trustOf, type Decision, type Effect, type Policy, type Proposal, type TraceEvent, type TraceSource } from '@blindspot/shared';
import { decodeCallParties, intendedOutflows } from '../check/checks.js';

/** Append-only record of every tool call in one agent run (SPEC §8 origin trace). */
export class Trace {
  readonly events: TraceEvent[] = [];
  private step = 0;
  constructor(readonly runId: string, private readonly now: () => number = () => Date.now()) {}

  /** Record what a tool returned. Trust is derived from the source, never chosen by the caller. */
  record(tool: string, source: TraceSource, input: unknown, output: string, path?: string): TraceEvent {
    const e: TraceEvent = {
      id: `${this.runId}:${++this.step}`,
      runId: this.runId,
      step: this.step,
      tool,
      input,
      output,
      trust: trustOf(source),
      source,
      at: this.now(),
      ...(path === undefined ? {} : { path }),
    };
    this.events.push(e);
    return e;
  }

  /** Record a multi-file read (a repository): one event per file so the origin can name the file. */
  recordFiles(tool: string, source: TraceSource, input: unknown, files: { path: string; content: string }[]): TraceEvent[] {
    return files.map((f) => this.record(tool, source, input, f.content, f.path));
  }
}

// ---------------------------------------------------------------- what to look for
export type SuspiciousValue =
  | { kind: 'address'; value: Address; why: string }
  | { kind: 'amount'; value: bigint; decimals: number; token: Address; why: string };

/**
 * Values in a proposal that the owner's rules or the checks objected to: recipients / spenders not on the
 * owner's lists, and amounts of outflows that broke a cap or did not match the agent's claim.
 */
export function suspiciousValues(p: Policy, proposal: Proposal, decision: Decision, safe: Address, decimals: Record<string, number>): SuspiciousValue[] {
  const out: SuspiciousValue[] = [];
  const seen = new Set<string>();
  const known = [...p.payees, ...p.spenders, ...p.operators].map((a) => a.toLowerCase());
  const addAddr = (a: Address | undefined, why: string) => {
    if (!a || known.includes(a.toLowerCase()) || seen.has(a.toLowerCase())) return;
    seen.add(a.toLowerCase());
    out.push({ kind: 'address', value: getAddress(a), why });
  };
  for (const c of proposal.calls) {
    try {
      const pt = decodeCallParties(c);
      addAddr(pt.recipient, 'recipient not on the owner\'s list');
      addAddr(pt.spender, 'spender not on the owner\'s list');
      addAddr(pt.operator, 'operator not on the owner\'s list');
    } catch {
      /* undecodable calls are reported by the rules check */
    }
  }
  for (const e of decision.undeclared) if (e.kind !== 'unknownLog') addAddr(e.counterparty, 'undeclared effect');

  const amountChecks = decision.failedChecks.filter((f) => f.rule === 'Per-transaction cap' || f.rule === 'Daily cap' || f.rule === 'Maximum ETH per transaction' || f.check === 'claimVsReality' || f.check === 'askOwner');
  if (amountChecks.length) {
    const outs: Effect[] = decision.effects.length ? decision.effects.filter((e) => e.kind === 'out') : intendedOutflows(proposal.calls, safe);
    for (const e of outs) {
      const key = `amt:${e.token.toLowerCase()}:${e.amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: 'amount', value: e.amount, token: e.token, decimals: e.token === ETH ? 18 : (decimals[e.token.toLowerCase()] ?? 0), why: amountChecks[0]!.detail });
    }
  }
  return out;
}

// ---------------------------------------------------------------- matching
/** Human spellings of a raw token amount: "26", "26.0", "26.00", "26,000,000" (raw), "$26" ... */
export function amountSpellings(raw: bigint, decimals: number): string[] {
  const s = new Set<string>([raw.toString(), withCommas(raw.toString())]);
  if (decimals > 0) {
    const base = 10n ** BigInt(decimals);
    const whole = raw / base;
    const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    const human = frac ? `${whole}.${frac}` : whole.toString();
    s.add(human);
    s.add(frac ? `${withCommas(whole.toString())}.${frac}` : withCommas(whole.toString()));
    if (!frac) {
      s.add(`${whole}.0`);
      s.add(`${whole}.00`);
    } else if (frac.length === 1) s.add(`${human}0`);
  }
  return [...s].filter((x) => x.length > 0);
}
const withCommas = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex that finds the value as a whole token in text (no partial matches inside longer numbers / hex). */
function matcher(v: SuspiciousValue): RegExp {
  if (v.kind === 'address') {
    const hex = v.value.slice(2);
    return new RegExp(`(?<![0-9a-fA-Fx])(?:0x)?${hex}(?![0-9a-fA-F])`, 'i');
  }
  const forms = amountSpellings(v.value, v.decimals).sort((a, b) => b.length - a.length).map(escape);
  return new RegExp(`(?<![\\d.,])\\$?(?:${forms.join('|')})(?![\\d]|[.,]\\d)`);
}

export type Origin = {
  value: string;
  eventId: string;
  source: TraceSource;
  tool: string;
  path?: string;
  line: number;
  /** The exact line of untrusted text where the value first appeared. */
  excerpt: string;
  why: string;
};

/**
 * Where did the agent get it? The first untrusted event (in step order) whose output contains the value.
 * Trusted events are skipped: a value that only ever came from ENS or the chain has no untrusted origin.
 */
export function findOrigin(trace: Trace, value: SuspiciousValue): Origin | null {
  const re = matcher(value);
  for (const e of trace.events) {
    if (e.trust !== 'untrusted') continue;
    const lines = e.output.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        return {
          value: value.kind === 'address' ? value.value : amountSpellings(value.value, value.decimals)[2] ?? value.value.toString(),
          eventId: e.id,
          source: e.source,
          tool: e.tool,
          ...(e.path === undefined ? {} : { path: e.path }),
          line: i + 1,
          excerpt: lines[i]!.trim().slice(0, 300),
          why: value.why,
        };
      }
    }
  }
  return null;
}

/** Origins for every suspicious value (addresses first, then amounts); the first is "where the agent went wrong". */
export function explainOrigins(trace: Trace, values: SuspiciousValue[]): Origin[] {
  const ordered = [...values.filter((v) => v.kind === 'address'), ...values.filter((v) => v.kind === 'amount')];
  return ordered.map((v) => findOrigin(trace, v)).filter((o): o is Origin => o !== null);
}

export const isHexAddress = (s: string) => isAddress(s, { strict: false });
