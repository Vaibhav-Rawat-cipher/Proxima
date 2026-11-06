import type { RulesDraft, Labeled } from './rules.js';

/** An ERC-20 token the agent may move, with its caps in token units. */
export type PresetToken = Labeled & { decimals: number; maxPerTx: string; perDay: string };
/** A router (trading) or vault (DeFi deposits) and the functions the agent may call on it. */
export type PresetContract = Labeled & { functions: string[] };
export type PresetInput = {
  payees?: Labeled[];
  tokens?: PresetToken[];
  /** Native ETH limits; omitted/null = no ETH. */
  eth?: { maxPerTx: string; perDay: string } | null;
  contract?: PresetContract;
  askOwnerAboveUsd?: string;
  rateLimitPerHour?: number;
  blockNewContracts?: boolean;
};
export type PresetId = 'payments' | 'trading' | 'defi-deposits' | 'read-only';
export type Preset = {
  id: PresetId;
  title: string;
  /** Plain-language explanation shown to the owner, including what the preset does NOT cover. */
  description: string;
  /** Inputs the owner must provide. */
  needs: (keyof PresetInput)[];
  build(input: PresetInput): RulesDraft;
};

const TRANSFER = 'transfer(address,uint256)';
const APPROVE = 'approve(address,uint256)';

const need = <T>(v: T | undefined, what: string, preset: string): T => {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) throw new Error(`The "${preset}" preset needs ${what}.`);
  return v;
};
const base = (i: PresetInput): Omit<RulesDraft, 'payees' | 'allowEthToPayees' | 'eth' | 'tokens' | 'contracts' | 'spenders' | 'operators'> => ({
  version: 1,
  rateLimitPerHour: i.rateLimitPerHour ?? 10,
  askOwnerAboveUsd: i.askOwnerAboveUsd ?? '20',
  blockNewContracts: i.blockNewContracts ?? true,
});
// Code hashes are left unresolved (undefined): resolveCodeHashes reads them from the chain (proxies stay unpinned).
const tokenEntries = (tokens: PresetToken[], functions: string[]) => tokens.map((t) => ({ ...t, kind: 'erc20' as const, functions: [...functions] }));
// Copies, so editing a draft never changes the caller's input.
const copy = (xs: Labeled[] | undefined) => (xs ?? []).map((x) => ({ ...x }));
const ethOf = (i: PresetInput) => (i.eth ? { ...i.eth } : null);

/** Owner-facing rule presets (SPEC: presets, rule editor, plain-English helper). Every result goes through toPolicy. */
export const PRESETS: Record<PresetId, Preset> = {
  payments: {
    id: 'payments',
    title: 'Payments only',
    description:
      'The agent may pay approved recipients in the listed tokens (and ETH if set), within per-transaction and daily caps. ' +
      'Payments above the ask-owner threshold wait for you. No approvals, no other contracts.',
    needs: ['payees', 'tokens'],
    build(i) {
      return {
        ...base(i),
        payees: copy(need(i.payees, 'at least one approved recipient', 'payments')),
        allowEthToPayees: Boolean(i.eth),
        eth: ethOf(i),
        tokens: tokenEntries(need(i.tokens, 'at least one token with caps', 'payments'), [TRANSFER]),
        contracts: [],
        spenders: [],
        operators: [],
      };
    },
  },
  trading: {
    id: 'trading',
    title: 'Trading',
    description:
      'The agent may swap the listed tokens on one router: it approves the router for the exact amount and swaps in the same transaction ' +
      '(an approval left over afterwards is rejected on-chain). Outflows are capped per token. The module caps what leaves the wallet; ' +
      "where a swap's output goes is checked by the wallet's simulation (claim vs reality), not by the module.",
    needs: ['contract', 'tokens'],
    build(i) {
      const router = need(i.contract, 'the router contract and its swap functions', 'trading');
      return {
        ...base(i),
        payees: copy(i.payees),
        allowEthToPayees: false,
        eth: ethOf(i),
        tokens: tokenEntries(need(i.tokens, 'the tokens the agent may sell, with caps', 'trading'), [APPROVE]),
        contracts: [{ address: router.address, ...(router.label ? { label: router.label } : {}), functions: need(router.functions, "the router's swap functions", 'trading') }],
        spenders: [{ address: router.address, ...(router.label ? { label: router.label } : {}) }],
        operators: [],
      };
    },
  },
  'defi-deposits': {
    id: 'defi-deposits',
    title: 'DeFi deposits',
    description:
      'The agent may deposit the listed tokens into one vault (and call the other vault functions you list), approving the vault for the exact amount ' +
      'in the same transaction. Deposits are capped per token. If the vault is a proxy, the wallet blocks it after an upgrade until you re-approve it.',
    needs: ['contract', 'tokens'],
    build(i) {
      const vault = need(i.contract, 'the vault contract and its functions (e.g. deposit)', 'defi-deposits');
      return {
        ...base(i),
        payees: copy(i.payees),
        allowEthToPayees: false,
        eth: ethOf(i),
        tokens: tokenEntries(need(i.tokens, 'the tokens the agent may deposit, with caps', 'defi-deposits'), [APPROVE]),
        contracts: [{ address: vault.address, ...(vault.label ? { label: vault.label } : {}), functions: need(vault.functions, "the vault's functions", 'defi-deposits') }],
        spenders: [{ address: vault.address, ...(vault.label ? { label: vault.label } : {}) }],
        operators: [],
      };
    },
  },
  'read-only': {
    id: 'read-only',
    title: 'Read-only',
    description: 'The agent may read and propose, but every transaction is rejected: BlindspotModule allows no contract, recipient or token.',
    needs: [],
    build(i) {
      return { ...base(i), askOwnerAboveUsd: '0', rateLimitPerHour: 0, payees: [], allowEthToPayees: false, eth: null, tokens: [], contracts: [], spenders: [], operators: [] };
    },
  },
};
