#!/usr/bin/env sh
# Initialise the Solidity dependencies without the ones that cannot be checked out on Windows.
#
# Why: ensdomains/contracts-v2 has a nested submodule `contracts/lib/nexus` containing the file
# `scripts/hardhat/deploy:mainnet.ts`. ':' is not allowed in Windows file names, so
# `git submodule update --init --recursive` (and `forge install`) aborts on Windows.
# Blindspot does not use nexus (only contracts-v2's src/hca/ imports it), so it is skipped here.
# Only the nested libraries that contracts/remappings.txt maps are initialised, non-recursively.
#
# core.longpaths: nested submodule git data (e.g. .git/modules/.../openzeppelin-contracts-upgradeable/
# objects/pack/*.keep) can exceed Windows' 260-character path limit when the repo lives in a deep
# folder ("Filename too long"). `git -c` passes the setting to the nested clones without changing
# the user's global git config. It has no effect on macOS/Linux.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git -c core.longpaths=true submodule update --init contracts/lib/forge-std contracts/lib/safe-smart-account contracts/lib/contracts-v2

cd contracts/lib/contracts-v2
git -c core.longpaths=true submodule update --init \
  contracts/lib/openzeppelin-contracts \
  contracts/lib/openzeppelin-contracts-upgradeable \
  contracts/lib/openzeppelin-contracts-v4 \
  contracts/lib/ens-contracts \
  contracts/lib/buffer \
  contracts/lib/unruggable-gateways \
  contracts/lib/verifiable-factory \
  contracts/lib/solady \
  contracts/lib/solsha1

echo "Solidity dependencies ready (nexus intentionally skipped)."
