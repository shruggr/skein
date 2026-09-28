#!/usr/bin/env bash
# Everything that says the Zig kernel is the TS runtime: unit tests, the
# shell cases, replay equivalence over a generated corpus and over copies of
# the instance stores under $SKEIN_HOME (never opened in place), and the
# process interface. Run from anywhere; needs node (26) and the repo's
# node_modules.
#
#   kernel-zig/equiv/run.sh              # all of it
#   SKEIN_EQUIV_LIVE=0 kernel-zig/equiv/run.sh   # skip the stores under $SKEIN_HOME
set -euo pipefail
kz="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
root="$(cd "$kz/.." && pwd)"
node=(node --experimental-strip-types --no-warnings)
work="$(mktemp -d "${TMPDIR:-/tmp}/skein-kz-equiv-XXXXXX")"
trap 'rm -rf "$work"' EXIT
status=0

echo "== build and unit tests"
(cd "$kz" && mise exec -- zig build --release && mise exec -- zig build test --summary all 2>&1 | grep "Build Summary")

echo "== shell: host-go's cases"
"${node[@]}" "$kz/equiv/shell.ts" || status=1

echo "== git in the VM: the verbs, the synthetic object directory (issue #2)"
"${node[@]}" "$kz/equiv/git.ts" | grep -E "^(ok|FAIL)|failed$|all ok" || status=1 # pipefail: git.ts's status counts

echo "== replay: a generated corpus"
"${node[@]}" "$kz/equiv/corpus.ts" "$work/gen" > "$work/gen.list"
mapfile -t gen < "$work/gen.list"
"${node[@]}" "$kz/equiv/replays.ts" "${gen[@]}" || status=1

if [ "${SKEIN_EQUIV_LIVE:-1}" != 0 ]; then
  home="${SKEIN_HOME:-$HOME/.skein}"
  shopt -s nullglob
  live=("$home"/instances/*/runtime.db "$home"/instances/*/runtime.db.pre-* "$home"/runtime.db "$home"/runtime.db.*-era "$home"/runtime.db.*-edge)
  if [ ${#live[@]} -gt 0 ]; then
    echo "== replay: copies of the stores under $home"
    "${node[@]}" "$kz/equiv/replays.ts" "${live[@]}" || status=1
  fi
fi

echo "== serve: the process interface"
"${node[@]}" "$kz/equiv/serve.ts" || status=1

exit $status
