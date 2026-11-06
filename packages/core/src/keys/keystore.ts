import { bytesToHex, hexToBytes, isHex, type Hex } from 'viem';

/**
 * Encrypted key storage (owner decision): PBKDF2-SHA256, 600,000 iterations -> AES-256-GCM.
 * Uses the standard WebCrypto API (browser and Node). The decrypted key is returned to the caller for a
 * memory-only session; nothing here stores plaintext.
 */
export const PBKDF2_ITERATIONS = 600_000;

export type EncryptedKey = { v: 1; kdf: 'PBKDF2-SHA256'; iterations: number; salt: Hex; iv: Hex; ciphertext: Hex };

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is not available');
  return s;
};

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptPrivateKey(privateKey: Hex, passphrase: string): Promise<EncryptedKey> {
  if (!isHex(privateKey) || privateKey.length !== 66) throw new Error('private key must be 0x + 64 hex characters');
  if (passphrase.length < 8) throw new Error('passphrase must be at least 8 characters');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, hexToBytes(privateKey)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: bytesToHex(salt), iv: bytesToHex(iv), ciphertext: bytesToHex(ct) };
}

/** Same scheme for any other secret (e.g. the agent app's AI provider key). */
export async function encryptSecret(secret: string, passphrase: string): Promise<EncryptedKey> {
  if (!secret) throw new Error('nothing to encrypt');
  if (passphrase.length < 8) throw new Error('passphrase must be at least 8 characters');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: bytesToHex(salt), iv: bytesToHex(iv), ciphertext: bytesToHex(ct) };
}
export async function decryptSecret(enc: EncryptedKey, passphrase: string): Promise<string> {
  return new TextDecoder().decode(hexToBytes(await decryptPrivateKey(enc, passphrase)));
}

/** Throws on a wrong passphrase (AES-GCM authentication fails). */
export async function decryptPrivateKey(enc: EncryptedKey, passphrase: string): Promise<Hex> {
  const key = await deriveKey(passphrase, hexToBytes(enc.salt), enc.iterations);
  try {
    const pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: hexToBytes(enc.iv) as BufferSource }, key, hexToBytes(enc.ciphertext) as BufferSource));
    return bytesToHex(pt);
  } catch {
    throw new Error('wrong passphrase (or corrupted key file)');
  }
}
