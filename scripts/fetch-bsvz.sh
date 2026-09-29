#!/usr/bin/env bash
# Fetch bsvz (b-open-io/bsvz, the BSV primitives wallet-zig builds on) at a
# pinned revision into .build/bsvz and apply wallet-zig/patches/bsvz.patch
# (what it takes to build for wasm32-wasi; see docs/WALLET.md).
# wallet-zig/build.zig.zon names .build/bsvz as a path dependency.
# BSVZ_SRC may point at a local clone to fetch from instead of GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
# Chronicle script rules on by default, Zig 0.16 (issue #53). This is the head
# of branch `chronicle` on shruggr/bsvz, open as opldotdev/bsvz PR #2: once
# that PR is merged, move SRC to https://github.com/opldotdev/bsvz and
# BSVZ_REV to the merged commit.
BSVZ_REV=8e1c9563c88d8191c0829e8f40717cd6f4f8b2c7   # shruggr/bsvz chronicle (opldotdev/bsvz#2)
SRC=${BSVZ_SRC:-https://github.com/shruggr/bsvz}
mkdir -p .build
if [ ! -d .build/bsvz/.git ]; then git clone -q "$SRC" .build/bsvz; fi
git -C .build/bsvz fetch -q origin "$BSVZ_REV" 2>/dev/null || true
git -C .build/bsvz checkout -q -f "$BSVZ_REV"
git -C .build/bsvz clean -qfd
git -C .build/bsvz apply "$PWD/wallet-zig/patches/bsvz.patch"
echo "bsvz $BSVZ_REV (+ wallet-zig/patches/bsvz.patch) in .build/bsvz"
