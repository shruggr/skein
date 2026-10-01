#!/usr/bin/env bash
# Build the components unit test's fixtures from probe.c (issue #34):
#   probe.p1.wasm         preview1 module (wasi-sdk, wasm32-wasip1)
#   probe.adapted.wasm    that module made a component with the preview1 adapter
#   probe.p2.wasm         a native WASI 0.2 component (wasi-sdk, wasm32-wasip2)
#   fetch.wasm            a component that GETs by emit to the fetch provider (#15, #70): programs/fetch (Zig 0.16.0)
#   p2p.wasm              a component that publishes by emit to the libp2p provider (#51, #70): programs/p2p-component (Zig 0.16.0)
# The outputs are committed; `zig build test` needs none of the tools.
# Needs wasi-sdk 34 ($WASI_SDK, default ~/.local/wasi-sdk-34.0), wasm-tools
# 1.259.0 on PATH and wasmtime v49.0.1's preview1 command adapter
# ($SKEIN_WASI_ADAPTER, default ~/.local/wasi-adapter-v49.0.1/…).
set -euo pipefail
cd "$(dirname "$0")"
sdk=${WASI_SDK:-$HOME/.local/wasi-sdk-34.0}
adapter=${SKEIN_WASI_ADAPTER:-$HOME/.local/wasi-adapter-v49.0.1/wasi_snapshot_preview1.command.wasm}
"$sdk/bin/clang" --target=wasm32-wasip1 --sysroot="$sdk/share/wasi-sysroot" -O2 -s -o probe.p1.wasm probe.c
wasm-tools component new probe.p1.wasm --adapt "wasi_snapshot_preview1=$adapter" -o probe.adapted.wasm
"$sdk/bin/clang" --target=wasm32-wasip2 --sysroot="$sdk/share/wasi-sysroot" -O2 -s -o probe.p2.wasm probe.c
(cd ../../../programs/fetch && mise exec -- zig build)
cp ../../../programs/fetch/zig-out/bin/fetch.wasm fetch.wasm
(cd ../../../programs/p2p-component && mise exec -- zig build)
cp ../../../programs/p2p-component/zig-out/bin/p2p.wasm p2p.wasm
ls -l probe.*.wasm fetch.wasm p2p.wasm
