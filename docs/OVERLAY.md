# Overlay services (issues #36, #50, #57, #73, #74)

The overlay services engine is an app in its own repo (#71):
[shruggr/skein-overlay](https://github.com/shruggr/skein-overlay). Its
`docs/OVERLAY.md` is this document, moved there with the engine's sources:
the submission flow, the maps, the split with the wallet, settlement, the
engine's boxes and config, the topic contract, the lookup contract (#50),
the wire (#40), the gossip (#74), and a system tree for an overlay node.
Links elsewhere in skein's docs to a section of docs/OVERLAY.md ("Gossip",
"The wire", …) name that document's sections.

The app's tree is `bin/overlay.wasm` (the engine), `bin/topic-demo.wasm`
(`tm_demo`) and `bin/lookup-demo.wasm` (`ls_demo`), committed, and
`etc/app.json`, its manifest (docs/APPS.md §6). The engine is not pinned
here: a tree carries its modules.

`kernel-zig/equiv/overlay.ts` runs it end to end, as part of
`kernel-zig/equiv/run.sh`: it clones skein-overlay at a pinned commit (or
takes the checkout `$SKEIN_OVERLAY_DIR`) and boots instances from trees
carrying its `bin/*.wasm`.
