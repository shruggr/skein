#!/usr/bin/env bash
# Build programs/test/perm-probe (call permissions) into bin/perm-probe.wasm here (committed; kernel-zig/equiv/call-permissions.ts installs it).
set -euo pipefail
cd "$(dirname "$0")"
mise exec -- zig build "$@"
mkdir -p bin
cp zig-out/bin/perm-probe.wasm bin/perm-probe.wasm
