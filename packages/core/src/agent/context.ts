import type { Address, Hex, PublicClient } from 'viem';
import type { Decision, Proposal } from '@blindspot/shared';
import type { ReadSourceAdapter, RpcAdapter, RunScriptAdapter, StorageAdapter } from '../adapters/types.js';
import type { Analytics } from '../analytics/analytics.js';
import type { Deployment } from '../deployment.js';
import type { SignerAdapter } from '../keys/signer.js';
import type { Trace } from '../trace/trace.js';

/** What the shell shows the human before a real transaction is broadcast. */
export type ApprovalRequest = {
  proposalId: string;
  decision: Decision;
  from: Address;
  to: Address;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
  /** Simulate-only mode: approving does NOT send anything. */
  simulated?: boolean;
};

export type ProposalEntry = { proposal: Proposal; decision: Decision; executedTx?: Hex };

/** Everything one agent run needs. The shell provides the adapters; core holds no keys of its own. */
export type RunContext = {
  rpc: RpcAdapter; // already wrapped with withTransportRetry by the shell
  client: PublicClient; // clientFor(rpc)
  deployment: Deployment;
  storage: StorageAdapter;
  label: string; // agent label, e.g. "demo"
  agent: Address;
  trace: Trace;
  readSource?: ReadSourceAdapter;
  runScript?: RunScriptAdapter;
  signer?: SignerAdapter;
  /** Must resolve true before ANY real transaction is broadcast. Missing => execute refuses. */
  approve?: (req: ApprovalRequest) => Promise<boolean>;
  proposals: Map<string, ProposalEntry>;
  /** ENS names the owner knows (e.g. payee names). get_rules shows a name next to an address only after resolving it to that address. */
  knownNames?: string[];
  /** "Simulate only": execute runs every check and asks for approval, then reports the simulated effects; it never signs or sends. */
  simulateOnly?: boolean;
  /** Local counts (2.7): every decision and execution of the run is recorded here when given. */
  analytics?: Analytics;
  /** Run log (decisions, executions, refusals) — Blindspot's own outputs, not searched for origins. */
  log: { at: number; kind: string; detail: unknown }[];
};
