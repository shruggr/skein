#!/usr/bin/env bash
# After scripts/build-programs.sh: rewrite the handler CIDs pinned in
# src/runtime/programs.ts to the freshly built wasm/*.wasm.
set -euo pipefail
cd "$(dirname "$0")/.."
for p in run-handler objects-handler head-handler subscribe-handler loop wallet; do
  cid=$(node --experimental-strip-types --no-warnings -e "
    const { readFileSync } = await import('node:fs');
    const { rawCid } = await import('./src/runtime/programs.ts');
    console.log(rawCid(readFileSync('wasm/$p.wasm')).toString());")
  sed -i -E "s|(\"$p\": CID.parse\(\")[a-z0-9]+(\"\))|\1$cid\2|" src/runtime/programs.ts
  echo "$p $cid"
done
