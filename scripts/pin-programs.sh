#!/usr/bin/env bash
# After scripts/build-programs.sh: rewrite the pinned module CIDs to the
# committed wasm/*.wasm — the Zig kernel's pins (kernel-zig/src/programs.zig)
# for the boundary programs, and the wallet's in both it and
# src/runtime/programs.ts. Nothing else is pinned (#83: the shell and the chat
# loop are apps, shruggr/skein-shell and shruggr/skein-chat).
set -euo pipefail
cd "$(dirname "$0")/.."
cid() {
  node --experimental-strip-types --no-warnings -e "
    const { readFileSync } = await import('node:fs');
    const { rawCid } = await import('./src/runtime/programs.ts');
    console.log(rawCid(readFileSync('wasm/$1.wasm')).toString());"
}
for p in messagebox frontdoor resolve wallet; do
  c=$(cid "$p")
  sed -i -E "s|(\.name = \"$p\", \.cid = \")[a-z0-9]+(\")|\1$c\2|" kernel-zig/src/programs.zig
  echo "$p $c"
done
c=$(cid wallet)
sed -i -E "s|(\"wallet\": CID.parse\(\")[a-z0-9]+(\"\))|\1$c\2|" src/runtime/programs.ts
