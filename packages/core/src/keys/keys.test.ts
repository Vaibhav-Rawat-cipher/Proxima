import { encodeFunctionData, getAddress, parseAbi, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { PBKDF2_ITERATIONS, decryptPrivateKey, decryptSecret, encryptPrivateKey, encryptSecret } from './keystore.js';
import { MODULE_SELECTORS, SignerRefused, moduleOnlySigner } from './signer.js';

const MODULE = getAddress('0x1BBeEe9eA550755Ae99566F7C2b6a9b381D4b874');
const moduleAbi = parseAbi(['function execute(string,address,uint256,bytes) returns (bytes)', 'function executeBatch(string,(address,uint256,bytes)[]) returns (bytes[])']);

describe('keystore (PBKDF2-SHA256 600k + AES-GCM)', () => {
  it('round-trips with the right passphrase; the ciphertext never contains the key', async () => {
    const pk = generatePrivateKey();
    const enc = await encryptPrivateKey(pk, 'correct horse battery');
    expect(enc.iterations).toBe(PBKDF2_ITERATIONS);
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(JSON.stringify(enc)).not.toContain(pk.slice(2));
    expect(await decryptPrivateKey(enc, 'correct horse battery')).toBe(pk);
  }, 30_000);
  it('rejects a wrong passphrase', async () => {
    const enc = await encryptPrivateKey(generatePrivateKey(), 'correct horse battery');
    await expect(decryptPrivateKey(enc, 'wrong passphrase!')).rejects.toThrow(/wrong passphrase/);
  }, 30_000);
  it('rejects malformed keys and short passphrases', async () => {
    await expect(encryptPrivateKey('0x1234' as Hex, 'long enough')).rejects.toThrow(/64 hex/);
    await expect(encryptPrivateKey(generatePrivateKey(), 'short')).rejects.toThrow(/at least 8/);
  });
});

describe('secret storage (agent app AI key): same scheme', () => {
  it('round-trips a provider key, stores no plaintext, rejects a wrong passphrase', async () => {
    const enc = await encryptSecret('gsk_example_not_a_real_key_123', 'correct horse');
    expect(enc.iterations).toBe(PBKDF2_ITERATIONS);
    expect(JSON.stringify(enc)).not.toContain('gsk_example');
    expect(await decryptSecret(enc, 'correct horse')).toBe('gsk_example_not_a_real_key_123');
    await expect(decryptSecret(enc, 'wrong horse!')).rejects.toThrow(/wrong passphrase/);
    await expect(encryptSecret('x', 'short')).rejects.toThrow(/at least 8/);
  });
});

describe('moduleOnlySigner (hard rule 1)', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = moduleOnlySigner(account, MODULE, 11155111);
  const base = { chainId: 11155111, nonce: 0, gas: 300_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  const exec = encodeFunctionData({ abi: moduleAbi, functionName: 'execute', args: ['demo', MODULE, 0n, '0x'] });

  it('signs execute(...) and executeBatch(...) to the module', async () => {
    expect(exec.slice(0, 10)).toBe(MODULE_SELECTORS.execute);
    const raw = await signer.signModuleCall({ ...base, to: MODULE, data: exec });
    const tx = parseTransaction(raw);
    expect(getAddress(tx.to!)).toBe(MODULE);
    expect(tx.value ?? 0n).toBe(0n);
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(account.address);
    const batch = encodeFunctionData({ abi: moduleAbi, functionName: 'executeBatch', args: ['demo', [[MODULE, 0n, '0x']]] });
    await expect(signer.signModuleCall({ ...base, to: MODULE, data: batch })).resolves.toMatch(/^0x02/);
  });
  it('refuses any other target', async () => {
    await expect(signer.signModuleCall({ ...base, to: getAddress('0x000000000000000000000000000000000000dEaD'), data: exec })).rejects.toBeInstanceOf(SignerRefused);
  });
  it('refuses any other function (e.g. an ERC-20 transfer) and empty calldata', async () => {
    const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [MODULE, 1n] });
    await expect(signer.signModuleCall({ ...base, to: MODULE, data: transfer })).rejects.toThrow(/not a BlindspotModule/);
    await expect(signer.signModuleCall({ ...base, to: MODULE, data: '0x' })).rejects.toThrow(/not a BlindspotModule/);
  });
  it('refuses another chain', async () => {
    await expect(signer.signModuleCall({ ...base, chainId: 1, to: MODULE, data: exec })).rejects.toThrow(/chain/);
  });
});
