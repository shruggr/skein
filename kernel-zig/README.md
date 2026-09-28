# kernel-zig

The skein kernel in Zig (issue #32): the block store, the input log, the
index (issue #30: IPLD maps in the store and one state record), the
scheduler, the subscriptions and heads chains, the filesystem over the
store, the WASI preview1 imports and the `skein` imports — running the wasm
programs through wasmtime's C API. It was built replay-exact against the
TypeScript runtime in `src/runtime` (frozen); since fuel went on the update
record (issue #5) it is its own reference: the same log gives the same
entries, records, CIDs, derived state and fuel on every replay, and the
suite checks that Zig against Zig. Delivery, the
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
skein-kernel fuel <store.db> [--since n]   # fuel per thread and in total, from the steps whose input is entry n or later
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

## Fuel (issue #5)

wasmtime's fuel is on for every instance the kernel runs (`engine.zig`:
`wasmtime_config_consume_fuel_set`). Fuel is an instruction count, not a
clock: the same module and input burn the same fuel on every machine, so it
is recorded and replayed like any other field.

- **Per step, one budget** (`engine.Meter`): a handler program's step, or a
  shell step — the shell and every child it spawns (`skein.spawn`, pipes),
  nested instances drawing on one pool. The meter settles the running
  instance before a child starts and after it ends, so a step's fuel is the
  sum over everything that ran in it. A shell thread's steps are its
  segments: from a `running` update to the `waiting`/`finished`/`errored`
  that ends it (a sleep ends one; the wake starts the next with a full
  budget). Re-executing a thread from its origin on wake burns the same fuel
  again, and every recomputed update — its fuel included — is verified
  against the chain.
- **The field**: every update that ends a step (`finished`, `errored`,
  `waiting`) has `fuel` (an integer); `running` updates have none, nor do
  heads and subscriptions chains. A step that failed before running wasm
  records `fuel: 0`.
- **The limit**: `fuelPerStep` in the genesis's `defaults` (a decimal
  string, as every default is; `src/runtime/log.ts` `DEFAULTS` gives
  `"1000000000000"`, 10^12), read at the start of each step; a genesis
  without it gets the same 10^12 (`scheduler.FUEL_PER_STEP`). Out of fuel
  (wasmtime's out-of-fuel trap, in whichever instance) the step ends
  `errored` with `error: {kind: "cant-do", message: "fuel exhausted"}` and
  `fuel` = the limit — stable, never retried. An errored step's update
  lists the recorded calls it made before failing, so a replay has their
  answers. (wasmtime checks fuel at function entries and loop headers; a run
  may overshoot its budget by the few instructions after its last check,
  in which case its `fuel` is the limit without a trap.)
- **Billing is a query over the log**: `skein-kernel fuel <db> [--since n]`
  sums the updates' fuel per thread (in thread order, with the program's
  name) and in total, over the steps whose input entry is n or later;
  `skein-kernel dump` lists each update's fuel and the per-thread sums.
  Anyone holding the log can replay it and get the same numbers.
- **Cost**: replaying the generated corpus takes 0–9% longer with fuel on
  (best of 5 per store, e.g. `gen-run` 1110 → 1210 ms, `gen-kurt` 594 →
  593 ms; wasmtime's fuel instrumentation, plus a settle per nested
  instance).
- **Existing state**: update CIDs changed. The state record carries
  `format: 1`; a store with a log whose state record has no `format` (the
  kernel before #5), or in the TS runtime's tables, is refused for running
  (`serve`, `shell`: "a store written before fuel metering (issue #5) …
  refused (start a new store: re-genesis)"). Read-only uses still open it:
  `dump`, `fuel`, and `replay` as a source (a log is a log — the replay
  recomputes every update, with fuel, into a fresh store).
- Not metered: host time outside the VM (the peers, the oracle), memory
  (a module's own max), per-tree depth and step counts (countable from the
  chain; enforced from config later).

## For the wallet (issue #29)

What this kernel adds for the wallet in the VM (`wallet-zig/`, docs/WALLET.md);
the TS runtime has none of it.

- **Bitcoin codecs** (`cid.zig`): `putblock` accepts `bitcoin-tx` (0xb1) and
  `bitcoin-block` (0xb0, 80 bytes) with `dbl-sha2-256` (0x56), hash-checked,
  so a transaction's CID is its txid and a header's its block hash (the
  digest in internal byte order); `get` returns the bytes as stored.
- **Plain entries** (`log.zig`, `scheduler.zig` `processEvent`):
  `{kind: "log", n, prev, time, box, event}` — no envelope, no signature. The
  host admits one per event from a feed it holds (SSE/webhook: a header, a
  proof, a transaction status), with the record `event` names already put.
  Processing: the thread whose tip awaits the record's `subject` (a CID; a
  transaction's is its txid) steps with `input.event = {event, box,
  subject}`; else a subscription with no sender on the entry's box launches
  its handler with `args = {event, box}`.
- **`await` on a record**: besides an envelope the step emitted, a step may
  await any record in the store — the subject of a plain entry to come.
- **`deadline(until_ms)`**: a step that ends waiting rests until then at
  most: the update carries `until`, the thread is a sleeper for the tick
  (re-registered on start), and the wake entry steps it with `input.woke`.
- **`http(req, len, out, cap)`**: a dag-cbor request `{method, url,
  headers?, body?}` → response `{status, headers, body}`, answered by the host
  (`serve`: the peer's `http` frame; `peer.ts` answers with a test's handler,
  or with `fetch` when `SKEIN_HTTP=fetch`, else refuses) and attested like
  `wallet`/`resolve` (op `http`): replay reads the answer from the record and
  never touches the network. This is the pre-#15 shape: #15 replaces the
  import with standard `wasi:http`, answered and recorded the same way.

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
replays' files. The wallet (`wallet-zig`, #29) builds `mst.zig` as a module
of its own for its index maps (inside the VM). **Not yet:** pruning old
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

Since #5 the Zig kernel is its own reference: the TS runtime does not
meter, so its update records (and CIDs) are no longer the Zig kernel's.
`equiv/run.sh` runs all of it (it builds first):

| check | what | result (2026-09-27, #5) |
|---|---|---|
| `zig build test` | dag-cbor encodings and CIDs, canonical re-encoding, strict decoding, program-record CIDs, "anyone" signatures, JCS, the entropy stream — against fixtures the TS runtime made (`test/fixtures.ts`); traps in V8's words; the Merkle search tree; the index; **fuel** (`fuel_test.zig`): the same module burns the same fuel, in proportion to the work; a spinning module traps out of fuel at the limit every time, with `used` = the limit; nested instances share one budget (a step's fuel is their sum; a child or the parent runs out); a segment starts a full budget | 23/23 |
| `equiv/shell.ts` | host-go's 64 shell cases plus 7 for the script runtimes (#25) through `runShell` on Node and `skein-kernel shell`: stdout, stderr, exit code, tree CID (none of which carries fuel) | 64/64 identical |
| `equiv/git.ts` | git (`wasm/git.wasm`) in the shell on this kernel, 15 verbs over one tree; a second run gives identical trees and output | all ok |
| `equiv/replays.ts` over `equiv/corpus.ts` | 8 logs the TS runtime writes (run/objects/head/subscribe handlers, the shell with writes, cwd, failures, sleeps and wakes, the loop with bash and message tools, replies, resolutions, a failed delivery, a refused infer, two agents, and `gen-fuel`: `fuelPerStep` 10^8, where run-handler's reply step runs out after its wallet call), each replayed by the Zig kernel into z1, and z1's log replayed into z2 | 8/8 identical |
| pre-fuel refusal | a TS-written store with a log opened for running (`skein-kernel shell`) | refused, with the message |
| `equiv/wallet.ts` | `serve` with `equiv/wallet-peer.ts`: a ProtoWallet oracle, a fake ARC on the `http` import, the wallet program (#29) subscribed to an owner's box and a sender-less `chain` box — headers from regtest's genesis (an owner's message, then plain `header` entries), a BRC-29 payment internalized, a spend signed through the oracle and broadcast (the posted BEEF's scripts verify under @bsv/sdk), the thread's deadline woken by the tick and ARC re-asked, a plain `status` entry (MINED + path) for the transaction's CID proving it, a rejected broadcast dropping its action, a draft signed by `signAction`; then the store replayed Zig against Zig | all ok; the store reproduced exactly |
| `equiv/serve.ts` | `serve` spawned as the supervisor spawns `bin/skein-runtime`, with the real providers on an in-process messagebox: genesis, a run, a chat through the inference peer, a sleep woken by the tick, SIGTERM mid-sleep and the restart that finishes it, stop on channel close; a second instance with `SKEIN_FUEL_PER_STEP=10^9` where `while :; do :; done` runs out (run-handler replies `fuel exhausted`; `skein-kernel fuel` shows the shell's step at exactly the limit); then both stores replayed Zig against Zig | all ok; both stores reproduced exactly by their replays |

A replay comparison (`equiv/replays.ts`) requires z1 and z2 to be the
same in: the replay reports (the runtime's log lines, the emits handed to
the outbox, the log tip, the final state record — which covers every index
node); everything `skein-kernel dump` derives (entries, chains and tips,
every update with its fuel, threads, resting threads in resume order,
sleepers, awaits, edges, heads, the cursor, fuel per thread and in total,
every record's CID); `skein-kernel fuel`'s output; and every explorer page
rendered over the two files (through `src/runtime/index-store.ts`). It also
requires every update that ends a step to carry fuel (only `running` ones
lack it), every `fuel exhausted` update to be `errored`/`cant-do` with fuel
= the genesis's limit (and at least one in a `*fuel*` store), no `DIVERGED`
or `cannot run` line, and — for a source the Zig kernel wrote itself (a
format-1 store, from `serve.ts`) — the source's dump to equal z1's: the
running kernel and the replay agree exactly. A corpus store from the TS
runtime is only a log here (its updates carry no fuel). Sources are copied
(with their `-wal`) before anything opens them.

Dropped with #5: the comparisons with the TS runtime's replay
(`equiv/replay.ts`, row-by-row tables, TS-built state CIDs, "vs the source"
tips) and the replays of copies of the stores under `~/.skein` (they
predate fuel; the live instances re-genesis when they move to this build).

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
| `engine.zig` | wasmtime behind compile/run/one host callback; traps as V8 names them; the fuel meter (#5) |
| `wasi.zig`, `vfs.zig`, `tree.zig` | `wasi/host.ts`, `wasi/vfs.ts`, `tree.ts` |
| `objects.zig` | none: the synthetic `.git/objects` (issue #2, docs/VM.md), loose-object framing over git-raw records |
| `runner.zig`, `shell.zig`, `program.zig` | module cache and `runModule`; `shell.ts`; `program.ts` + `wasi/skein-imports.ts` |
| `scheduler.zig` | `scheduler.ts` |
| `serve.zig`, `ipc.zig`, `peer/peer.ts` | `src/host/main.ts` as a process with its providers as a peer |
| `replay.zig`, `cmd_shell.zig` | `skein-dev replay`; the shell test driver |
| `fuel.zig`, `fuel_test.zig` | `skein-kernel fuel` (billing as a query over the log); the fuel unit tests (issue #5) |

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
  so a deep enough recursion overflows at a different depth. Fuel is on
  here and not in the TS runtime (issue #5): the two no longer write the
  same update records.
- **The drain's own crash lines** (`runtime: <stack>`) are not stack traces.
- **The store file** (#30): blocks and the state pointer, not the TS tables.
  The TS runtime ran on it only through a rebuild (the `equiv/replay.ts`
  removed with #5 showed how); the explorer and `skein-dev` read it
  (`src/runtime/index-store.ts`, which ignores the state record's `format`).
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
