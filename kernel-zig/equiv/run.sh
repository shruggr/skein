#!/usr/bin/env bash
# The Zig kernel's checks: unit tests, the shell cases against the TS shell
# (stdout/stderr/exit/tree carry no fuel), git in the VM, and replay
# exactness Zig against Zig (issue #5: from fuel on the Zig kernel is its own
# reference) over a generated corpus (format 2, issue #33: written by the Zig
# kernel as the router drives it) and over the stores `serve` writes.
# Run from anywhere; needs node (26) and the repo's node_modules. Never
# touches the stores under $SKEIN_HOME: they predate fuel.
#
#   kernel-zig/equiv/run.sh
set -euo pipefail
kz="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
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

echo "== replay, Zig against Zig: a generated corpus (format 2, written by the Zig kernel through the router)"
"${node[@]}" "$kz/equiv/corpus.ts" "$work/gen" > "$work/gen.list"
mapfile -t gen < "$work/gen.list"
"${node[@]}" "$kz/equiv/replays.ts" "${gen[@]}" || status=1

echo "== a store in an older format (host-signed, before format 2) is refused for running"
"${node[@]}" "$kz/equiv/old-store.ts" "$work/old.db"
if echo '[]' | "$kz/zig-out/bin/skein-kernel" shell "$work/old.db" 2> "$work/old.err" > /dev/null; then
  echo "FAIL an older store with a log was opened"; status=1
elif grep -q -e "before format 2" -e "before fuel metering" "$work/old.err"; then
  echo "ok   refused: $(head -1 "$work/old.err")"
else
  echo "FAIL refused for another reason: $(cat "$work/old.err")"; status=1
fi

echo "== the wallet in the VM (#29): oracle signing, plain entries, http to a fake ARC, deadline wakes; replayed"
"${node[@]}" "$kz/equiv/wallet.ts" || status=1

echo "== serve: the process interface, fuel exhaustion, its stores replayed"
"${node[@]}" "$kz/equiv/serve.ts" || status=1

exit $status
