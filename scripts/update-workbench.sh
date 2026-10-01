#!/usr/bin/env bash
# Move a build of the workbench (shruggr/skein-workbench, #71) into skein: the
# stock genesis wires `run` → run-handler and `chat` → loop, and the kernel's
# stock shell program names the toolset's modules, so their built modules are
# committed here (wasm/) and pinned (kernel-zig/src/programs.zig, the shell's
# modules also in src/runtime/programs.ts); their sources live in the
# workbench.
#
#   scripts/update-workbench.sh <workbench checkout>
#
# Copies the checkout's bin/run-handler.wasm and bin/loop.wasm (`zig build bin`
# there) and, when the checkout has a toolset build (scripts/build-toolset.sh
# → out/), every module and support file in out/; rewrites the pins; and
# records the checkout's commit in wasm/WORKBENCH. A changed shell module
# changes the shell's program record: regenerate the kernel's fixtures after
# (node --experimental-strip-types --no-warnings kernel-zig/test/fixtures.ts > kernel-zig/test/fixtures.json).
set -euo pipefail
wb=$(cd "${1:?usage: scripts/update-workbench.sh <workbench checkout>}" && pwd)
cd "$(dirname "$0")/.."
cp "$wb/bin/run-handler.wasm" wasm/run-handler.wasm
cp "$wb/bin/loop.wasm" wasm/loop.wasm
scripts/pin-programs.sh | grep -E '^(run-handler|loop) '
if [ -d "$wb/out" ]; then
  for f in "$wb"/out/*.wasm "$wb"/out/*.zip; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    cp "$f" "wasm/$name"
    key=${name%.wasm}
    c=$(node --experimental-strip-types --no-warnings -e "
      const { readFileSync } = await import('node:fs');
      const { rawCid } = await import('./src/runtime/programs.ts');
      console.log(rawCid(readFileSync('wasm/$name')).toString());")
    sed -i -E "s|(\.name = \"$key\", \.cid = \")[a-z0-9]+(\")|\1$c\2|" kernel-zig/src/programs.zig
    sed -i -E "s|^(  \"?$key\"?: CID\.parse\(\")[a-z0-9]+(\"\))|\1$c\2|" src/runtime/programs.ts
    echo "$key $c"
  done
fi
rev=$(git -C "$wb" rev-parse HEAD)
echo "$rev" > wasm/WORKBENCH
echo "workbench $rev"
