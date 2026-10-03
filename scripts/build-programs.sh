#!/usr/bin/env bash
# Build skein's own programs into wasm/<name>.wasm and print their
# CIDv1(raw, sha2-256) (scripts/pin-programs.sh writes them into the pins):
# all Zig 0.16.0 (mise.toml), wasm32-wasi, over the SDK (shruggr/skein-sdk, a
# Zig package dependency by URL+hash, #75 — `zig build` fetches it; override
# with a sibling checkout via scripts/sdk-local.sh) — the boundary programs
# (the messagebox, the front door, resolve, the wallet over the SDK's wallet
# library and bsvz; the install handlers went with #77: those are kernel
# operations), plus the wire-probe test program.
#
# The apps' modules are built in their own repos (#71, #83) and installed
# with them, never pinned here: the shell and run-handler in
# shruggr/skein-shell, the chat loop in shruggr/skein-chat, static in
# shruggr/skein-static, the overlay engine in shruggr/skein-overlay.
set -euo pipefail
cd "$(dirname "$0")/.."
programs=(messagebox frontdoor resolve wallet)
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
