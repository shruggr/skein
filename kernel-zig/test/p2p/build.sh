#!/usr/bin/env bash
# Build programs/p2p-demo (#51) into p2p-demo.wasm here (committed; src/host/p2p-router.test.ts runs it).
set -euo pipefail
cd "$(dirname "$0")/../../../programs/p2p-demo"
mise exec -- zig build
cp zig-out/bin/p2p-demo.wasm ../../kernel-zig/test/p2p/p2p-demo.wasm
