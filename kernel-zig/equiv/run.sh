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
# touches the stores under $SKEIN_HOME: they predate fuel. The shell and the
# chat loop are apps (#83): the drivers that run them install shruggr/skein-shell
# and shruggr/skein-chat at src/testapps.ts's pinned commits (fetched once into
# $TMPDIR/skein-apps), or $SKEIN_SHELL_DIR / $SKEIN_CHAT_DIR (checkouts).
#
#   kernel-zig/equiv/run.sh
set -euo pipefail
kz="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
node=(node --experimental-strip-types --no-warnings)
work="$(mktemp -d "${TMPDIR:-/tmp}/skein-kz-equiv-XXXXXX")"
trap 'rm -rf "$work"' EXIT
# Every mkdtemp the TS drivers make (os.tmpdir() honours TMPDIR) lands under the work dir, gone with it (#77).
export TMPDIR="$work"
status=0

echo "== build and unit tests"
(cd "$kz" && mise exec -- zig build --release && mise exec -- zig build test --summary all 2>&1 | grep "Build Summary")

echo "== shell: host-go's cases (the shell app's shell program, #83)"
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
  rm -f "$work/$n".f[iab].db* # a store with the shell app is hundreds of MB (#83); the work dir is often tmpfs
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

echo "== the wallet in the VM (#29, #79): its own records under wallet/state over the chain app (shruggr/skein-chain at wallet.ts's pinned commit, or \$SKEIN_CHAIN_DIR): signer signing, every transaction ingested by a message to the instance itself, the chain app broadcasting to a fake Arcade and answering accepted/proven/rejected; settlement and a reorg read from chain/state; replayed"
# Issue #34: its component build too, when wasm-tools and the preview1 adapter are there (wallet.ts compares the ABIs).
if command -v wasm-tools > /dev/null; then
  (cd "$kz/../programs/wallet" && mise exec -- zig build component) || { echo "FAIL the wallet's component build"; status=1; }
fi
"${node[@]}" "$kz/equiv/wallet.ts" || status=1

echo "== bootstrap (#4): a system tree from a directory and from a packet, chatted with; a checkpoint restored; replayed"
"${node[@]}" "$kz/equiv/boot.ts" || status=1
echo "== a component's emit (#15, #70): the fetch component through the router's fetch provider, its answer an entry; replayed with no host to ask"
"${node[@]}" "$kz/equiv/fetch.ts" || status=1

echo "== libp2p (#51): two routers — publish, validate, admit, reject (recorded), a stream round trip (over the libp2p provider, #70); replayed natively and in the browser; a live step with no signer in the browser"
"${node[@]}" "$kz/equiv/libp2p.ts" || status=1

echo "== overlay services (#36, #79): the app shruggr/skein-overlay (#71: cloned at overlay.ts's pinned commit, or \$SKEIN_OVERLAY_DIR) and the chain app in a tree; submit/lookup through the router with the stock SDK clients; the gate (the chain app's answer); the gossip; replayed"
"${node[@]}" "$kz/equiv/overlay.ts" || status=1

echo "== static files (#52): the app shruggr/skein-static (#71: cloned at static.ts's pinned commit, or \$SKEIN_STATIC_DIR) in a tree; its files through its routes (types, index, 301, 404s, 405, HEAD, ETag/304); each request an entry, no head moved; replayed"
"${node[@]}" "$kz/equiv/static.ts" || status=1

echo "== apps (#72, #76, #124): the owner's messages (skein plan install) for shruggr/skein-static (its routes under /static/, the head its app record) and programs/test/app-demo (start → a cron heartbeat from \$cron; {fn, args} answered by message and on /app-demo/call; args checked; a writes: false function that writes refused); uninstall (stop, routes gone); replayed"
"${node[@]}" "$kz/equiv/install.ts" || status=1

echo "== the default image and the claim (#89, #127): an instance from images/default (no owner, the claim row from anyone, the management site at / and /site/, the explorer nobody's until the claim); the owner's own message in box claim → the sender's admin rows (a key in the body not read), the claim row gone, the owner reads the explorer; a second claim refused; the owner installs app-demo; an owned instance refuses a claim; add --image; a claim signed before the instance existed (no recipient) forwarded: the signer owns it; replayed"
"${node[@]}" "$kz/equiv/claim.ts" || status=1

echo "== the host skein, the instance manager and the onboarding app (#90): skein-host init (the host skein from the default image, the instance manager in its address book; the operator claims it from the operator's wallet, #127); shruggr/skein-onboard (src/testapps.ts's pinned commit, or \$SKEIN_ONBOARD_DIR) installed in it; a client's session creates alice with its own signed claim (forwarded by the manager as her first entry, before her hostname is published; none or another key's refused), she answers at her url and the client installs app-demo in her; a second create refused; replayed"
"${node[@]}" "$kz/equiv/host.ts" || status=1

echo "== deploy by hash (#91): the git app (shruggr/skein-git, src/testapps.ts's pinned commit, or \$SKEIN_GIT_DIR) clones one commit of a local repository served over smart HTTP (git http-backend) through the fetch provider — protocol v2, one shallow pack, checked against the hash — and answers {tree, app}; the manifest read by CID, the record rebuilt by the install client (the same CID), head + dispatch + start, the app runs; a hash not held, another commit's pack, a bad URL, no repository, no manifest refused; replayed"
"${node[@]}" "$kz/equiv/git-clone.ts" || status=1

if [ "${SKEIN_EQUIV_BROWSER:-1}" = "0" ] || ! command -v playwright > /dev/null || [ ! -x "${SKEIN_CHROMIUM:-/usr/bin/chromium}" ]; then
  echo "== the management site (#92): skipped (SKEIN_EQUIV_BROWSER=0, or no playwright on PATH or no Chromium at ${SKEIN_CHROMIUM:-/usr/bin/chromium})"
else
  echo "== the management site (#92): the page the host skein serves, in headless Chrome with a wallet in the tab (a stand-in for the 1sat services funds it); create alice from the page (the onboarding app), her locator written to the wallet's basket skein-locators, the page opens her copy of the site; the git app installed from her image's tree, then app-demo by hash through the git app (a local repository over git http-backend), the prompt approved, app-demo runs; the explorer renders her log and dispatch table, another key refused; the host skein's page lists alice; the Inbox (#99): a payment delivered to your mailbox instance in metanet_inbox listed by the page (@bsv/message-box-client), Sync calls @1sat/actions' syncMetanetInbox with the wallet in the tab and shows its result; replayed"
  "${node[@]}" "$kz/equiv/site.ts" || status=1
fi

echo "== an overlay installed as an app (#72, #79): shruggr/skein-chain and shruggr/skein-overlay (install-overlay.ts's pinned commits, or \$SKEIN_CHAIN_DIR / \$SKEIN_OVERLAY_DIR) by the owner's messages (skein plan install, #124), the overlay refused without the chain app; its wiring derived from config.overlay; the libp2p node subscribes the installed topics live; a token gossiped from a second router admitted on the chain app's answer; BRC-22 submit → the chain app's answer → BRC-24 lookup over HTTP at the base URL /@<handle>/overlay (#111); two overlay apps on one instance; a register / deregister by the owner (overlay 0.6.1): three subscriptions the kernel delivers by, then gone; a reinstall with another topic read without a restart; uninstall unsubscribes; replayed"
"${node[@]}" "$kz/equiv/install-overlay.ts" || status=1

echo "== subscriptions (#119): two apps (programs/test/app-demo's module under other names) on a router with libp2p; refusals as emitted; an app's subscribe {topic, program, fn} → the node subscribes it, a message published on it from a second router delivered by the subscription to that app's fn; another app's subscription does not take the topic; unsubscribe stops delivery; a row wins; a restarted router and kernel read the subscriptions from the log; replayed"
"${node[@]}" "$kz/equiv/emit-events.ts" || status=1

echo "== the chain module (#78): shruggr/skein-chain (chain.ts's pinned commit, or \$SKEIN_CHAIN_DIR) by the owner's messages (skein plan install, #124), on a router with an Arcade; the feed's headers; ingest proven → answered at once; ingest unproven → broadcast → accepted (status) → proven (proof), each an answer; refused → rejected; status/proof reads; the same app at boot from a system tree; replayed"
"${node[@]}" "$kz/equiv/chain.ts" || status=1

echo "== serve: the process interface, fuel exhaustion, its stores replayed"
"${node[@]}" "$kz/equiv/serve.ts" || status=1

exit $status
