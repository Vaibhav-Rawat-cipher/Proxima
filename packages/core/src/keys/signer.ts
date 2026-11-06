import { getAddress, size, slice, toFunctionSelector, type Address, type Hex, type LocalAccount } from 'viem';

/** Selectors of the only calls the agent key may ever sign (BlindspotModule). */
export const MODULE_SELECTORS = {
  execute: toFunctionSelector('execute(string,address,uint256,bytes)'),
  executeBatch: toFunctionSelector('executeBatch(string,(address,uint256,bytes)[])'),
} as const;

export type ModuleCallRequest = {
  to: Address;
  data: Hex;
  chainId: number;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

/** Hard rule 1: the agent key signs ONLY BlindspotModule.execute / executeBatch calls to the module. */
export interface SignerAdapter {
  readonly address: Address;
  signModuleCall(req: ModuleCallRequest): Promise<Hex>;
}

export class SignerRefused extends Error {
  override name = 'SignerRefused';
}

/**
 * A SignerAdapter around an in-memory account that refuses anything but a module call: wrong target,
 * non-zero value, wrong chain, or calldata that is not execute(...) / executeBatch(...).
 * Defence in depth: core's execute() already builds this calldata itself from an ALLOWed proposal.
 */
export function moduleOnlySigner(account: LocalAccount, module: Address, chainId: number): SignerAdapter {
  const allowed = [MODULE_SELECTORS.execute.toLowerCase(), MODULE_SELECTORS.executeBatch.toLowerCase()];
  return {
    address: account.address,
    async signModuleCall(req) {
      if (getAddress(req.to) !== getAddress(module)) throw new SignerRefused(`refusing to sign: target ${req.to} is not the BlindspotModule`);
      if (req.chainId !== chainId) throw new SignerRefused(`refusing to sign: chain ${req.chainId} is not ${chainId}`);
      if (size(req.data) < 4 || !allowed.includes(slice(req.data, 0, 4).toLowerCase())) throw new SignerRefused('refusing to sign: not a BlindspotModule.execute / executeBatch call');
      return account.signTransaction({
        type: 'eip1559',
        chainId: req.chainId,
        to: req.to,
        value: 0n,
        data: req.data,
        nonce: req.nonce,
        gas: req.gas,
        maxFeePerGas: req.maxFeePerGas,
        maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      });
    },
  };
}
