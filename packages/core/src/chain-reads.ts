import { parseAbi, type Address, type PublicClient } from 'viem';
import { ETH } from '@blindspot/shared';

const metaAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

/**
 * Token metadata from chain. The READ is trustworthy, but the CONTENT (name, symbol) is attacker-written
 * text: the agent's token tool records it in the trace as source "token" (untrusted).
 */
export async function readTokenMetadata(client: PublicClient, token: Address): Promise<{ name: string; symbol: string; decimals: number }> {
  if (token === ETH) return { name: 'Ether', symbol: 'ETH', decimals: 18 };
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: metaAbi, functionName: 'name' }).catch(() => ''),
    client.readContract({ address: token, abi: metaAbi, functionName: 'symbol' }).catch(() => ''),
    client.readContract({ address: token, abi: metaAbi, functionName: 'decimals' }).catch(() => 0),
  ]);
  return { name, symbol, decimals: Number(decimals) };
}

export async function readDecimals(client: PublicClient, tokens: Address[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of [...new Set(tokens.map((x) => x.toLowerCase()))]) out[t] = (await readTokenMetadata(client, t as Address)).decimals;
  return out;
}
