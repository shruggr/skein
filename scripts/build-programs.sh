#!/usr/bin/env bash
# Build the stock programs into wasm/<name>.wasm and print their
# CIDv1(raw, sha2-256) (scripts/pin-programs.sh writes them into the pins):
# all Zig 0.16.0 (mise.toml), wasm32-wasi — the handlers under programs/
# (run, objects, head, subscribe, the loop; issue #54), the wire-probe test
# program, the messagebox, the front door, resolve (over the kernel's dag-cbor
# and programs/lib), and the wallet (wallet-zig/, over bsvz).
set -euo pipefail
cd "$(dirname "$0")/.."
for p in run-handler objects-handler head-handler subscribe-handler loop wire-probe messagebox frontdoor resolve; do
  (cd "programs/$p" && zig build)
  cp "programs/$p/zig-out/bin/$p.wasm" "wasm/$p.wasm"
done
# The wallet (issue #29): over bsvz (scripts/fetch-bsvz.sh).
[ -d .build/bsvz/.git ] || scripts/fetch-bsvz.sh
(cd wallet-zig && zig build program)
cp wallet-zig/zig-out/bin/wallet.wasm wasm/wallet.wasm
node --experimental-strip-types --no-warnings -e '
  const { readFileSync } = await import("node:fs");
  const { rawCid } = await import("./src/runtime/programs.ts");
  for (const p of ["run-handler", "objects-handler", "head-handler", "subscribe-handler", "loop", "wire-probe", "wallet", "messagebox", "frontdoor", "resolve"]) console.log(p, rawCid(readFileSync(`wasm/${p}.wasm`)).toString());
'
