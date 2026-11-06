import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAddress, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Reads .env without exporting it to the process or printing any value. */
function readEnv(): Record<string, string> {
  const text = readFileSync(resolve(ROOT, '.env'), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const required = (env: Record<string, string>, k: string) => {
  const v = env[k];
  if (!v) throw new Error(`.env: ${k} is missing or empty`);
  return v;
};

/** Deterministic, clearly-labelled placeholder used only when a real address was not provided. */
export const placeholder = (tag: string): Address =>
  `0x${keccak256(stringToHex(`blindspot dry-run placeholder: ${tag}`)).slice(26)}` as Address;

export type SetupEnv = {
  rpcUrl: string;
  ownerKey: Hex;
  owner: Address;
  parentLabel: string;
  agent: { address: Address; isPlaceholder: boolean };
  payees: { address: Address; isPlaceholder: boolean }[];
};

export function loadEnv(): SetupEnv {
  const env = readEnv();
  const ownerKey = required(env, 'OWNER_PRIVATE_KEY') as Hex;
  const parentLabel = required(env, 'PARENT_NAME').toLowerCase().replace(/\.eth$/, '');
  if (!/^[a-z0-9-]+$/.test(parentLabel)) throw new Error('PARENT_NAME must be a plain lowercase label');

  const agentEnv = env.AGENT_ADDRESS;
  if (agentEnv && !isAddress(agentEnv)) throw new Error('AGENT_ADDRESS is not an address');
  const payeeEnv = (env.PAYEE_ADDRESSES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of payeeEnv) if (!isAddress(p)) throw new Error(`PAYEE_ADDRESSES contains a non-address`);

  return {
    rpcUrl: required(env, 'SEPOLIA_RPC_URL'),
    ownerKey,
    owner: privateKeyToAccount(ownerKey).address,
    parentLabel,
    agent: agentEnv ? { address: agentEnv as Address, isPlaceholder: false } : { address: placeholder('agent'), isPlaceholder: true },
    payees:
      payeeEnv.length > 0
        ? payeeEnv.map((a) => ({ address: a as Address, isPlaceholder: false }))
        : [
            { address: placeholder('payee 1'), isPlaceholder: true },
            { address: placeholder('payee 2'), isPlaceholder: true },
          ],
  };
}

export type Config = {
  chainId: number;
  ens: Record<string, string> & {
    ETHRegistrar: Address;
    ETHRegistry: Address;
    VerifiableFactory: Address;
    UserRegistryImpl: Address;
    PermissionedResolverImpl: Address;
    UpgradableUniversalResolverProxy: Address;
    MockUSDC: Address;
  };
  safe: { SafeProxyFactory: Address; Safe: Address; CompatibilityFallbackHandler: Address };
};

export const loadConfig = (): Config => JSON.parse(readFileSync(resolve(ROOT, 'config/sepolia.json'), 'utf8'));
