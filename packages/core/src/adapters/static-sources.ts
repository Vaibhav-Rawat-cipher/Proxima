import type { ReadSourceAdapter, SourceKind, SourceRead } from './types.js';

/**
 * A ReadSourceAdapter over a fixed set of sources (demo-world fixtures, check pages, tests).
 * The content is still UNTRUSTED: the tools record it in the trace with its source kind.
 */
export function staticSources(sources: Record<string, { kind: SourceKind; content?: string; files?: { path: string; content: string }[] }>, defaultPage?: string): ReadSourceAdapter {
  return {
    async read(kind: SourceKind, url?: string): Promise<SourceRead> {
      const key = url ?? (kind === 'page' ? defaultPage : undefined);
      const s = key ? sources[key] : undefined;
      if (!key || !s || s.kind !== kind) throw new Error(`no ${kind} at ${url ?? '(current page)'}`);
      return { kind, url: key, content: s.content ?? '', ...(s.files ? { files: s.files } : {}) };
    },
  };
}
