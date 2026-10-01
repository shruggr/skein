#!/usr/bin/env bash
# Override the skein_sdk dependency (shruggr/skein-sdk, fetched by URL+hash,
# #75) with a sibling checkout, for developing both repos at once — no edit
# to any build.zig.zon. Zig 0.16's `zig build --fork=<dir>` matches an
# override by the package name declared in <dir>/build.zig.zon, not by path
# or hash, so this one flag works no matter which consumer you build
# (kernel-zig/, a program under programs/ or programs/test/, each at a
# different depth and each with its own skein_sdk dependency).
#
# Usage: prefix the command you'd otherwise run, from anywhere:
#   cd kernel-zig && ../scripts/sdk-local.sh mise exec -- zig build test
#   cd programs/wallet && ../../scripts/sdk-local.sh mise exec -- zig build
#
# The sibling defaults to ../skein-sdk, next to this skein checkout
# (`git clone https://github.com/shruggr/skein-sdk ../skein-sdk`);
# SKEIN_SDK_DIR overrides it.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk="${SKEIN_SDK_DIR:-$root/../skein-sdk}"
[ -f "$sdk/build.zig.zon" ] || {
  echo "no sibling SDK checkout at $sdk (git clone https://github.com/shruggr/skein-sdk $sdk, or set SKEIN_SDK_DIR)" >&2
  exit 1
}
exec "$@" --fork="$sdk"
