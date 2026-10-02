# kernel-zig

The skein kernel in Zig: the block store, the input log, the index (IPLD
maps in the store and one state record), the scheduler, the kernel's four
tables (objects, heads with their owner, the dispatch table, the address
book), the filesystem over the store, the WASI preview1 imports and the
`skein` imports, and the same as a WASI 0.2 world for components. It runs
wasm programs through wasmtime's C API, and builds for
`wasm32-freestanding` for the browser host. It is the one kernel
implementation: the same log gives the same entries, records, CIDs, derived
state and fuel on every replay, and the equivalence suite checks that Zig
against Zig.

The kernel at log format 8: one dispatch table routes (rows for boxes, HTTP
paths, libp2p topics and protocols); the admin operations (`objects`,
`head`, `dispatch`, `peers`) are the kernel's own, on messages from the
owner or a delegate; a program advances only heads in its write scope (an
app's `<app>/…`; a genesis-wired program's genesis `scopes`); every package
a transport carries in is an entry and the front door is stepped on it; a
step's one way out is `emit` (a signed message to a key the address book
names, or a broadcast event), and the answer is an entry; a deadline or a
shell's sleep is a wake-me message to the waker provider. The host
(`src/host/`, TypeScript) drives it over one channel per kernel; the host
is transports + providers + store + oracle and routes nothing. History: the
format sections below say what each format changed.

## Build

Zig 0.16.0 is pinned by the repo's `mise.toml` (`mise install`, then prefix
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
zig build test               # unit tests, incl. test/fixtures.json made by src/runtime's formats
```

wasmtime's compilation cache (`~/.cache/wasmtime`) is on: a cache of machine
code for module bytes, not state. `SKEIN_WASMTIME_CACHE=0` turns it off.

## Run

```
skein-kernel serve                         # the kernel process the host spawns
skein-kernel replay <source.db> <out.db>   # the log alone into a fresh store, no wallet
skein-kernel shell <store.db> < cases.json # shell cases as equiv/shell.ts passes them
skein-kernel dump <store.db>               # the derived state read through the index, as JSON (either format, read only)
skein-kernel fuel <store.db> [--since n]   # fuel per thread and in total, from the steps whose input is entry n or later
```

`serve` is started by the host (`src/host/kernel.ts`) with `SKEIN_DB`,
`SKEIN_HANDLE` and `SKEIN_HOME`, installs the pinned modules from `wasm/`
into a store that lacks them, speaks frames on stdin/stdout and writes its
log lines — among them `skein runtime <identity> (<handle>@<domain>) · pid …
· db …` once running — on stderr; it stops at EOF on stdin or on
SIGINT/SIGTERM. Since #30 the store file holds blocks and the state
pointer only: the explorer and
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
  heads and dispatch chains. A step that failed before running wasm
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
- **Fuel accounting is a query over the log**: `skein-kernel fuel <db> [--since n]`
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
  kernel before #5), or in the older tables (sqlite.ts's, host-signed entries), is refused for running
  (`serve`, `shell`: "a store written before fuel metering (issue #5) …
  refused (start a new store: re-genesis)"). Read-only uses still open it:
  `dump`, `fuel`, and `replay` as a source (a log is a log — the replay
  recomputes every update, with fuel, into a fresh store).
- Not metered: host time outside the VM (the peers, the oracle), memory
  (a module's own max), per-tree depth and step counts (countable from the
  chain; enforced from config later).

## The in-step clock runs on fuel (issue #38)

`clock_time_get` inside a step (realtime and monotonic alike) returns
`max(last + 1, stamp + fuel × 1 ns)` (`syscalls.ThreadClock`): `stamp` is the
time of the entry driving the step, `fuel` the step's `engine.Meter.used()`
so far — one meter for a handler step, one for a shell and every child it
spawns, so they read one clock — and `last` the previous read (the +1 ns
tie-break: no two reads equal). **1 fuel unit = 1 ns** (`NS_PER_FUEL`), fixed.
Deterministic because fuel is; nothing is recorded. A busy-wait on the clock
ends on its own: `equiv/serve.ts`'s clock scenario waits 50 ms on qjs
`Date.now()` and on python `time.monotonic()` and the shell's step burns
~3.6·10^8 fuel, under a 10^9 limit. A shell sleep's deadline is this clock
plus the sleep; the waker's answer drives the next segment's stamp and the
meter's new segment counts from zero. Outside a thread (`skein-kernel
shell`, no meter) the clock is `shell.Fixed`, as before.

Changed by it: an update's `until` (a sleep's deadline) moves by the fuel
burnt before the sleep; the Go programs of the time (run-handler, loop; Zig
since #54) burnt ~1.2k more fuel per step (their runtime read the clock);
any printed mid-step time.

## For the wallet (issue #29)

What this kernel adds for the wallet in the VM (`programs/wallet` over the SDK's wallet and chain libraries, docs/WALLET.md) and the chain app (shruggr/skein-chain), which since #79 holds the chain state the wallet reads.

- **Bitcoin codecs** (`cid.zig`, `bitcoin.zig`, #42): `putblock` accepts
  `bitcoin-tx` (0xb1) and `bitcoin-block` (0xb0, 80 bytes) with
  `dbl-sha2-256` (0x56), raw bytes, hash-checked, so a transaction's CID is
  its txid, a header's its block hash and a merkle node's its merkle hash
  (the digest in internal byte order); `get` returns the bytes as stored.
  The kernel **decodes them the IPLD way** (after IPLD's bitcoin codecs,
  bitcoind's field names): a header → `{version, previousblockhash → link,
  merkleroot → link, time, bits, nonce}`; a transaction → `{version, vin:
  [{txid → link, vout, script, sequence} | {coinbase, sequence}], vout:
  [{value, script}], locktime}`; **exactly 64 bytes under `bitcoin-tx` is a
  merkle node** `[left → link, right → link]` (IPLD's convention; a 64-byte
  transaction is malformed by convention, so the length decides). The
  header's merkle root names the root node, each node its two children
  (nodes, or at the bottom transactions), so a block's transaction tree is a
  DAG in the store — sparse, holding only the paths a wallet needs
  (docs/WALLET.md "Proofs"). (The unregistered 0xb3 `bitcoin-merkle` of
  #29 is gone.)
- **Edges from kept bitcoin transactions** (`index.zig`, `bitcoin.zig`
  `edgesOf`, #42): a transaction a step keeps adds its inputs to the `edges`
  map, from the block itself at seq 0 — each input `spends` (locator = its
  vout, an integer). Kept headers and merkle nodes add **no edges** (decided
  2026-09-30: nothing asks the reverse questions; a proof reads down from
  the root); their forward links (`bitcoin.zig` `links`) stay what the
  explorer and packets follow. Keep is the trigger, not `putblock`: the map
  stays a function of the chains, and a block kept again (by any thread)
  adds nothing.
- **`edges(to, to_len, rel, rel_len, out, cap)`** (WIT `edges: func(to:
  cid, rel: option<string>) -> result<list<u8>, string>`): the edges into
  `to`, `rel` only if given, as dag-cbor `[{from, seq, rel, locator}]` in key
  order (from, seq, ord) — who spent txid:vout is the `spends` edges into
  the transaction's CID with that locator. A read: the index (a function of
  the log) plus the inputs of the bitcoin transactions the step kept so far
  (the edges its update will add); a kernel `call` reads the index only. The
  wallet's `spenders` map folded into it.
- **Plain entries** (`log.zig`, `scheduler.zig` `processEvent`):
  `{kind: "log", n, prev, time, box, event}`, the `event` kind of the
  entry encoding (genesis | mail | event+box | request+transport; none
  signed). The host admits one per event from its wiring (a header from a
  feed, a proof from the broadcaster; `admitEvent` in src/host/router.ts), with the record
  `event` names already put. Statuses are not events: they are signed
  messages from the status provider.
  Processing: the thread whose tip awaits the record's `subject` (a CID; a
  transaction's is its txid) steps with `input.event = {event, box,
  subject}`; else the first `mailbox` dispatch row from anyone on the
  entry's box launches its program with `args = {event, box}`.
- **`await` on a record**: besides a message the step emitted, a step may
  await any record in the store — the subject of a plain entry to come.
- **`emit(msg, len, out, cap)`** (#70, #67): a dag-cbor `{to: bytes(33),
  box, body: bytes, subject?: <cid>}` → the CID of the signed message record
  `{kind: "mail", op: "put", sender, recipient, box, body: <cid>, subject?,
  nonce: bytes(16), signature}` (`scheduler.zig` hEmit/emitMessage). `to`
  must be in the address book (`addressbook.zig`, the head `peers`); the
  signature is BRC-169's (`[2, "metanet handles envelope"]`, key `send`,
  counterparty anyone, over the record without `signature`), made through
  the oracle as a recorded call (`oracle.zig`); `nonce` is sha256(thread ‖
  step ‖ index)[0..16]. The update lists it in `emitted`; it goes out only
  if the step did not error: a `mailbox` recipient's by a delivery thread
  the kernel launches (the messagebox program, args `{message, transport:
  "mailbox"}`), a `local` or `libp2p` recipient's handed to the host after
  commit (the serve notice `emit {message, body, transport, address}`). At
  start the kernel offers again what a waiting thread still awaits. A
  delivery thread that errors steps the awaiting thread with `undelivered:
  {message, error}`. Refused in a kernel `call`. docs/VM.md ("emit") and
  docs/MESSAGES.md ("Outbound") have the contract.
- **`deadline(until_ms)`**: the update carries `until`; when the step ends
  waiting the kernel emits `{at}` in box `wake` to the address book's waker
  (role `waker`) and awaits it; the waker's answer steps the thread with
  `input.woke`. A shell's sleep is the same wake-me message.

There is no `http` or `libp2p` import (format 6 removed them, and the
host's attestations with them): HTTP and libp2p are providers a step emits
to (`src/host/providers.ts`).

## For the bootstrap loader (issue #4)

The loader itself is host code (`src/host/boot.ts`, `packet.ts`;
docs/BOOTSTRAP.md). The kernel adds only this:

- **genesis `tree?`** (`log.zig`): a git-raw CID, the system tree the loader
  pre-filled. Processing the genesis (`scheduler.zig`) sets the head `main` to
  it. The head update has no `thread` (`heads.By.thread` is optional), and the
  genesis is refused if the tree is not in the store.
- **`serve` frames**:
  - `has` answers whether any block is present, whatever its codec.
  - `putblock {cid, bytes}` stores a block minted elsewhere, hash-checked like
    the `putblock` import.
  - `restore <state>` (`SqliteStore.restore`) is for a checkpoint whose blocks
    are already put. The state pointer moves onto that record and the index is
    read from it. It works only on a store with no log, and only for this
    kernel's format.
- **replay** (`replay.zig` copyLog): copies the genesis tree's objects, so a
  booted store replays to itself.

## Components (issue #34)

The kernel runs **WASI 0.2 components** as well as preview1 core modules,
wherever it runs a module: a handler program's step, or a program the shell
spawns. `runner.zig` tells them apart by the binary's preamble.

A component targets `skein:kernel/handler` in the SDK's `wit/skein.wit`
(shruggr/skein-sdk, a Zig package dependency by URL+hash, #75; see its
`wit/README.md`):

- WASI 0.2.12: `cli`, `clocks`, `filesystem`, `io` and `random`;
- the interface `skein:kernel/skein`: the preview1 `skein` calls, including
  `emit` and `deadline` (there is no `wasi:http`: #70, below);
- the export `wasi:cli/run`.

Imports the kernel does not answer, such as sockets, link as traps.

### Toolchain (pinned)

| what | version | where |
|---|---|---|
| wasmtime C API | v49.0.1 (its component API: `wasmtime/component/*.h`) | `~/.local/wasmtime-c-api/…` (unchanged) |
| WASI | 0.2.12 (the WIT is vendored in the SDK's `wit/deps`, from wasmtime v49.0.1's `crates/wasi/src/p2/wit/deps`) | |
| preview1 adapter | wasmtime v49.0.1's `wasi_snapshot_preview1.command.wasm` (sha256 `86c88319…9f76`) | `~/.local/wasi-adapter-v49.0.1/` (`$SKEIN_WASI_ADAPTER`) |
| wasm-tools | 1.259.0 | `~/.local/wasm-tools-1.259.0-aarch64-linux/`, linked from `~/.local/bin` |
| wit-bindgen | 0.62.0 (`wit-bindgen c`) | `~/.local/wit-bindgen-0.62.0-aarch64-linux/`, linked from `~/.local/bin` |
| wasi-sdk | 34 (for the unit test's C program) | `~/.local/wasi-sdk-34.0` |

To install them: `gh release download` the tools from
bytecodealliance/wasm-tools and bytecodealliance/wit-bindgen, and the adapter
from wasmtime's v49.0.1 release. The kernel build needs none of these. The
component fixtures the unit tests use are committed.

### The host side

`component.zig` is written by hand against `wasmtime_component_*`.
wit-bindgen has no C host bindings, so the host uses dynamic values: wasmtime
lifts and lowers through the canonical ABI, and the host reads
`wasmtime_component_val_t`. Every descriptor, stream, pollable and error is a
host resource.

To give **one behaviour**, the 0.2 filesystem, io and cli calls are answered
by the preview1 implementation itself (`wasi.Process.dispatch`), run against
a scratch memory:

- a `descriptor` is a process fd;
- a file stream has its own description at its offset;
- reads, writes, stats, readdir, opens, renames and links are the preview1
  calls.

So the tree, the errors and the inode numbers are the preview1 ones. The
other imports:

- **Clocks**: the run's clock, which is the entry's stamp.
- **Random**: the run's entry-derived stream. `insecure` and
  `insecure-seed` draw on it too.
- **cli**: the process's args and env. There is no terminal, and
  `initial-cwd` is none.
- **poll**: follows `poll_oneoff`'s rule. Clocks alone are a sleep, and every
  subscription fires.
- **skein**: calls `program.Host` exactly as the preview1 imports do. Its
  errors are the `result`'s string.

### Components and emit (issues #70, #67)

A component has no network import: there is no `wasi:http` and no
`skein:kernel/libp2p` (format 6 removed them, as it removed the preview1
`http` and `libp2p` imports). It reaches the world as a preview1 program
does: `skein:kernel/skein.emit(message) -> result<cid, string>` (the
component host's `sk_emit`, over `program.Host.emit`, the scheduler's
`hEmit`) — a signed message to a provider or a peer — and awaits the
answer, which steps it again. `test/components/fetch.wasm`
(`../programs/test/fetch`) is the fixture: it emits `{method: "GET", url}` in box
`fetch` to the address book's `fetch` provider, ends awaiting, and writes
the answer's body on its next step (`equiv/fetch.ts`).
`test/components/p2p.wasm` (`../programs/test/p2p-component`) publishes the
same way, by an emit to the `libp2p` provider.

Fuel is per store, so a component draws on the step's `engine.Meter` like a
module. If fuel is 0 when the call fails, the step ran out of fuel. Other
traps are read from wasmtime's message and reported in V8's wording, as for
modules.

`SKEIN_COMPONENT_TRACE=1` prints every component call and the preview1 call
behind it.

Three variables exist for the equivalence suite only; live instances do not
use them:

- `SKEIN_EXTRA_MODULES=<file>:…` makes `serve` and `replay` install modules
  that are not pinned, under their raw CIDs.
- `SKEIN_REPLAY_MODULE=<cid>=<file>` makes `replay` run `<file>` wherever the
  log runs module `<cid>`.
- `SKEIN_SHELL_COMPONENTS=<dir>` makes `shell` run the tools found there as
  `<name>.wasm`.

### Building a component handler

The wallet (`../programs/wallet`) is the example: `zig build component` gives
`zig-out/bin/wallet.component.wasm`.

1. **Generate the C bindings.**
   `wit-bindgen c wit --world program --out-dir wit/bindings/c` gives
   `program.h`, `program.c` and `program_component_type.o`. The last one
   carries the world.
2. **Compile the program.** Build it for `wasm32-wasi` with `program.c` and
   the `.o`. In Zig, `@cImport(@cInclude("program.h"))`
   (the SDK's `skein_wit` module, `wit/zig/skein_wit.zig`).
3. **Keep wasi-libc out** if the program must draw the same random bytes as
   its preview1 build. Linking wasi-libc switches Zig's random (`std.Io`'s
   `randomSecure`) to `arc4random`. The SDK's `cabi` module (`wit/zig/cabi.zig`) provides the few libc
   functions `program.c` needs.
4. **Make the component.**
   `wasm-tools component new core.wasm --adapt wasi_snapshot_preview1=<adapter> -o out.wasm`.
   The adapter turns the program's preview1 WASI into 0.2.

A program that uses 0.2 directly needs no adapter: for example, C built with
wasi-sdk's `wasm32-wasip2`, as in the unit test.

The wallet's two builds share one source (`program.zig`, where `sk` is the
preview1 imports or `skein_wit.zig`). Both broadcast the same way: a
broadcast event (`emit`, #65), the same record from either build. The preview1 build stays byte-identical to the pinned
`wasm/wallet.wasm`, and the pin stays on preview1. `../programs/test/fetch` is a
second, minimal example (an emit to the `fetch` provider, its URL from argv
or the step's input).

### What is not the same

- **Fuel.** The adapter and the canonical-ABI glue execute instructions, so a
  component's fuel is not the module's. Each ABI replays itself exactly.
  Across the two ABIs, every update matches except `fuel` and `prev`
  (`equiv/abi.ts`).
- **Exit statuses.** `wasi:cli/exit` is ok/err. The v49 preview1 adapter and
  wasi-libc's 0.2 `exit` both report any non-zero status as 1. The kernel
  implements the unstable `exit-with-code`, but neither of them calls it.
- **Writes through the adapter** arrive in 4096-byte chunks. A pipe that
  reaches its limit (stdout's 1 MiB for a handler) keeps the chunks that fit.
  Under preview1, the whole write is refused.
- **Stdin of a handler step.** Through the adapter it has type `unknown`;
  preview1 calls it a character device.
- **Costs.** Values cross as dynamic values, so a `list<u8>` is one value per
  byte on the host side. A component is linked per compile, with its own
  linker.

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
| `unique` | message (its mail record's CID), or a libp2p `p2p` event record's CID (#42/#51: a redelivery is refused) → entry | `byEnvelope` (the name kept), duplicate admission |
| `chains` | origin → {tip, seq, kind} | `chainTip`, `chainAppend` |
| `updates` | origin ‖ seq → update | `chainUpdates` (a prefix) |
| `threads` | at ‖ origin | every thread (the witness) |
| `resting` | at ‖ origin | threads not finished, in resume order |
| `sleepers` | until ‖ origin | waiting threads by deadline |
| `awaits` | record ‖ at ‖ origin | the threads awaiting a reply to a message they sent, or a subject (a prefix) |
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

**Older stores.** A file in the format before #30 (this kernel's before #30,
or the deleted TS runtime's) has no state record: it is imported from its tables —
the log from `entries`, each chain from its origin and `updates`, the cursor
from `meta` — through the same derivation, so the import and the
incremental path reach the same state CID (the suite checks it on every
replay). Opened for writing, the state record is written and the old tables
are renamed `legacy_*`; opened read only (a replay's source, `dump`), the
import stays in memory. A store whose old index is stale is refused (nothing
rebuilds it any more: `skein-dev rebuild` went with the TS runtime, #55).

**From TypeScript** (`src/runtime/index-store.ts`): a read-only `Store` over
the maps (the pointer re-read on every call, so it follows a live kernel),
used by the explorer and `skein-dev` (`rebuild` is refused on such a store:
the kernel keeps its index); and `buildIndex`, the same maps built
canonically in TypeScript — equiv checks it reaches the kernel's state CID,
and that every explorer page renders the same over the TS and the Zig
replays' files. The wallet (the SDK's `wallet`, #29) uses `mst.zig` as the SDK module `mst`
of its own for its index maps (inside the VM). **Not yet:** pruning old
spine nodes and state records; a cache bound (decoded nodes are dropped at
every commit).

### How serve is put together (issue #33)

```
skein-host run (the host, src/host/router.ts) ──spawn on demand──▶ skein-kernel serve   (one per instance)
   transports · providers · oracle · feeds · fuel ledger     store · log · scheduler · programs (wasmtime)
                  ▲                     │
                  └──────── frames ─────┘  length-prefixed dag-cbor on the kernel's stdin/stdout; its log lines on stderr
```

The host speaks to the kernel through `src/host/kernel.ts`: it asks `tip`,
`get`, `put`, `has`, `putblock`, `restore`, `append`, `genesis`, `programs`
(the pinned program records, for a new genesis), `head`, `boxes`,
`dispatch` (#77: `{tip, rows}`, the dispatch table as it stands — the
host's libp2p node follows it), `byEnvelope`, `admit` (`{entry, body?}`: the one call in that writes — a
request as received, #68, a feed's or a proof's event), `answer` (#66, below),
`call` (#40: host-side reads, below), `idle`, `start`, `running`; the kernel
asks `wallet` (a BRC-100 wire frame: the host answers from the instance's
ProtoWallet, the oracle), and tells `emit` (#70: `{message, body,
transport, address}`, a committed message for a `local` or `libp2p`
recipient, which the host's providers carry out — a step's deadline's
and a shell's sleep's wake-me among them, #69 — or, transport `event`, a
broadcast for the host's broadcaster, #65) and `stop`. There is no `send` and no
`resolve` (#40): an instance delivers its mailbox messages itself, by its
delivery threads. The host starts the process when a message or a
read needs the instance and closes its stdin when it has been idle; the
kernel stops at EOF. A wallet call cut off because the host went away
aborts the step unrecorded (it runs again at the next hydration), unlike a
deterministic error, which is recorded.

**`serve` is re-entrant.** While a step waits for the host's answer to a
`wallet` request, `serve` keeps reading frames: `call`, `admit` and `answer`
are handled mid-step (an admit is processed when the running drain loops
again), and answers to other requests are kept until asked for. A request
appended mid-step is processed after that step. Since #67 a step never waits
on the network: sending is an `emit`, and the answer an entry.

### Requests and `answer` (issues #68, #66)

A request entry (`{request: <record>, transport}`, `log.zig`) launches the
transport's middleware as the request's thread (`scheduler.zig`
`processRequest`, `middlewareOf`: the genesis's `middleware[transport]`,
else its front door for `http`, `libp2p` and `local`), origin `{kind: "thread",
program, args: {request, transport}, launchedBy: <record>, input: <entry>,
at}` — so `requestThread(entry)` finds it again. Its steps run on
`callFuelLimit`, read `dispatch` (the rows, #77), `reads` (and, first, `seen`), and what their
stdout lists in `admit` is routed after the step (`routeAdmits`; a message
or `p2p` event once: `markUnique`, the `unique` map). A step may `await` a
thread's origin; `rested()` steps its awaiters with `resolved`.

`answer {entry, wait: ms}` → `{thread, state: "finished", answer: bytes}` |
`{thread, state: "errored", error}` when the request's thread comes to rest
for good — at once if it has; else the frame is parked, and the scheduler's
`on_answer` (called the moment the thread's last update is written, before
what its step routed runs) replies — or, `wait` ms on, `{thread?, state}` as
it stands (`waiting`, or `pending`: not processed yet). `serve`'s poll sleeps
until the earliest parked bound. The host holds a synchronous client on it
(`src/host/frontdoor.ts`).

### Calls (issue #40)

`call {program: <CID or a genesis program's name>, fn, arg: bytes, caller?,
now?}` → `{ok, result | error, fuel}` runs a program as a function over the
current state (`scheduler.zig` `call`): its normal entry, with `input()` =
`{kind: "call", fn, arg, caller?, now, self: {handle, domain, identity},
owner, programs, peers, defaults, names, reads, dispatch,
pending, state}`; the result is its stdout, a non-zero exit the error (the
last stderr line). Since #68 no request is a call: calls are host-side
reads (the front door's fn `read`, the answer of a route that reads live
state, after its request's thread; the broadcaster's questions later, #65).
No entry and no writes: `put`/`putblock` go to the call's write cache,
dropped with it, `keep`/`launch`/`await`/`advance`/
`emit`/`deadline` are refused (a call sends nothing), `wallet`
is answered by the host and not recorded, random is real. Fuel is limited by
`defaults.callFuelLimit` (default 10^10) and reported. The `call` import
(preview1 `call(prog, prog_len, fn, fn_len, arg, arg_len, out, cap)`, WIT
`call: func(program, fn, arg)`) is the same from inside a program: from a
call it reads only; from a step the callee is part of the step (its host and
meter: its recorded calls, records and head moves are the step's, and replay
re-runs it), and a step reads its own pending head moves. Depth at most 8,
output at most 64 MiB. `test/call/probe.wasm`
(`test/call/probe.zig`) is the probe `src/host/call.test.ts` drives. The
docs: `docs/VM.md`, "Calls".

### Format 8 (issue #77)

The state record's `format` is 8 (`index.FORMAT`); a store in an older
format is refused for running ("before format 8": start a new store:
re-genesis); read-only uses still open it. Format 8: the kernel is the
machine, four tables and the oracle.

- **The dispatch table** (`dispatch.zig`): one chain, origin `{kind:
  "dispatch"}`, updates `{op: "add" | "remove", row, thread?, input, at}`,
  rows `{transport: mailbox | http | libp2p | local, address, prefix?,
  sender: "*" | "event" | "session" | bytes(33), program: <cid> | "kernel", fn?, …}`
  folded in order by key (transport, address, prefix, sender). It replaces
  the subscriptions chain, the genesis's `routes` and the head `routes`:
  `processMail` routes by `forMail` (a kernel row → `kernelOp`, else the
  row's program launched), `processEvent` by `forEvent` (a row from `event`
  or `*`; `forMail` never takes an `event` row, #79); a request thread's
  input and a call's context carry the rows as `dispatch`. The genesis
  carries `dispatch` (its seed) and `scopes`; one naming `subscriptions` or
  `routes` is refused (`log.isGenesis`).
- **The admin operations** (`scheduler.zig` `kernelOp`): a message at a row
  whose program is `kernel` is one of `objects` (`{records, root?}`),
  `head` (`{name, tree}`), `dispatch` (`{op, row}`), `peers` (`{op, key,
  …}`) — validated whole, then written under the entry (chain updates with
  `thread: null`); a refusal is a log line and nothing written. No program
  runs: `objects-handler`, `head-handler`, `subscribe-handler` and the
  front door's `routes` box are gone, as is the `subscribe` import
  (preview1 and WIT; skein-sdk 0.3.0). An admin message whose sender is the
  instance itself (a delegate row from its own key) is answered (#79,
  `adminDone`): the thread awaiting the message steps with `admin: {message,
  op, done: true | error}`.
- **The loopback** (#79, `routeTo`): `emit` to the instance's own identity
  needs no address book entry; the message goes to the host as transport
  `local`, address `self`, and the host appends it back as a `local`
  request (src/host/providers.ts).
- **Write scope** (`hAdvance`, `inScope`): `advance(name)` only when the
  running program (the thread's, or the in-VM callee's: `StepState.progs`)
  may write it — its record's `app` makes `<app>/…` its scope; a program
  with no `app` has the genesis's `scopes[<its name>]` (exact names, or
  prefixes ending in `/`); nothing else (#79: the `heads` grants on
  program records are gone).
  A head update carries `owner` (`heads.ownerOf`: the name's text before
  the first `/`), and `dump` lists `[name, tree, owner]`.
- **The address book's `peers` operation** is `addressbook.write` (the
  resolve program's writePeer, moved into the kernel; since #79 the resolve
  program records a lookup through it — a message to itself, the default
  delegate row `{peers, $self, kernel}` — with `source` resolve or claim,
  and writes no head). Sessions are the head `frontdoor/sessions`.

### Earlier formats

Each format change refuses older stores for running ("before format N":
start a new store); read-only uses (`dump`, `fuel`, `replay` as a source)
still open them.

| format | issue | what changed |
|---|---|---|
| 7 | #65, #69 | `emitted` may list a broadcast event `{kind: "broadcast", tx, beef?}`; no `wake` entry (a deadline and a shell's sleep are wake-me messages to the waker); a genesis naming `jobs` refused; the kernel keeps no sleepers |
| 6 | #70, #67 | `emit` is the one way out; no `http` or `libp2p` imports and no attestations; the only recorded call is the oracle's (`{kind: "oracle", thread, step, i, request, result}`); the genesis seeds the address book (`addressBook`); mail records may carry `subject`, `nonce`, `signature`; updates list `emitted`; delivery threads |
| 5 | #68 | a `request` entry per package a transport carries in; sessions as records; the `unique` map holds what request threads routed |
| 4 | #62 | recorded `http`/`libp2p` calls attested by a host key (removed by format 6) |
| 3 | #40 | messages as mail records (`{kind: "mail", op: "put", …}`), their CID the message id; no envelope or outcome entries |
| 2 | #33 | unsigned entries; identity keys and signatures as byte strings |

## The browser build (issue #35)

The same kernel compiled to `wasm32-freestanding`, with its engine and its
store behind a small JS shim. Nothing else changes: log, scheduler, index/MST,
cbor/cid, vfs, syscalls, wasi and the programs compile as they are.

```
cd kernel-zig && mise exec -- zig build web      # → zig-out/web/skein-kernel.wasm (2.4 MB, stripped)
mise exec -- zig build -Dtarget=wasm32-freestanding   # the same (any wasm target builds only the web kernel)
node --experimental-strip-types web/kernel/serve.ts   # the proof page on :4401 (builds web/kernel/dist)
```

**The two seams.** `engine.zig` is now the interface; it picks
`engine_wasmtime.zig` natively and `engine_v8.zig` when the kernel is itself
wasm. `store.zig`'s key→bytes backend is `sqlite_store.zig` natively and
`web_store.zig` in the browser. `component_web.zig` stands in for the
component host: the browser runs **preview1 modules only** for now (a
component is refused at compile with a clear message). Two lines outside the
backends: `wasi.zig`'s memory accessors call `engine.touch` (a no-op
natively), and `runner.zig` picks the component backend by target.

**The shim** (`kernel-zig/web/`, dependency-free ES modules):

| file | what |
|---|---|
| `kernel.js` | the kernel's imports and exports as a class: `skein_engine` (V8 as the engine), `skein_store` (stores by id: `MemoryStore`), `skein_peer` (the host) |
| `store.js` | `IdbStore`: IndexedDB (`blocks`: CID → bytes, `pointers`: name → CID), loaded whole at open (the kernel reads synchronously), each committed batch written behind in its own readwrite transaction (IndexedDB runs them in order, so what is durable is a prefix of what was committed); `flushed()` before an admission is acknowledged |
| `worker.js` | the kernel in a module Worker: programs are compiled and run synchronously, and the kernel's requests (wallet) block on a SharedArrayBuffer (`Atomics.wait`) while the page answers — so the page must be cross-origin isolated (COOP/COEP) |
| `client.js` | the page's side: calls as promises, notifications, requests answered into the shared buffer |

**The ABI** (`src/web.zig`). Results are left in a result buffer
(`skein_result()`), the call returning its length; a failure returns
−(length + 1) with its message there. Values are dag-cbor.

| export | what (serve's op) |
|---|---|
| `skein_alloc(n)`, `skein_free(p, n)`, `skein_result()`, `skein_args()` | buffers; `skein_args` is 16 × i64 for a host call's arguments and result |
| `skein_open(store)` | open the shim's store `store` and a runtime over it (an older-format store is refused) |
| `skein_modules()` | `[{name, file, cid}]`: the pinned modules and files to install |
| `skein_put_block(cid, bytes)`, `skein_get_block(cid)` | a block, checked against its CID on put |
| `skein_admit({entry, body?})` | `admit`: the one call in that writes; admitted, not yet processed |
| `skein_start()`, `skein_drain()` | `start`; the step loop over everything admitted (`kick`) |
| `skein_state()` | `{state, log, cursor}` |
| `skein_call({op, v})` | the other serve ops: `tip get put append programs head genesis boxes byEnvelope state`, and `call` (#40; the browser requires `now`) |
| `skein_replay(src, dst)` | `skein-kernel replay` between two shim stores, the same JSON report |
| `skein_host_call(instance, index, nargs, memlen)` | a program's import (the shim's import functions call it) |

Imports: `skein_engine` (`compile`, `instantiate`, `run`, `release`,
`fuel_get`/`fuel_set`, `mem_read`/`mem_write`, `error_len`/`error_take`),
`skein_store` (`get`/`take`, `has`, `put`, `begin`/`commit`/`rollback`,
`pointer_get`/`pointer_set`), `skein_peer` (`request(op, v)` → the answer,
blocking, for `wallet`; `notify(op, v)` for `emit` (a wake-me among them),
`say`, `panic`; `take`).

**Programs on V8.** The kernel hands the shim a program's bytes; the shim
compiles and instantiates them with an import object whose every function
writes its arguments into `skein_args` and calls `skein_host_call` — the same
host callback, by import index, as wasmtime's. An abort (exit, a park, a fatal
host error) is a JS exception thrown through the program's frames; a trap
comes back by V8's message (the `Trap` table). A sleeping shell re-executes on
wake, as natively: same records. The program's memory is not the kernel's:
during a host call the callback's `mem` is a mirror in the kernel's memory,
whose 4 KiB pages are fetched on first touch and written back when the call
returns (nothing else runs in the program meanwhile, and nested instances each
have their own mirror).

**Fuel by instrumentation** (`src/wasm_fuel.zig`). V8 has no fuel, so the
kernel rewrites each module before handing it over to count its own fuel in
an exported i64 global, exactly as wasmtime v49's `consume_fuel` counts it
(read from `crates/cranelift/src/func_environ.rs` and wasmtime-environ's
`tunables.rs`): 1 per operator except `nop drop block loop unreachable return
else end`; 1 per function entry; the bulk operators 1 per unit
(memory.copy/fill/init per byte, memory.grow per page, table.* per element),
charged on success, or up front for a small constant count (≤ 128); costs
buffered and added to a local at loop/if/br/br_if/br_table/end/else and the
calls, returns and traps; the local saved to the global before every call,
return, unreachable and at the exit, reloaded after calls; checked (≥ 0 → out
of fuel) at function entries, loop headers and after a bulk operator with a
runtime or large count. A start function runs through a wrapper that costs
what wasmtime's start trampoline costs (2). The kernel's `Meter` then works
over that counter exactly as over wasmtime's fuel, so `fuel`, the in-step
clock (#38) and exhaustion are the same numbers. **Identical to wasmtime** on
everything checked: `wasm_fuel_test.zig` runs a probe module both ways under
wasmtime (the fuel read at every host call, at the end, and the exhaustion
point for every limit), `SKEIN_FUEL_MODE=instrument` runs the native kernel
with instrumented modules (the 18 corpus stores replay to identical reports),
and the corpus replays identically in Chrome. Not modelled, and absent from
every pinned program: a statically out-of-bounds load/store (wasmtime makes
what follows unreachable), and a bulk count that is a constant carried in a
local across a control-flow merge (wasmtime may see a constant there; the
total on success is the same, only a failed small grow or the exhaustion
point could differ). Exceptions, GC, typed function references and memory64
are refused.

**The host in the browser** (`web/kernel/host.ts`, #16): one instance whose
identity is the connected wallet's; the page is its host. `wallet` → the
page's BRC-100 wallet over the wire (Yours via @1sat/connect; a ProtoWallet in
tests); `emit` → the page's own providers (#70: `fetch`, `waker`, keys from
a page-local master), by which the instance's own programs deliver its
messages (the messagebox's delivery threads, a BRC-104 client through the
`fetch` provider) and resolve handles (the resolve program). The call in: the page's chat (a message from the user,
admitted directly as a mail record), a poll of this identity's mailbox
instance on the host (registered by the page; `listMessages` on a BRC-104
session, each message admitted and acknowledged once durable; what the
instance sends its owner lands there too and is shown), and a timer for
wakes. An intermittent host: nothing runs while the tab is closed; inbound
waits in the mailbox instance, wakes fire late at the next open.

**Proof** (`equiv/run.sh`; `SKEIN_EQUIV_BROWSER=0` skips the Chrome parts):
`equiv/browser.ts` replays every corpus store in headless Chrome (Playwright,
`/usr/bin/chromium`) into IndexedDB, reads it back in a fresh worker and
compares the report and `skein-kernel dump` of what IndexedDB kept with the
native replay — 18/18 identical (entries, updates with fuel, state CID; about
1–7 s a store in the worker). `equiv/browser-live.ts` runs the page against a
host on a scratch port with an agent on the native kernel and a scripted
inference peer (on its own mailbox instance): the page registers its
identity's mailbox instance; its instance asks inference through its delivery thread and the page's `fetch` provider, resolves
`@agent@localhost` (its resolve program), delivers a chat to the agent's front
door, the reply is polled from the page identity's mailbox and admitted, and the thread answers the page; the store the browser wrote then
replays natively to the same state with no DIVERGED.

**Not yet:** components in the browser (the shim would need jco-style glue);
the JSPI path (not needed: re-execution on wake); a store too big to hold in
memory (IdbStore loads everything).

## Equivalence

Since #5 the Zig kernel is its own reference (the TS runtime did not
meter; it is deleted, #55). `equiv/run.sh` runs all of it (it builds first):

| check | what | expected result |
|---|---|---|
| `zig build test` | format 3's records (mail, genesis routes/reads) and, kept from format 2, §7.3 envelopes verified over the dag-cbor preimage, genesis keys as bytes, unsigned entries, against vectors the host's TypeScript made: `test/format2.ts`); dag-cbor encodings and CIDs, canonical re-encoding, strict decoding, program-record CIDs, "anyone" signatures, JCS, the entropy stream — against fixtures src/runtime's formats make (`test/fixtures.ts`); traps in V8's words; the Merkle search tree; the index; **fuel** (`fuel_test.zig`): the same module burns the same fuel, in proportion to the work; a spinning module traps out of fuel at the limit every time, with `used` = the limit; nested instances share one budget (a step's fuel is their sum; a child or the parent runs out); a segment starts a full budget; **components** (`component_test.zig`, #34): one C program as a preview1 module, through the adapter and as a native `wasm32-wasip2` component gives the same stdout, stderr and tree, exit statuses as the ABIs carry them, and a component's fuel is repeatable, metered per step and runs out at the limit, and the in-step clock (#38) advances by the same fuel on every ABI | 35/35 tests pass |
| `equiv/shell.ts` | host-go's 64 shell cases plus 7 for the script runtimes (#25; `equiv/shell-cases.ts`) through `skein-kernel shell`, against the results recorded from the TypeScript shell before it was deleted (`equiv/shell-expected.json`, #55): stdout, stderr, exit code, tree CID (none of which carries fuel). Then (#34) the same cases with every plain preview1 tool (coreutils, find, diff/cmp, jq, grep, tree, awk, sed, qjs/node, python/python3) made a component with the preview1 adapter, against the modules | 71/71 identical; as components 66/71 identical, the other 5 differing only in a printed exit status above 1 (the adapter's ok/err) |
| `equiv/git.ts` | git (`wasm/git.wasm`) in the shell on this kernel, 15 verbs over one tree; a second run gives identical trees and output | all ok |
| `equiv/replays.ts` over `equiv/corpus.ts` | 18 logs: 10 agents (the kernel's objects/head/dispatch operations (#77), the run handler, the shell with writes, cwd, failures, sleeps and wakes, the loop with bash and message tools, replies, resolutions, a failed delivery, a refused infer, a stranger's run, two agents, and `gen-fuel`: `fuelPerStep` 4·10^6, where a step runs out) and the 8 owner's mailbox instances they delivered into (`<name>-david`), each replayed by the Zig kernel into z1, and z1's log replayed into z2. Since #40 the corpus is written by the Zig kernel as the host drives it (format 6 since #70/#67: every message out an `emit`, signed through the recorded oracle; on a script clock, the owner over raw BRC-33 on BRC-104 sessions, the inference peer on its own mailbox instance, the instances delivering by their own delivery threads through the host's `fetch` provider, whose signed answers are `local` requests in the log), so each source is also reproduced exactly by its replay | 18/18 identical, sources reproduced |
| `equiv/wallet.ts` (#29, #79) | on a test host with a fake Arcade behind its broadcaster and a fake SSE header feed, the chain app (shruggr/skein-chain) installed into two instances and the wallet program on the owner's `wallet` box: the feed's headers reach the chain app (the wallet takes none); a BRC-29 payment internalized (SPV against `chain/state`) and ingested; a spend signed through the oracle whose step emits one `ingest` message to the instance itself and no broadcast — the chain app broadcasts it (Extended Format, the host's token), Arcade's RECEIVED answers the wallet's thread `accepted`, MINED `proven`; the payee internalizes it and is answered the same; a rejected broadcast gives the balance back; a draft signed by `signAction`; settlement at the chain app (A rejected, B input-rejected, both threads answered, the coins read back); a reorg run re-broadcast by the chain app and the change listed unproven; the heads `wallet/state` and `chain/state`; both stores replayed | all ok; both reproduced exactly |
| `equiv/boot.ts` (#4) | `skein-host system` → a system tree (one handler as .wasm bytes, a SOUL.md, a config default); `add --boot <dir>` and `add --packet` of a mined ordfs-form packet of it (`--proofs`); a wrong `--scope` refused; both genesis name the tree, `main` is it, programs from bin/; each chatted with (the loop reads SOUL.md from main) and run over main; the wallet's component build (#34) as `bin/wallet.wasm` answering a `list`; `pack --checkpoint` restored on a second host (same master key): `dump` identical, still answering; both booted stores replayed Zig against Zig | all ok; both reproduced exactly |
| `equiv/wallet.ts` (#34 part) | after the preview1 scenario: `equiv/abi.ts` replays its log with the wallet's component build in the module's place (`SKEIN_REPLAY_MODULE`), and the scenario runs again through the host with the component as the wallet program | no DIVERGED; the same chains and log lines; every update identical but for `fuel` and `prev` (the CID of the update before); the component's replay reproduces itself; the component run reports exactly what the module's did, and its store replays to itself exactly. Since #65 both builds broadcast by emitting the same event, so this also shows the two ABIs emit byte-identical records |
| `equiv/fetch.ts` (#15, #70) | the `fetch` component as a box's handler through the host: it emits a GET to the `fetch` provider (the host's http handler standing in for the network) and writes the answer's body on its next step; then `replays.ts` with no host | the body on stdout; the update lists the emitted message; the provider's signed answer is a `local` request in the log; a 404 comes back to the program; the store replays exactly with no host to ask |
| `wasm_fuel_test.zig` (#35) | fuel by instrumentation against wasmtime's on a probe module (bulk operators, grows that fail, branches to the function's label, call_indirect, a trap, a start function): the same reading at every host call and at the end, and the same exhaustion for every limit; every pinned program instruments to a valid module | ok |
| instrumented fuel (#35) | the corpus replayed natively with `SKEIN_FUEL_MODE=instrument` (every module metered by its own counter) | 18/18 identical reports |
| `equiv/browser.ts` (#35) | the corpus replayed by the wasm kernel in headless Chrome into IndexedDB, read back, against the native replay: report and dump | 18/18 identical |
| `equiv/browser-live.ts` (#35) | an instance in Chrome chats an agent on a scratch host; the reply admitted; its store replayed natively | all ok |
| older-format refusal | a store in sqlite.ts's tables with a host-signed genesis (`equiv/old-store.ts`: format 1, no fuel) opened for running (`skein-kernel shell`) | refused, with the message |
| `equiv/overlay.ts` (#36, #40, #79) | overlay nodes booted from system trees carrying skein-overlay's and skein-chain's modules and their #77 rows: @bsv/sdk's `TopicBroadcaster` and `LookupResolver` at the host-name origin; a submission ingested at the chain app and admitted on its first `accepted`/`proven` answer; GossipSub the same state; lookups, dupes, refusals, listings; a spend rejected at the chain app unwound by the overlay's watch; proofs as IPLD nodes; the busy gate; no Arcade (admitted at the proof); the three-host gossip (#74); all replayed | all ok; reproduced exactly |
| `equiv/install-overlay.ts` (#72, #79) | skein-chain and skein-overlay 0.3.0 installed by `skein-host install` (the overlay refused without the chain app: `requires chain/1`); its derived rows (its box from `event` and `$self`, /submit, /lookup, the libp2p topics) and no grants; a gossiped token admitted once the chain app answers; two overlay apps on one instance (the same tree as `overlay2`), each writing only its own heads over one `chain/state`; reinstall, uninstall; replayed | all ok; reproduced exactly |
| `equiv/chain.ts` (#78) | the chain module, shruggr/skein-chain at a pinned commit (or `$SKEIN_CHAIN_DIR`), installed by `skein-host install` on a host with a fake Arcade (its broadcaster and `$status` provider) and called by its owner (#79: its rows take `event`, `$self` and `$owner`; a stranger is refused): the feed's headers; `ingest` proven → answered at once; `ingest` unproven → broadcast (the Arcade gets it) → `accepted` (the status provider's RECEIVED) → `proven` (Arcade's MINED proof, its header first), each an answer to the same request, a second watcher told too; refused by Arcade → `rejected`; `status`/`proof` reads by message and as a kernel call; then the same app at boot from a system tree (the default files, `bin/chain.wasm`, its rows, the default scope `chain/`); both stores replayed | all ok; both reproduced exactly |
| `equiv/serve.ts` | `serve` as the host drives it, the owner (raw BRC-33, and a signed `/account/register`) and the inference peer on BRC-104 sessions with the instances' front doors and their mailbox instances: genesis, a run, a chat through the inference peer, an idle stop mid-sleep and the waker's hydration that finishes it, a host restart mid-sleep, mail surviving it; (#38) 50 ms busy-waits on the in-step clock (qjs, python) ending on their own under a 10^9 fuel limit; a second instance with `SKEIN_FUEL_PER_STEP=10^9` where `while :; do :; done` runs out (run-handler replies `fuel exhausted`; `skein-kernel fuel` shows the shell's step at exactly the limit); then both stores replayed Zig against Zig | all ok; both stores reproduced exactly by their replays |

A replay comparison (`equiv/replays.ts`) requires z1 and z2 to be the
same in: the replay reports (the runtime's log lines, the log tip, the final state record — which covers every index
node); everything `skein-kernel dump` derives (entries, chains and tips,
every update with its fuel, threads, resting threads in resume order,
sleepers, awaits, edges, heads, the cursor, fuel per thread and in total,
every record's CID); `skein-kernel fuel`'s output; and every explorer page
rendered over the two files (through `src/runtime/index-store.ts`). It also
requires every update that ends a step to carry fuel (only `running` ones
lack it), every `fuel exhausted` update to be `errored`/`cant-do` with fuel
= the genesis's limit (and at least one in a `*fuel*` store), no `DIVERGED`
or `cannot run` line, and — for a source the Zig kernel wrote itself (every
store now: the corpus and `serve.ts`) — the source's dump to equal z1's: the
running kernel and the replay agree exactly. Sources are copied
(with their `-wal`) before anything opens them.

Dropped with #5: the comparisons with the TS runtime's replay (row-by-row
tables, TS-built state CIDs, "vs the source" tips) and the replays of copies
of the stores under `~/.skein` (they predate fuel; the live instances
re-genesis when they move to this build).

## Layout

| file | what (the TypeScript it was ported from; the machine's parts were deleted in #55) |
|---|---|
| `cbor.zig`, `cid.zig` | dag-cbor as @ipld/dag-cbor + cborg do it; CIDs (`cid.ts`) |
| `json.zig` | JSON.stringify quoting, Number::toString, RFC 8785 (`envelope.ts jcs`) |
| `secp.zig` | BRC-42 "anyone" keys, ECDSA verify as @bsv/sdk (`identity.ts`) |
| `envelope.zig` | BRC-169 envelope checks, BRC-78 framing (`runtime/envelope.ts`) |
| `store.zig`, `sqlite.zig`, `sqlite_store.zig` | the store interface; the SQLite file as blocks + the state pointer, and the import of the old format (`store.ts`, `sqlite.ts`; `index-store.ts` reads this format) |
| `index.zig`, `mst.zig`, `dump.zig` | the index as maps in the store and the state record (#30); the Merkle search tree; `skein-kernel dump` |
| `log.zig`, `heads.zig`, `dispatch.zig`, `programs.zig`, `syscalls.zig` | `log.ts`, `records.ts`, `heads.ts`, the dispatch table (#77; `src/runtime/dispatch.ts` reads it), `programs.ts`, `syscalls.ts` |
| `engine.zig`, `engine_wasmtime.zig` | the engine interface; wasmtime behind compile/run/one host callback; traps as V8 names them; the fuel meter (#5) |
| `engine_v8.zig`, `web_store.zig`, `component_web.zig`, `web.zig`, `wasm_fuel.zig`, `web/` | the browser build (#35): V8 through the shim, the shim's stores, preview1 only, the exported ABI, fuel by instrumentation, the JS shim |
| `wasi.zig`, `vfs.zig`, `tree.zig` | the WASI host and vfs (deleted); `tree.ts` |
| `objects.zig` | none: the synthetic `.git/objects` (issue #2, docs/VM.md), loose-object framing over git-raw records |
| `runner.zig`, `shell.zig`, `program.zig` | module cache and `runModule`; the shell; one program step and the `skein` imports (deleted) |
| `scheduler.zig` | the scheduler (deleted) |
| `serve.zig`, `ipc.zig` | the kernel as the host drives it (`src/host/kernel.ts`, issue #33) |
| `replay.zig`, `cmd_shell.zig` | `skein-kernel replay` (was `skein-dev replay`); the shell test driver |
| `fuel.zig`, `fuel_test.zig` | `skein-kernel fuel` (fuel accounting as a query over the log); the fuel unit tests (issue #5) |
| `component.zig`, `component_test.zig`, `test/components/` | WASI 0.2 components (issue #34): the standard worlds and `skein:kernel/skein` over the preview1 implementation; the unit tests' C program in three builds and the `fetch` component (`build.sh`) |
| `addressbook.zig` | the address book (#70, #77): the head `peers`, lookup by key and by role, the genesis's seed, the kernel's `peers` operation (`write`) |
| `oracle.zig` | the oracle's signature of an emitted message (#70): the BRC-100 `createSignature` frame, its answer |

## What is not the same, or not here

- **The synthetic object directory** (issue #2) is only here. In a tree,
  `.git/objects/xx/yyyy…` is a gitlink naming the git-raw record; to
  programs it is a read-only file of zlib bytes; a loose object that git
  writes is hash-checked and kept as the record; `.git/objects/pack` takes
  nothing new (docs/VM.md). The TypeScript runtime treated those paths as
  plain files and gitlinks as empty directories.

- **Sleeping shells** are not parked mid-instance (no JSPI): the run is
  abandoned at the sleep after writing `waiting`, and the wake re-executes the
  thread from its origin, verifying every update against its chain — the
  restart path — and carries on under the waker's answer (#69: the sleep is a
  wake-me message to the waker). Same records; a re-execution per wake.
- **Messages that only exist as JavaScript text**: trap messages are mapped
  to V8's wording for the common traps (unreachable, out-of-bounds memory,
  division, conversion, indirect calls; stack overflow as V8's RangeError);
  wasm compile errors, cborg decode errors ("CBOR decode error") and
  multiformats CID decode errors are approximated. They reach records only
  when a program prints what an import told it or a step fails that way.
- **Engine limits**: wasmtime's default wasm stack (512 KiB) and V8's differ,
  so a deep enough recursion overflows at a different depth.
- **The drain's own crash lines** (`runtime: <stack>`) are not stack traces.
- **The store file** (#30): blocks and the state pointer, not sqlite.ts's
  tables; the explorer, `skein-dev` and `skein-host` read it
  (`src/runtime/index-store.ts`, which ignores the state record's `format`).
- **Not ported**: the index rebuild of a stale older store (`edges.rebuild`;
  such a store is refused), `putMessage` and
  the `messages` table (the runtime does not write them), `handles`, the
  `waitersOn`/`waitingFrom`/`due` queries (the kernel does not ask them; the
  maps would be `launched ‖ origin` and `identity ‖ origin`, and `due` is a
  range of `sleepers`).
- **Components in the browser build**: the browser build runs preview1
  modules only ("The browser build" above). The
  seams are `engine.zig` and `component.zig` (the wasm engine) and `index.Backend` (a key→bytes
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
