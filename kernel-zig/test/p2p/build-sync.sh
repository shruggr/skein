#!/usr/bin/env bash
# Build programs/test/sync-demo (#154) into sync-demo.wasm here (committed; src/host/sync.test.ts runs it).
set -euo pipefail
cd "$(dirname "$0")/../../../programs/test/sync-demo"
mise exec -- zig build
cp zig-out/bin/sync-demo.wasm ../../../kernel-zig/test/p2p/sync-demo.wasm
