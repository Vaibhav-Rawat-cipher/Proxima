// Serves the R1 check page on http://127.0.0.1:5174 for the user to open in their own Chrome.
// Usage: node serve.mjs [nox|torJs]. Reads RPC URLs from the repo .env; never prints them.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const network = process.argv[2] ?? 'nox';
const env = Object.fromEntries(
  readFileSync(resolve(here, '../../.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\s*[A-Z0-9_]+\s*=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const bootstrap = network === 'torJs' ? env.MAINNET_BOOTSTRAP_RPC_URL : env.SEPOLIA_RPC_URL;
if (!env.SEPOLIA_RPC_URL || !bootstrap) {
  console.error(`missing ${network === 'torJs' ? 'MAINNET_BOOTSTRAP_RPC_URL' : 'SEPOLIA_RPC_URL'} in .env`);
  process.exit(2);
}
process.env.R1_NETWORK = network;
process.env.R1_TARGET_RPC = env.SEPOLIA_RPC_URL;
process.env.R1_BOOTSTRAP_RPC = bootstrap;

const { createServer } = await import('vite');
const server = await createServer({ root: here, configFile: resolve(here, 'vite.config.ts'), logLevel: 'error' });
await server.listen();
console.log(`R1 (${network}) check page ready: open http://127.0.0.1:5174/ in Chrome (local only). Ctrl+C to stop.`);
