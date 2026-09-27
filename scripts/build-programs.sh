#!/usr/bin/env bash
# Build the handler programs under programs/ (Go, GOOS=wasip1 GOARCH=wasm) and
# the wallet (wallet-zig/, Zig wasm32-wasi) into
# wasm/<name>.wasm, and print their CIDv1(raw, sha2-256) for src/runtime/programs.ts.
# Needs Go >= 1.24 (mise). go-sdk comes from ../bsv/go-sdk via a replace directive.
set -euo pipefail
cd "$(dirname "$0")/.."
for p in run-handler objects-handler head-handler subscribe-handler loop wire-probe; do
  (cd programs && GOOS=wasip1 GOARCH=wasm go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "../wasm/$p.wasm" "./$p")
done
# The wallet (issue #29): Zig 0.15.2 (mise.toml), over bsvz (scripts/fetch-bsvz.sh).
[ -d .build/bsvz/.git ] || scripts/fetch-bsvz.sh
(cd wallet-zig && zig build program)
cp wallet-zig/zig-out/bin/wallet.wasm wasm/wallet.wasm
node --experimental-strip-types --no-warnings -e '
  const { readFileSync } = await import("node:fs");
  const { rawCid } = await import("./src/runtime/programs.ts");
  for (const p of ["run-handler", "objects-handler", "head-handler", "subscribe-handler", "loop", "wire-probe", "wallet"]) console.log(p, rawCid(readFileSync(`wasm/${p}.wasm`)).toString());
'
