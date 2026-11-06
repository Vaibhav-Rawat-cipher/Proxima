// Creates the "rules key" (can ONLY rewrite the agent's rules on ENS) and appends it to the repo .env as
// RULES_PRIVATE_KEY + RULES_KEY_ADDRESS. Prints ONLY the address. Refuses to overwrite an existing rules key.
// You paste the key into the Blindspot wallet once (Rules → Edit rules); it is stored there encrypted.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
const env = readFileSync(envPath, 'utf8');
if (/^\s*RULES_PRIVATE_KEY\s*=/m.test(env)) {
  console.error('RULES_PRIVATE_KEY already exists in .env — not overwriting it.');
  process.exit(1);
}
const key = generatePrivateKey();
const address = privateKeyToAccount(key).address;
appendFileSync(envPath, `${env.endsWith('\n') ? '' : '\n'}# Rules key: may ONLY change the agent's rules record (blindspot.policy). Not the owner key, not the agent key.\nRULES_PRIVATE_KEY=${key}\nRULES_KEY_ADDRESS=${address}\n`);
console.log(`Rules key created and saved to .env. Rules key address: ${address}`);
