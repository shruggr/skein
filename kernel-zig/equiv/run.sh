#!/usr/bin/env bash
# The Zig kernel's feature scenarios, each run once on one backend, and its
# replay exactness (issue #5: the Zig kernel is its own reference).
#
# skein next (2026-11-13, build K): EVERY scenario below WAITS for the host build
# (H2: the router onto CHECK/COMMIT, request records, rows with roles — the
# kernel's surface in src/host/kernel.ts) and, for those that install the chain,
# overlay or 1color apps, the chain/overlay build (C). They drive the kernel
# through the Node host and through apps from other repos not yet rebuilt, so
# none passes until those land. Deleted with the mechanisms they tested: serve.ts
# (serve mode), git.ts and git-clone.ts (the shell runner), fetch.ts (the
# component runner, the fetch intention), rest-on.ts (on with no fn: await a
# name now), door-spv.ts and event-beef.ts (kernel.beef: the chain app's check
# now, tested in skein-sdk chain/door), libp2p.ts and emit-events.ts (libp2p
# rows, subscriptions as a match source), inboxes.ts and corpus.ts (mail),
# host.ts, site.ts, files.ts and collection.ts (the instance manager, onboarding,
# the management site and the collection app: out of the first cut),
# image-chain.ts (the image-chain live copy), browser.ts and browser-live.ts
# (the browser host and its front door). The kernel's own tests are
# `zig build test` (README).
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

echo "== build (the native kernel, and the browser build wasm-host.ts loads)"
(cd "$kz" && mise exec -- zig build --release && mise exec -- zig build web --release)


echo "== bootstrap (#4): a system tree from a directory and from a packet, chatted with; a checkpoint restored; replayed"
"${node[@]}" "$kz/equiv/boot.ts" || status=1

echo "== overlay services (#36, #79): the app shruggr/skein-overlay (#71: cloned at overlay.ts's pinned commit, or \$SKEIN_OVERLAY_DIR) and the chain app in a tree; submit/lookup through the router with the stock SDK clients (POST /submit is BRC-22 and synchronous, 0.9.2: the STEAK, 503 + Retry-After at the bound, waiters all answered; a plain POST admitted because its BEEF validates, #135), verdicts by message into box overlay/submit (0.7.6, #128), answered once (#112); the gate (the chain app's answer); the gossip; replayed"
"${node[@]}" "$kz/equiv/overlay.ts" || status=1



echo "== the kernel appends (#163): N arrivals into one instance at once, none queued on the host side (the kernel's admit, as the HTTP front door and libp2p inbound call it) — on serve (SQLite): all land, n strictly increasing with each prev the entry before, stamps behind the tip raised, every arrival's record named by exactly one entry; a frame naming prev or n refused, nothing written"
"${node[@]}" "$kz/equiv/appends.ts" || status=1


echo "== apps (#72, #76, #124): the owner's messages for shruggr/skein-site (#125: its row under /site/, the head its app record; the owner's own root row to its handler, \`skein dispatch --http\`, which an uninstall leaves) and programs/test/app-demo (start → a cron heartbeat from \$cron; {fn, args} answered by message and on /app-demo/call; args checked; a writes: false function that writes refused); uninstall (stop, routes gone); replayed"
"${node[@]}" "$kz/equiv/install.ts" || status=1

echo "== the default image and the claim (#89, #127): an instance from images/default (no owner, the claim row from anyone, nothing at /, /site/ or /manifest.json (#125), the explorer nobody's until the claim); the owner's own message in box claim → the sender's admin rows (a key in the body not read), the claim row gone, the owner reads the explorer; a second claim refused; the owner installs chain, git and site by message (#152) and root's / to the site, which then serves /, /site/ and /manifest.json; git again sends only its head; the owner installs app-demo; an owned instance refuses a claim; add --image; a claim signed before the instance existed (no recipient) forwarded: the signer owns it; replayed"
"${node[@]}" "$kz/equiv/claim.ts" || status=1




echo "== overlay sync (#150; the settled design, David 2026-10-30): shruggr/skein-chain and shruggr/skein-overlay (sync.ts's pinned commits, or \$SKEIN_CHAIN_DIR / \$SKEIN_OVERLAY_DIR) on three routers with libp2p, tm_sync registered on each; a token mined at 2 reaches the second host by announce-then-fetch (b's admit, the BEEF fetched from b), the anchors agree; one host offline for three blocks catches up from the other's beat (the locator on /skein/overlay/sync/1.0.0, answered by the engine's filter on its libp2p row (#154), the admitted lists pulled and their BUMPs checked, each missing transaction submitted) to equal anchors; a third host from genesis likewise; a transfer whose parent only one host holds, posted to another without it, refused at the door (#121: 400 MissingInput, nothing written, nothing wanted); the parent, an unmined tail never announced, reaches the others by the tail reconcile; replayed"
"${node[@]}" "$kz/equiv/sync.ts" || status=1

echo "== announce, then fetch (the settled sync design, David 2026-10-30): three routers b — a — c, tm_ann on each, beats every 2 s, nothing mined: (i) t1 posted to b reaches a by b's admit and c by a's (c never connected to b), each fetched once; (ii) a fetch that fails (b announces what it does not hold) is asked once, the set exhausted, nothing asked again; c's admit adds c: one more try, taken; (iii) a burst of beacon replaces publishes nothing beyond the timer's ticks; (iv) c down while t4 is admitted, its remembered peers forgotten: back, a beat's tail digest differs, the tail asked, t4 fetched; (v) c down while t5 is admitted, every beacon stopped: back, its host.db's peers asked at once (the locator, the tail), t5 fetched with no beat; replayed"
"${node[@]}" "$kz/equiv/announce.ts" || status=1

echo "== undecided is not rejected, and nothing is wanted (shruggr/skein-overlay 0.20.0, shruggr/skein-1color 0.13.1): two hosts with libp2p, the chain app and the 1color app (undecided.ts's pinned commits, or \$SKEIN_1COLOR_DIR / \$SKEIN_CHAIN_DIR), one 1Color token topic; b holds the deploy D (spending a mined funding F), P (spends D) and C (spends P), each mined, its beacons held back; a is posted C's Atomic BEEF alone: color-topic fails MissingParents (P), the engine pauses C waiting [P], no want event, nothing asked; b's beacon starts: a hears its beat, pulls D then P (then C) — D admitted, P admitted, C's pause ends and C is admitted once; a's admitted set b's; F never waited on; nothing recorded or answered as rejected on a; replayed"
"${node[@]}" "$kz/equiv/undecided.ts" || status=1

echo "== the one-key host (#160, #161, #162): a host with ONE key (SKEIN_KEY_FILE) — two path-only instances whose handles are token ids and alice: one identity and peer ID (skein-host add / identity --peer, the wallet's answer for libp2p:<handle>); ONE libp2p node; gossip by topic (one instance; two sharing a topic, both); streams by their first frame's topic (sync to the token's instance; no topic: the one declaring instance, else \"topic required\"); /@<token id>; the bare host's /submit and /lookup by topic, mixed 400; alice (SKEIN_MANAGER_FOR) creates and stops an instance from an image by name with config, host-claimed; others refused; a master-key host's claimless create refused; a derived-key host syncs a topic through the shared node; timings; replayed"
"${node[@]}" "$kz/equiv/onekey.ts" || status=1

echo "== the host loads the kernel (the settled split, 2026-10-31): onekey.ts and sync.ts on the WASM host (every instance a set of its host's one SQLite database, kernel-zig/zig-out/web/skein-kernel.wasm on a worker), #157's delivery as an emit (the server's signed answer an entry; forged ones refused at the door), every store replayed by the native kernel to the same state CID; front-door steps/s wasm vs native"
"${node[@]}" "$kz/equiv/wasm-host.ts" || status=1



echo "== the event index (skein 0.5.0): one router, two apps (programs/test/event-demo's module): a name not under the emitting app's own refused as emitted; evx's facts under three names; GET /@ix/events/<name path> (a name, a prefix, latest, after, limit) and evy's in-step read (the events import) the same rows; the stream the same read then live; replayed"
"${node[@]}" "$kz/equiv/event-index.ts" || status=1

echo "== a step reads its own facts (skein 0.8.0): one router, one app (programs/test/event-demo's module); emit then read in one step (a name, a prefix, latest), two records under one name, the same record twice, an in-VM callee's emits seen by its caller and the caller's by a callee, after and limit across the committed / pending boundary, latest + limit, an errored step leaves nothing, fact names of 300 and 9,000 bytes, 1,000 and 5,000 emits with a read after each (linear, the step's line bounded) — each in-step answer the host's read once committed; replayed"
"${node[@]}" "$kz/equiv/events-own-step.ts" || status=1

echo "== facts placed by the instance's step number (skein 0.8.0): one router, one app (programs/test/order-probe's module); in one entry an old resting thread raises a fact and a fresh subscription thread raises the same name after it — latest is the later (and the reverse); the step numbers follow the log; SSE resumed after the first gets the second; after a kernel restart a step is numbered after every one before; killed mid-entry (a slow subscription step), restarted, the entry runs again numbered after every step committed before; index-store.ts derives every map of the kernel's index (the one comparison of the two index implementations); skein-kernel dump decodes the place; replayed"
"${node[@]}" "$kz/equiv/event-order.ts" || status=1

echo "== subscriptions (skein 0.5.2): one router, three apps (programs/test/event-demo's module); on/off in a step, refused for a name that is no fact's or a role the app has not; two apps on one name stepped in the order made, another name not stepped, an on after a fact does not hear it, off stops delivery; a kernel killed in the middle of a delivery commits nothing of the entry and, restarted, steps each subscription once; replayed"
"${node[@]}" "$kz/equiv/on-off.ts" || status=1

echo "== call permissions: one router, three apps (programs/test/perm-probe's module) — a named call (callAs) the grants approve runs and the callee reads the name as \`as\`, an unapproved name refused to the caller, \"*\" any name, a nameless call unchanged, a launched or messaged program sees no \`as\`, a nested call inherits none (from a step and from a kernel call); the raw signer refused without the signer service; root's grants without a manifest; an image's apps' approvals from its genesis; the review's cases (a non-root grant, an `as` in the arg, step-put records, a dotted app name, upgrade and uninstall taken back from the grants head — an app rewriting its own record changes nothing); replayed"
"${node[@]}" "$kz/equiv/call-permissions.ts" || status=1

echo "== an event's place identifies one event: one router, two apps (programs/test/perm-probe's module); one step's facts from the caller and an in-VM callee, then the same with the caller resting on its own first fact (its delivery steps the thread again before the later facts go out): every fact on the live stream at the index's place, Last-Event-ID resumes right after; replayed"
"${node[@]}" "$kz/equiv/event-place.ts" || status=1


echo "== liveness (#138): two routers; an app on the second emits liveness for a topic an app on the first beacons on; the second's node subscribes it without admitting; GET /<app>/.live/<topic> (served by the host) shows the first's beat within a beat and the second's own; a bad signature never shows; the window drops a silent sender; unliveness and uninstall end it; replayed"
"${node[@]}" "$kz/equiv/liveness.ts" || status=1

echo "== the chain module (#78): shruggr/skein-chain (chain.ts's pinned commit, or \$SKEIN_CHAIN_DIR) by the owner's messages (#124), on a router with an Arcade; the feed's headers through the host chain (#156: \`headers\` frames, the \`chain\` event); ingest proven → answered at once; ingest unproven → broadcast → pending, seen (status), mined (proof) as facts (skein-chain 0.11.0); refused as invalid → rejected; status/proof reads; the same app at boot from a system tree; a reorg: unproven again, nothing broadcast, the new proof by the status feed answered to the same watchers; replayed"
"${node[@]}" "$kz/equiv/chain.ts" || status=1

echo "== chain proof events (skein-chain 0.11.0, skein-sdk 0.21.0): a saved merkle path links every transaction it covers (chain/proof/<txid> once, held or not); one taken in after its link mined at intake and never broadcast, its unproven child posted once in Extended Format; linked later, mined by its subscription; the rejection cascade by subscription and its revival; blocks leaving and rejoining the best chain (chain/block/<hash>); one BUMP for two proven entries; the in-VM ingest of programs/test/ingester; replayed"
"${node[@]}" "$kz/equiv/chain-proof-events.ts" || status=1

echo "== a large bundle (skein-chain 0.11.0, as in the live case): N bare transactions over a proven funding, the last one's BEEF ingested by one in-VM call (programs/test/ingester): every one has its intake status; replayed"
"${node[@]}" "$kz/equiv/chain-bundle.ts" || status=1


echo "== headers from the Teranode P2P network (#156, teranode.ts): a host with no headers source makes alice and installs the chain app (no chain anywhere); restarted with the tracker (a fake Teranode mesh and data hub), it syncs the whole chain from the hub at start, fills the empty host chain from the image chain (headers runs) before alice is hydrated; her chain state holds it, a proof against it verifies, the next announced block moves her on; replayed — on the one-process host (RocksDB), where the host chain is"
SKEIN_EQUIV_STORE=rocksdb "${node[@]}" "$kz/equiv/teranode.ts" || status=1

echo "== the host chain (#156, #133): two instances on one RocksDB host take three header runs; their chain/state headers and heights roots are the host chain record's, the tip read off them the host's; a proof on A verifies; a heavier branch replacing two headers reverts it (unproven, broadcast again) and leaves B on the new record; the gate (a host chain block through every set, A's record not through B's); replayed after the process stopped; timings: a block's frame and its event to 8 instances, chain-import of an image (HOSTCHAIN_IMPORT headers)"
"${node[@]}" "$kz/equiv/hostchain.ts" || status=1


echo "== the worker pool (#158): 8 instances × 500 entries interleaved = serial, with 1 worker too; a call beside a step blocked on the wallet sees the state as committed; the member gate and host/chain; each set replayed after the process stopped; timings"
"${node[@]}" "$kz/equiv/pool.ts" || status=1

exit $status
