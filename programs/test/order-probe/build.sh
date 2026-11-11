#!/usr/bin/env bash
# Build programs/test/order-probe (skein 0.8.0) into bin/order-probe.wasm here (committed; kernel-zig/equiv/event-order.ts installs it).
set -euo pipefail
cd "$(dirname "$0")"
mise exec -- zig build "$@"
mkdir -p bin
cp zig-out/bin/order-probe.wasm bin/order-probe.wasm
