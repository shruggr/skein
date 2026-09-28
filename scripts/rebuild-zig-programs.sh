#!/usr/bin/env bash
# The Zig programs only (#40: frontdoor, messagebox, resolve), copied to wasm/
# and pinned (kernel-zig/src/programs.zig), then the kernel rebuilt: the quick
# loop while working on them. scripts/build-programs.sh builds everything.
set -euo pipefail
cd "$(dirname "$0")/.."
for p in frontdoor messagebox resolve; do
  (cd "programs/$p" && mise exec -- zig build)
  cp "programs/$p/zig-out/bin/$p.wasm" "wasm/$p.wasm"
done
scripts/pin-programs.sh > /dev/null
(cd kernel-zig && mise exec -- zig build --release)
