// The rules key may sign ONLY setData(<agent name>, "blindspot.policy", <valid policy>) on the agent's resolver.
import { POLICY_RECORD_KEY, encodePolicy } from '@blindspot/shared';
import { encodeFunctionData, parseTransaction, recoverTransactionAddress, toFunctionSelector, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { dnsEncode } from '../ens/names.js';
import { PRESETS } from '../policy/presets.js';
import { toPolicy } from '../policy/rules.js';
import { RESOLVER_ABI, policyUpdateCalldata, rulesOnlySigner } from './rules-signer.js';
import { SignerRefused } from './signer.js';

const RESOLVER: Address = '0xd8CB5CF0b1A80179Ca8B8d5540e9e12077408aB8';
const NAME = 'demo.blindspot-demo.eth';
const account = privateKeyToAccount(generatePrivateKey());
const signer = rulesOnlySigner(account, RESOLVER, NAME, 11155111);
const policy = toPolicy({ ...PRESETS['read-only'].build({}) });
const tx = (over: Partial<{ to: Address; data: Hex; chainId: number }> = {}) => ({ to: RESOLVER, data: policyUpdateCalldata(NAME, policy), chainId: 11155111, nonce: 0, gas: 300_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, ...over });

describe('rules-only signer', () => {
  it('signs a valid rules update for this agent on its resolver', async () => {
    const raw = await signer.signPolicyUpdate(tx());
    expect(parseTransaction(raw).to?.toLowerCase()).toBe(RESOLVER.toLowerCase());
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(account.address);
  });
  it.each([
    ['another contract', () => tx({ to: '0x1BBeEe9eA550755Ae99566F7C2b6a9b381D4b874' }), /not the agent's resolver/],
    ['another chain', () => tx({ chainId: 1 }), /chain/],
    ['another agent name', () => tx({ data: policyUpdateCalldata('try1.trials.blindspot-demo.eth', policy) }), /not the record of/],
    ['another record key', () => tx({ data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setData', args: [dnsEncode(NAME), 'agent-context', encodePolicy(policy)] }) }), /only the "blindspot.policy"/],
    ['invalid rules bytes', () => tx({ data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setData', args: [dnsEncode(NAME), POLICY_RECORD_KEY, '0x1234'] }) }), /invalid/],
    ['a different function (setText)', () => tx({ data: `${toFunctionSelector('setText(bytes,string,string)')}00` as Hex }), /not a setData call/],
    ['a module payment', () => tx({ data: `${toFunctionSelector('execute(string,address,uint256,bytes)')}00` as Hex }), /not a setData call/],
  ])('refuses %s', async (_, make, msg) => {
    await expect(signer.signPolicyUpdate(make())).rejects.toThrow(SignerRefused);
    await expect(signer.signPolicyUpdate(make())).rejects.toThrow(msg);
  });
});
