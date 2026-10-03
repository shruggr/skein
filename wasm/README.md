# wasm/

The modules the kernel pins (`kernel-zig/src/programs.zig`; the wallet's
also in `src/runtime/programs.ts`) and installs into every store
(`skein-kernel serve`/`replay`, `skein-dev install`; `$SKEIN_WASM_DIR`
overrides where they are read from). Each is checked against its pinned raw
CID (CIDv1, raw, sha2-256) when it is installed.

## Built here

| module | source | what |
|---|---|---|
| `messagebox.wasm`, `frontdoor.wasm`, `resolve.wasm` | `programs/` | the boundary programs (#40) |
| `wallet.wasm` | `programs/wallet` | the wallet app's program (#29, #79), over the SDK's `wallet` and `chain` modules |
| `wire-probe.wasm` | `programs/test/wire-probe` | a test program, not pinned |

All of these are Zig 0.16.0 and `wasm32-wasi`, over the SDK (shruggr/skein-sdk,
a Zig package dependency by URL+hash, #75 — not a path in this tree).
`scripts/build-programs.sh` builds them and `scripts/pin-programs.sh` rewrites
the pins. The builds are reproducible.

## Not here

Apps ship their own modules in their trees (docs/APPS.md), and the install
sends them. The shell app (shruggr/skein-shell) carries `run` and the shell
itself: brush, coreutils and the toolset, with python's stdlib as a support
file (#83: the kernel pins none of them; a genesis has no shell). The chat
app (shruggr/skein-chat) carries the chat loop. Static files are
shruggr/skein-static (`bin/static.wasm`). The overlay engine is
shruggr/skein-overlay (`bin/overlay.wasm`, with its demo topic manager and
lookup service), the chain app shruggr/skein-chain (`bin/chain.wasm`).

Go `wasip1`, Rust, C and so on remain valid targets for third-party programs.
The `skein` imports are the ABI (the SDK's `wit/skein.wit`), not a language.
