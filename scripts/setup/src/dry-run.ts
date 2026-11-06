/**
 * Dry-run of the R2 / 1.4 / 1.5 Sepolia setup. SENDS NOTHING.
 *
 * The whole plan (every owner transaction in order, the 60 s commit-reveal wait as a block-time jump,
 * then verification calls) is executed in ONE eth_simulateV1 request against live Sepolia state with
 * validation on (real nonces, balances, fees, and Sepolia's current gas schedule). All addresses are
 * predicted up front (CREATE2 / owner nonce), so they are the addresses a real run would produce if
 * nothing else touches the owner's nonce first.
 *
 * Usage: pnpm --filter @blindspot/setup dry-run [report.json]
 * Prints only public data. Never prints .env values.
 */
import { writeFileSync } from 'node:fs';
import {
  createPublicClient,
  decodeAbiParameters,
  decodeErrorResult,
  decodeFunctionResult,
  formatEther,
  formatUnits,
  http,
  numberToHex,
  parseAbi,
  parseGwei,
  type Address,
  type Hex,
} from 'viem';
import { explainModuleRevert } from '@blindspot/shared';
import { loadConfig, loadEnv } from './env.js';
import { ABI, buildPlan, verifySteps, type Step } from './plan.js';

const env = loadEnv();
const cfg = loadConfig();
const client = createPublicClient({ transport: http(env.rpcUrl) });
const line = (k: string, v: unknown) => console.log(`${k.padEnd(46)} ${v}`);

// ---------------------------------------------------------------- chain + EIP-7825 check
const chainId = await client.getChainId();
if (chainId !== 11155111) throw new Error(`not Sepolia (chainId ${chainId})`);
const latest = await client.getBlock();
const baseFee = latest.baseFeePerGas ?? 0n;
const CAP = 16_777_216n;
let overCap = 0;
let maxSeen = 0n;
for (let n = latest.number; n > latest.number - 50n; n--) {
  const b = await client.getBlock({ blockNumber: n, includeTransactions: true });
  for (const t of b.transactions) {
    if (t.gas > CAP) overCap++;
    if (t.gas > maxSeen) maxSeen = t.gas;
  }
}
console.log('# Chain');
line('chain / block', `Sepolia ${chainId} / ${latest.number} (baseFee ${baseFee} wei)`);
line('EIP-7825 check (last 50 blocks)', `${overCap} included txs with gas limit > 2^24 (largest ${maxSeen}) -> cap ${overCap > 0 ? 'NOT enforced' : 'possibly enforced: STOP'}`);

// ---------------------------------------------------------------- plan
const plan = await buildPlan(client, env, cfg, latest.timestamp);
const verify = verifySteps(plan, cfg);
console.log('\n# Inputs');
line('owner (sender of every setup tx)', env.owner);
line('owner nonce / ETH', `${await client.getTransactionCount({ address: env.owner })} / ${formatEther(await client.getBalance({ address: env.owner }))}`);
line('parent name / agent name', `${plan.parentName} / ${plan.agentName}`);
line('agent address', `${env.agent.address}${env.agent.isPlaceholder ? '  <- DRY-RUN PLACEHOLDER (set AGENT_ADDRESS)' : ''}`);
env.payees.forEach((p, i) => line(`payee ${i + 1}`, `${p.address}${p.isPlaceholder ? '  <- DRY-RUN PLACEHOLDER (set PAYEE_ADDRESSES)' : ''}`));
line('name price (1 year)', `${formatUnits(plan.priceUsdc, 6)} MockUSDC`);
console.log('\n# Predicted addresses');
for (const [k, v] of Object.entries(plan.addresses)) line(`  ${k}`, v);

// ---------------------------------------------------------------- build the simulation
const maxPriority = 1_000_000n; // 0.001 gwei tip
const maxFee = baseFee * 3n + maxPriority;
const nonces = new Map<Address, bigint>();
const nextNonce = async (a: Address) => {
  if (!nonces.has(a)) nonces.set(a, BigInt(await client.getTransactionCount({ address: a })));
  const n = nonces.get(a)!;
  nonces.set(a, n + 1n);
  return n;
};
const toCall = async (s: Step) => ({
  from: s.from,
  ...(s.to ? { to: s.to } : {}),
  data: s.data,
  value: numberToHex(s.value ?? 0n),
  nonce: numberToHex(await nextNonce(s.from)),
  maxFeePerGas: numberToHex(maxFee),
  maxPriorityFeePerGas: numberToHex(maxPriority),
});

type Block = { steps: Step[]; time: bigint; overrides?: Record<string, { balance: Hex }> };
const blocks: Block[] = [];
let t = latest.timestamp + 12n;
let cur: Block = { steps: [], time: t };
for (const s of plan.steps) {
  cur.steps.push(s);
  if (s.waitAfter) {
    blocks.push(cur);
    t += s.waitAfter;
    cur = { steps: [], time: t };
  }
}
blocks.push(cur);
// Verification block. A placeholder agent has no ETH for gas: give it some IN THE SIMULATION ONLY.
const verifyOverrides: Record<string, { balance: Hex }> = {};
if ((await client.getBalance({ address: env.agent.address })) < 10n ** 16n) verifyOverrides[env.agent.address] = { balance: numberToHex(10n ** 17n) };
blocks.push({ steps: verify, time: t + 24n, overrides: verifyOverrides });

const blockStateCalls = [];
for (const b of blocks) {
  // Sequential on purpose: nonces must be assigned in plan order (no concurrent lookups).
  const calls = [];
  for (const s of b.steps) calls.push(await toCall(s));
  blockStateCalls.push({
    blockOverrides: { time: numberToHex(b.time) },
    ...(b.overrides && Object.keys(b.overrides).length ? { stateOverrides: b.overrides } : {}),
    calls,
  });
}

type SimCall = { status: Hex; gasUsed: Hex; returnData: Hex; error?: { code: number; message: string; data?: Hex } };
/** Revert bytes of a failed simulated call: some nodes return them in returnData, others in error.data. */
const revertData = (c: SimCall): Hex | undefined =>
  c.returnData && c.returnData !== '0x' ? c.returnData : c.error?.data;
const result = (await client.request({
  method: 'eth_simulateV1' as never,
  params: [{ blockStateCalls, validation: true }, numberToHex(latest.number)] as never,
})) as unknown as { calls: SimCall[] }[];

// ---------------------------------------------------------------- decode helpers
const eacAbi = parseAbi(['error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)']);
const errorStringAbi = parseAbi(['error Error(string)']);
const revertName = (data: Hex | undefined): string => {
  if (!data || data === '0x') return 'empty revert';
  const m = explainModuleRevert(data);
  if (m.name === 'Error') return `Error("${String(m.args[0])}")`;
  if (m.name !== 'Unknown') return m.name;
  for (const abi of [eacAbi, errorStringAbi]) {
    try {
      const d = decodeErrorResult({ abi, data });
      return d.errorName === 'Error' ? `Error("${d.args?.[0]}")` : d.errorName;
    } catch {}
  }
  return `unknown ${data.slice(0, 10)}`;
};
const verifyDetail = (s: Step, ret: Hex): string => {
  try {
    if (s.id === 'ur-addr' || s.id === 'ur-payee') {
      const [inner] = decodeFunctionResult({ abi: ABI.universalResolver, functionName: 'resolve', data: ret }) as unknown as [Hex];
      const [addr] = decodeAbiParameters([{ type: 'address' }], inner);
      const want = s.id === 'ur-addr' ? plan.addresses.agent : plan.addresses.payee1;
      return `${addr} ${addr.toLowerCase() === want!.toLowerCase() ? '(matches)' : '(MISMATCH)'}`;
    }
    if (s.id === 'ur-policy') {
      const [inner] = decodeFunctionResult({ abi: ABI.universalResolver, functionName: 'resolve', data: ret }) as unknown as [Hex];
      const [bytes] = decodeAbiParameters([{ type: 'bytes' }], inner);
      return bytes.toLowerCase() === plan.policyEncoded.toLowerCase() ? 'policy bytes match' : 'POLICY MISMATCH';
    }
    if (s.id === 'module-active') return decodeAbiParameters([{ type: 'bool' }], ret)[0] ? 'true' : 'FALSE';
  } catch (e) {
    return `decode failed: ${(e as Error).message.split('\n')[0]}`;
  }
  return '';
};

// ---------------------------------------------------------------- report
const all = blocks.flatMap((b) => b.steps);
const calls = result.flatMap((b) => b.calls);
if (calls.length !== all.length) throw new Error(`simulation returned ${calls.length} results for ${all.length} calls`);

const ONE_GWEI = parseGwei('1');
let ok = true;
const rows: Record<string, unknown>[] = [];
console.log('\n# Setup transactions (simulated in order; nothing sent)');
console.log(`${'#'.padEnd(3)} ${'group'.padEnd(5)} ${'gas used'.padStart(11)} ${'ETH @ now'.padStart(14)} ${'ETH @ 1 gwei'.padStart(13)} ${'value ETH'.padStart(9)} ${'MockUSDC'.padStart(10)}  result  what`);
const totals: Record<string, { gas: bigint; value: bigint; usdc: bigint }> = {};
all.forEach((s, i) => {
  const c = calls[i]!;
  const gas = BigInt(c.gasUsed);
  const success = c.status === '0x1';
  const price = baseFee + maxPriority;
  if (s.group !== 'verify') {
    if (!success) ok = false;
    const g = (totals[s.group] ??= { gas: 0n, value: 0n, usdc: 0n });
    g.gas += gas;
    g.value += s.value ?? 0n;
    g.usdc += s.usdc ?? 0n;
    console.log(
      `${String(i + 1).padEnd(3)} ${s.group.padEnd(5)} ${gas.toString().padStart(11)} ${formatEther(gas * price).padStart(14)} ${formatEther(gas * ONE_GWEI).padStart(13)} ${formatEther(s.value ?? 0n).padStart(9)} ${formatUnits(s.usdc ?? 0n, 6).padStart(10)}  ${success ? 'OK    ' : 'FAILED'}  ${s.title}${success ? '' : ` -> ${revertName(revertData(c))} ${c.error?.message ?? ''}`}`,
    );
  }
  rows.push({ n: i + 1, id: s.id, group: s.group, title: s.title, from: s.from, to: s.to ?? null, valueWei: (s.value ?? 0n).toString(), usdc: (s.usdc ?? 0n).toString(), gasUsed: gas.toString(), status: success ? 'success' : 'revert', revert: success ? null : revertName(revertData(c)) });
});

console.log('\n# Totals');
let gasAll = 0n;
let valueAll = 0n;
let usdcAll = 0n;
for (const [g, v] of Object.entries(totals)) {
  gasAll += v.gas;
  valueAll += v.value;
  usdcAll += v.usdc;
  line(`  ${g}`, `${v.gas} gas | gas ETH @1 gwei ${formatEther(v.gas * ONE_GWEI)} | value ${formatEther(v.value)} ETH | MockUSDC spent ${formatUnits(v.usdc, 6)}`);
}
line('  ALL', `${gasAll} gas | gas ETH @now ${formatEther(gasAll * (baseFee + maxPriority))} @1 gwei ${formatEther(gasAll * ONE_GWEI)} | value ${formatEther(valueAll)} ETH | MockUSDC spent ${formatUnits(usdcAll, 6)}`);
const bal = await client.getBalance({ address: env.owner });
const breakEven = (bal - valueAll) / gasAll;
line('  owner ETH covers gas up to', `${formatUnits(breakEven, 9)} gwei (after ${formatEther(valueAll)} ETH Safe funding)`);

console.log('\n# Verification (simulated after setup; nothing sent)');
let vOk = true;
verify.forEach((s, j) => {
  const i = all.length - verify.length + j;
  const c = calls[i]!;
  const success = c.status === '0x1';
  const got = success ? 'success' : 'revert';
  const name = success ? '' : revertName(revertData(c));
  const pass = got === s.expect && (!s.expectRevertName || name === s.expectRevertName) && !/MISMATCH|FALSE|failed/.test(success ? verifyDetail(s, c.returnData) : '');
  if (!pass) {
    vOk = false;
    console.log(`        raw node response: ${JSON.stringify(c).slice(0, 400)}`);
  }
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${s.title}  -> ${got}${name ? ` (${name})` : ''}${success ? ` ${verifyDetail(s, c.returnData)}` : ''}`);
});
if (Object.keys(verifyOverrides).length) console.log('  note: the placeholder agent was given 0.1 ETH in the simulation only, to pay gas for its verify calls');

console.log(`\nRESULT: setup ${ok ? 'all OK' : 'HAS FAILURES'}, verification ${vOk ? 'all PASS' : 'HAS FAILURES'}`);

const out = process.argv[2];
if (out) {
  writeFileSync(out, JSON.stringify({ block: latest.number.toString(), baseFeeWei: baseFee.toString(), plan: { parentName: plan.parentName, agentName: plan.agentName, addresses: plan.addresses, policyEncoded: plan.policyEncoded, priceUsdc: plan.priceUsdc.toString() }, rows }, null, 2));
  console.log(`report written to ${out}`);
}
process.exit(ok && vOk ? 0 : 1);
