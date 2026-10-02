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
first `accepted` or `proven` answer. Two overlay apps on one instance run
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
