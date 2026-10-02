# Overlay services (issues #36, #50, #57, #73, #74, #79)

The overlay services engine is an app in its own repo (#71):
[shruggr/skein-overlay](https://github.com/shruggr/skein-overlay). Its
`docs/OVERLAY.md` is this document, moved there with the engine's sources:
the submission flow, the overlay's own state and its split from the chain
app (#79), the engine's boxes and config, the topic contract, the lookup
contract (#50), the wire (#40), the gossip (#74), and a system tree for an
overlay node. Links elsewhere in skein's docs to a section of
docs/OVERLAY.md ("Gossip", "The wire", …) name that document's sections.

Since 0.3.0 (#79) an overlay app keeps what its topics admitted and judged,
its lookup services' maps and its gossip state under its own name
(`<app>/state`, `<app>/ls_<service>`, `<app>/gossip`), holds no chain state
and links no chain tracker: a submission goes to the chain app
(shruggr/skein-chain, `requires: ["chain/1"]`) as an `ingest` message and is
admitted on the chain app's first `accepted` or `proven` answer. Two
overlay apps on one instance coexist by construction (docs/APPS.md §6). The
topic and lookup contracts are Zig modules (`topic`, `lookup`) an app
depends on by URL+hash.

The app's tree is `bin/overlay.wasm` (the engine), `bin/topic-demo.wasm`
(`tm_demo`) and `bin/lookup-demo.wasm` (`ls_demo`), committed, and
`etc/app.json`, its manifest (docs/APPS.md §6). The engine is not pinned
here: a tree carries its modules.

`kernel-zig/equiv/overlay.ts` runs it end to end, as part of
`kernel-zig/equiv/run.sh`: it clones skein-overlay and skein-chain at pinned
commits (or takes the checkouts `$SKEIN_OVERLAY_DIR`, `$SKEIN_CHAIN_DIR`) and
boots instances from trees carrying their `bin/*.wasm`;
`kernel-zig/equiv/install-overlay.ts` installs both as apps, and two overlay
apps on one instance.
