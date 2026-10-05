# Overlay services

The overlay engine is an app in its own repository,
[shruggr/skein-overlay](https://github.com/shruggr/skein-overlay) (0.3.0).
Its `docs/OVERLAY.md` is the reference: the submission flow, the overlay's
state and its split from the chain app, the engine's box and config, the
topic contract, the lookup contract, the wire, the gossip, and a system
tree for an overlay node. Links elsewhere in skein's docs to a section of
docs/OVERLAY.md ("Gossip", "The wire", …) name that document's sections.

An overlay app keeps what its topics admitted and judged, its lookup
services' maps and its gossip state under its own name (`<app>/state`,
`<app>/ls_<service>`, `<app>/gossip`). It holds no chain state: a
submission goes to the chain app (shruggr/skein-chain, `requires:
["chain/1"]`) as an `ingest` message and is admitted on the chain app's
first `accepted` or `proven` answer.

**A submission's BEEF is decoded at the kernel's door** (#121, docs/VM.md
"The door"). The submit rows — `/<app>/submit` and the libp2p `<topic>`,
derived from `config.overlay` (src/host/manifest.ts `overlayWiring`) — name
`filter: "beef"`: before the request's entry is written, the kernel stores
each transaction once as its `bitcoin-tx` block and each BUMP as its bytes'
raw block, checks every BUMP against `chain/state`, and puts the BEEF's
pointer record where the bytes were. The submit handler gets the record's
CID, reads it (skein-overlay ≥ its `beef-as-cid` commit, `decodeRecord`),
and does not prove the BUMPs again; the submit event and the `ingest`
message carry the CID; the gossip re-publishes the exact bytes received
(skein-sdk `chain.record.beefOf`). A bad BUMP is a refusal entry, 400 to an
HTTP client, `reject` on GossipSub; nothing runs. No BEEF bytes are logged
— but for a body framed with off-chain values (`VarInt(len) ‖ BEEF ‖
values`), which no BEEF pattern leads: the door passes it, and the overlay
decodes and checks it in its call as before. Two overlay apps on one instance run
over the one `chain/state` (docs/APPS.md §6). The topic and lookup
contracts are Zig modules (`topic`, `lookup`, and the `sk` helpers) an app
depends on by URL+hash. Next for the engine: skein-overlay#1 (submit walks
the whole BEEF oldest-first and judges every transaction of the topic).

The app's tree is `bin/overlay.wasm` (the engine), `bin/topic-demo.wasm`
(`tm_demo`), `bin/lookup-demo.wasm` (`ls_demo`) and `etc/app.json`. The
engine is not pinned here: a tree carries its modules.

`kernel-zig/equiv/overlay.ts` runs it end to end as part of
`kernel-zig/equiv/run.sh`: it clones skein-overlay and skein-chain at
pinned commits (or takes `$SKEIN_OVERLAY_DIR`, `$SKEIN_CHAIN_DIR`) and boots
instances from trees carrying their `bin/*.wasm`;
`kernel-zig/equiv/install-overlay.ts` installs both as apps, and two
overlay apps on one instance.

## How an overlay app activates a token topic live (#119)

A topic per token (`tm_<txid>`) is not known at install, so it cannot be a
row of its own. The app's manifest declares one libp2p **prefix row** —
`{transport: "libp2p", address: "tm_", prefix: true, sender: "*",
program: <role>, fn}` — which the owner approves at the install like any
row. That row subscribes nothing by itself; it makes every `tm_…` topic the
app's to route (the kernel's `forLibp2p`: an exact row first, then the
longest prefix) and the app's to ask for.

When the app learns of a token, its installed program emits
`{event: "subscribe", topic: "tm_<txid>"}` (and `unsubscribe` when it is
done with it). The kernel records the event on the step's update with the
app's name; after the commit the host's libp2p node subscribes the topic
for that app — only if the app's rows take it (another app's exact row for
that topic, or its longer prefix, makes it the other app's: refused, a log
line). A message gossiped on the topic is then validated and routed to the
app's row like any topic message. After a host restart the node reads the
subscriptions back from the log at hydrate; the app does nothing.
docs/MESSAGES.md "libp2p (#51)", "Topics an app asks for".
