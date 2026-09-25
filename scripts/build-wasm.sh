#!/usr/bin/env bash
# Rebuild wasm/brush.wasm and wasm/coreutils.wasm from pinned sources plus the
# patches in wasm/patches. Needs rustup with the wasm32-wasip1 target
# (mise use -g rust@latest && rustup target add wasm32-wasip1). Work happens in
# .build/ (git-ignored). See wasm/README.md for what the patches do.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BRUSH_REV=739a15d262005acc1e886da0cadf376c29070875     # reubeno/brush main, 2026-09-25
COREUTILS_REV=dc1efd89948a9ca4c78c3a4b9a6ac891019a8c69 # uutils/coreutils tag 0.12.0
export CARGO_PROFILE_RELEASE_STRIP=true

fetch() { # url dir rev
  if [ ! -d "$2/.git" ]; then git clone -q "$1" "$2"; fi
  git -C "$2" fetch -q origin "$3" 2>/dev/null || git -C "$2" fetch -q --unshallow origin || true
  git -C "$2" checkout -q -f "$3"
  git -C "$2" clean -qfd
}

mkdir -p .build
fetch https://github.com/reubeno/brush .build/brush "$BRUSH_REV"
git -C .build/brush apply "$ROOT/wasm/patches/brush.patch"
rustup target add wasm32-wasip1 --toolchain "$(cd .build/brush && rustup show active-toolchain | cut -d' ' -f1)" >/dev/null
(cd .build/brush && cargo build --release --target wasm32-wasip1 -p brush-shell --no-default-features --features minimal)
cp .build/brush/target/wasm32-wasip1/release/brush.wasm wasm/brush.wasm

fetch https://github.com/uutils/coreutils .build/coreutils "$COREUTILS_REV"
git -C .build/coreutils apply "$ROOT/wasm/patches/coreutils.patch"
(cd .build/coreutils && cargo build --release --target wasm32-wasip1 --no-default-features --features feat_wasm)
cp .build/coreutils/target/wasm32-wasip1/release/coreutils.wasm wasm/coreutils.wasm

sha256sum wasm/*.wasm
