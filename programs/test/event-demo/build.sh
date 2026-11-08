#!/usr/bin/env bash
# Build programs/test/event-demo (skein 0.5.0) into bin/event-demo.wasm here (committed; kernel-zig/equiv/event-index.ts installs it).
set -euo pipefail
cd "$(dirname "$0")"
mise exec -- zig build "$@"
mkdir -p bin
cp zig-out/bin/event-demo.wasm bin/event-demo.wasm
