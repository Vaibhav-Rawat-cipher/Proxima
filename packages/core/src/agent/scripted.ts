import type { LlmAdapter, LlmMessage } from '../adapters/types.js';

/** One step of a scripted run: a tool call (args may use "$lastProposalId"), or the final answer. */
export type ScriptStep = { tool: string; args?: Record<string, unknown> } | { final: string };

const lastProposalId = (messages: LlmMessage[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'tool') continue;
    try {
      const j = JSON.parse(m.content) as { proposal_id?: string };
      if (j.proposal_id) return j.proposal_id;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
};

/**
 * Scripted mode (SPEC §9 "hidden scripted fallback"): an LlmAdapter that replays recorded tool calls, one
 * per step. Only the MODEL is replaced: every tool, simulation, check, trace and signature runs for real.
 */
export function scriptedLlm(script: ScriptStep[]): LlmAdapter {
  let i = 0;
  return {
    name: 'scripted',
    async chat({ messages }) {
      const step = script[i++];
      if (!step) return { content: 'Script finished.', toolCalls: [], finishReason: 'stop', model: 'scripted' };
      if ('final' in step) return { content: step.final, toolCalls: [], finishReason: 'stop', model: 'scripted' };
      const args = Object.fromEntries(Object.entries(step.args ?? {}).map(([k, v]) => [k, v === '$lastProposalId' ? lastProposalId(messages) : v]));
      return { content: null, toolCalls: [{ id: `s${i}`, name: step.tool, arguments: JSON.stringify(args) }], finishReason: 'tool_calls', model: 'scripted' };
    },
  };
}
