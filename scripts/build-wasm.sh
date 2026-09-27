#!/usr/bin/env bash
# Rebuild every wasm/*.wasm shell module from pinned sources plus the patches
# in wasm/patches. Needs rustup with the wasm32-wasip1 target
# (mise use -g rust@latest && rustup target add wasm32-wasip1). findutils'
# `onig` (C) dependency needs a WASI C toolchain; this script fetches
# wasi-sdk itself (pinned below) into .build/ if it isn't there yet. Work
# happens in .build/ (git-ignored). See wasm/README.md for what each patch
# does and the toolset survey (issue #13).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BRUSH_REV=739a15d262005acc1e886da0cadf376c29070875       # reubeno/brush main, 2026-09-25
COREUTILS_REV=dc1efd89948a9ca4c78c3a4b9a6ac891019a8c69   # uutils/coreutils tag 0.12.0
FINDUTILS_REV=28be1fa20c370c43e51f0b2e81ef399f3b3a26db   # uutils/findutils tag 0.10.0
DIFFUTILS_REV=60f65858748d56d7b53c95bbcbaa61185a36c27b   # uutils/diffutils tag v0.5.0
JAQ_REV=c866e70303b5dbc37d83a0b0cbacf10e90af9c8c         # 01mf02/jaq tag v3.1.1
SED_REV=2ce633cb8dd83912d0a01cfdc6fefafdb9f28eaf         # uutils/sed tag 0.2.0
TREE_REV=dfed2820d8d761107b2ddc4bf68b4746c82af302        # peteretelej/tree tag v1.3.0
RAWK_REV=4addaefab9ff35c1e8d00ce348aacee259cf8b26        # quinnjr/rawk tag v0.2.0
WASI_SDK_VERSION=34.0
export CARGO_PROFILE_RELEASE_STRIP=true

fetch() { # url dir rev
  if [ ! -d "$2/.git" ]; then git clone -q "$1" "$2"; fi
  git -C "$2" fetch -q origin "$3" 2>/dev/null || git -C "$2" fetch -q --unshallow origin || true
  git -C "$2" checkout -q -f "$3"
  git -C "$2" clean -qfd
}

mkdir -p .build

# findutils' onig_sys (C) needs a WASI sysroot; the Rust wasm32-wasip1 target
# alone (wasi-libc bundled by rustup) is not enough for compiling C.
if [ ! -x .build/wasi-sdk/bin/clang ]; then
  arch=$(uname -m); case "$arch" in aarch64) arch=arm64 ;; esac
  curl -sL -o .build/wasi-sdk.tar.gz \
    "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION%%.*}/wasi-sdk-${WASI_SDK_VERSION}-${arch}-linux.tar.gz"
  tar -C .build -xzf .build/wasi-sdk.tar.gz
  rm .build/wasi-sdk.tar.gz
  mv ".build/wasi-sdk-${WASI_SDK_VERSION}-${arch}-linux" .build/wasi-sdk
fi
export WASI_SDK_PATH="$ROOT/.build/wasi-sdk"
export CC_wasm32_wasip1="$WASI_SDK_PATH/bin/clang"
export CFLAGS_wasm32_wasip1="--sysroot=$WASI_SDK_PATH/share/wasi-sysroot"

fetch https://github.com/reubeno/brush .build/brush "$BRUSH_REV"
git -C .build/brush apply "$ROOT/wasm/patches/brush.patch"
rustup target add wasm32-wasip1 --toolchain "$(cd .build/brush && rustup show active-toolchain | cut -d' ' -f1)" >/dev/null
(cd .build/brush && cargo build --release --target wasm32-wasip1 -p brush-shell --no-default-features --features minimal)
cp .build/brush/target/wasm32-wasip1/release/brush.wasm wasm/brush.wasm

fetch https://github.com/uutils/coreutils .build/coreutils "$COREUTILS_REV"
git -C .build/coreutils apply "$ROOT/wasm/patches/coreutils.patch"
(cd .build/coreutils && cargo build --release --target wasm32-wasip1 --no-default-features --features feat_wasm)
cp .build/coreutils/target/wasm32-wasip1/release/coreutils.wasm wasm/coreutils.wasm

# --- the toolset (issue #13): search/edit/structured-data beyond coreutils ---

fetch https://github.com/uutils/findutils .build/findutils "$FINDUTILS_REV"
git -C .build/findutils apply "$ROOT/wasm/patches/findutils.patch"
(cd .build/findutils && cargo build --release --target wasm32-wasip1 --bin find --bin xargs)
cp .build/findutils/target/wasm32-wasip1/release/find.wasm wasm/find.wasm
cp .build/findutils/target/wasm32-wasip1/release/xargs.wasm wasm/xargs.wasm

fetch https://github.com/uutils/diffutils .build/diffutils "$DIFFUTILS_REV"
git -C .build/diffutils apply "$ROOT/wasm/patches/diffutils.patch"
(cd .build/diffutils && cargo build --release --target wasm32-wasip1)
# One multicall binary (like coreutils' own), registered under both names.
cp .build/diffutils/target/wasm32-wasip1/release/diffutils.wasm wasm/diff.wasm
cp .build/diffutils/target/wasm32-wasip1/release/diffutils.wasm wasm/cmp.wasm

fetch https://github.com/01mf02/jaq .build/jaq "$JAQ_REV"
git -C .build/jaq apply "$ROOT/wasm/patches/jaq.patch"
(cd .build/jaq && cargo build --release --target wasm32-wasip1 -p jaq --no-default-features)
cp .build/jaq/target/wasm32-wasip1/release/jaq.wasm wasm/jq.wasm

fetch https://github.com/uutils/sed .build/sed-cli "$SED_REV"
git -C .build/sed-cli apply "$ROOT/wasm/patches/sed.patch"
(cd .build/sed-cli && cargo build --release --target wasm32-wasip1)
cp .build/sed-cli/target/wasm32-wasip1/release/sed.wasm wasm/sed.wasm

fetch https://github.com/peteretelej/tree .build/tree-cli "$TREE_REV"
(cd .build/tree-cli && cargo build --release --target wasm32-wasip1)
cp .build/tree-cli/target/wasm32-wasip1/release/tree.wasm wasm/tree.wasm

fetch https://github.com/quinnjr/rawk .build/rawk "$RAWK_REV"
(cd .build/rawk && cargo build --release --target wasm32-wasip1)
cp .build/rawk/target/wasm32-wasip1/release/awk-rs.wasm wasm/awk.wasm

# which, grep: first-party (no upstream Rust CLI exists for either — see
# wasm/README.md), built straight from wasm/tools/.
(cd wasm/tools/which && cargo build --release --target wasm32-wasip1)
cp wasm/tools/which/target/wasm32-wasip1/release/which.wasm wasm/which.wasm
(cd wasm/tools/grep && cargo build --release --target wasm32-wasip1)
cp wasm/tools/grep/target/wasm32-wasip1/release/grep.wasm wasm/grep.wasm

sha256sum wasm/*.wasm
