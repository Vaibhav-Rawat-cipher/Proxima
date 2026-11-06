import {
  decodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { POLICY_RECORD_KEY, PolicyError, decodePolicy, type Policy } from '@blindspot/shared';
import type { Deployment } from '../deployment.js';
import { dnsEncode, namehash, subname } from './names.js';

// Signatures from ensdomains/contracts-v2 @07e55a05 (IPermissionedRegistry, IRegistry, IExtendedResolver,
// ens-contracts profiles) and AbstractNormalizedUniversalResolver.resolve(bytes,bytes) -> (bytes,address).
const registryAbi = parseAbi([
  'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
  'function getResolver(string label) view returns (address)',
]);
const resolverAbi = parseAbi(['function resolve(bytes name, bytes data) view returns (bytes)']);
const profileAbi = parseAbi([
  'function addr(bytes32 node) view returns (address)',
  'function text(bytes32 node, string key) view returns (string)',
  'function data(bytes32 node, string key) view returns (bytes)',
]);
const universalResolverAbi = parseAbi(['function resolve(bytes name, bytes data) view returns (bytes, address)']);

const STATUS = ['AVAILABLE', 'RESERVED', 'REGISTERED'] as const;
export type NameStatus = (typeof STATUS)[number];

export type AgentStatus = {
  name: string;
  label: string;
  status: NameStatus;
  owner: Address;
  expiry: bigint;
  /** Same rule as BlindspotModule._isAgentActive: REGISTERED, owned by `agent`, not expired. */
  active: boolean;
  /** Plain-language reason when not active. */
  reason?: string;
};

/**
 * Identity check, mirroring the module (SPEC §5.2 step 1): fresh getState(labelhash) on every call,
 * token IDs never cached.
 */
export async function readAgentStatus(
  client: PublicClient,
  d: Deployment,
  label: string,
  agent: Address,
  nowSec?: bigint,
): Promise<AgentStatus> {
  const s = await client.readContract({
    address: d.agentRegistry,
    abi: registryAbi,
    functionName: 'getState',
    args: [BigInt(keccak256(toHex(label)))],
  });
  const now = nowSec ?? (await client.getBlock()).timestamp;
  const status = STATUS[s.status] ?? 'AVAILABLE';
  const base = { name: subname(label, d.parentName), label, status, owner: s.latestOwner, expiry: s.expiry };
  if (status !== 'REGISTERED') return { ...base, active: false, reason: `The agent name is not registered (status ${status}): it was never registered or has been revoked.` };
  if (s.latestOwner.toLowerCase() !== agent.toLowerCase())
    return { ...base, active: false, reason: `The agent name belongs to ${s.latestOwner}, not to this agent key (${agent}).` };
  if (s.expiry <= now) return { ...base, active: false, reason: `The agent name expired at ${new Date(Number(s.expiry) * 1000).toISOString()}.` };
  return { ...base, active: true };
}

export type PolicyRecord = { name: string; resolver: Address; raw: Hex; keccak: Hex; policy: Policy };

/**
 * Rules check, mirroring the module (SPEC §5.2 step 2): resolver = registry.getResolver(label), then
 * resolver.resolve(dnsName, data(node, "blindspot.policy")), then the shared codec. Fails closed
 * (PolicyError) on a missing resolver, an empty record, or an invalid / non-canonical encoding.
 */
export async function readPolicy(client: PublicClient, d: Deployment, label: string): Promise<PolicyRecord> {
  const name = subname(label, d.parentName);
  const resolver = await client.readContract({ address: d.agentRegistry, abi: registryAbi, functionName: 'getResolver', args: [label] });
  if (resolver === zeroAddress) throw new PolicyError(`${name} has no resolver (expired or never set up), so it has no rules`);
  const data = encodeFunctionData({ abi: profileAbi, functionName: 'data', args: [namehash(name), POLICY_RECORD_KEY] });
  let result: Hex;
  try {
    result = await client.readContract({ address: resolver, abi: resolverAbi, functionName: 'resolve', args: [dnsEncode(name), data] });
  } catch (e) {
    throw new PolicyError(`could not read ${POLICY_RECORD_KEY} for ${name}: ${(e as Error).message.split('\n')[0]}`);
  }
  let raw: Hex;
  try {
    [raw] = decodeAbiParameters([{ type: 'bytes' }], result);
  } catch {
    throw new PolicyError(`${POLICY_RECORD_KEY} for ${name}: resolver returned malformed data`);
  }
  return { name, resolver, raw, keccak: keccak256(raw), policy: decodePolicy(raw) };
}

/** Text record (e.g. ENSIP-26 "agent-context", "agent.status") via the name's resolver, through the Universal Resolver. */
export async function readText(client: PublicClient, d: Deployment, name: string, key: string): Promise<string> {
  const { bytes } = await viaUniversalResolver(client, d, name, encodeFunctionData({ abi: profileAbi, functionName: 'text', args: [namehash(name), key] }));
  if (!bytes) return '';
  return decodeAbiParameters([{ type: 'string' }], bytes)[0];
}

/**
 * Trusted name resolution for the agent's `resolve_name` tool and for payee names: the ENS Universal
 * Resolver (official Sepolia ENSv2 deployment). Returns null when the name does not resolve.
 */
export async function resolveName(client: PublicClient, d: Deployment, name: string): Promise<Address | null> {
  const { bytes } = await viaUniversalResolver(client, d, name, encodeFunctionData({ abi: profileAbi, functionName: 'addr', args: [namehash(name)] }));
  if (!bytes) return null;
  const [addr] = decodeAbiParameters([{ type: 'address' }], bytes);
  return addr === zeroAddress ? null : getAddress(addr);
}

async function viaUniversalResolver(client: PublicClient, d: Deployment, name: string, data: Hex): Promise<{ bytes: Hex | null; resolver: Address | null }> {
  try {
    const [bytes, resolver] = await client.readContract({
      address: d.ens.UpgradableUniversalResolverProxy,
      abi: universalResolverAbi,
      functionName: 'resolve',
      args: [dnsEncode(name), data],
    });
    return { bytes, resolver };
  } catch {
    // Universal Resolver reverts (e.g. ResolverNotFound) for names without a resolver.
    return { bytes: null, resolver: null };
  }
}
