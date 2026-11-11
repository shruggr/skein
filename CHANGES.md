# Changes

## 0.9.0

The host only (src/host); the kernel, the programs and the pins are 0.8.1's. David's settled rules
8-10 of the one-step swap (2026-11-11).

- **An instance hears of a transaction it broadcast only when it is rejected or mined.** The
  broadcaster (arc.ts) sends into the instances holding a transaction a proof (MINED / IMMUTABLE
  with its merkle path, a reorg's re-proof: the proof event, as before) and a REJECTED for an
  invalid transaction (Arcade's 400 with an invalid-class ARC code, a REJECTED it gives, a stream
  or webhook REJECTED that is not of our payload or 476: the status message, as before). Every
  other status — Arcade's 2xx answer to a post (RECEIVED, a duplicate's current status), the
  stream's and webhooks' RECEIVED, SENT_TO_NETWORK, ACCEPTED_BY_NETWORK, SEEN_ON_NETWORK,
  SEEN_MULTIPLE_NODES, MINED / IMMUTABLE with no path — is the host's: logged, recorded in
  host.db `status_seen`, sent to no instance (and no instance is read or hydrated for it).
  `DOUBLE_SPEND_ATTEMPTED` (the broadcaster never produces it; a double spend arrives as a
  REJECTED) is no longer named: it is one of the host's. The queue, its retries and its one-day
  give-up are unchanged.
- **The requester is answered off this host's broadcast.** `Broadcaster.taken(txid, signal?)`
  resolves when this host's broadcast of the transaction is taken by Arcade (its 2xx, or any
  status of it but a rejection; one already in `status_seen` at once) or refused as invalid
  (`{taken: false, reason}`); held in memory by txid, gone on a restart, ended otherwise only by
  `signal`. `Router.p2pInbound` holds a stream frame's answer that carries a signed transaction
  (dag-cbor `{…, tx, …}`: `signedTxOf`) on it (`heldAnswer`): taken, the answer is written as the
  instance gave it; refused, it is `{ok: false, reason: "rejected", detail: <Arcade's reason>}`.
  An answer with no transaction (a refusal: nothing broadcast) is written at once.
  `Router.broadcastTaken` is the same hold for an application host (open-exchange's swap relay).
  A host with no Arcade never releases such a hold (David to review).

## 0.8.1

The host and the log are 0.8.0's; the kernel's door verifier (skein-sdk v0.21.3) and the stock mail
program change (a new module CID in the kernel's pins and the default image: fresh homes pick it up).

- **A message is no longer lost when the kernel dies mid-entry.** The mail program
  (programs/mail, `/sendMessage`) took "the message's record is in the store" for "already
  admitted" and admitted nothing. A record's block is kept the moment it is put, also by an
  attempt whose entry was never committed: a kill after the sender's 200 and before the entry
  committed left the block, the entry ran again at restart, and the message was never routed
  (silently; the sender had its success). The program always answers the entry to admit now; the
  kernel admits a message once, by its `unique` map, committed with the entry that admits it. The
  same message delivered again (the same record: an instance's emit, delivered again after its
  restart) is two request entries, as before, and one admission: the kernel refuses the second
  ("already admitted; nothing runs"), its handler runs once, both answers carry the same id
  (event-order.ts: the kill case through the front door, and the double delivery; replayed
  exactly).

- **A held transaction is not script-checked again at the door.** The kernel pins skein-sdk
  v0.21.3: `kernel.beef`'s verifier treats a transaction the instance holds (chain/state `txs`, not
  rejected: `Headers.held`) that a BEEF carries raw as its txid-only entry; its scripts are not run
  again. Not held, it is checked as before.
- **The kernel builds from a clean clone.** It pins skein-sdk v0.21.2
  (placeholder modules in the first configure pass), so kernel-zig/build.zig
  needs no guard for the SDK's `chain` module; checked from a fresh clone with
  empty Zig caches. scripts/wasmtime-c-api.sh fetches the wasmtime C API where
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
  wasmtime fuel; the dag-cbor / dispatch fixtures); a check about one
  backend's own code stays per backend (format_test.zig: the old-format
  refusal on SQLite and on RocksDB). replays.ts no longer replays into
  RocksDB or migrates.

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
  host at delivery. The kernel pins skein-sdk v0.21.1 (was v0.12.0).

## 0.7.1

Host only: the kernel and the log are 0.7.0's.

- **The broadcaster posts Extended Format or nothing.** The raw-transaction
  fallbacks are gone (src/host/arc.ts). A broadcast event with no BEEF, a
  BEEF of another transaction, one whose subject lacks an input's source, or
  one that proves its subject (it is mined: a chain-app defect, which
  broadcasts only an unlinked transaction) is a host error, named with the
  txid on the instance's log. Nothing is queued and the instance is told
  nothing.
- **Arcade's answers by one table** (`ARC_CODES`, David to review). An
  invalid transaction (ARC 461-466, 471-474, and 467 on the stream) is
  REJECTED. Our payload or request at fault (a 400 with no ARC code, 460,
  467 at intake, 468, 469, 475, 401, 403, 404, any other 4xx) is not a
  rejection: an error on the instance's log, the row off the queue, no
  status. 476 (not final) keeps the row, tried again. 408, 425, 429, a 5xx
  or no answer are tried again as before. A REJECTED on the stream or a
  webhook with one of our codes or 476 is logged and not routed.
- The equivs pin skein-chain v0.11.0 (`chain.ts` on its status words), with
  `chain-proof-events.ts`, `chain-bundle.ts` and the test caller
  programs/test/ingester.

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
