import { createPublicClient, custom, type PublicClient } from 'viem';
import type { RpcAdapter } from './adapters/types.js';

/** A viem client whose every request goes through the rpc adapter (Anon-RPC in the product). */
export function clientFor(rpc: RpcAdapter): PublicClient {
  return createPublicClient({
    transport: custom({
      request: ({ method, params }) => rpc.request(params === undefined ? { method } : { method, params: params as unknown[] }),
    }),
  });
}
