/** SPEC §15. One tool call the agent made, with what it read. */
export type TraceSource = 'ens' | 'chain' | 'page' | 'document' | 'repo' | 'script' | 'tool' | 'token';
export type Trust = 'trusted' | 'untrusted';

export type TraceEvent = {
  id: string;
  runId: string;
  step: number;
  tool: string;
  input: unknown;
  /** Exactly what the tool returned to the agent (the text that can mislead it). */
  output: string;
  trust: Trust;
  source: TraceSource;
  at: number;
  /** For multi-file sources (repositories): file path inside the source. */
  path?: string;
};

/** Sources whose content is attacker-controllable. Token metadata is on-chain text written by the token deployer. */
export const UNTRUSTED_SOURCES: readonly TraceSource[] = ['page', 'document', 'repo', 'script', 'tool', 'token'];
export const trustOf = (source: TraceSource): Trust => (UNTRUSTED_SOURCES.includes(source) ? 'untrusted' : 'trusted');
