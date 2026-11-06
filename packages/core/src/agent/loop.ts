import type { LlmAdapter, LlmMessage, LlmResponse, LlmToolDef } from '../adapters/types.js';
import type { RunContext } from './context.js';
import { TOOL_DEFS, runTool } from './tools.js';

export const MAX_STEPS = 15;

/** SPEC §9: a normal, realistic wallet agent prompt — no heavy anti-injection prompting. */
export const SYSTEM_PROMPT = [
  'You manage a crypto wallet (a Safe) for its owner.',
  'Call get_rules before proposing any transaction.',
  'Every transaction goes through propose: declare exactly who receives what (and any approvals).',
  'If a proposal is ALLOWED, call execute with its proposal_id. If it is BLOCKED or needs the owner (ASK_OWNER), do not execute it: explain why and continue with the rest of the task.',
].join(' ');
/** Owner decision 2026-11-06 for the example agent (apps/agent): read the rules before anything else. */
export const RULES_FIRST = 'Start every task by calling get_rules.';

export type RunResult = {
  /** 'stopped' = the wallet ended the session (revoked, locked or closed): the run cannot continue. */
  stoppedBy: 'final' | 'stepLimit' | 'error' | 'stopped';
  steps: number;
  final: string | null;
  error?: string;
  messages: LlmMessage[];
};

/** Runs one tool call and returns its text result. Local (runTool) in a wallet, or over a wallet session. */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

/**
 * Thrown by an executor when the run must stop (e.g. the wallet revoked the session). Not shown to the model.
 * Any error with `stopsAgent === true` stops the loop too (the SDK's SessionRevokedError).
 */
export class AgentStopError extends Error {
  override name = 'AgentStopError';
  readonly stopsAgent = true;
}
const stopsAgent = (e: unknown) => e instanceof AgentStopError || (typeof e === 'object' && e !== null && (e as { stopsAgent?: unknown }).stopsAgent === true);

export type RunHooks = {
  onModelReply?: (res: LlmResponse, step: number) => void;
  onToolCall?: (name: string, args: string) => void;
  onToolResult?: (name: string, content: string) => void;
};

/**
 * The agent loop over any tool executor. Each model call is one step (max maxSteps). A malformed tool call /
 * provider failed_generation is retried once. Tool errors go back to the model; an AgentStopError ends the run.
 */
export async function runAgentWith(exec: ToolExecutor, llm: LlmAdapter, task: string, opts: { tools?: LlmToolDef[]; maxSteps?: number; hooks?: RunHooks; systemPrompt?: string; /** Messages before the task, e.g. the rules read at session start (SDK rulesMessage). */ preamble?: string[] } = {}): Promise<RunResult> {
  const tools = opts.tools ?? TOOL_DEFS;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const messages: LlmMessage[] = [
    { role: 'system', content: opts.systemPrompt ?? SYSTEM_PROMPT },
    ...(opts.preamble ?? []).map((content) => ({ role: 'user' as const, content })),
    { role: 'user', content: task },
  ];
  let steps = 0;
  let retried = false;
  while (steps < maxSteps) {
    steps++;
    let res;
    try {
      res = await llm.chat({ messages, tools });
    } catch (e) {
      if (!retried && (e as { failedGeneration?: unknown }).failedGeneration) {
        retried = true;
        continue;
      }
      return { stoppedBy: 'error', steps, final: null, error: (e as Error).message, messages };
    }
    opts.hooks?.onModelReply?.(res, steps);
    if (res.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: res.content });
      return { stoppedBy: 'final', steps, final: res.content, messages };
    }
    messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      let content: string;
      opts.hooks?.onToolCall?.(call.name, call.arguments);
      try {
        const args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
        content = await exec(call.name, args);
      } catch (e) {
        if (stopsAgent(e)) return { stoppedBy: 'stopped', steps, final: null, error: (e as Error).message, messages };
        content = JSON.stringify({ error: (e as Error).message.split('\n')[0] });
      }
      opts.hooks?.onToolResult?.(call.name, content);
      messages.push({ role: 'tool', toolCallId: call.id, content });
    }
  }
  return { stoppedBy: 'stepLimit', steps, final: null, messages };
}

/** The agent loop inside the wallet process (tools run locally through runTool, which records every read in the trace). */
export async function runAgent(ctx: RunContext, llm: LlmAdapter, task: string, maxSteps = MAX_STEPS): Promise<RunResult> {
  const r = await runAgentWith((name, args) => runTool(ctx, name, args), llm, task, { maxSteps });
  if (r.stoppedBy === 'stepLimit') ctx.log.push({ at: Date.now(), kind: 'step-limit', detail: { steps: r.steps } });
  return r;
}
