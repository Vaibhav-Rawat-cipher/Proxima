// Serves the Blindspot wallet on http://127.0.0.1:5181 (local presenter mode). Reads ONLY SEPOLIA_RPC_URL (Nox target +
// declared bootstrap read) and MAINNET_BOOTSTRAP_RPC_URL (tor-js fallback: mainnet specifier read only) from the repo
// .env. Private keys are never read here: the agent key is pasted into the wallet page and stored encrypted with the
// owner's passphrase.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(resolve(here, '../../.env'), 'utf8').split(/\r?\n/);
const read = (name) => {
  const line = lines.find((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
};
const url = read('SEPOLIA_RPC_URL');
if (!url) {
  console.error('SEPOLIA_RPC_URL is missing in .env');
  process.exit(2);
}
process.env.WALLET_SEPOLIA_RPC = url;
process.env.WALLET_MAINNET_BOOTSTRAP = read('MAINNET_BOOTSTRAP_RPC_URL');
if (!process.env.WALLET_MAINNET_BOOTSTRAP) console.warn('MAINNET_BOOTSTRAP_RPC_URL is missing in .env: the tor-js fallback is disabled.');
const { createServer } = await import('vite');
const server = await createServer({ root: here, configFile: resolve(here, 'vite.config.ts'), logLevel: 'error' });
await server.listen();
console.log('Blindspot wallet ready on http://127.0.0.1:5181/ (local only). Open the agent app at http://127.0.0.1:5180/ and click "Connect wallet". Ctrl+C to stop.');
