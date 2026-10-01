# wasm/

The modules the kernel pins (`kernel-zig/src/programs.zig`; the shell's and
the wallet's also in `src/runtime/programs.ts`) and installs into every
store (`skein-kernel serve`/`replay`, `skein-dev install`; `$SKEIN_WASM_DIR`
overrides where they are read from). Each is checked against its pinned raw
CID (CIDv1, raw, sha2-256) when it is installed. Since #71 they come from
two places.

## Built here

| module | source | what |
|---|---|---|
| `messagebox.wasm`, `frontdoor.wasm`, `resolve.wasm` | `programs/` | the boundary programs (#40) |
| `wallet.wasm` | `programs/wallet` | the wallet's handler (#29), over the SDK's wallet library |
| `wire-probe.wasm` | `programs/test/wire-probe` | a test program, not pinned |

All of these are Zig 0.16.0 and `wasm32-wasi`, over the SDK (shruggr/skein-sdk,
a Zig package dependency by URL+hash, #75 — not a path in this tree).
`scripts/build-programs.sh` builds them and `scripts/pin-programs.sh` rewrites
the pins. The builds are reproducible.

## From the workbench (shruggr/skein-workbench)

`run-handler.wasm` and `loop.wasm` are the workbench's two Zig programs.
The rest is the shell's toolset: `brush.wasm` and `coreutils.wasm` (the
shell), `find`, `xargs`, `diff`/`cmp`, `jq`, `which`, `grep`, `tree`, `awk`,
`sed`, `git`, `qjs` (also `node`), `python` (also `python3`) and
`python314.zip` (the stdlib, a support file, not a module).

Their sources, patches and build (`scripts/build-toolset.sh`) live in the
workbench, and `toolset/README.md` there says where each one comes from. The
built modules are committed here because the stock genesis wires `run` and
`chat` to them and the kernel's stock shell program names the toolset.
`scripts/update-workbench.sh <workbench checkout>` copies a workbench build
in, rewrites the pins, and writes the workbench commit to `WORKBENCH`.

## Not here

Apps outside the stock genesis ship their own modules in their trees
(docs/APPS.md). Static files are shruggr/skein-static (`bin/static.wasm`).
The overlay engine is shruggr/skein-overlay (`bin/overlay.wasm`, with its
demo topic manager and lookup service).

Go `wasip1`, Rust, C and so on remain valid targets for third-party programs.
The `skein` imports are the ABI (the SDK's `wit/skein.wit`), not a language.
