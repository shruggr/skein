#!/usr/bin/env bash
# The Zig kernel's checks: unit tests, the shell cases against the results
# recorded from the TS shell (equiv/shell-expected.json, issue #55;
# stdout/stderr/exit/tree carry no fuel), git in the VM, and replay
# exactness Zig against Zig (issue #5: from fuel on the Zig kernel is its own
# reference) over a generated corpus (format 2, issue #33: written by the Zig
# kernel as the router drives it) and over the stores `serve` writes.
# Both store backends (#96): every store replays.ts checks is also replayed
# into an LMDB environment (the same state CID and CIDs) and, a SQLite one,
# migrated into one; the corpus, serve.ts, chain.ts, overlay.ts and sync.ts
# run a second time with their instances as sets of one LMDB environment per
# host (SKEIN_EQUIV_STORE=lmdb, equiv/backend.ts); equiv/lmdb.ts checks the
# member gate, the chain's set and times 8 instances writing at once. The
# LMDB reader in node needs lmdb-js's data-v1 build (kernel-zig/README.md).
# The one-process kernel (#158): replays.ts also replays every store into a
# RocksDB set and migrates the Zig ones into one; the corpus, serve.ts,
# chain.ts, overlay.ts, sync.ts, claim.ts, host.ts and git-clone.ts run once
# more with every host's instances sets of one RocksDB database inside ONE
# `skein-kernel host` process (SKEIN_EQUIV_STORE=rocksdb), their sets replayed
# after the process stopped; equiv/pool.ts checks the worker pool (8
# instances interleaved = serial = SQLite; 1 worker; a call beside a blocked
# step; the gate; replay after stop) and prints its timings. A RocksDB
# database's host-read socket is <db dir>/kernel.sock: keep $TMPDIR short
# (a Unix socket path is at most 107 bytes).
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

ms() { echo $(( $(date +%s%N) / 1000000 )); }
echo "== replay, Zig against Zig: a generated corpus (format 2, written by the Zig kernel through the router)"
t0=$(ms)
"${node[@]}" "$kz/equiv/corpus.ts" "$work/gen" > "$work/gen.list"
t1=$(ms)
mapfile -t gen < "$work/gen.list"
"${node[@]}" "$kz/equiv/replays.ts" "${gen[@]}" || status=1
t2=$(ms)

echo "== the same corpus on LMDB (#96): each host's instances sets of one environment, replayed (on both backends) to themselves exactly"
rm -rf "$work/gen-lmdb"
t3=$(ms)
SKEIN_EQUIV_STORE=lmdb "${node[@]}" "$kz/equiv/corpus.ts" "$work/gen-lmdb" > "$work/gen-lmdb.list"
t4=$(ms)
mapfile -t genl < "$work/gen-lmdb.list"
"${node[@]}" "$kz/equiv/replays.ts" "${genl[@]}" || status=1
echo "timing: the corpus driven on SQLite $((t1 - t0)) ms, on LMDB $((t4 - t3)) ms (replays.ts after it: $((t2 - t1)) ms over the SQLite stores, $(( $(ms) - t4 )) ms over the LMDB sets; each replays every store on both backends)"
rm -rf "$work/gen-lmdb"

echo "== the same corpus on RocksDB (#158): each host's instances sets of one database inside one skein-kernel host process, replayed after it stopped"
rm -rf "$work/gen-rocks"
t5=$(ms)
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/corpus.ts" "$work/gen-rocks" > "$work/gen-rocks.list"
t6=$(ms)
mapfile -t genr < "$work/gen-rocks.list"
"${node[@]}" "$kz/equiv/replays.ts" "${genr[@]}" || status=1
echo "timing: the corpus driven on SQLite $((t1 - t0)) ms, on RocksDB (one process, the pool) $((t6 - t5)) ms"
rm -rf "$work/gen-rocks"

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
  echo "== browser live (issue #35): an instance in Chrome, chatted on the page's own session with it (#126 step 4), delivers its inference request itself; the answer shown from the page identity's mailbox, nothing admitted; its store replayed natively"
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

echo "== overlay services (#36, #79): the app shruggr/skein-overlay (#71: cloned at overlay.ts's pinned commit, or \$SKEIN_OVERLAY_DIR) and the chain app in a tree; submit/lookup through the router with the stock SDK clients (POST /submit is BRC-22 and synchronous, 0.9.2: the STEAK, 503 + Retry-After at the bound, waiters all answered; a plain POST admitted because its BEEF validates, #135), verdicts by message into box overlay/submit (0.7.6, #128), answered once (#112); the gate (the chain app's answer); the gossip; replayed"
"${node[@]}" "$kz/equiv/overlay.ts" || status=1

echo "== the BEEF intake on an event route (#121, #164): an event route naming kernel.beef (the call probe its handler); no chain state: refused; root sets chain/state (block 170's header); {kind: \"deploy\", beef} with its record beside the entry admitted, the entry naming the record the door rewrote (the envelope, its pointer record, the bitcoin-tx block held, the bytes never stored), the step reading the envelope; a bad BUMP and no BEEF refused, nothing written; the same event on a route with no filter as it is; replayed — on SQLite and on RocksDB"
"${node[@]}" "$kz/equiv/event-beef.ts" || status=1
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/event-beef.ts" || status=1

echo "== the BEEF proven at the door, always (#121): kernel.beef proves every BEEF with skein-sdk's verifier over the BEEF alone — on event, http and mailbox routes an Atomic BEEF with no BUMP and its parent absent refused 400 ERR_BEEF MissingInput, a txid-only parent UnknownTxidOnly, a bad BUMP RootMismatch, a failing script ScriptFailed, nothing written; a proven transaction, and a proven parent with its unmined child (marks [0, null], the BUMP proving the parent only) admitted; replayed — on SQLite and on RocksDB"
"${node[@]}" "$kz/equiv/door-spv.ts" || status=1
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/door-spv.ts" || status=1

echo "== the kernel appends (#163): N arrivals into one instance at once, none queued on the host side (the kernel's admit, as the HTTP front door and libp2p inbound call it) — on serve (SQLite) and on skein-kernel host (RocksDB): all land, n strictly increasing with each prev the entry before, stamps behind the tip raised, every arrival's record named by exactly one entry; a frame naming prev or n refused, nothing written"
"${node[@]}" "$kz/equiv/appends.ts" || status=1

echo "== files (#52, #125): skein-sdk's files module through the site app's handler (shruggr/skein-site at src/testapps.ts's pinned commit, or \$SKEIN_SITE_DIR, with test files in its tree), installed by the owner; its row /site/* and the owner's own rows to it (/favicon.ico, /): types, index, 301, 404s, 405, HEAD, ETag/304; each request an entry, no head moved; replayed"
"${node[@]}" "$kz/equiv/files.ts" || status=1

echo "== apps (#72, #76, #124): the owner's messages for shruggr/skein-site (#125: its row under /site/, the head its app record; the owner's own root row to its handler, \`skein dispatch --http\`, which an uninstall leaves) and programs/test/app-demo (start → a cron heartbeat from \$cron; {fn, args} answered by message and on /app-demo/call; args checked; a writes: false function that writes refused); uninstall (stop, routes gone); replayed"
"${node[@]}" "$kz/equiv/install.ts" || status=1

echo "== the default image and the claim (#89, #127): an instance from images/default (no owner, the claim row from anyone, nothing at /, /site/ or /manifest.json (#125), the explorer nobody's until the claim); the owner's own message in box claim → the sender's admin rows (a key in the body not read), the claim row gone, the owner reads the explorer; a second claim refused; the owner installs chain, git and site by message (#152) and root's / to the site, which then serves /, /site/ and /manifest.json; git again sends only its head; the owner installs app-demo; an owned instance refuses a claim; add --image; a claim signed before the instance existed (no recipient) forwarded: the signer owns it; replayed"
"${node[@]}" "$kz/equiv/claim.ts" || status=1

echo "== the host skein, the instance manager and the onboarding app (#90, #142): skein-host init (the host skein from the host image, owned by the operator's key at birth: its admin rows and explorer row, no claim row; the onboarding app, its only app (#152: by its release tarball), installed with its config from the settings; the instance manager in its address book); skein-host grant (another key's rows, signed by the operator's key, over the control socket); a client's session creates alice with its own signed claim (forwarded by the manager as her first entry, before her hostname is published; none or another key's refused), she answers at her url and the client installs app-demo in her; a second create refused; replayed"
"${node[@]}" "$kz/equiv/host.ts" || status=1

echo "== deploy by hash (#91): the git app (shruggr/skein-git, src/testapps.ts's pinned commit, or \$SKEIN_GIT_DIR) clones one commit of a local repository served over smart HTTP (git http-backend) through the fetch provider — protocol v2, one shallow pack, checked against the hash — and answers {tree, app}; the manifest read by CID, the record rebuilt by the install client (the same CID), head + dispatch + start, the app runs; a hash not held, another commit's pack, a bad URL, no repository, no manifest refused; the client's skein install <url>#<hash> --instance (#142: one git.clone message, signed in the client, over the control socket; head and row only); replayed"
"${node[@]}" "$kz/equiv/git-clone.ts" || status=1

if [ "${SKEIN_EQUIV_BROWSER:-1}" = "0" ] || ! command -v playwright > /dev/null || [ ! -x "${SKEIN_CHROMIUM:-/usr/bin/chromium}" ]; then
  echo "== the management site (#92): skipped (SKEIN_EQUIV_BROWSER=0, or no playwright on PATH or no Chromium at ${SKEIN_CHROMIUM:-/usr/bin/chromium})"
else
  echo "== the management site (#92): the site app (#125) installed in the host skein with the owner's root row, its page at /site/, in headless Chrome with a wallet in the tab (a stand-in for the 1sat services funds it); create alice from the page (the onboarding app), nothing written into the wallet, the page opens her view; chain, git and site there from birth (#141), git's owner row added by installing git again, then app-demo by hash through the git app (a local repository over git http-backend), the prompt approved, app-demo runs; the explorer renders her log and dispatch table, another key refused; Your skeins from the host (GET /skeins?key=, the skeins' grants): the host skein and alice; the host skein's page lists alice; the Inbox (#99): a payment delivered to your mailbox instance in metanet_inbox listed by the page (@bsv/message-box-client), Sync calls @1sat/actions' syncMetanetInbox with the wallet in the tab and shows its result; replayed"
  "${node[@]}" "$kz/equiv/site.ts" || status=1
fi

echo "== an overlay installed as an app (#72, #79): shruggr/skein-chain and shruggr/skein-overlay (install-overlay.ts's pinned commits, or \$SKEIN_CHAIN_DIR / \$SKEIN_OVERLAY_DIR) by the owner's messages (#124), the overlay refused without the chain app; its wiring derived from config.overlay; the libp2p node subscribes the installed topics live; a token gossiped from a second router admitted on the chain app's answer; BRC-22 submit (the STEAK, overlay 0.9.2, #112; plain too, #135) → the chain app's answer → BRC-24 lookup over HTTP at the base URL /@<handle>/overlay (#111); a submission by message into box overlay/submit (0.7.6) answered admitted, once; two overlay apps on one instance; a register / deregister by the owner in box overlay2/register (0.7.7, #128; pinned 0.9.2): three subscriptions the kernel delivers by, then gone; a reinstall with another topic read without a restart; uninstall unsubscribes; replayed"
"${node[@]}" "$kz/equiv/install-overlay.ts" || status=1

echo "== overlay sync (#150): shruggr/skein-chain and shruggr/skein-overlay 0.15.0 (sync.ts's pinned commits, or \$SKEIN_CHAIN_DIR / \$SKEIN_OVERLAY_DIR) on three routers with libp2p, tm_sync registered on each; a token mined at 2 reaches the second host by gossip, the anchors agree; one host offline for three blocks catches up from the other's beat (the locator on /skein/overlay/sync/1.0.0, answered by the engine's filter on its libp2p row (#154), the admitted lists pulled and their BUMPs checked, each missing transaction into the receive row) to equal anchors; a third host from genesis likewise; a transfer whose parent only one host holds, posted to another without it, refused at the door (#121: 400 MissingInput, nothing written); replayed"
"${node[@]}" "$kz/equiv/sync.ts" || status=1

echo "== the one-key host (#160, #161, #162): a host with ONE key (SKEIN_KEY_FILE) — two path-only instances whose handles are token ids and alice: one identity and peer ID (skein-host add / identity --peer, the wallet's answer for libp2p:<handle>); ONE libp2p node; gossip by topic (one instance; two sharing a topic, both); streams by their first frame's topic (sync to the token's instance; no topic: the one declaring instance, else \"topic required\"); /@<token id>; the bare host's /submit and /lookup by topic, mixed 400; alice (SKEIN_MANAGER_FOR) creates and stops an instance from an image by name with config, host-claimed; others refused; a master-key host's claimless create refused; a derived-key host syncs a topic through the shared node; timings; replayed — on SQLite and on RocksDB"
"${node[@]}" "$kz/equiv/onekey.ts" || status=1
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/onekey.ts" || status=1

echo "== the collection app (#151): a skein from the default image, claimed; root installs the chain app and shruggr/skein-collection (its engine with it; equiv/collection.ts's pinned commit, or \$SKEIN_COLLECTION_DIR) by message; nothing registered until root registers a collection's topic tm_col_<txid>_<vout> and the lookup ls_collection; the collection's mint, an item mint (another key's item not admitted), a transfer behind a funding input (its satoshi by the ordinal rule; the funding parent ancillary, /holds says so), an OrdLock v2 listing and its purchase, each mined and posted to /collection/submit; the four reads as read routes and as BRC-24 (items, history, listings, sales with its block's time); replayed"
"${node[@]}" "$kz/equiv/collection.ts" || status=1

echo "== subscriptions (#119) and beacons (#126): two apps (programs/test/app-demo's module under other names) on a router with libp2p; refusals as emitted; an app's subscribe {topic, program, fn} → the node subscribes it, a message published on it from a second router delivered by the subscription to that app's fn; another app's subscription does not take the topic; unsubscribe stops delivery; a row wins; a restarted router and kernel read the subscriptions from the log; beacons (#126): a beacon beats on its own clock, seen by the second router, nothing logged per beat, stopped by an unbeacon and an uninstall, beaten again after a restart; replayed"
"${node[@]}" "$kz/equiv/emit-events.ts" || status=1

echo "== liveness (#138): two routers; an app on the second emits liveness for a topic an app on the first beacons on; the second's node subscribes it without admitting; GET /<app>/.live/<topic> (served by the host) shows the first's beat within a beat and the second's own; a bad signature never shows; the window drops a silent sender; unliveness and uninstall end it; replayed"
"${node[@]}" "$kz/equiv/liveness.ts" || status=1

echo "== the chain module (#78): shruggr/skein-chain (chain.ts's pinned commit, or \$SKEIN_CHAIN_DIR) by the owner's messages (#124), on a router with an Arcade; the feed's headers through the host chain (#156: \`headers\` frames, the \`chain\` event); ingest proven → answered at once; ingest unproven → broadcast → accepted (status) → proven (proof), each an answer; refused → rejected; status/proof reads; the same app at boot from a system tree; replayed"
"${node[@]}" "$kz/equiv/chain.ts" || status=1

echo "== the image carries the header chain (#132, #156): a fake chaintracks' history (N regtest headers) and tip stream (M more), all before any skein exists; the host builds the default image's chain part from genesis at start and grows it per header; a skein created from the image holds chain/headers and chain/tip; the empty host chain imports them at her first start (chain-import; skein-host chain shows the image's tip); her owner installs the chain app (shruggr/skein-chain at image-chain.ts's pinned commit, or \$SKEIN_CHAIN_DIR): the install's chain event and her chain state holds all N + M + 1 from genesis, no header fed, its maps the host chain's; the next header moves it on; add --image default boots from the same image; replayed — on SQLite and on RocksDB"
"${node[@]}" "$kz/equiv/image-chain.ts" || status=1
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/image-chain.ts" || status=1

echo "== the host chain (#156, #133): two instances on one RocksDB host take three header runs; their chain/state headers and heights roots are the host chain record's, the tip read off them the host's; a proof on A verifies; a heavier branch replacing two headers reverts it (unproven, broadcast again) and leaves B on the new record; the gate (a host chain block through every set, A's record not through B's); a serve (SQLite) instance's chain/state for the same runs is the RocksDB host's; replayed after the processes stopped; timings: a block's frame and its event to 8 instances, chain-import of an image (HOSTCHAIN_IMPORT headers)"
"${node[@]}" "$kz/equiv/hostchain.ts" || status=1

echo "== billing (#130): two skeins from the default image (its wallet, no route to it) on a host that bills, with the chain app (wallet.ts's pinned commit, or \$SKEIN_CHAIN_DIR) over a fake header feed and a fake Arcade; root funds alice by the wallet's internalize message (its own route to the wallet); alice's owner grants the host (skein host: the host row, the host's published terms), the host ticks at once (billing starts on its allowance); a tick charges storage and the host's amounts, its period's log record kept; an owner's head message for billing and a stranger's tick refused; usage consumes the allocation and the kernel's pay step pays X — a payment event the host keeps and broadcasts, its output the host's BRC-29 key, its other output OP_RETURN the state record's CID — then all she has, then nothing: asleep, 402, no tick, her owner held too (her internalize among it: nothing wakes her), reclaimable past the grace; bob (no host row) untouched; an app's payment event refused; replayed"
"${node[@]}" "$kz/equiv/billing.ts" || status=1

echo "== serve: the process interface, fuel exhaustion, its stores replayed"
"${node[@]}" "$kz/equiv/serve.ts" || status=1

echo "== the same on LMDB (#96): serve.ts, chain.ts, overlay.ts and sync.ts with every host's instances sets of one LMDB environment (SKEIN_EQUIV_STORE=lmdb), their stores replayed on both backends"
for d in serve chain overlay sync; do
  SKEIN_EQUIV_STORE=lmdb "${node[@]}" "$kz/equiv/$d.ts" | grep -vE "^  \|" || status=1
done

echo "== the one-process kernel on RocksDB (#158): serve.ts, chain.ts, overlay.ts, sync.ts, claim.ts, host.ts and git-clone.ts with every host's instances sets of one RocksDB database in one skein-kernel host process (SKEIN_EQUIV_STORE=rocksdb), their sets replayed after it stopped"
for d in serve chain overlay sync claim host git-clone; do
  SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/$d.ts" | grep -vE "^  \|" || status=1
done

echo "== the worker pool (#158): 8 instances × 500 entries interleaved = serial = SQLite, with 1 worker too; a call beside a step blocked on the wallet sees the state as committed; the member gate and host/chain; each set replayed after the process stopped; timings"
"${node[@]}" "$kz/equiv/pool.ts" || status=1

echo "== the shared store (#96, #133): two instances in one LMDB environment — a block one put is absent for the other (has, get, a call of a program only the other holds; the host's lmdb-js reader too); a block under host/chain readable by both; each set's size its own; 8 instances writing at once, SQLite against LMDB"
"${node[@]}" "$kz/equiv/lmdb.ts" || status=1

exit $status
