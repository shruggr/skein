#!/usr/bin/env bash
# Build programs/test/app-demo (#72) into bin/app-demo.wasm here (committed; kernel-zig/equiv/install.ts installs this tree).
set -euo pipefail
cd "$(dirname "$0")"
mise exec -- zig build "$@"
mkdir -p bin
cp zig-out/bin/app-demo.wasm bin/app-demo.wasm
