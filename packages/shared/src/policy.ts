import { decodeAbiParameters, encodeAbiParameters, isAddress, isHex, type Address, type Hex } from 'viem';

/**
 * Owner rules stored in the agent's ENS data record `blindspot.policy` (SPEC §15).
 *
 * The whole struct is ABI-encoded as one tuple. BlindspotModule decodes the same tuple
 * (contracts/src/PolicyCodec.sol) and enforces the on-chain fields; the last three fields
 * are wallet-only and ignored on-chain.
 *
 * Conventions shared with Solidity:
 * - targets[i] has codeHashes[i] and selectors[i]. codeHashes[i] == 0x00..00 means "not pinned"
 *   (proxy target; upgrades are checked off-chain via the EIP-1967 slot, SPEC §8).
 * - Selector 0x00000000 allows a call with empty calldata (plain ETH transfer); the target must be a payee.
 * - tokens[i] has tokenKinds[i], maxOut[i] and dailyCap[i]. tokens[i] == address(0) tracks native ETH.
 * - operators: NFT operators allowed to remain approved-for-all after a call.
 */
export type Policy = {
  version: number;
  targets: Address[];
  codeHashes: Hex[];
  selectors: Hex[][];
  payees: Address[];
  spenders: Address[];
  operators: Address[];
  tokens: Address[];
  tokenKinds: TokenKind[];
  maxOut: bigint[];
  dailyCap: bigint[];
  maxEth: bigint;
  // wallet-only (off-chain) fields, same record:
  rateLimitPerHour: number;
  askOwnerAbove: bigint;
  blockNewContracts: boolean;
};

/** 0 = ERC-20 (or native ETH when the token is address(0)), 1 = ERC-721, 2 = ERC-1155. */
export const TokenKind = { ERC20: 0, ERC721: 1, ERC1155: 2 } as const;
export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

export const POLICY_RECORD_KEY = 'blindspot.policy';

/** `askOwnerAbove` is a USD amount with 6 decimals (e.g. 20 USD = 20_000_000), compared to stablecoin outflows. */
export const ASK_OWNER_DECIMALS = 6;

/**
 * Selectors that move tokens or grant rights over them. A target that allows any of these
 * must be listed in `tokens` (so caps and approval post-checks cover it).
 * Must match BlindspotModule / PolicyCodec.isTokenMoving.
 */
export const TOKEN_MOVING_SELECTORS: readonly Hex[] = [
  '0xa9059cbb', // transfer(address,uint256)
  '0x23b872dd', // transferFrom(address,address,uint256)
  '0x42842e0e', // safeTransferFrom(address,address,uint256)
  '0xb88d4fde', // safeTransferFrom(address,address,uint256,bytes)
  '0xf242432a', // safeTransferFrom(address,address,uint256,uint256,bytes)
  '0x2eb2c2d6', // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
  '0x095ea7b3', // approve(address,uint256)
  '0x39509351', // increaseAllowance(address,uint256)
  '0xa22cb465', // setApprovalForAll(address,bool)
];

/** Must match `struct Policy` in contracts/src/PolicyCodec.sol field for field. */
export const POLICY_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'version', type: 'uint32' },
      { name: 'targets', type: 'address[]' },
      { name: 'codeHashes', type: 'bytes32[]' },
      { name: 'selectors', type: 'bytes4[][]' },
      { name: 'payees', type: 'address[]' },
      { name: 'spenders', type: 'address[]' },
      { name: 'operators', type: 'address[]' },
      { name: 'tokens', type: 'address[]' },
      { name: 'tokenKinds', type: 'uint8[]' },
      { name: 'maxOut', type: 'uint256[]' },
      { name: 'dailyCap', type: 'uint256[]' },
      { name: 'maxEth', type: 'uint256' },
      { name: 'rateLimitPerHour', type: 'uint32' },
      { name: 'askOwnerAbove', type: 'uint256' },
      { name: 'blockNewContracts', type: 'bool' },
    ],
  },
] as const;

export class PolicyError extends Error {
  override name = 'PolicyError';
}

const UINT32_MAX = 0xffff_ffff;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Throws PolicyError on any inconsistency. Same rules as PolicyCodec.isValid in Solidity. */
export function validatePolicy(p: Policy): void {
  const fail = (msg: string): never => {
    throw new PolicyError(msg);
  };
  if (!Number.isInteger(p.version) || p.version < 1 || p.version > UINT32_MAX) fail('version must be a uint32 >= 1');
  if (!Number.isInteger(p.rateLimitPerHour) || p.rateLimitPerHour < 0 || p.rateLimitPerHour > UINT32_MAX)
    fail('rateLimitPerHour must be a uint32');
  if (p.codeHashes.length !== p.targets.length) fail('codeHashes length must equal targets length');
  if (p.selectors.length !== p.targets.length) fail('selectors length must equal targets length');
  if (p.tokenKinds.length !== p.tokens.length) fail('tokenKinds length must equal tokens length');
  if (p.maxOut.length !== p.tokens.length) fail('maxOut length must equal tokens length');
  if (p.dailyCap.length !== p.tokens.length) fail('dailyCap length must equal tokens length');
  for (const a of [...p.targets, ...p.payees, ...p.spenders, ...p.operators, ...p.tokens])
    if (!isAddress(a, { strict: false })) fail(`invalid address ${a}`);
  for (const h of p.codeHashes) if (!isHex(h) || h.length !== 66) fail(`invalid code hash ${h}`);
  for (const list of p.selectors)
    for (const s of list) if (!isHex(s) || s.length !== 10) fail(`invalid selector ${s}`);
  for (const v of [...p.maxOut, ...p.dailyCap, p.maxEth, p.askOwnerAbove])
    if (v < 0n || v >= 2n ** 256n) fail('amount out of uint256 range');

  const tokens = p.tokens.map((t) => t.toLowerCase());
  p.tokens.forEach((t, i) => {
    const kind = p.tokenKinds[i];
    if (kind !== 0 && kind !== 1 && kind !== 2) fail(`tokenKinds[${i}] must be 0, 1 or 2`);
    if (t.toLowerCase() === ZERO_ADDRESS && kind !== TokenKind.ERC20) fail(`tokens[${i}] is ETH and must have kind 0`);
    const maxOut = p.maxOut[i] ?? 0n;
    const dailyCap = p.dailyCap[i] ?? 0n;
    if (maxOut > dailyCap) fail(`maxOut[${i}] exceeds dailyCap[${i}]`);
    // ERC-1155 balances are per id, so the module cannot measure amounts: caps must be 0 (not enforced on-chain).
    if (kind === TokenKind.ERC1155 && (maxOut !== 0n || dailyCap !== 0n))
      fail(`tokens[${i}] is ERC-1155: maxOut and dailyCap must be 0 (amounts are not capped on-chain)`);
  });

  const moving = new Set(TOKEN_MOVING_SELECTORS.map((s) => s.toLowerCase()));
  p.targets.forEach((t, i) => {
    const sels = p.selectors[i] ?? [];
    if (sels.some((s) => moving.has(s.toLowerCase())) && !tokens.includes(t.toLowerCase()))
      fail(`targets[${i}] allows a token-moving function but is not listed in tokens`);
  });
}

export function encodePolicy(p: Policy): Hex {
  validatePolicy(p);
  return encodeAbiParameters(POLICY_ABI, [
    {
      version: p.version,
      targets: p.targets,
      codeHashes: p.codeHashes,
      selectors: p.selectors,
      payees: p.payees,
      spenders: p.spenders,
      operators: p.operators,
      tokens: p.tokens,
      tokenKinds: p.tokenKinds,
      maxOut: p.maxOut,
      dailyCap: p.dailyCap,
      maxEth: p.maxEth,
      rateLimitPerHour: p.rateLimitPerHour,
      askOwnerAbove: p.askOwnerAbove,
      blockNewContracts: p.blockNewContracts,
    },
  ]);
}

/** Decodes and validates. Throws PolicyError on empty, malformed or inconsistent data (fail closed). */
export function decodePolicy(data: Hex): Policy {
  if (data === '0x') throw new PolicyError('policy record is empty');
  let raw;
  try {
    [raw] = decodeAbiParameters(POLICY_ABI, data);
  } catch (e) {
    throw new PolicyError(`policy record is not decodable: ${(e as Error).message}`);
  }
  const p: Policy = {
    version: raw.version,
    targets: [...raw.targets],
    codeHashes: [...raw.codeHashes],
    selectors: raw.selectors.map((s) => [...s]),
    payees: [...raw.payees],
    spenders: [...raw.spenders],
    operators: [...raw.operators],
    tokens: [...raw.tokens],
    tokenKinds: raw.tokenKinds.map((k) => k as TokenKind),
    maxOut: [...raw.maxOut],
    dailyCap: [...raw.dailyCap],
    maxEth: raw.maxEth,
    rateLimitPerHour: raw.rateLimitPerHour,
    askOwnerAbove: raw.askOwnerAbove,
    blockNewContracts: raw.blockNewContracts,
  };
  validatePolicy(p);
  // Reject non-canonical encodings (e.g. trailing bytes): re-encoding must reproduce the input.
  if (encodePolicy(p).toLowerCase() !== data.toLowerCase()) throw new PolicyError('policy record is not canonically encoded');
  return p;
}
