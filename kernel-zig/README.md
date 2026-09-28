# kernel-zig

The skein kernel in Zig (issue #32): the SQLite block store, the input log,
the scheduler, the subscriptions and heads chains, the filesystem over the
store, the WASI preview1 imports and the `skein` imports — running the wasm
programs through wasmtime's C API. It is replay-exact against the TypeScript
runtime in `src/runtime` (the reference, frozen): the same log gives the same
records, the same CIDs, the same store file row for row. Delivery, the tick,
the resolver and the wallets stay TypeScript and are peers (`peer/peer.ts`),
as they are around the TS runtime.

## Build

Zig 0.15.2 is pinned by the repo's `mise.toml` (`mise install`, then prefix
commands with `mise exec --` or activate mise).

- **wasmtime**: the C API release, not vendored. Download
  `wasmtime-v49.0.1-aarch64-linux-c-api.tar.xz` (or your platform's) from
  https://github.com/bytecodealliance/wasmtime/releases and unpack it under
  `~/.local/wasmtime-c-api/`. `build.zig` takes the directory from
  `-Dwasmtime=<dir>`, else `$WASMTIME_C_API`, else
  `~/.local/wasmtime-c-api/wasmtime-v49.0.1-aarch64-linux-c-api`. The static
  `libwasmtime.a` is linked: the binary needs nothing of it at run time.
- **SQLite**: the system `libsqlite3` (3.38 or later, for JSON1).

```
cd kernel-zig
zig build --release          # zig-out/bin/skein-kernel (ReleaseSafe)
zig build test               # unit tests, incl. test/fixtures.json made by the TS runtime
```

wasmtime's compilation cache (`~/.cache/wasmtime`) is on: a cache of machine
code for module bytes, not state. `SKEIN_WASMTIME_CACHE=0` turns it off.

## Run

```
skein-kernel serve                         # the runtime process: a drop-in for bin/skein-runtime
skein-kernel replay <source.db> <out.db>   # the log alone into a fresh store, no wallet (skein-dev replay)
skein-kernel shell <store.db> < cases.json # shell cases as host-go's tests pass them
```

`serve` reads the environment `bin/skein-runtime` documents (`SKEIN_HOME`,
`SKEIN_DB`, `SKEIN_HANDLE`, `SKEIN_WALLET`, `SKEIN_WALLET_URL`,
`SKEIN_HOST_WALLET_URL`, `SKEIN_OWNER`, `SKEIN_INFER`, `SKEIN_MESSAGEBOX`,
`SKEIN_HOST_DB`, `SKEIN_POLL_MS`, `SKEIN_SEND_*`, …), installs the pinned
modules from `wasm/` into a store that lacks them, prints the same lines —
among them `skein runtime <identity> (<handle>@<domain>) · pid … · db …`, which
the supervisor waits for — and stops on SIGINT/SIGTERM or when the
supervisor's IPC channel (`NODE_CHANNEL_FD`) closes. With
`SKEIN_KERNEL=zig`, `bin/skein-runtime` execs it instead of `src/host/main.ts`,
so `SKEIN_KERNEL=zig skein-host run` runs every instance on the Zig kernel
(build it first); the explorer reads the same store file unchanged.

### How serve is put together

```
skein-host run ──spawn──▶ skein-kernel serve ──spawn──▶ node peer/peer.ts
   (supervisor)            store · log · scheduler        host wallet · instance wallet
                           programs (wasmtime)             Delivery (messagebox) · Tick
                                ▲        │                 hostResolver
                                └frames──┘  length-prefixed dag-cbor on the child's stdin/stdout
```

`peer/peer.ts` is `main.ts`'s `startInstance` with the runtime behind
`RemoteRuntime`: the surface the providers use on the TS `Runtime` — `admit`,
`boxes`, `sleepersDue`/`onSleep`, `idle`, the outbox, `store.log.tip`/
`byEnvelope`, `store.get`/`put`/`log.append` (for the genesis) — each one a
frame. The kernel asks the peer for the instance wallet's answers to
programs' BRC-100 wire frames and for handle resolutions; both are attested
calls, recorded as the TS runtime records them. The Delivery, Tick and
resolver code is `src/host`'s, unchanged.

## Equivalence

`equiv/run.sh` runs all of it (it builds first):

| check | what | result (2026-09-27) |
|---|---|---|
| `zig build test` | dag-cbor encodings and CIDs, canonical re-encoding of non-canonical input, strict decoding, program-record CIDs, "anyone" signatures (log entries, envelopes), JCS, the entropy stream — against fixtures the TS runtime made (`test/fixtures.ts`); traps through wasmtime reported in V8's words (the words read from Node 26 on the same hand-built modules) | 10/10 |
| `equiv/shell.ts` | host-go's 64 shell cases through `runShell` on Node and `skein-kernel shell`: stdout, stderr, exit code, tree CID | 64/64 identical |
| `equiv/git.ts` | git (`wasm/git.wasm`) in the shell on this kernel, 15 steps over one tree: `init add rm mv status diff commit log show branch checkout reset restore merge tag`, author from `.gitconfig`/env, dates from the run's clock; the commit's tree is the VFS's project tree; `.git/objects` holds gitlinks only; every object is one git-raw record, no zlib copy in the store; gc/repack write no pack; a second run gives identical trees and output | all ok (2026-09-27) |
| `equiv/replays.ts` over `equiv/corpus.ts` | 7 stores the TS runtime writes: run/objects/head/subscribe handlers, the shell (writes, cwd, failures, one and two sleeps with their wakes), the loop with bash and message tools, replies, resolutions, a failed delivery resuming the loop, a refused infer, two agents talking | 7/7 identical; each also reproduces its source store exactly |
| `equiv/replays.ts` over copies of `~/.skein` | the live `martha` and `kurt` stores, their 6 backups, `~/.skein/runtime.db` and its eras | 10/10 replayable stores identical; the 6 pre-current-format eras are refused by both runtimes |
| `equiv/serve.ts` | `serve` spawned as the supervisor spawns `bin/skein-runtime` (ipc channel included), with the real providers on an in-process messagebox: genesis, a run, a chat through the inference peer, a sleep woken by the tick, SIGTERM mid-sleep and the restart that finishes it, stop on channel close; then the store the Zig kernel wrote, replayed on both runtimes | all ok; the replays identical to each other and to the store |

A replay comparison is every row of `blocks`, `chains`, `updates`, `edges`,
`entries`, `meta`, the runtime's log lines, the emits handed to the outbox
and the state hash. Sources are copied (with their `-wal`) before anything
opens them.

## Layout

| file | what (TS counterpart) |
|---|---|
| `cbor.zig`, `cid.zig` | dag-cbor as @ipld/dag-cbor + cborg do it; CIDs (`cid.ts`) |
| `json.zig` | JSON.stringify quoting, Number::toString, RFC 8785 (`envelope.ts jcs`) |
| `secp.zig` | BRC-42 "anyone" keys, ECDSA verify as @bsv/sdk (`identity.ts`) |
| `envelope.zig` | BRC-169 envelope checks, BRC-78 framing (`runtime/envelope.ts`) |
| `store.zig`, `sqlite.zig`, `sqlite_store.zig` | the store interface and the SQLite file (`store.ts`, `sqlite.ts`) |
| `log.zig`, `heads.zig`, `subscriptions.zig`, `programs.zig`, `syscalls.zig` | `log.ts`, `records.ts`, `heads.ts`, `subscriptions.ts`, `programs.ts`, `syscalls.ts` |
| `engine.zig` | wasmtime behind compile/run/one host callback; traps as V8 names them |
| `wasi.zig`, `vfs.zig`, `tree.zig` | `wasi/host.ts`, `wasi/vfs.ts`, `tree.ts` |
| `objects.zig` | none: the synthetic `.git/objects` (issue #2, docs/VM.md), loose-object framing over git-raw records |
| `runner.zig`, `shell.zig`, `program.zig` | module cache and `runModule`; `shell.ts`; `program.ts` + `wasi/skein-imports.ts` |
| `scheduler.zig` | `scheduler.ts` |
| `serve.zig`, `ipc.zig`, `peer/peer.ts` | `src/host/main.ts` as a process with its providers as a peer |
| `replay.zig`, `cmd_shell.zig` | `skein-dev replay`; the shell test driver |

## What is not the same, or not here

- **The synthetic object directory** (issue #2) is only here. In a tree,
  `.git/objects/xx/yyyy…` is a gitlink naming the git-raw record; to
  programs it is a read-only file of zlib bytes; a loose object that git
  writes is hash-checked and kept as the record; `.git/objects/pack` takes
  nothing new (docs/VM.md). The TypeScript runtime treats those paths as
  plain files and gitlinks as empty directories. So a log in which `git`
  writes objects replays on this kernel only, and trees without
  `.git/objects` behave the same on both.

- **Sleeping shells** are not parked mid-instance (no JSPI): the run is
  abandoned at the sleep after writing `waiting`, and the wake re-executes the
  thread from its origin, verifying every update against its chain — the TS
  restart path — and carries on under the wake entry. Same records; a
  re-execution per wake.
- **Messages that only exist as JavaScript text**: trap messages are mapped
  to V8's wording for the common traps (unreachable, out-of-bounds memory,
  division, conversion, indirect calls; stack overflow as V8's RangeError);
  wasm compile errors, cborg decode errors ("CBOR decode error") and
  multiformats CID decode errors are approximated. They reach records only
  when a program prints what an import told it or a step fails that way.
- **Engine limits**: wasmtime's default wasm stack (512 KiB) and V8's differ,
  so a deep enough recursion overflows at a different depth. Fuel is off, as
  on Node.
- **The drain's own crash lines** (`runtime: <stack>`) are not stack traces.
- **Not ported**: the index rebuild of an older store (`edges.rebuild`; such a
  store is refused, `skein-dev rebuild` it first), `putMessage` and the
  `messages` table (the runtime does not write them), `handles`, the edge
  queries the explorer makes (it reads the file itself).
- **Components / WASI 0.2** (#14) and the browser target: not built. The
  seams are `engine.zig` (the wasm engine) and `store.zig` (the store table of
  functions); the scheduler, the WASI and skein imports, the vfs and the codecs
  touch no OS. `serve.zig` and `replay.zig` are the native front ends.
