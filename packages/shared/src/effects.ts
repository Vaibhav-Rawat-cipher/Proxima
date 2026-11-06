import type { Address } from 'viem';

/** SPEC §15. What a transaction does to the Safe, derived from simulation (or a real receipt). */
export type EffectKind = 'out' | 'in' | 'approve' | 'operator' | 'unknownLog';

export type Effect = {
  kind: EffectKind;
  /** Token contract; address(0) = native ETH. */
  token: Address;
  /** Raw units. For ERC-721 out/in this is 1; for `operator` 1 = approved, 0 = revoked. */
  amount: bigint;
  /** Recipient (out), sender (in), spender (approve), operator (operator), log emitter (unknownLog). */
  counterparty: Address;
  source: 'log' | 'postState';
  /** ERC-721 / ERC-1155 token id, when the effect is about a specific NFT. */
  tokenId?: bigint;
};

export const ETH: Address = '0x0000000000000000000000000000000000000000';
