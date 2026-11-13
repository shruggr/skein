#!/usr/bin/env bash
# Build the skein-next test program into next.wasm (committed; src/runtime_test.zig runs it), over
# the SDK's dag-cbor codec as the kernel's build fetched it (kernel-zig/zig-pkg/skein_sdk-*).
set -euo pipefail
cd "$(dirname "$0")"
sdk=$(ls -d ../../zig-pkg/skein_sdk-* | head -1)
mise exec -- zig build-exe -target wasm32-wasi -O ReleaseSmall -fstrip \
  --dep cbor -Mroot=next.zig \
  --dep cid -Mcbor="$sdk/src/cbor.zig" \
  -Mcid="$sdk/src/cid.zig" \
  -femit-bin=next.wasm
rm -f next.wasm.o
