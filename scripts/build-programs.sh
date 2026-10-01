#!/usr/bin/env bash
# Build skein's own programs into wasm/<name>.wasm and print their
# CIDv1(raw, sha2-256) (scripts/pin-programs.sh writes them into the pins):
# all Zig 0.16.0 (mise.toml), wasm32-wasi, over the SDK (sdk/, the
# shruggr/skein-sdk submodule: `git submodule update --init`) — the boundary
# programs (the messagebox, the front door, resolve, the wallet over the SDK's
# wallet library and bsvz) and the install handlers (objects, head, subscribe),
# plus the wire-probe test program.
#
# The apps' modules are built in their own repos (#71): run-handler and loop
# in shruggr/skein-workbench (their built modules stay pinned here, moved in by
# scripts/update-workbench.sh), static in shruggr/skein-static.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f sdk/build.zig ] || { echo "sdk/ is empty: git submodule update --init" >&2; exit 1; }
programs=(objects-handler head-handler subscribe-handler messagebox frontdoor resolve wallet)
for p in "${programs[@]}"; do
  (cd "programs/$p" && zig build)
  cp "programs/$p/zig-out/bin/$p.wasm" "wasm/$p.wasm"
done
(cd programs/test/wire-probe && zig build)
cp programs/test/wire-probe/zig-out/bin/wire-probe.wasm wasm/wire-probe.wasm
node --experimental-strip-types --no-warnings -e '
  const { readFileSync } = await import("node:fs");
  const { rawCid } = await import("./src/runtime/programs.ts");
  for (const p of process.argv.slice(1)) console.log(p, rawCid(readFileSync(`wasm/${p}.wasm`)).toString());
' "${programs[@]}" wire-probe
