// The owner's own browser wallet (MetaMask, Rabby, Coinbase Wallet, …) for changing the rules — the way any dapp asks
// for a signature: connect, the wallet shows the transaction, the owner confirms there. No key is pasted and no
// password is asked here. Standard APIs only: EIP-1193 (provider.request) and EIP-6963 (multi-wallet discovery).
// The transaction is the same resolver.setData(<agent name>, "blindspot.policy", <rules>) the rules key used to sign;
// the resolver's ENSv2 roles decide on-chain who may send it (the owner, or any account granted ROLE_SET_DATA).
import { toHex, type Address, type Hex } from 'viem';

type RequestArgs = { method: string; params?: unknown[] | Record<string, unknown> };
export type Eip1193Provider = {
  request(a: RequestArgs): Promise<unknown>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
};
type Announced = { info: { uuid: string; name: string; rdns: string; icon: string }; provider: Eip1193Provider };

const announced = new Map<string, Announced>();
window.addEventListener('eip6963:announceProvider', (e) => {
  const d = (e as CustomEvent<Announced>).detail;
  if (d?.info?.uuid && d.provider) announced.set(d.info.uuid, d);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

export type OwnerWallet = { address: Address; name: string; provider: Eip1193Provider };
let current: OwnerWallet | undefined;
let onChange: ((w: OwnerWallet | undefined) => void) | undefined;
export const ownerWallet = () => current;
export const onOwnerWalletChange = (cb: (w: OwnerWallet | undefined) => void) => (onChange = cb);

function pick(): { name: string; provider: Eip1193Provider } | undefined {
  const list = [...announced.values()];
  const mm = list.find((x) => x.info.rdns === 'io.metamask');
  const first = mm ?? list[0];
  if (first) return { name: first.info.name, provider: first.provider };
  const legacy = (window as unknown as { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum;
  return legacy ? { name: legacy.isMetaMask ? 'MetaMask' : 'your browser wallet', provider: legacy } : undefined;
}
export const hasBrowserWallet = () => Boolean(pick());

/** EIP-1193 errors → plain words. */
export function walletError(e: unknown): string {
  const err = e as { code?: number; message?: string; shortMessage?: string };
  switch (err?.code) {
    case 4001:
      return 'You cancelled the request in your wallet. Nothing was changed.';
    case 4100:
      return 'Your wallet did not allow this site. Unlock your wallet and connect this site, then try again.';
    case 4900:
    case 4901:
      return 'Your wallet is not connected to a network. Open it, pick Sepolia, then try again.';
    case -32002:
      return 'Your wallet already has a request waiting. Open the wallet extension and answer it.';
  }
  const m = err?.shortMessage ?? err?.message ?? String(e);
  if (/user (rejected|denied)/i.test(m)) return 'You cancelled the request in your wallet. Nothing was changed.';
  return m.split('\n')[0]!.slice(0, 240);
}

const SEPOLIA = 11155111;
async function ensureSepolia(p: Eip1193Provider) {
  const id = Number(await p.request({ method: 'eth_chainId' }));
  if (id === SEPOLIA) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(SEPOLIA) }] });
  } catch (e) {
    if ((e as { code?: number }).code === 4001) throw new Error('Please switch your wallet to the Sepolia test network to change the rules.');
    throw new Error(`Switch your wallet to the Sepolia test network, then try again (${walletError(e)}).`);
  }
}

/** Connects (or reuses) the owner's browser wallet on Sepolia. */
export async function connectOwnerWallet(): Promise<OwnerWallet> {
  const w = pick();
  if (!w) throw new Error('No browser wallet found. Install MetaMask (or another wallet), add the owner account, then try again.');
  let accounts: string[];
  try {
    accounts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[];
  } catch (e) {
    throw new Error(walletError(e));
  }
  if (!accounts?.length) throw new Error('Your wallet did not share an account. Unlock it and try again.');
  try {
    await ensureSepolia(w.provider);
  } catch (e) {
    throw new Error(walletError(e));
  }
  current = { address: accounts[0] as Address, name: w.name, provider: w.provider };
  w.provider.on?.('accountsChanged', (a) => {
    const list = a as string[];
    current = list?.length ? { address: list[0] as Address, name: w.name, provider: w.provider } : undefined;
    onChange?.(current);
  });
  onChange?.(current);
  return current;
}

/** Asks the owner's wallet to send the transaction (the wallet shows it and picks fees). */
export async function sendFromOwnerWallet(w: OwnerWallet, tx: { to: Address; data: Hex; gas: bigint }): Promise<Hex> {
  await ensureSepolia(w.provider);
  try {
    return (await w.provider.request({ method: 'eth_sendTransaction', params: [{ from: w.address, to: tx.to, data: tx.data, value: '0x0', gas: toHex(tx.gas) }] })) as Hex;
  } catch (e) {
    throw new Error(walletError(e));
  }
}

/** Polls the owner's wallet for the receipt (the same provider that broadcast it). */
export async function waitForReceipt(w: OwnerWallet, hash: Hex, timeoutMs = 240_000): Promise<{ status: 'success' | 'reverted' }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = (await w.provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null)) as { status?: string } | null;
    if (r?.status) return { status: r.status === '0x1' ? 'success' : 'reverted' };
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('Sepolia has not confirmed the change yet. It may still go through — check the transaction link, then refresh the rules.');
}
