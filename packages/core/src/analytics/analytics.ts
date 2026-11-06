import type { Decision } from '@blindspot/shared';
import type { RpcAdapter, StorageAdapter } from '../adapters/types.js';

/**
 * Local analytics (2.7). Counts only, kept in the shell's storage on the user's device: no trackers, no
 * network, no addresses, keys, URLs or amounts. The owner can view the summary and export it as JSON.
 *
 * Privacy accounting: every RPC request is counted as anonymized (through Anon-RPC) or excluded. An excluded
 * adapter must carry a declared reason (e.g. "bootstrap: Nox specifier read"), so excluded traffic is never
 * silent.
 */
export type AnalyticsState = {
  version: 1;
  since: number; // ms timestamp of the first record
  rpc: {
    anonymized: number;
    excluded: number;
    byMethod: Record<string, { anonymized: number; excluded: number }>;
    excludedReasons: Record<string, number>;
    byAdapter: Record<string, number>;
  };
  decisions: { ALLOW: number; BLOCK: number; ASK_OWNER: number };
  /** Check name → how many decisions it failed in (a decision can fail several). */
  failedChecks: Record<string, number>;
  /** Plain rule name (e.g. "Allowed recipients") → count. */
  rulesBroken: Record<string, number>;
  /** Where blocked/asked values came from (trace source kind, e.g. "document") → count. */
  origins: Record<string, number>;
  txs: { sent: number; success: number; reverted: number; refused: number; simulated?: number };
};
export type AnalyticsSummary = AnalyticsState & { anonShare: number | null; totalRequests: number };

export const ANALYTICS_KEY = 'analytics:v1';
const fresh = (now: number): AnalyticsState => ({
  version: 1,
  since: now,
  rpc: { anonymized: 0, excluded: 0, byMethod: {}, excludedReasons: {}, byAdapter: {} },
  decisions: { ALLOW: 0, BLOCK: 0, ASK_OWNER: 0 },
  failedChecks: {},
  rulesBroken: {},
  origins: {},
  txs: { sent: 0, success: 0, reverted: 0, refused: 0 },
});
const bump = (r: Record<string, number>, k: string, n = 1) => (r[k] = (r[k] ?? 0) + n);
/** JSON-RPC method names are short identifiers; anything else is not a method and is not stored verbatim. */
const methodKey = (m: string) => (/^[a-z][a-zA-Z0-9_]{0,63}$/.test(m) ? m : 'other');

export class Analytics {
  private writes: Promise<void> = Promise.resolve();
  private constructor(
    private readonly storage: StorageAdapter,
    private state: AnalyticsState,
    private readonly now: () => number,
  ) {}

  /** Loads the saved counts (or starts fresh). A corrupt record starts fresh rather than failing the wallet. */
  static async load(storage: StorageAdapter, now: () => number = Date.now): Promise<Analytics> {
    const saved = await storage.get<AnalyticsState>(ANALYTICS_KEY);
    return new Analytics(storage, saved?.version === 1 ? saved : fresh(now()), now);
  }

  /** Writes are serialized, so concurrent records are never lost. */
  private save(): void {
    const snapshot = structuredClone(this.state);
    this.writes = this.writes.then(() => this.storage.set(ANALYTICS_KEY, snapshot));
  }
  /** Resolves when every record so far is in storage. */
  flush(): Promise<void> {
    return this.writes;
  }

  recordRpc(adapter: { name: string; anonymized: boolean }, method: string, excludedReason?: string): void {
    const m = (this.state.rpc.byMethod[methodKey(method)] ??= { anonymized: 0, excluded: 0 });
    if (adapter.anonymized) {
      this.state.rpc.anonymized++;
      m.anonymized++;
    } else {
      if (!excludedReason) throw new Error(`excluded RPC traffic needs a declared reason (adapter "${adapter.name}")`);
      this.state.rpc.excluded++;
      m.excluded++;
      bump(this.state.rpc.excludedReasons, excludedReason);
    }
    bump(this.state.rpc.byAdapter, adapter.name);
    this.save();
  }

  recordDecision(d: Decision): void {
    this.state.decisions[d.verdict]++;
    for (const c of new Set(d.failedChecks.map((f) => f.check))) bump(this.state.failedChecks, c);
    for (const r of new Set(d.failedChecks.map((f) => f.rule).filter((x): x is string => Boolean(x)))) bump(this.state.rulesBroken, r);
    for (const s of new Set((d.origins ?? (d.origin ? [d.origin] : [])).map((o) => o.source))) bump(this.state.origins, s);
    this.save();
  }

  recordTx(result: { status: 'sent'; receiptStatus: 'success' | 'reverted' } | { status: 'refused' } | { status: 'simulated' }): void {
    if (result.status === 'refused') this.state.txs.refused++;
    else if (result.status === 'simulated') this.state.txs.simulated = (this.state.txs.simulated ?? 0) + 1;
    else {
      this.state.txs.sent++;
      this.state.txs[result.receiptStatus]++;
    }
    this.save();
  }

  summary(): AnalyticsSummary {
    const s = structuredClone(this.state);
    const total = s.rpc.anonymized + s.rpc.excluded;
    return { ...s, totalRequests: total, anonShare: total ? Math.round((1000 * s.rpc.anonymized) / total) / 10 : null };
  }

  /** The owner's JSON export: counts only (see the privacy note above). */
  exportJson(): string {
    return JSON.stringify({ blindspotAnalytics: 1, exportedAt: new Date(this.now()).toISOString(), ...this.summary() }, null, 2);
  }

  async reset(): Promise<void> {
    this.state = fresh(this.now());
    this.save();
    await this.flush();
  }
}

/**
 * Counts every request of an RPC adapter (the Anon-RPC traffic meter). A non-anonymized adapter must be
 * declared with the reason it is excluded; creating one without a reason throws.
 */
export function meteredRpc(rpc: RpcAdapter, analytics: Analytics, excludedReason?: string): RpcAdapter {
  if (!rpc.anonymized && !excludedReason) throw new Error(`"${rpc.name}" is not anonymized: declare why its traffic is excluded`);
  return {
    name: rpc.name,
    anonymized: rpc.anonymized,
    request(args) {
      analytics.recordRpc(rpc, args.method, excludedReason);
      return rpc.request(args);
    },
  };
}
