#!/usr/bin/env bash
# After scripts/build-programs.sh: rewrite the pinned module CIDs to the
# committed wasm/*.wasm — the Zig kernel's pins (kernel-zig/src/programs.zig)
# for the boundary programs, and the default image's bin/*.cid (#89). Nothing else is pinned (#83: the shell and the chat
# loop are apps, shruggr/skein-shell and shruggr/skein-chat).
set -euo pipefail
cd "$(dirname "$0")/.."
cid() {
  node --experimental-strip-types --no-warnings -e "
    const { readFileSync } = await import('node:fs');
    const { rawCid } = await import('./src/runtime/programs.ts');
    console.log(rawCid(readFileSync('wasm/$1.wasm')).toString());"
}
for p in mail frontdoor resolve; do
  c=$(cid "$p")
  sed -i -E "s|(\.name = \"$p\", \.cid = \")[a-z0-9]+(\")|\1$c\2|" kernel-zig/src/programs.zig
  echo "$p $c"
done
# #89: the default image names the front door and the mail program by CID.
for p in mail frontdoor; do cid "$p" > "images/default/bin/$p.cid"; done
