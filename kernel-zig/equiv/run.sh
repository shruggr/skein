#!/usr/bin/env bash
# The Zig kernel's checks: unit tests, the shell cases against the results
# recorded from the TS shell (equiv/shell-expected.json, issue #55;
# stdout/stderr/exit/tree carry no fuel), git in the VM, and replay
# exactness Zig against Zig (issue #5: from fuel on the Zig kernel is its own
# reference) over a generated corpus (format 2, issue #33: written by the Zig
# kernel as the router drives it) and over the stores `serve` writes.
# Run from anywhere; needs node (26) and the repo's node_modules; for the
# component cases (issue #34) wasm-tools and the preview1 adapter (README,
# "Components"), else those are skipped with a note. Never
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

echo "== fuel by instrumentation (issue #35): the corpus replayed with every module counting its own fuel, as under V8"
for db in "${gen[@]}"; do
  n="$(basename "$db" .db)"
  cp "$db" "$work/$n.fi.db"; [ -f "$db-wal" ] && cp "$db-wal" "$work/$n.fi.db-wal"
  a="$("$kz/zig-out/bin/skein-kernel" replay "$work/$n.fi.db" "$work/$n.fa.db")"
  b="$(SKEIN_FUEL_MODE=instrument "$kz/zig-out/bin/skein-kernel" replay "$work/$n.fi.db" "$work/$n.fb.db")"
  if [ "$a" = "$b" ]; then echo "ok   $n: the same report, fuel included"; else echo "FAIL $n: instrumented fuel differs from wasmtime's"; status=1; fi
done

# The browser build (issue #35): the same corpus replayed by the wasm kernel in
# headless Chrome (a Worker, IndexedDB) against the native replay. About 10 s
# a store; SKEIN_EQUIV_BROWSER=0 skips it, and it is skipped (with a note)
# without Playwright or Chromium.
if [ "${SKEIN_EQUIV_BROWSER:-1}" = "0" ]; then
  echo "== browser: skipped (SKEIN_EQUIV_BROWSER=0)"
elif ! command -v playwright > /dev/null || [ ! -x "${SKEIN_CHROMIUM:-/usr/bin/chromium}" ]; then
  echo "== browser: skipped (no playwright on PATH or no Chromium at ${SKEIN_CHROMIUM:-/usr/bin/chromium})"
else
  echo "== browser (issue #35): the corpus replayed by the wasm kernel in headless Chrome, into IndexedDB"
  (cd "$kz" && mise exec -- zig build web)
  "${node[@]}" "$kz/equiv/browser.ts" "${gen[@]}" || status=1
  echo "== browser live (issue #35): an instance in Chrome chats an agent on a scratch router; the reply admitted; its store replayed natively"
  "${node[@]}" "$kz/equiv/browser-live.ts" || status=1
fi

echo "== a store in an older format (host-signed, before format 2) is refused for running"
"${node[@]}" "$kz/equiv/old-store.ts" "$work/old.db"
if echo '[]' | "$kz/zig-out/bin/skein-kernel" shell "$work/old.db" 2> "$work/old.err" > /dev/null; then
  echo "FAIL an older store with a log was opened"; status=1
elif grep -q -e "before format 2" -e "before fuel metering" "$work/old.err"; then
  echo "ok   refused: $(head -1 "$work/old.err")"
else
  echo "FAIL refused for another reason: $(cat "$work/old.err")"; status=1
fi

echo "== the wallet in the VM (#29): oracle signing, plain entries, broadcast events through the host's broadcaster (#58, #65) to a fake Arcade, statuses and proofs to every holder, a restart resumed; replayed"
# Issue #34: its component build too, when wasm-tools and the preview1 adapter are there (wallet.ts compares the ABIs).
if command -v wasm-tools > /dev/null; then
  (cd "$kz/../programs/wallet" && mise exec -- zig build component) || { echo "FAIL the wallet's component build"; status=1; }
fi
"${node[@]}" "$kz/equiv/wallet.ts" || status=1

echo "== bootstrap (#4): a system tree from a directory and from a packet, chatted with; a checkpoint restored; replayed"
"${node[@]}" "$kz/equiv/boot.ts" || status=1
echo "== a component's emit (#15, #70): the fetch component through the router's fetch provider, its answer an entry; replayed with no host to ask"
"${node[@]}" "$kz/equiv/fetch.ts" || status=1

echo "== libp2p (#51): two routers — publish, validate, admit, reject (recorded), a stream round trip (over the libp2p provider, #70); replayed natively and in the browser; a live step with no oracle in the browser"
"${node[@]}" "$kz/equiv/libp2p.ts" || status=1

echo "== overlay services (#36): programs/overlay built and tested; submit/lookup through the router with the stock SDK clients; replayed"
(cd "$kz/../programs/overlay" && mise exec -- zig build && mise exec -- zig build test) || { echo "FAIL programs/overlay build or tests"; status=1; }
"${node[@]}" "$kz/equiv/overlay.ts" || status=1

echo "== static files (#52): the app shruggr/skein-static (#71: cloned at static.ts's pinned commit, or \$SKEIN_STATIC_DIR) in a tree; its files through its routes (types, index, 301, 404s, 405, HEAD, ETag/304); each request an entry, no head moved; replayed"
"${node[@]}" "$kz/equiv/static.ts" || status=1

echo "== serve: the process interface, fuel exhaustion, its stores replayed"
"${node[@]}" "$kz/equiv/serve.ts" || status=1

exit $status
