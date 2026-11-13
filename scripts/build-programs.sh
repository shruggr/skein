#!/usr/bin/env bash
# Build skein's own test program into wasm/wire-probe.wasm and print its CIDv1(raw, sha2-256): Zig 0.16.0
# (mise.toml), wasm32-wasi, over the SDK (shruggr/skein-sdk, a Zig package dependency by URL+hash;
# override with a sibling checkout via scripts/sdk-local.sh). skein next: the boundary programs (the
# mail program, the front door, resolve) are gone — the kernel runs a row's handler directly — and the
# apps' modules are built in their own repos and installed with them, never pinned here.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd programs/test/wire-probe && zig build)
cp programs/test/wire-probe/zig-out/bin/wire-probe.wasm wasm/wire-probe.wasm
node --experimental-strip-types --no-warnings -e '
  const { readFileSync } = await import("node:fs");
  const { rawCid } = await import("./src/runtime/programs.ts");
  console.log("wire-probe", rawCid(readFileSync("wasm/wire-probe.wasm")).toString());
'
