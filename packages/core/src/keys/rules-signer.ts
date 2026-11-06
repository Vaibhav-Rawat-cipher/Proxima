import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex, type LocalAccount, type PublicClient } from 'viem';
import { POLICY_RECORD_KEY, decodePolicy, encodePolicy, type Policy } from '@blindspot/shared';
import type { RpcAdapter } from '../adapters/types.js';
import type { Deployment } from '../deployment.js';
import { readPolicy } from '../ens/reader.js';
import { dnsEncode, subname } from '../ens/names.js';
import { SignerRefused } from './signer.js';

/**
 * The "rules key" (owner decision 2026-11-06): a dedicated key that can ONLY rewrite the agent's rules. The owner grants
 * it the ENSv2 resolver role ROLE_SET_DATA for the key "blindspot.policy" (grantSetterRoles) on the agent's resolver.
 * It cannot move funds (only the agent key can call the module, and only within the rules), cannot take the ENS name,
 * and is never part of an agent session. This signer refuses anything except
 *   resolver.setData(<this agent's DNS name>, "blindspot.policy", <a valid, canonical policy>)
 * on exactly that resolver and chain.
 */
export const RESOLVER_ABI = parseAbi(['function setData(bytes name, string key, bytes value)']);

export type PolicyUpdateRequest = { to: Address; data: Hex; chainId: number; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
export interface RulesSigner {
  readonly address: Address;
  signPolicyUpdate(req: PolicyUpdateRequest): Promise<Hex>;
}

export function policyUpdateCalldata(agentName: string, policy: Policy): Hex {
  return encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setData', args: [dnsEncode(agentName), POLICY_RECORD_KEY, encodePolicy(policy)] });
}

export function rulesOnlySigner(account: LocalAccount, resolver: Address, agentName: string, chainId: number): RulesSigner {
  const name = dnsEncode(agentName).toLowerCase();
  return {
    address: account.address,
    async signPolicyUpdate(req) {
      if (getAddress(req.to) !== getAddress(resolver)) throw new SignerRefused(`refusing to sign: target ${req.to} is not the agent's resolver`);
      if (req.chainId !== chainId) throw new SignerRefused(`refusing to sign: chain ${req.chainId} is not ${chainId}`);
      let args: readonly [Hex, string, Hex];
      try {
        args = decodeFunctionData({ abi: RESOLVER_ABI, data: req.data }).args as readonly [Hex, string, Hex];
      } catch {
        throw new SignerRefused('refusing to sign: not a setData call');
      }
      if (args[0].toLowerCase() !== name) throw new SignerRefused(`refusing to sign: not the record of ${agentName}`);
      if (args[1] !== POLICY_RECORD_KEY) throw new SignerRefused(`refusing to sign: only the "${POLICY_RECORD_KEY}" record may be changed`);
      try {
        decodePolicy(args[2]); // valid and canonical, or refuse (the module would treat bad rules as missing)
      } catch (e) {
        throw new SignerRefused(`refusing to sign: the new rules are invalid (${(e as Error).message})`);
      }
      return account.signTransaction({ type: 'eip1559', chainId: req.chainId, to: req.to, value: 0n, data: req.data, nonce: req.nonce, gas: req.gas, maxFeePerGas: req.maxFeePerGas, maxPriorityFeePerGas: req.maxPriorityFeePerGas });
    },
  };
}

/**
 * Writes new rules for `label` (signed by the rules key, broadcast through `rpc` = Anon-RPC), waits for the receipt and
 * reads the record back: resolves only when the chain holds exactly the new bytes.
 */
export async function updatePolicy(o: { rpc: RpcAdapter; client: PublicClient; deployment: Deployment; label: string; signer: RulesSigner; policy: Policy }): Promise<{ hash: Hex; keccak: Hex }> {
  const name = subname(o.label, o.deployment.parentName);
  const current = await readPolicy(o.client, o.deployment, o.label);
  const data = policyUpdateCalldata(name, o.policy);
  const [nonce, gasEstimate, block] = await Promise.all([
    o.client.getTransactionCount({ address: o.signer.address, blockTag: 'pending' }),
    o.client.estimateGas({ account: o.signer.address, to: current.resolver, data }),
    o.client.getBlock(),
  ]);
  const tip = 1_000_000n; // 0.001 gwei (Sepolia)
  const raw = await o.signer.signPolicyUpdate({ to: current.resolver, data, chainId: o.deployment.chainId, nonce, gas: (gasEstimate * 13n) / 10n, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + tip, maxPriorityFeePerGas: tip });
  const hash = (await o.rpc.request({ method: 'eth_sendRawTransaction', params: [raw] })) as Hex;
  const receipt = await o.client.waitForTransactionReceipt({ hash, pollingInterval: 2_000, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`the rules update reverted (tx ${hash}) — is the rules key granted on this resolver?`);
  const after = await readPolicy(o.client, o.deployment, o.label);
  const expected = keccak256(encodePolicy(o.policy));
  if (after.keccak !== expected) throw new Error(`the record on ENS does not match the new rules (tx ${hash})`);
  return { hash, keccak: after.keccak };
}
