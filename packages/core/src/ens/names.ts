import { namehash, toHex, type Hex } from 'viem';

/** DNS wire-format encoding of an ENS name, as ENSv2 setters and resolve() expect. */
export function dnsEncode(name: string): Hex {
  const parts = name.split('.').map((label) => {
    const bytes = new TextEncoder().encode(label);
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`invalid label in "${name}"`);
    return [bytes.length, ...bytes];
  });
  return toHex(new Uint8Array([...parts.flat(), 0]));
}

export { namehash };

/** "demo" + "blindspot-demo.eth" -> "demo.blindspot-demo.eth" */
export const subname = (label: string, parent: string) => `${label}.${parent}`;
