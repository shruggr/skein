# wasm/

skein next: the kernel pins no program and installs none into a store (SPEC 5: the kernel runs a row's
handler directly; no front door, no mail program, no resolve program). An instance's programs come in its
apps (docs/APPS.md), whose trees ship their modules; the install sends them. `wasmDirObjects(WASM_DIR)`
(src/host/boot.ts) still lets an app's `bin/<x>.cid` name a module kept here.

| module | source | what |
|---|---|---|
| `wire-probe.wasm` | `programs/test/wire-probe` | a test program, not pinned |

Zig 0.16.0 and `wasm32-wasi`, over the SDK (shruggr/skein-sdk, a Zig package dependency by URL+hash):
`scripts/build-programs.sh` builds it.
