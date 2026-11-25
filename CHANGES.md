# Changes

## 0.8.0

**Existing instances do not replay on this kernel, and their stores do not
open (index format 11). Fresh instances only.** Event ids change shape;
stored cursors from before are void.

- **Events are placed by the instance's step number.** Every thread update
  the scheduler appends — a step's, an errored step's, each shell update —
  carries `ord`, the instance's next step number (the state record's `steps`
  is the greatest so far). An event's place is `{s, i, thread}`: `s` the
  `ord` of the update that lists it, `i` its index in that update's
  `emitted`, `thread` the thread's origin, which orders nothing (it finds the
  update). Facts are ordered by `s`, then `i` — the order the steps ran in,
  whichever thread and whichever entry drove them. Before, they were ordered
  by the entry's `n` and the thread's own step count (`seq`): within one
  entry a fresh thread's later fact sorted before an older thread's earlier
  one, and `latest` returned the earlier. `latest`, `after`, `limit`, the
  result order and prefix reads all follow `s`; a step run at a restart
  takes the next number, so it sorts where it committed. The ids the host
  serves (`GET /events/…`, the SSE `id`, Last-Event-ID) are `<s>.<i>.<thread>`
  (was `<n>.<seq>.<i>.<thread>`; a four-part id is now a 400). The `events`
  import's `after` and every row's `place` are `{s, i, thread}`; a
  subscription's delivery and a woken thread's `event` carry the same place.
  Threads resting on a name wake in the order they began resting (the `s`
  that began it; `restsOn` entries are `{name, s}`), and `start` resumes
  resting threads in the order of their tips' `s`. The subscriptions,
  beacons and liveness folds (the kernel's and the host's) read the emits in
  `s` order. Index format 11.
- **A step sees its own events.** The `events` import includes the facts the
  step has emitted so far — its in-VM callees' too — at the places its update
  will give them (`s` is known before the step runs): the answer is exactly
  what the index gives once the step is committed. A kernel call still reads
  the committed index; an errored step leaves nothing. A step's duplicate-emit
  check is O(1).
- **A log line of any length.** The RocksDB host aborted on a log line of
  8 KiB or more (a step with ~1,000 emits): host.zig `sayRaw` narrowed its
  length to 13 bits. It now writes any line whole, and a step's log line is a
  bounded summary (each list's first 8 and its count; stderr's first 2 KiB).
- **Long fact names.** skein-sdk 0.21.1: a prefix scan of 256 bytes or more
  went out of bounds (`Forest.prefixed`), so a fact name that long aborted any
  host at delivery. The kernel pins skein-sdk v0.21.2 (was v0.12.0; 0.21.2
  builds from a clean clone: placeholder modules in the first configure pass).
- **An older store is refused by every backend.** RocksDB opened a set in an
  older format and rewrote it (its event keys read in the new layout); it is
  now refused for writing before anything is written, as SQLite's was. One
  message everywhere (SQLite, RocksDB, the wasm host): for format 10, "…
  before format 11 (skein 0.8.0: events placed by the instance's step number
  …): refused, no migration — start a fresh home". `skein-kernel dump` shows
  events as `[name, s, i, thread, record]`.
- **The broadcaster posts Extended Format or nothing** (host). The
  raw-transaction fallbacks are gone (src/host/arc.ts). A broadcast event with
  no BEEF, a BEEF of another transaction, one whose subject lacks an input's
  source, or one that proves its subject (it is mined: a chain-app defect,
  which broadcasts only an unlinked transaction) is a host error, named with
  the txid on the instance's log. Nothing is queued and the instance is told
  nothing.
- **Arcade's answers by one table** (host; `ARC_CODES`, David to review). An
  invalid transaction (ARC 461-466, 471-474, and 467 on the stream) is
  REJECTED. Our payload or request at fault (a 400 with no ARC code, 460,
  467 at intake, 468, 469, 475, 401, 403, 404, any other 4xx) is not a
  rejection: an error on the instance's log, the row off the queue, no
  status. 476 (not final) keeps the row, tried again. 408, 425, 429, a 5xx
  or no answer are tried again as before. A REJECTED on the stream or a
  webhook with one of our codes or 476 is logged and not routed.
- **The kernel builds from a clean clone** (kernel-zig/build.zig, skein-sdk
  0.21.2); scripts/wasmtime-c-api.sh fetches the wasmtime C API where
  build.zig looks (per host arch); the workflow installs librocksdb-dev and
  builds the wasm kernel.
- **The suite, to one rule: a backend is checked by the interface it
  implements.** One storage-interface test per interface
  (src/store_iface_test.zig: SQLite, RocksDB; src/host/store-iface.test.ts:
  the shim's MemoryStore, the wasm host's SqliteSetStore); every scenario runs
  once (SQLite serve; pool, hostchain and teranode on the one-process RocksDB
  host, where those features are); one comparison per pair of real double
  implementations (index-store.ts `derive` vs index.zig, every map, in
  event-order.ts; the wasm kernel vs native in wasm-host.ts; instrumented vs
  wasmtime fuel; the dag-cbor / dispatch fixtures). replays.ts no longer
  replays into RocksDB or migrates. New scenarios: events-own-step.ts,
  event-order.ts (with programs/test/order-probe), and format_test.zig for the
  refusal on SQLite and RocksDB. The equivs pin skein-chain v0.11.0 (with
  chain-proof-events.ts, chain-bundle.ts and programs/test/ingester).
  announce.ts asserts what the sync flow guarantees (below).

## 0.7.0

**Existing instances do not replay on this kernel. Fresh instances only.**
A log written by an earlier kernel diverges at its first signer call by a
program (the raw signer is now a granted kernel service) and wherever it
used the genesis wallet program (gone).

- **Call permissions.** A program may make a named in-VM call,
  `callAs(prog, fn, name, arg)`. The kernel checks that the calling app is
  approved to call the callee's app under that exact name (the grants head's
  `calls`, granted by root or written at birth), and hands the callee the
  name as `as` in its input. A call with no name is unchanged.
  docs/VM.md "Call permissions".
- **Granted kernel services.** The raw signer import (`wallet`) answers
  only a program whose app holds the service `signer`. The stock genesis
  grants it to the front door (`genesis:frontdoor`). An app asks for it in its
  manifest (`services: ["signer"]`); root approves it at install.
- **The genesis wallet program is gone.** No `programs.wallet` in any
  genesis, no pinned wallet module, no `wallet/` genesis scope. The name
  `wallet` is free: a wallet is an app (shruggr/skein-wallet).
- **Billing is out of the kernel** (#130: the host row, tick, meter, pay
  step, asleep gate) and **`kernel.pay` is gone** (#149), with their host
  halves (`skein-host billing`, `reclaim`, `skein host`). Per-step fuel stays.
- **An event's place identifies one event.** A step's facts are handed over,
  delivered to subscriptions and wake resting threads at their place in the
  step's own update (`n.seq.i.thread`), not in the thread's tip at the
  moment: delivering a fact the step's own thread rests on steps it again,
  and its later facts went out with no place (lost to live streams, their
  subscriptions and resting threads not stepped) or another update's place
  (de-duplicated away by the host). A log where that happened replays
  differently on this kernel.
- **`skein-dev install` is gone** (it installed the pinned wallet module; the
  kernel installs its own pinned modules).
- docs/WALLET.md is gone; its proofs and settlement sections are
  docs/CHAIN.md.
