# kernel-zig

The skein kernel in Zig (issue #32): the block store, the input log, the
index (issue #30: IPLD maps in the store and one state record), the
scheduler, the subscriptions and heads chains, the filesystem over the
store, the WASI preview1 imports and the `skein` imports — running the wasm
programs through wasmtime's C API. It is replay-exact against the TypeScript
runtime in `src/runtime` (the reference, frozen): the same log gives the same
entries, the same records and CIDs, the same derived state. Delivery, the
tick, the resolver and the wallets stay TypeScript and are peers
(`peer/peer.ts`), as they are around the TS runtime.

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
skein-kernel dump <store.db>               # the derived state read through the index, as JSON (either format, read only)
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
(build it first). Since #30 the store file holds blocks and the state
pointer only: `skein-host` (it reads blocks) is unaffected; the explorer and
`skein-dev` open a store file through `src/runtime/index-store.ts`, which
reads the maps when the file has the state pointer and the old tables when
it does not — see "The index" below.

## The index (issue #30)

The store is a key→bytes map: SQLite's `blocks` table and a `pointers` table
with one row, `state` → the CID of the **state record**
`{kind: "skein-state", log: <log tip>|null, cursor, heads: <root>|null, index: {<map>: <root>|null}}`.
What SQLite's `chains`/`updates`/`edges`/`entries`/`meta` held is now
**Merkle search trees** (`mst.zig`) whose nodes are blocks beside every
other record, one per query shape (`index.zig`):

| map | key → value | answers |
|---|---|---|
| `log` | n → entry | `logFrom(n)` (a range), genesis |
| `unique` | envelope or emit → entry | `byEnvelope`, `outcomeOf`, duplicate admission |
| `chains` | origin → {tip, seq, kind} | `chainTip`, `chainAppend` |
| `updates` | origin ‖ seq → update | `chainUpdates` (a prefix) |
| `threads` | at ‖ origin | every thread (the witness) |
| `resting` | at ‖ origin | threads not finished, in resume order |
| `sleepers` | until ‖ origin | waiting threads by deadline |
| `awaits` | envelope ‖ at ‖ origin | the threads awaiting a reply to an envelope (a prefix) |
| `edges` | to ‖ from ‖ seq ‖ ord → [rel, locator] | what points at a record (a prefix) |
| `heads` | name → tree | `head` |

Keys: numbers 8-byte big-endian with the sign bit flipped; binary CIDs
(prefix-free, so concatenations split); strings uvarint-length-prefixed. A
node is the dag-cbor array `[left, [[key, value, right]…]]` (CIDv1,
dag-cbor, sha2-256, as every record). A key's level is the leading zero
5-bit groups of sha2-256(key), so nodes hold ~32 keys. The tree is
**canonical** — one tree per set of pairs, whatever the insertion or
deletion order (unit-tested with shuffled puts and interleaved deletes) —
so a map's root is a function of its contents and the state record is a
function of the log. The derivation is `sqlite.ts`'s, key for key.

**Commits.** Changes go to a working state; new nodes wait in memory. At each
log append the log maps' nodes and a state record are written (the entry is
durable before the provider hears back; the other maps as last committed);
after each processed entry, and at the end of `start` and of a drain,
every map's new nodes, the cursor and the state record are written in one
transaction and the pointer moves. Only the nodes the new roots reach are
written (intermediate versions within an entry are dropped). A crash loses
at most the unprocessed entry's derived changes, which reprocessing
recomputes (same CIDs).

**Per-entry cost** (measured over every replay in the suite): 2.5–7.5 new
index nodes per log entry (0.6–4.2 KiB), plus two state records (~0.5 KiB
each: one at admission, one after processing). A put writes at most the
nodes on one root-to-leaf path: log₃₂(n)+1 levels, ~5 at 2M keys. Replay
time is unchanged within noise (e.g. the generated `run` store: 1.36 s
before, 1.21–1.35 s after; `kurt/runtime.db.pre-replies` 0.57 s → 0.59–0.62
s): the wasm runs dominate.

**Older stores.** A file in the format before #30 (the TS runtime's, or this
kernel's before #30) has no state record: it is imported from its tables —
the log from `entries`, each chain from its origin and `updates`, the cursor
from `meta` — through the same derivation, so the import and the
incremental path reach the same state CID (the suite checks it on every
replay). Opened for writing, the state record is written and the old tables
are renamed `legacy_*`; opened read only (a replay's source, `dump`), the
import stays in memory. A store whose old index is stale is refused as
before (`skein-dev rebuild` it).

**From TypeScript** (`src/runtime/index-store.ts`): a read-only `Store` over
the maps (the pointer re-read on every call, so it follows a live kernel),
used by the explorer and `skein-dev` (`rebuild` is refused on such a store:
the kernel keeps its index); and `buildIndex`, the same maps built
canonically in TypeScript — equiv checks it reaches the kernel's state CID,
and that every explorer page renders the same over the TS and the Zig
replays' files. **Not yet:** the wallet's flat
index (`wallet-zig`, #29) moves onto `mst.zig` in #29 phase 2; pruning old
spine nodes and state records; a cache bound (decoded nodes are dropped at
every commit).

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

| check | what | result (2026-09-28, #30) |
|---|---|---|
| `zig build test` | dag-cbor encodings and CIDs, canonical re-encoding of non-canonical input, strict decoding, program-record CIDs, "anyone" signatures (log entries, envelopes), JCS, the entropy stream — against fixtures the TS runtime made (`test/fixtures.ts`); traps through wasmtime reported in V8's words (the words read from Node 26 on the same hand-built modules); the Merkle search tree (put/get/replace/delete/range/prefix, canonical under shuffled order, copy-on-write sharing and path-only writes); the index over an in-memory backend (maps follow chains, commits, import = incremental, reopen) | 15/15 |
| `equiv/shell.ts` | host-go's 64 shell cases, plus 7 for the script runtimes (#25: `node`/`qjs`/`python3` by name and by `#!`, argv, stdin, files, exit codes, the read-only stdlib mount, clock and random with `time`/`seed`, timers and `time.sleep` on the run's virtual clock), through `runShell` on Node and `skein-kernel shell`: stdout, stderr, exit code, tree CID | 71/71 identical (2026-09-27) |
| `equiv/git.ts` | git (`wasm/git.wasm`) in the shell on this kernel, 15 steps over one tree: `init add rm mv status diff commit log show branch checkout reset restore merge tag`, author from `.gitconfig`/env, dates from the run's clock; the commit's tree is the VFS's project tree; `.git/objects` holds gitlinks only; every object is one git-raw record, no zlib copy in the store; gc/repack write no pack; a second run gives identical trees and output | all ok (2026-09-27) |
| `equiv/replays.ts` over `equiv/corpus.ts` | 8 stores the TS runtime writes: run/objects/head/subscribe handlers, the shell (writes, cwd, failures, one and two sleeps with their wakes), node/qjs/python scripts in a thread (attested clock and random; a `time.sleep` and a qjs timer resting the thread until the tick; #25), the loop with bash and message tools, replies, resolutions, a failed delivery resuming the loop, a refused infer, two agents talking | 8/8 identical; each also reproduces its source's thread and head tips |
| `equiv/replays.ts` over copies of `~/.skein` | the live `martha` and `kurt` stores, their 6 backups, `~/.skein/runtime.db` and its eras | 10/10 replayable stores identical; the 6 pre-current-format eras are refused by both runtimes |
| `equiv/serve.ts` | `serve` spawned as the supervisor spawns `bin/skein-runtime` (ipc channel included), with the real providers on an in-process messagebox: genesis, a run, a chat through the inference peer, a sleep woken by the tick, SIGTERM mid-sleep and the restart that finishes it, stop on channel close; then the store the Zig kernel wrote (the new format), replayed on both runtimes | all ok; the replays identical to each other and to the store |

A replay comparison (issue #30: the two stores no longer share a format) is
what the runtimes did and derived: the log entries (n, CID, the
envelope/emit each is unique by); the records (every block of the TS store,
and in the Zig store nothing else but index nodes and state records); the
runtime's log lines, the emits handed to the outbox and the log tip; the
derived state asked of the TS tables in SQL and of the Zig index through
`skein-kernel dump` — chains and tips, every update's position, threads,
resting threads in resume order, sleepers by deadline, awaits, edges,
heads, the cursor; and the state record: the TS store's tables imported
into the index give the same state CID as the Zig replay's. A store the Zig
kernel wrote is given to the TS side as a TS store rebuilt from its blocks
and log (`equiv/replay.ts`). Sources are copied (with their `-wal`) before
anything opens them. The "vs the source" tip counts below 100% on the older
backups are the sources' own history (the TS replay differs from them the
same way).

## Layout

| file | what (TS counterpart) |
|---|---|
| `cbor.zig`, `cid.zig` | dag-cbor as @ipld/dag-cbor + cborg do it; CIDs (`cid.ts`) |
| `json.zig` | JSON.stringify quoting, Number::toString, RFC 8785 (`envelope.ts jcs`) |
| `secp.zig` | BRC-42 "anyone" keys, ECDSA verify as @bsv/sdk (`identity.ts`) |
| `envelope.zig` | BRC-169 envelope checks, BRC-78 framing (`runtime/envelope.ts`) |
| `store.zig`, `sqlite.zig`, `sqlite_store.zig` | the store interface; the SQLite file as blocks + the state pointer, and the import of the old format (`store.ts`, `sqlite.ts`) |
| `index.zig`, `mst.zig`, `dump.zig` | the index as maps in the store and the state record (#30); the Merkle search tree; `skein-kernel dump` |
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
- **The store file** (#30): blocks and the state pointer, not the TS tables.
  The TS runtime runs on it only through a rebuild (`equiv/replay.ts` shows
  how); the explorer and `skein-dev` read it (`src/runtime/index-store.ts`).
- **Not ported**: the index rebuild of a stale older store (`edges.rebuild`;
  such a store is refused, `skein-dev rebuild` it first), `putMessage` and
  the `messages` table (the runtime does not write them), `handles`, the
  `waitersOn`/`waitingFrom`/`due` queries (the kernel does not ask them; the
  maps would be `launched ‖ origin` and `identity ‖ origin`, and `due` is a
  range of `sleepers`).
- **Components / WASI 0.2** (#14) and the browser target: not built. The
  seams are `engine.zig` (the wasm engine) and `index.Backend` (a key→bytes
  map with one pointer: blocks by CID, a transaction, the state pointer);
  the scheduler, the index, the WASI and skein imports, the vfs and the
  codecs touch no OS. `serve.zig` and `replay.zig` are the native front ends.

## Script runtimes (issue #25)

The shell's `qjs`/`node` and `python`/`python3` (wasm/README.md, "Script
runtimes") run here as in `shell.ts`: `programs.zig` lists the modules, the
aliases (`node` → qjs, `python3` → python), FILES (`python314.zip`, installed
with the modules) and the shell program record's `support` (so its CID is
programs.ts's); `shell.zig` dispatches a `#!` script to its interpreter when
that is an extra program, adds a program's env defaults (`PYTHONHOME`,
`PYTHONDONTWRITEBYTECODE`) unless the caller set them, and mounts its support
files read-only for that process only (`wasi.zig` `Services.mounts`, a
preopen at fd 4 over in-memory nodes outside the tree; a write open there is
EROFS). Outside a thread, a sleep moves the run's clock to its deadline
(`shell.Fixed.sleep`), as `runShell` does without `clock`/`sleep`.
