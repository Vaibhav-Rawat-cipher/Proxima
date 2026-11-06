import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  encodePacked,
  getContractAddress,
  keccak256,
  namehash,
  parseAbi,
  parseEther,
  parseUnits,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { encodePolicy, type Policy } from '@blindspot/shared';
import { ROOT, type Config, type SetupEnv } from './env.js';

// ---------------------------------------------------------------- ABIs (signatures from the pinned sources)
export const ABI = {
  erc20: parseAbi([
    'function mint(address to, uint256 amount)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ]),
  registrar: parseAbi([
    'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
    'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)',
    'function commit(bytes32 commitment)',
    'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
  ]),
  registry: parseAbi([
    'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
    'function getSubregistry(string label) view returns (address)',
    'function getResolver(string label) view returns (address)',
    'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
    'function roles(uint256 resource, address account) view returns (uint256)',
  ]),
  factory: parseAbi([
    'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
    'function predictProxyAddress(address deployer, uint256 salt) view returns (address)',
  ]),
  userRegistryInit: parseAbi(['function initialize((address account, uint256 roleBitmap)[] grants)']),
  resolverInit: parseAbi(['function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)']),
  resolver: parseAbi([
    'function setData(bytes name, string key, bytes value)',
    'function setText(bytes name, string key, string value)',
    'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
    'function grantSetterRoles(bytes setter, address account) returns (bool)',
    'function roles(uint256 resource, address account) view returns (uint256)',
    'function resolve(bytes name, bytes data) view returns (bytes)',
  ]),
  profiles: parseAbi([
    'function addr(bytes32 node) view returns (address)',
    'function text(bytes32 node, string key) view returns (string)',
    'function data(bytes32 node, string key) view returns (bytes)',
  ]),
  universalResolver: parseAbi(['function resolve(bytes name, bytes data) view returns (bytes, address)']),
  safeFactory: parseAbi([
    'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)',
    'function proxyCreationCode() pure returns (bytes)',
  ]),
  safe: parseAbi([
    'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
    'function enableModule(address module)',
    'function isModuleEnabled(address module) view returns (bool)',
    'function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation) returns (bool)',
  ]),
};

// ---------------------------------------------------------------- constants
/** Every role + admin role, as in the official VerifiableFactory example. Owner-only. */
export const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n;
export const YEAR = 365n * 24n * 3600n;
const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
const USDC = (n: string) => parseUnits(n, 6);

/** DNS wire-format encoding of an ENS name (labels must be < 64 bytes). */
export function dnsEncode(name: string): Hex {
  const parts = name.split('.').map((l) => {
    const b = Buffer.from(l, 'utf8');
    if (b.length === 0 || b.length > 63) throw new Error(`bad label in ${name}`);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return toHex(Buffer.concat([...parts, Buffer.from([0])]));
}

const moduleArtifact = () =>
  JSON.parse(readFileSync(resolve(ROOT, 'contracts/out/BlindspotModule.sol/BlindspotModule.json'), 'utf8')) as {
    abi: unknown[];
    bytecode: { object: Hex };
  };

// ---------------------------------------------------------------- plan types
export type Group = 'R2' | '1.4' | '1.5' | 'verify';
export type Step = {
  id: string;
  group: Group;
  title: string;
  from: Address;
  to?: Address; // undefined = contract creation
  value?: bigint;
  data: Hex;
  usdc?: bigint; // MockUSDC leaving the owner in this step
  /** Seconds the sender must wait after this step before the next one (commit-reveal). */
  waitAfter?: bigint;
  /** Verify steps only: expected outcome. */
  expect?: 'success' | 'revert';
  expectRevertName?: string;
  decode?: (ret: Hex) => string;
};

export type Plan = {
  parentName: string;
  agentName: string;
  addresses: Record<string, Address>;
  policy: Policy;
  policyEncoded: Hex;
  priceUsdc: bigint;
  steps: Step[];
};

export const AGENT_LABEL = 'demo';
const PAYEE_LABELS = ['vendor1', 'vendor2'];
const AGENT_EXPIRY_DAYS = 90n;
const SAFE_FUND_ETH = parseEther('0.01');
const SAFE_FUND_USDC = USDC('100');

export async function buildPlan(client: PublicClient, env: SetupEnv, cfg: Config, nowSec: bigint): Promise<Plan> {
  const { owner } = env;
  const E = cfg.ens;
  const S = cfg.safe;
  const parentName = `${env.parentLabel}.eth`;
  const agentName = `${AGENT_LABEL}.${parentName}`;
  const agent = env.agent.address;
  const payees = env.payees.map((p) => p.address);
  const startNonce = BigInt(await client.getTransactionCount({ address: owner }));

  // ---- deterministic addresses
  const salt = (kind: string, name: string) =>
    BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], [keccak256(stringToHex(kind)), namehash(name), 0n])));
  const registrySalt = salt('UserRegistry', parentName); // salt scheme from the official VerifiableFactory example
  const agentResolverSalt = salt('PermissionedResolver', agentName);
  const payeeResolverSalt = salt('PermissionedResolver', `payees.${parentName}`);
  const predict = (s: bigint) =>
    client.readContract({ address: E.VerifiableFactory, abi: ABI.factory, functionName: 'predictProxyAddress', args: [owner, s] });
  const registry = await predict(registrySalt);
  const agentResolver = await predict(agentResolverSalt);
  const payeeResolver = await predict(payeeResolverSalt);

  const safeInitializer = encodeFunctionData({
    abi: ABI.safe,
    functionName: 'setup',
    args: [[owner], 1n, zeroAddress, '0x', S.CompatibilityFallbackHandler, zeroAddress, 0n, zeroAddress],
  });
  const safeSaltNonce = BigInt(keccak256(stringToHex(`blindspot safe for ${agentName}`)));
  const proxyCode = await client.readContract({ address: S.SafeProxyFactory, abi: ABI.safeFactory, functionName: 'proxyCreationCode' });
  const safe = getContractAddress({
    opcode: 'CREATE2',
    from: S.SafeProxyFactory,
    salt: keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(safeInitializer), safeSaltNonce])),
    bytecode: encodePacked(['bytes', 'uint256'], [proxyCode, BigInt(S.Safe)]),
  });

  // ---- price + commitment
  const [base, premium] = await client.readContract({ address: E.ETHRegistrar, abi: ABI.registrar, functionName: 'getRegisterPrice', args: [env.parentLabel, YEAR, E.MockUSDC] });
  const priceUsdc = base + premium;
  const secret = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
  const commitment = await client.readContract({
    address: E.ETHRegistrar,
    abi: ABI.registrar,
    functionName: 'makeCommitment',
    args: [env.parentLabel, owner, secret, registry, zeroAddress, YEAR, ZERO32],
  });

  // ---- policy (owner rules) for the demo agent
  const usdcCode = await client.getCode({ address: E.MockUSDC });
  if (!usdcCode || usdcCode === '0x') throw new Error('MockUSDC has no code');
  const policy: Policy = {
    version: 1,
    targets: [E.MockUSDC, ...payees],
    codeHashes: [keccak256(usdcCode), ...payees.map(() => ZERO32)],
    selectors: [['0xa9059cbb'], ...payees.map(() => ['0x00000000' as Hex])], // transfer; plain ETH to payees
    payees,
    spenders: [],
    operators: [],
    tokens: [E.MockUSDC, zeroAddress],
    tokenKinds: [0, 0],
    maxOut: [USDC('25'), parseEther('0.002')],
    dailyCap: [USDC('50'), parseEther('0.005')],
    maxEth: parseEther('0.002'),
    rateLimitPerHour: 10,
    askOwnerAbove: USDC('20'),
    blockNewContracts: true,
  };
  const policyEncoded = encodePolicy(policy);

  const agentDns = dnsEncode(agentName);
  const agentContext = [
    `# ${agentName}`,
    'Blindspot demo agent. It manages a Safe on Sepolia through BlindspotModule.',
    'Its rules are the ABI-encoded data record "blindspot.policy" on this name (owner-only);',
    'BlindspotModule reads and enforces them on-chain for every transaction.',
    'The agent may write only the text record "agent.status". Revoking this name stops the agent.',
  ].join('\n');

  // ---- module (CREATE from the owner: address depends on the owner's nonce at that step)
  const art = moduleArtifact();
  const moduleDeployData = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args: [safe, registry, dnsEncode(parentName)] });

  const steps: Step[] = [];
  const add = (s: Step) => steps.push(s);
  const tx = (group: Group, id: string, title: string, to: Address | undefined, data: Hex, extra: Partial<Step> = {}) =>
    add({ id, group, title, from: owner, to, data, ...extra });

  // R2 — parent name + agent registry + agent + rules
  tx('R2', 'mint-usdc', 'Mint 109 MockUSDC to the owner (open faucet mint; 8.000021 for the name + 100 for the Safe, rounded up)', E.MockUSDC,
    encodeFunctionData({ abi: ABI.erc20, functionName: 'mint', args: [owner, USDC('109')] }));
  tx('R2', 'deploy-registry', `Deploy UserRegistry proxy (agent subnames of ${parentName}) via VerifiableFactory`, E.VerifiableFactory,
    encodeFunctionData({ abi: ABI.factory, functionName: 'deployProxy', args: [E.UserRegistryImpl, registrySalt,
      encodeFunctionData({ abi: ABI.userRegistryInit, functionName: 'initialize', args: [[{ account: owner, roleBitmap: ALL_ROLES }]] })] }));
  tx('R2', 'deploy-agent-resolver', `Deploy PermissionedResolver proxy for ${agentName} via VerifiableFactory`, E.VerifiableFactory,
    encodeFunctionData({ abi: ABI.factory, functionName: 'deployProxy', args: [E.PermissionedResolverImpl, agentResolverSalt,
      encodeFunctionData({ abi: ABI.resolverInit, functionName: 'initialize', args: [[{ account: owner, roleBitmap: ALL_ROLES }], []] })] }));
  tx('R2', 'approve-registrar', `Approve ETHRegistrar for exactly the name price (no leftover allowance)`, E.MockUSDC,
    encodeFunctionData({ abi: ABI.erc20, functionName: 'approve', args: [E.ETHRegistrar, priceUsdc] }));
  tx('R2', 'commit', `Commit to registering ${parentName} (commit-reveal)`, E.ETHRegistrar,
    encodeFunctionData({ abi: ABI.registrar, functionName: 'commit', args: [commitment] }), { waitAfter: 70n });
  tx('R2', 'register-parent', `Register ${parentName} for 1 year, subregistry = UserRegistry (so subnames resolve)`, E.ETHRegistrar,
    encodeFunctionData({ abi: ABI.registrar, functionName: 'register', args: [env.parentLabel, owner, secret, registry, zeroAddress, YEAR, E.MockUSDC, ZERO32] }),
    { usdc: priceUsdc });
  tx('R2', 'register-agent', `Register ${agentName} to the agent address, zero roles, expiry +${AGENT_EXPIRY_DAYS} days`, registry,
    encodeFunctionData({ abi: ABI.registry, functionName: 'register', args: [AGENT_LABEL, agent, zeroAddress, agentResolver, 0n, nowSec + AGENT_EXPIRY_DAYS * 86400n] }));
  tx('R2', 'set-policy', `Write the owner-only data record "blindspot.policy" (${(policyEncoded.length - 2) / 2} bytes)`, agentResolver,
    encodeFunctionData({ abi: ABI.resolver, functionName: 'setData', args: [agentDns, 'blindspot.policy', policyEncoded] }));
  tx('R2', 'grant-status', 'Let the agent write only the text record "agent.status" (grantSetterRoles)', agentResolver,
    encodeFunctionData({ abi: ABI.resolver, functionName: 'grantSetterRoles', args: [encodeFunctionData({ abi: ABI.resolver, functionName: 'setText', args: ['0x', 'agent.status', ''] }), agent] }));

  // 1.4 — Safe + module
  tx('1.4', 'create-safe', 'Create the Safe v1.4.1 (1-of-1, owner) with the official fallback handler', S.SafeProxyFactory,
    encodeFunctionData({ abi: ABI.safeFactory, functionName: 'createProxyWithNonce', args: [S.Safe, safeInitializer, safeSaltNonce] }));
  const moduleNonce = startNonce + BigInt(steps.length);
  const module = getContractAddress({ from: owner, nonce: moduleNonce });
  tx('1.4', 'deploy-module', `Deploy BlindspotModule(safe, agent registry, "${parentName}")`, undefined, moduleDeployData);
  const sig = encodePacked(['uint256', 'uint256', 'uint8'], [BigInt(owner), 0n, 1]); // approved-hash signature, msg.sender == owner
  tx('1.4', 'enable-module', 'Safe: enableModule(BlindspotModule) (owner-signed Safe transaction)', safe,
    encodeFunctionData({ abi: ABI.safe, functionName: 'execTransaction', args: [safe, 0n, encodeFunctionData({ abi: ABI.safe, functionName: 'enableModule', args: [module] }), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, sig] }));
  tx('1.4', 'fund-eth', 'Fund the Safe with 0.01 ETH', safe, '0x', { value: SAFE_FUND_ETH });
  tx('1.4', 'fund-usdc', 'Fund the Safe with 100 MockUSDC', E.MockUSDC,
    encodeFunctionData({ abi: ABI.erc20, functionName: 'transfer', args: [safe, SAFE_FUND_USDC] }), { usdc: SAFE_FUND_USDC });

  // 1.5 — remaining records + payee names
  tx('1.5', 'set-agent-context', 'Write ENSIP-26 text record "agent-context"', agentResolver,
    encodeFunctionData({ abi: ABI.resolver, functionName: 'setText', args: [agentDns, 'agent-context', agentContext] }));
  tx('1.5', 'set-agent-addr', `Write the address record of ${agentName}`, agentResolver,
    encodeFunctionData({ abi: ABI.resolver, functionName: 'setAddress', args: [agentDns, 60n, agent] }));
  tx('1.5', 'deploy-payee-resolver', 'Deploy an owner-only PermissionedResolver for payee names', E.VerifiableFactory,
    encodeFunctionData({ abi: ABI.factory, functionName: 'deployProxy', args: [E.PermissionedResolverImpl, payeeResolverSalt,
      encodeFunctionData({ abi: ABI.resolverInit, functionName: 'initialize', args: [[{ account: owner, roleBitmap: ALL_ROLES }], []] })] }));
  PAYEE_LABELS.forEach((label, i) => {
    const name = `${label}.${parentName}`;
    tx('1.5', `register-${label}`, `Register payee name ${name} (owned by the owner, zero extra roles)`, registry,
      encodeFunctionData({ abi: ABI.registry, functionName: 'register', args: [label, owner, zeroAddress, payeeResolver, 0n, nowSec + YEAR] }));
    tx('1.5', `addr-${label}`, `Write the address record of ${name}`, payeeResolver,
      encodeFunctionData({ abi: ABI.resolver, functionName: 'setAddress', args: [dnsEncode(name), 60n, payees[i]!] }));
  });

  return {
    parentName,
    agentName,
    addresses: { owner, agent, registry, agentResolver, payeeResolver, safe, module, ...Object.fromEntries(payees.map((p, i) => [`payee${i + 1}`, p])) },
    policy,
    policyEncoded,
    priceUsdc,
    steps,
  };
}

// ---------------------------------------------------------------- verification calls (simulated only, never sent)
export function verifySteps(plan: Plan, cfg: Config): Step[] {
  const a = plan.addresses as Record<string, Address>;
  const agentDns = dnsEncode(plan.agentName);
  const node = namehash(plan.agentName);
  const moduleAbi = parseAbi([
    'function isAgentActive(string label, address agent) view returns (bool)',
    'function execute(string label, address to, uint256 value, bytes data) returns (bytes)',
  ]);
  const v = (id: string, title: string, from: Address, to: Address, data: Hex, expect: 'success' | 'revert', extra: Partial<Step> = {}): Step => ({ id, group: 'verify', title, from, to, data, expect, ...extra });
  const transfer = (to: Address, amt: bigint) => encodeFunctionData({ abi: ABI.erc20, functionName: 'transfer', args: [to, amt] });
  return [
    v('ur-addr', `Universal Resolver: ${plan.agentName} addr == agent`, a.owner!, cfg.ens.UpgradableUniversalResolverProxy,
      encodeFunctionData({ abi: ABI.universalResolver, functionName: 'resolve', args: [agentDns, encodeFunctionData({ abi: ABI.profiles, functionName: 'addr', args: [node] })] }), 'success'),
    v('ur-policy', `Universal Resolver: ${plan.agentName} data "blindspot.policy" == written policy`, a.owner!, cfg.ens.UpgradableUniversalResolverProxy,
      encodeFunctionData({ abi: ABI.universalResolver, functionName: 'resolve', args: [agentDns, encodeFunctionData({ abi: ABI.profiles, functionName: 'data', args: [node, 'blindspot.policy'] })] }), 'success'),
    v('ur-payee', `Universal Resolver: vendor1.${plan.parentName} addr == payee 1`, a.owner!, cfg.ens.UpgradableUniversalResolverProxy,
      encodeFunctionData({ abi: ABI.universalResolver, functionName: 'resolve', args: [dnsEncode(`vendor1.${plan.parentName}`), encodeFunctionData({ abi: ABI.profiles, functionName: 'addr', args: [namehash(`vendor1.${plan.parentName}`)] })] }), 'success'),
    v('agent-setdata', 'Agent tries to overwrite "blindspot.policy" (must revert)', a.agent!, a.agentResolver!,
      encodeFunctionData({ abi: ABI.resolver, functionName: 'setData', args: [agentDns, 'blindspot.policy', '0x01'] }), 'revert', { expectRevertName: 'EACUnauthorizedAccountRoles' }),
    v('agent-settext-other', 'Agent tries to write "agent-context" (must revert)', a.agent!, a.agentResolver!,
      encodeFunctionData({ abi: ABI.resolver, functionName: 'setText', args: [agentDns, 'agent-context', 'anything'] }), 'revert', { expectRevertName: 'EACUnauthorizedAccountRoles' }),
    v('agent-status', 'Agent writes "agent.status" (allowed)', a.agent!, a.agentResolver!,
      encodeFunctionData({ abi: ABI.resolver, functionName: 'setText', args: [agentDns, 'agent.status', 'ready'] }), 'success'),
    v('module-active', 'Module: isAgentActive("demo", agent) == true', a.owner!, a.module!,
      encodeFunctionData({ abi: moduleAbi, functionName: 'isAgentActive', args: [AGENT_LABEL, a.agent!] }), 'success'),
    v('module-pay-payee', 'Agent pays 1 MockUSDC to payee 1 through the module (allowed)', a.agent!, a.module!,
      encodeFunctionData({ abi: moduleAbi, functionName: 'execute', args: [AGENT_LABEL, cfg.ens.MockUSDC, 0n, transfer(a.payee1!, parseUnits('1', 6))] }), 'success'),
    v('module-pay-attacker', 'Agent pays an unlisted address through the module (must revert)', a.agent!, a.module!,
      encodeFunctionData({ abi: moduleAbi, functionName: 'execute', args: [AGENT_LABEL, cfg.ens.MockUSDC, 0n, transfer(a.owner!, parseUnits('1', 6))] }), 'revert', { expectRevertName: 'RecipientNotAllowed' }),
    v('module-over-cap', 'Agent pays 26 MockUSDC to payee 1 (over the 25 cap, must revert)', a.agent!, a.module!,
      encodeFunctionData({ abi: moduleAbi, functionName: 'execute', args: [AGENT_LABEL, cfg.ens.MockUSDC, 0n, transfer(a.payee1!, parseUnits('26', 6))] }), 'revert', { expectRevertName: 'OutflowExceeded' }),
    v('agent-direct-safe', 'Agent calls the Safe directly, skipping the module (must revert GS104)', a.agent!, a.safe!,
      encodeFunctionData({ abi: ABI.safe, functionName: 'execTransactionFromModule', args: [cfg.ens.MockUSDC, 0n, transfer(a.agent!, 1n), 0] }), 'revert', { expectRevertName: 'Error("GS104")' }),
  ];
}
