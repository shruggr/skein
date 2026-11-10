#!/usr/bin/env bash
# The Zig kernel's checks: unit tests, git in the VM, replay exactness Zig
# against Zig (issue #5: from fuel on the Zig kernel is its own reference)
# over a generated corpus (format 2, issue #33: written by the Zig kernel as
# the router drives it), and the feature scenarios, each run once in its
# default mode (a SQLite file per instance, one `skein-kernel serve` each),
# their stores replayed by replays.ts.
# Backends are proven equal once, by replays.ts: every store it checks is
# also replayed into a set of a fresh RocksDB database (the same report,
# state CID and dump) and a Zig-written one migrated into one. The checks that
# compare backends on purpose run on more than one: appends.ts, hostchain.ts
# and pool.ts (SQLite and RocksDB inside one run), wasm-host.ts (the wasm
# kernel, its stores replayed natively), teranode.ts (wasm and RocksDB), and
# on-off.ts / rest-on.ts (their crash cases differ per kernel). A RocksDB
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

echo "timing: the corpus driven $((t1 - t0)) ms, replays.ts over it $((t2 - t1)) ms"

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

echo "== bootstrap (#4): a system tree from a directory and from a packet, chatted with; a checkpoint restored; replayed"
"${node[@]}" "$kz/equiv/boot.ts" || status=1
echo "== a component's emit (#15, #70): the fetch component through the router's fetch provider, its answer an entry; replayed with no host to ask"
"${node[@]}" "$kz/equiv/fetch.ts" || status=1

echo "== libp2p (#51): two routers — publish, validate, admit, reject (recorded), a stream round trip (over the libp2p provider, #70); replayed natively and in the browser; a live step with no signer in the browser"
"${node[@]}" "$kz/equiv/libp2p.ts" || status=1

echo "== overlay services (#36, #79): the app shruggr/skein-overlay (#71: cloned at overlay.ts's pinned commit, or \$SKEIN_OVERLAY_DIR) and the chain app in a tree; submit/lookup through the router with the stock SDK clients (POST /submit is BRC-22 and synchronous, 0.9.2: the STEAK, 503 + Retry-After at the bound, waiters all answered; a plain POST admitted because its BEEF validates, #135), verdicts by message into box overlay/submit (0.7.6, #128), answered once (#112); the gate (the chain app's answer); the gossip; replayed"
"${node[@]}" "$kz/equiv/overlay.ts" || status=1

echo "== the BEEF intake on an event route (#121, #164): an event route naming kernel.beef (the call probe its handler); no chain state: refused; root sets chain/state (block 170's header); {kind: \"deploy\", beef} with its record beside the entry admitted, the entry naming the record the door rewrote (the envelope, its pointer record, the bitcoin-tx block held, the bytes never stored), the step reading the envelope; a bad BUMP and no BEEF refused, nothing written; the same event on a route with no filter as it is; replayed"
"${node[@]}" "$kz/equiv/event-beef.ts" || status=1

echo "== the BEEF proven at the door, always (#121): kernel.beef proves every BEEF with skein-sdk's verifier over the BEEF alone — on event, http and mailbox routes an Atomic BEEF with no BUMP and its parent absent refused 400 ERR_BEEF MissingInput, a txid-only parent UnknownTxidOnly, a bad BUMP RootMismatch, a failing script ScriptFailed, nothing written; a proven transaction, and a proven parent with its unmined child (marks [0, null], the BUMP proving the parent only) admitted; replayed"
"${node[@]}" "$kz/equiv/door-spv.ts" || status=1

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

echo "== overlay sync (#150; the settled design, David 2026-10-30): shruggr/skein-chain and shruggr/skein-overlay (sync.ts's pinned commits, or \$SKEIN_CHAIN_DIR / \$SKEIN_OVERLAY_DIR) on three routers with libp2p, tm_sync registered on each; a token mined at 2 reaches the second host by announce-then-fetch (b's admit, the BEEF fetched from b), the anchors agree; one host offline for three blocks catches up from the other's beat (the locator on /skein/overlay/sync/1.0.0, answered by the engine's filter on its libp2p row (#154), the admitted lists pulled and their BUMPs checked, each missing transaction submitted) to equal anchors; a third host from genesis likewise; a transfer whose parent only one host holds, posted to another without it, refused at the door (#121: 400 MissingInput, nothing written, nothing wanted); the parent, an unmined tail never announced, reaches the others by the tail reconcile; replayed"
"${node[@]}" "$kz/equiv/sync.ts" || status=1

echo "== announce, then fetch (the settled sync design, David 2026-10-30): three routers b — a — c, tm_ann on each, beats every 2 s, nothing mined: (i) t1 posted to b reaches a by b's admit and c by a's (c never connected to b), each fetched once; (ii) a fetch that fails (b announces what it does not hold) is asked once, the set exhausted, nothing asked again; c's admit adds c: one more try, taken; (iii) a burst of beacon replaces publishes nothing beyond the timer's ticks; (iv) c down while t4 is admitted, its remembered peers forgotten: back, a beat's tail digest differs, the tail asked, t4 fetched; (v) c down while t5 is admitted, every beacon stopped: back, its host.db's peers asked at once (the locator, the tail), t5 fetched with no beat; replayed"
"${node[@]}" "$kz/equiv/announce.ts" || status=1

echo "== undecided is not rejected, and nothing is wanted (shruggr/skein-overlay 0.20.0, shruggr/skein-1color 0.13.1): two hosts with libp2p, the chain app and the 1color app (undecided.ts's pinned commits, or \$SKEIN_1COLOR_DIR / \$SKEIN_CHAIN_DIR), one 1Color token topic; b holds the deploy D (spending a mined funding F), P (spends D) and C (spends P), each mined, its beacons held back; a is posted C's Atomic BEEF alone: color-topic fails MissingParents (P), the engine pauses C waiting [P], no want event, nothing asked; b's beacon starts: a hears its beat, pulls D then P (then C) — D admitted, P admitted, C's pause ends and C is admitted once; a's admitted set b's; F never waited on; nothing recorded or answered as rejected on a; replayed"
"${node[@]}" "$kz/equiv/undecided.ts" || status=1

echo "== the one-key host (#160, #161, #162): a host with ONE key (SKEIN_KEY_FILE) — two path-only instances whose handles are token ids and alice: one identity and peer ID (skein-host add / identity --peer, the wallet's answer for libp2p:<handle>); ONE libp2p node; gossip by topic (one instance; two sharing a topic, both); streams by their first frame's topic (sync to the token's instance; no topic: the one declaring instance, else \"topic required\"); /@<token id>; the bare host's /submit and /lookup by topic, mixed 400; alice (SKEIN_MANAGER_FOR) creates and stops an instance from an image by name with config, host-claimed; others refused; a master-key host's claimless create refused; a derived-key host syncs a topic through the shared node; timings; replayed"
"${node[@]}" "$kz/equiv/onekey.ts" || status=1

echo "== the host loads the kernel (the settled split, 2026-10-31): onekey.ts and sync.ts on the WASM host (every instance a set of its host's one SQLite database, kernel-zig/zig-out/web/skein-kernel.wasm on a worker), #157's delivery as an emit (the server's signed answer an entry; forged ones refused at the door), every store replayed by the native kernel to the same state CID; front-door steps/s wasm vs native"
(cd "$kz" && mise exec -- zig build web)
"${node[@]}" "$kz/equiv/wasm-host.ts" || status=1

echo "== the collection app (#151): a skein from the default image, claimed; root installs the chain app and shruggr/skein-collection (its engine with it; equiv/collection.ts's pinned commit, or \$SKEIN_COLLECTION_DIR) by message; nothing registered until root registers a collection's topic tm_col_<txid>_<vout> and the lookup ls_collection; the collection's mint, an item mint (another key's item not admitted), a transfer behind a funding input (its satoshi by the ordinal rule; the funding parent ancillary, /holds says so), an OrdLock v2 listing and its purchase, each mined and posted to /collection/submit; the four reads as read routes and as BRC-24 (items, history, listings, sales with its block's time); replayed"
"${node[@]}" "$kz/equiv/collection.ts" || status=1

echo "== subscriptions (#119) and beacons (#126): two apps (programs/test/app-demo's module under other names) on a router with libp2p; refusals as emitted; an app's subscribe {topic, program, fn} → the node subscribes it, a message published on it from a second router delivered by the subscription to that app's fn; another app's subscription does not take the topic; unsubscribe stops delivery; a row wins; a restarted router and kernel read the subscriptions from the log; beacons (#126): a beacon beats on its own clock, seen by the second router, nothing logged per beat, stopped by an unbeacon and an uninstall, beaten again after a restart; replayed"
"${node[@]}" "$kz/equiv/emit-events.ts" || status=1

echo "== the event index (skein 0.5.0): one router, two apps (programs/test/event-demo's module): a name not under the emitting app's own refused as emitted; evx's facts under three names; GET /@ix/events/<name path> (a name, a prefix, latest, after, limit) and evy's in-step read (the events import) the same rows; the stream the same read then live; replayed"
"${node[@]}" "$kz/equiv/event-index.ts" || status=1

echo "== a step reads its own facts (skein 0.8.0): one router, one app (programs/test/event-demo's module); emit then read in one step (a name, a prefix, latest), two records under one name, the same record twice, an in-VM callee's emits seen by its caller and the caller's by a callee, after and limit across the committed / pending boundary, latest + limit, an errored step leaves nothing, 2,500 and 5,000 emits with a read after each (linear) — each in-step answer the host's read once committed; replayed — on SQLite, on RocksDB and on the WASM host"
"${node[@]}" "$kz/equiv/events-own-step.ts" || status=1
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/events-own-step.ts" || status=1
SKEIN_EQUIV_STORE=wasm "${node[@]}" "$kz/equiv/events-own-step.ts" || status=1

echo "== subscriptions (skein 0.5.2): one router, three apps (programs/test/event-demo's module); on/off in a step, refused for a name that is no fact's or a role the app has not; two apps on one name stepped in the order made, another name not stepped, an on after a fact does not hear it, off stops delivery; a kernel killed in the middle of a delivery commits nothing of the entry and, restarted, steps each subscription once; index-store.ts derives the on map; replayed — on SQLite, on RocksDB and on the WASM host"
"${node[@]}" "$kz/equiv/on-off.ts" || status=1
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/on-off.ts" || status=1
SKEIN_EQUIV_STORE=wasm "${node[@]}" "$kz/equiv/on-off.ts" || status=1

echo "== call permissions: one router, three apps (programs/test/perm-probe's module) — a named call (callAs) the grants approve runs and the callee reads the name as \`as\`, an unapproved name refused to the caller, \"*\" any name, a nameless call unchanged, a launched or messaged program sees no \`as\`, a nested call inherits none (from a step and from a kernel call); the raw signer refused without the signer service; root's grants without a manifest; an image's apps' approvals from its genesis; the review's cases (a non-root grant, an `as` in the arg, step-put records, a dotted app name, upgrade and uninstall taken back from the grants head — an app rewriting its own record changes nothing); both stores replayed — on SQLite and on RocksDB"
"${node[@]}" "$kz/equiv/call-permissions.ts" || status=1
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/call-permissions.ts" || status=1

echo "== an event's place identifies one event: one router, two apps (programs/test/perm-probe's module); one step's facts from the caller and an in-VM callee, then the same with the caller resting on its own first fact (its delivery steps the thread again before the later facts go out): every fact on the live stream at the index's place, Last-Event-ID resumes right after; replayed — on SQLite, on RocksDB and on the WASM host"
"${node[@]}" "$kz/equiv/event-place.ts" || status=1
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/event-place.ts" || status=1
SKEIN_EQUIV_STORE=wasm "${node[@]}" "$kz/equiv/event-place.ts" || status=1

echo "== a thread resting on an event name (skein 0.5.4): on(name) with no fn ends the step resting; each fact under the name wakes the resting threads in the order they began resting, never another name's, their context intact, and they rest again; a kernel killed mid-delivery commits nothing of the entry and, restarted, wakes each once; index-store.ts derives the waits index; replayed — on SQLite, on RocksDB and on the WASM host"
"${node[@]}" "$kz/equiv/rest-on.ts" || status=1
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/rest-on.ts" || status=1
SKEIN_EQUIV_STORE=wasm "${node[@]}" "$kz/equiv/rest-on.ts" || status=1

echo "== liveness (#138): two routers; an app on the second emits liveness for a topic an app on the first beacons on; the second's node subscribes it without admitting; GET /<app>/.live/<topic> (served by the host) shows the first's beat within a beat and the second's own; a bad signature never shows; the window drops a silent sender; unliveness and uninstall end it; replayed"
"${node[@]}" "$kz/equiv/liveness.ts" || status=1

echo "== the chain module (#78): shruggr/skein-chain (chain.ts's pinned commit, or \$SKEIN_CHAIN_DIR) by the owner's messages (#124), on a router with an Arcade; the feed's headers through the host chain (#156: \`headers\` frames, the \`chain\` event); ingest proven → answered at once; ingest unproven → broadcast → accepted (status) → proven (proof), each an answer; refused → rejected; status/proof reads; the same app at boot from a system tree; a reorg: unproven again, nothing broadcast, the new proof by the status feed answered to the same watchers; replayed"
"${node[@]}" "$kz/equiv/chain.ts" || status=1

echo "== the image carries the header chain (#132, #156): a fake chaintracks' history (N regtest headers) and tip stream (M more), all before any skein exists; the host builds the default image's chain part from genesis at start and grows it per header; a skein created from the image holds chain/headers and chain/tip; the empty host chain imports them at her first start (chain-import; skein-host chain shows the image's tip); her owner installs the chain app (shruggr/skein-chain at image-chain.ts's pinned commit, or \$SKEIN_CHAIN_DIR): the install's chain event and her chain state holds all N + M + 1 from genesis, no header fed, its maps the host chain's; the next header moves it on; add --image default boots from the same image; replayed"
"${node[@]}" "$kz/equiv/image-chain.ts" || status=1

echo "== headers from the Teranode P2P network (#156, teranode.ts): a host with no headers source makes alice and installs the chain app (no chain anywhere); restarted with the tracker (a fake Teranode mesh and data hub), it syncs the whole chain from the hub at start, fills the empty host chain from the image chain (chain-import on the wasm kernel's SQLite database, headers runs on RocksDB) before alice is hydrated; her chain state holds it, a proof against it verifies, the next announced block moves her on; replayed — on the wasm kernel and on RocksDB"
SKEIN_EQUIV_STORE=wasm "${node[@]}" "$kz/equiv/teranode.ts" || status=1
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/teranode.ts" || status=1

echo "== the host chain (#156, #133): two instances on one RocksDB host take three header runs; their chain/state headers and heights roots are the host chain record's, the tip read off them the host's; a proof on A verifies; a heavier branch replacing two headers reverts it (unproven, broadcast again) and leaves B on the new record; the gate (a host chain block through every set, A's record not through B's); a serve (SQLite) instance's chain/state for the same runs is the RocksDB host's; replayed after the processes stopped; timings: a block's frame and its event to 8 instances, chain-import of an image (HOSTCHAIN_IMPORT headers)"
"${node[@]}" "$kz/equiv/hostchain.ts" || status=1

echo "== serve: the process interface, fuel exhaustion, its stores replayed"
"${node[@]}" "$kz/equiv/serve.ts" || status=1

echo "== the worker pool (#158): 8 instances × 500 entries interleaved = serial = SQLite, with 1 worker too; a call beside a step blocked on the wallet sees the state as committed; the member gate and host/chain; each set replayed after the process stopped; timings"
"${node[@]}" "$kz/equiv/pool.ts" || status=1

exit $status
