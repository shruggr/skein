#!/usr/bin/env bash
# The wasmtime C API the kernel links (kernel-zig/build.zig, kernel-zig/README.md "Build"): the
# release for this machine, unpacked where build.zig looks by default —
# ~/.local/wasmtime-c-api/wasmtime-<version>-<arch>-<os>-c-api. Does nothing when it is there.
# The CI workflow runs this too (.github/workflows/test.yml).
#
#   scripts/wasmtime-c-api.sh          # prints the directory
set -euo pipefail
version=v49.0.1 # kernel-zig/build.zig WASMTIME_VERSION
case "$(uname -m)" in x86_64 | amd64) arch=x86_64 ;; aarch64 | arm64) arch=aarch64 ;; *) echo "wasmtime-c-api: no release for $(uname -m)" >&2; exit 1 ;; esac
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=macos ;; *) echo "wasmtime-c-api: no release for $(uname -s)" >&2; exit 1 ;; esac
name="wasmtime-${version}-${arch}-${os}-c-api"
root="$HOME/.local/wasmtime-c-api"
if [ ! -f "$root/$name/lib/libwasmtime.a" ]; then
  mkdir -p "$root"
  curl -fsSL "https://github.com/bytecodealliance/wasmtime/releases/download/${version}/${name}.tar.xz" | tar -xJ -C "$root"
fi
echo "$root/$name"
