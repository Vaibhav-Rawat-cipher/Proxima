# Blindspot

An agent wallet where an AI agent can be tricked, but cannot move money outside the owner's rules.
Rules live on the agent's ENSv2 name and are enforced on-chain by `BlindspotModule` on a Safe; the
wallet checks every request privately (Anon-RPC) before signing. See [SPEC.md](SPEC.md).

> Work in progress. **Step 1 (contracts + ENS) is deployed and tested on Sepolia**; see
> [docs/PROGRESS.md](docs/PROGRESS.md) for every address, transaction and test result. The full run
> guide, CROPS section, excluded traffic, limits and test table are added in step 5.

## Live on Sepolia

| What | Address |
| --- | --- |
| BlindspotModule ([verified](https://sepolia.etherscan.io/address/0x1bbeee9ea550755ae99566f7c2b6a9b381d4b874#code)) | `0x1BBeEe9eA550755Ae99566F7C2b6a9b381D4b874` |
| Safe v1.4.1 (1-of-1 owner) | `0x308924321a579844C0d7FA46Ea49dBec80a2a3F7` |
| Agent | `demo.blindspot-demo.eth` → `0xab5437DcC26cFA763692Ab2e3e6Ee46D11Fc6DF1` |
| Payees | `vendor1.blindspot-demo.eth`, `vendor2.blindspot-demo.eth` |

All addresses (ENS, Safe, module, resolvers, payees) are in [config/sepolia.json](config/sepolia.json).

## Setup

Requirements: Node 20+ with corepack (pnpm 9.15.0 is pinned in `package.json`), Git, and
[Foundry](https://getfoundry.sh).

```sh
git clone <repo-url> blindspot && cd blindspot
sh scripts/setup-submodules.sh      # do NOT use --recurse-submodules, see the Windows note
corepack pnpm install
corepack pnpm build && corepack pnpm test
cd contracts && forge build && forge test
```

Copy `.env.example` to `.env` for Sepolia scripts and fork tests. Never commit `.env`.

### Windows note (nexus submodule)

`ensdomains/contracts-v2` contains a nested submodule, `contracts/lib/nexus`, with a file named
`scripts/hardhat/deploy:mainnet.ts`. Windows does not allow `:` in file names, so
`git clone --recurse-submodules`, `git submodule update --init --recursive` and
`forge install ensdomains/contracts-v2` all abort with:

```
error: invalid path 'scripts/hardhat/deploy:mainnet.ts'
fatal: Unable to checkout '…' in submodule path 'contracts/lib/nexus'
```

Blindspot does not use nexus (only contracts-v2's `src/hca/` imports it). Run
`scripts/setup-submodules.sh` (Git Bash on Windows) instead: it initialises only the libraries mapped
in `contracts/remappings.txt`, non-recursively, and skips nexus.

The script also passes `core.longpaths=true` to git. Without it, cloning into a deep folder on
Windows fails with `Filename too long` inside the nested OpenZeppelin submodule (git's internal
paths exceed the 260-character limit). If you run git commands on the submodules yourself, use
`git -c core.longpaths=true …` or keep the repo in a short path such as `C:\src\blindspot`. ENS contracts are pinned to
`07e55a056f5b6a9c90119f501bdd05714e67dddd`, the commit the Sepolia ENSv2 deployment links to.

## Layout (so far)

| Path | Contents |
| --- | --- |
| `contracts/src/BlindspotModule.sol` | Safe module: ENS identity + rules, `execute` / `executeBatch`, post-checks |
| `contracts/src/PolicyCodec.sol` | On-chain policy struct, decoding and validation |
| `contracts/src/demo/` | Demo attack contracts. Built and tested locally, **not deployed** (decision pending) |
| `contracts/test/` | Unit, batch, NFT, ENS-permission and attack tests (real Safe v1.4.1 + ENSv2 code, run offline) |
| `contracts/test/fork/` | Fork tests against the live Sepolia deployment (skipped when `SEPOLIA_RPC_URL` is unset) |
| `contracts/script/` | Sepolia setup as Foundry scripts: `SetupA`–`SetupD`, `SetupFinal`, and a dry-run-only `SetupRehearsal` |
| `scripts/setup/` | TypeScript dry-run of the whole setup in one `eth_simulateV1` request (sends nothing) |
| `scripts/setup-submodules.sh` | Dependency setup that works on Windows (see the note above) |
| `packages/shared/` | TypeScript policy codec (byte-identical to Solidity) and plain-language revert reasons |
| `config/sepolia.json` | All addresses and setup transaction hashes (ENS from the official deployments page, Safe from safe-deployments) |
| `docs/PROGRESS.md` | Step-by-step record: addresses, transactions, test results, decisions |

### Running the Sepolia scripts

Keys are read inside the scripts with `vm.env*` from the local `.env`; nothing secret goes on the
command line. From Windows PowerShell:

```powershell
cd contracts
$env:Path += ";$env:USERPROFILE\.foundry\bin"
Get-Content ..\.env | ForEach-Object { if ($_ -match '^\s*([A-Z0-9_]+)\s*=(.*)$') { Set-Item "env:$($matches[1])" $matches[2].Trim().Trim('"',"'") } }
forge script script/Setup.s.sol:SetupA --rpc-url sepolia            # dry run (add --broadcast --slow to send)
forge test --match-path "test/fork/*"                               # fork tests against the live deployment
```

Script B must run between 60 seconds and 24 hours after Script A's commit (ENS commit-reveal).

## Limits (honest)

Full limits table is added in step 5. Known so far:

- **Inside-the-rules decisions are not prevented.** If the owner allowlists a contract, a call within
  the caps succeeds on-chain even if the contract is a scam (see `test_honestLimit_evilVaultInsideRules_notCaughtOnChain`).
  Only the wallet's claim-vs-reality check can flag it; the loss is bounded by `maxOut` / `dailyCap`.
- **ERC-1155 amounts are not tracked on-chain.** For an ERC-1155 token the policy must set
  `maxOut = dailyCap = 0`, which means "amount not tracked", not "nothing can move": the whole balance
  can be sent to a listed payee in one call (see `test_honestLimit_erc1155AmountNotTracked`).
  Recipients, operators, targets and functions are still enforced. List an ERC-1155 token only if
  every payee may receive all of it.
- **Proxy upgrades are not detected on-chain.** Targets with code hash `0x00…` (proxies) are checked
  by the wallet's off-chain EIP-1967 slot check; on-chain, the caps and no-leftover-approval rules
  bound the damage (see `test_attack_upgradedProxy`).
- **Wallet-only rules** (rate limit, look-alike / new-contract blocks, ask-owner threshold) are not
  enforced on-chain and do not protect against a stolen agent key.
- **If the wallet is bypassed, hidden effects, unknown events and upgraded proxies on owner-allowed
  contracts are caught only by the wallet's off-chain checks.** The on-chain module accepts them when they
  stay inside the owner's rules (proven on the Sepolia testbed: `test/testbed.ts` scenarios A, B, D, E,
  executed on a fork, all succeed through the module alone).

## Approved exceptions

- **Anon-RPC worker bundle (owner decision, 2026-11-06, "Option B").** The official harness
  `@anon-rpc/browser-harness` downloads the anonymizing network's worker bundle at runtime and runs it
  in a Web Worker inside a null-origin sandboxed iframe, only if its `keccak256` equals the hash pinned
  in the network's on-chain specifier contract. This is an approved exception to "no remote code".
  Blindspot additionally pins the expected bundle hash per network in `config/sepolia.json` and refuses
  to start the harness if the on-chain hash differs (the specifier owner can otherwise ship new code).
  The specifier read itself goes through the bootstrap RPC and is excluded (non-anonymized) traffic.

## Open questions

- **Demo/attacker contracts** (`contracts/src/demo/`: InjectToken, SimplePool, HoneypotWrapper,
  EvilVault, UpgradeableTarget): built and tested locally (`test/Attacks.t.sol`), **not deployed**.
  Whether to deploy all, deploy some, or delete them after testing is an owner decision, still pending.

## License

MIT
