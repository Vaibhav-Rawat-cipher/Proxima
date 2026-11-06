// Creates the relayer's key and appends it to the repo .env (TRIAL_RELAYER_PRIVATE_KEY + TRIAL_RELAYER_ADDRESS).
// Prints ONLY the address. Refuses to overwrite an existing relayer key.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
const env = readFileSync(envPath, 'utf8');
if (/^\s*TRIAL_RELAYER_PRIVATE_KEY\s*=/m.test(env)) {
  console.error('TRIAL_RELAYER_PRIVATE_KEY already exists in .env — not overwriting it.');
  process.exit(1);
}
const key = generatePrivateKey();
const address = privateKeyToAccount(key).address;
appendFileSync(envPath, `${env.endsWith('\n') ? '' : '\n'}# Step 3d gas-only relayer (Sepolia ETH for provision() gas only; never an agent key or Safe funds)\nTRIAL_RELAYER_PRIVATE_KEY=${key}\nTRIAL_RELAYER_ADDRESS=${address}\n`);
console.log(`Relayer key created and saved to .env. Relayer address: ${address}`);
