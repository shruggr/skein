#!/usr/bin/env bash
# Fetch bsvz (b-open-io/bsvz, the BSV primitives wallet-zig builds on) at a
# pinned revision into .build/bsvz and apply wallet-zig/patches/bsvz.patch
# (what it takes to build for wasm32-wasi; see wallet-zig/README.md).
# wallet-zig/build.zig.zon names .build/bsvz as a path dependency.
# BSVZ_SRC may point at a local clone to fetch from instead of GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
BSVZ_REV=e0b4b3e623dfc731208b818c86f21054383365ae   # b-open-io/bsvz main, 2026-03-30
SRC=${BSVZ_SRC:-https://github.com/b-open-io/bsvz}
mkdir -p .build
if [ ! -d .build/bsvz/.git ]; then git clone -q "$SRC" .build/bsvz; fi
git -C .build/bsvz fetch -q origin "$BSVZ_REV" 2>/dev/null || true
git -C .build/bsvz checkout -q -f "$BSVZ_REV"
git -C .build/bsvz clean -qfd
git -C .build/bsvz apply "$PWD/wallet-zig/patches/bsvz.patch"
echo "bsvz $BSVZ_REV (+ wallet-zig/patches/bsvz.patch) in .build/bsvz"
