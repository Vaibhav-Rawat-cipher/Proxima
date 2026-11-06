// Serves the milestone page on http://127.0.0.1:5175 (local only). Reads ONLY SEPOLIA_RPC_URL from the repo
// .env (the Nox target + bootstrap read). Private keys are never read here: they are pasted into the page.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const line = readFileSync(resolve(here, '../../.env'), 'utf8').split(/\r?\n/).find((l) => /^\s*SEPOLIA_RPC_URL\s*=/.test(l));
const url = line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
if (!url) {
  console.error('SEPOLIA_RPC_URL is missing in .env');
  process.exit(2);
}
process.env.E2E_SEPOLIA_RPC = url;
const { createServer } = await import('vite');
const server = await createServer({ root: here, configFile: resolve(here, 'vite.config.ts'), logLevel: 'error' });
await server.listen();
console.log('Milestone page ready: open http://127.0.0.1:5175/ in Chrome (local only). Ctrl+C to stop.');
