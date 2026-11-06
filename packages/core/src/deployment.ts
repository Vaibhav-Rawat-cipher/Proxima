import type { Address } from 'viem';

/**
 * The subset of config/sepolia.json the core needs. The shell loads the file and passes it in;
 * the core never reads files or hard-codes addresses.
 */
export type Deployment = {
  chainId: number;
  ens: {
    UpgradableUniversalResolverProxy: Address;
    MockUSDC: Address;
  };
  parentName: string; // e.g. "blindspot-demo.eth"
  agentRegistry: Address; // the owner's UserRegistry (agent + payee subnames)
  safeAddress: Address;
  module: Address;
};

export function deploymentFromConfig(cfg: Record<string, unknown>): Deployment {
  const c = cfg as Partial<Deployment> & { ens?: Partial<Deployment['ens']> };
  const need = <T>(v: T | null | undefined, what: string): T => {
    if (v === undefined || v === null || v === '') throw new Error(`deployment config: ${what} is missing`);
    return v;
  };
  return {
    chainId: need(c.chainId, 'chainId'),
    ens: {
      UpgradableUniversalResolverProxy: need(c.ens?.UpgradableUniversalResolverProxy, 'ens.UpgradableUniversalResolverProxy'),
      MockUSDC: need(c.ens?.MockUSDC, 'ens.MockUSDC'),
    },
    parentName: need(c.parentName, 'parentName'),
    agentRegistry: need(c.agentRegistry, 'agentRegistry'),
    safeAddress: need(c.safeAddress, 'safeAddress'),
    module: need(c.module, 'module'),
  };
}
