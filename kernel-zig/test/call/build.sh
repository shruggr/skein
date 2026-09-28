#!/usr/bin/env bash
# Build the `call` probe (#40) into probe.wasm (committed; src/host/call.test.ts runs it).
set -euo pipefail
cd "$(dirname "$0")"
mise exec -- zig build-exe probe.zig -target wasm32-wasi -O ReleaseSmall -fstrip -femit-bin=probe.wasm
rm -f probe.wasm.o
