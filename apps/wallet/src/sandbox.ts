import type { RunScriptAdapter } from '@blindspot/core';

/**
 * run_script in the wallet: untrusted repo scripts run in a sandboxed iframe (sandbox="allow-scripts", no
 * allow-same-origin → opaque origin, no access to the wallet's storage, keys or DOM). The iframe's CSP blocks
 * every network request (default-src 'none'). The only capability given to the script is propose(), which goes
 * through the wallet's normal checks. Time limit: 15 s.
 */
const SRC = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'"><script>
let pending = {}, n = 0;
addEventListener('message', async (e) => {
  const m = e.data || {};
  if (m.type === 'proposed') { const p = pending[m.id]; delete pending[m.id]; if (p) p(m.result); return; }
  if (m.type !== 'run') return;
  const logs = [];
  const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  const console = { log: (...a) => logs.push(fmt(a)), info: (...a) => logs.push(fmt(a)), warn: (...a) => logs.push('warn: ' + fmt(a)), error: (...a) => logs.push('error: ' + fmt(a)) };
  const propose = (input) => new Promise((res) => { const id = ++n; pending[id] = res; parent.postMessage({ type: 'propose', id, input }, '*'); });
  try { await (new Function('console', 'propose', '"use strict";\\n' + m.code))(console, propose); parent.postMessage({ type: 'done', output: logs.join('\\n') }, '*'); }
  catch (err) { parent.postMessage({ type: 'done', output: logs.concat('error: ' + (err && err.message || String(err))).join('\\n') }, '*'); }
});
</script>`;

export function sandboxRunner(): RunScriptAdapter {
  return {
    run(path, code, api) {
      return new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.style.display = 'none';
        frame.srcdoc = SRC;
        const finish = (output: string) => {
          clearTimeout(timer);
          removeEventListener('message', onMsg);
          frame.remove();
          resolve({ output: output.slice(0, 20_000) });
        };
        const onMsg = async (e: MessageEvent) => {
          if (e.source !== frame.contentWindow) return; // only this sandbox
          const m = e.data as { type?: string; id?: number; input?: unknown; output?: string };
          if (m.type === 'propose') {
            const result = await api.propose(m.input).catch((err: Error) => JSON.stringify({ error: err.message }));
            frame.contentWindow?.postMessage({ type: 'proposed', id: m.id, result }, '*');
          } else if (m.type === 'done') finish(String(m.output ?? ''));
        };
        const timer = setTimeout(() => finish(`script ${path} stopped: time limit (15 s)`), 15_000);
        addEventListener('message', onMsg);
        frame.onload = () => frame.contentWindow?.postMessage({ type: 'run', code }, '*');
        document.body.appendChild(frame);
      });
    },
  };
}
