#!/usr/bin/env bash
# Build the handler programs under programs/ (Go, GOOS=wasip1 GOARCH=wasm) into
# wasm/<name>.wasm, and print their CIDv1(raw, sha2-256) for src/runtime/programs.ts.
# Needs Go >= 1.24 (mise). go-sdk comes from ../bsv/go-sdk via a replace directive.
set -euo pipefail
cd "$(dirname "$0")/.."
for p in run-handler objects-handler loop wire-probe; do
  (cd programs && GOOS=wasip1 GOARCH=wasm go build -trimpath -ldflags="-s -w -buildid=" -o "../wasm/$p.wasm" "./$p")
done
node --experimental-strip-types --no-warnings -e '
  const { readFileSync } = await import("node:fs");
  const { rawCid } = await import("./src/runtime/programs.ts");
  for (const p of ["run-handler", "objects-handler", "loop", "wire-probe"]) console.log(p, rawCid(readFileSync(`wasm/${p}.wasm`)).toString());
'
