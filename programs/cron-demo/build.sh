#!/usr/bin/env bash
# Build programs/cron-demo (#60) into cron-demo.wasm here (committed; src/host/cron.test.ts and kernel-zig/equiv/serve.ts run it).
set -euo pipefail
cd "$(dirname "$0")"
mise exec -- zig build
cp zig-out/bin/cron-demo.wasm cron-demo.wasm
