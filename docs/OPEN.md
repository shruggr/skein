# Open questions raised by building

Model-level questions the first build surfaced. Each has a v1 default in the
code; none is settled. Settle them with David, then update MODEL.md.

1. **Who retries a thread that blew up.** MODEL.md says the scheduler "may"
   retry; it also says runners own relaunch judgement. v1: the scheduler never
   retries; the waiter does, by launching a new thread (the loop relaunches a
   blown-up model call once, then errors). `cant-do` is never retried.
2. **`say`/`page` in the same message as a tool call.** v1: shown as emissions
   on that step but they do not end the turn; the turn ends only on a step with
   no tool calls. Alternative: a `say` always ends the turn and the tool calls
   are dropped or deferred.
3. **A dismissed question.** If a `david` thread is dropped or errored, v1
   finishes the loop with its last step as the resolution. Alternative: the
   loop rests `dropped` too, so it shows up in the worklist as abandoned.
4. **Orphaned launch on crash.** A launch can be opened but its `launched`
   emission not yet written when the process dies. Recovery would relaunch,
   so a shell command could run twice. Shell narrows the window by writing
   `running` before spawning. A two-phase launch (reserve, then confirm) would
   close it; is it worth it?
5. **Step requests carry full history**, so storage grows quadratically with
   turn count. Fine for v1. Retrieval-over-compaction (the successor carries
   almost nothing) is the intended fix; when?
6. **`resting()` is literal**: errored and dropped threads stay on the
   scheduler's worklist forever. Should the worklist exclude terminal shapes,
   with a separate "abandoned" query for the nudger?
7. **Ordering.** The index has `at` (origin time) and `tip_at` (latest update).
   Lenses use `tip_at`; the scheduler uses `at` (oldest first). Confirm.
8. **Parent-less loop threads are "sessions".** They are the only threads that
   ask David. Subagent loops (with `launchedBy`) resolve to their caller with
   their final text. Confirm that a subagent must never need David directly,
   or add a way for it to launch a `david` thread on purpose.
9. **Emission type is open** (`{type: string}`), so unknown kinds can be
   written but cannot be narrowed at compile time. Keep it open, or close it
   and version it?
10. **Rebuild cannot recover a chain of an unknown kind** that was opened but
    never appended to (it looks like a plain block). Origins should probably
    carry a marker, or every opened chain should get a seq-1 update.

## Direction to keep in view (David, 2026-09-25)

Skein as a virtual machine whose storage is the full local graph, with the
scheduler as its execution engine. Runners become a standard interface into a
runtime (wasm or otherwise); tools become immutable objects, addressable in
the graph and on chain, calling each other through that same interface. gib's
git↔chain mapping can be reused between the VM's hash store and real git
repos. The ORDFS patch format (vcdiff against a base) is a candidate for how a
tool call expresses file edits, mapped onto the host filesystem.

## From the wasm shell prototype (2026-09-25)

`runShell` (src/runtime/shell.ts) runs patched brush + uutils coreutils as WASI
modules over the tree; see wasm/README.md for builds and patches.

1. **Pipelines run stage by stage.** Every external command runs to
   completion inside `skein.spawn` before the next starts; pipes are
   in-memory buffers capped at 64 MiB. Deterministic by construction, but
   `yes | head` ends only when the cap makes `yes` fail, streaming (`tail -f`),
   coprocesses and process substitution `<(…)` do not work. Good enough for
   agent use, or do we want real concurrency (one instance per stage with JSPI
   suspension on empty pipes, still deterministic if scheduling is fixed)?
2. **No metering.** `while :; do :; done` hangs the host. Needs fuel
   (instrumented wasm, counted per instance) rather than a wall-clock timeout,
   which would make results depend on the machine.
3. **Empty directories** are kept as empty git trees so `mkdir d` survives
   into the next command. `scan` drops empty directories, so
   `scan(materialize(t)) ≠ t` when `t` has one. Keep, or drop at commit?
4. **Modes.** WASI preview1 has no permission bits and no chmod: the exec bit
   comes only from the input tree, new files are 100644, `ls -l` shows
   `r-xr-xr-x` for everything, `test -x` is "exists". A `skein.chmod` import
   plus a patched `chmod` would close this if agents need it.
5. **Time** is one attested value for the whole run: every clock read and
   every mtime returns it, `sleep` returns at once. Should it advance per
   spawn, or per attestation message only?
6. **Randomness** is a seeded stream (`seed` option, default 0): `$RANDOM`,
   `mktemp`, `shuf` and Rust hash seeds are deterministic. Is the seed an
   input carried in the message that ran the command, or always 0?
7. **Toolset.** coreutils' WASI feature set has no `env`, `chmod`, `stat`,
   `du`, `timeout`; there is no `grep`, `sed`, `awk`, `find`, `diff`, `xargs`.
   Which programs to register next, and how: today names are hard-wired to
   two files in wasm/; the model says programs are records by CID.
8. **Binaries in git** (4.9 + 10.0 MB) and two patched forks to carry. The
   brush patch (host spawn/pipe imports behind `cfg(target_os = "wasi")`) is
   small and could be offered upstream as a pluggable process backend. Builds
   are byte-identical only on one machine (build paths in panic strings);
   `--remap-path-prefix` would fix that if program CIDs must be rebuildable.
9. **JSPI** (`WebAssembly.Suspending`/`promising`) lets reads load records
   lazily from the async store. It is Node 26 / V8 only; a Go host would need
   its own suspension or a preloaded tree.
10. **brush gaps seen**: `exec` is a unix-only builtin (so `exec 3>file` fails),
    `**/*.txt` with globstar missed top-level matches, errors read
    `error: command not found: x` rather than bash's wording.
11. **Devices**: `/dev/null` and `/dev/std{in,out,err}` are synthesized unless
    the tree has its own `/dev`; no `/dev/zero`, `/dev/urandom`, `/dev/fd/*`.

## From the runtime/clock build (2026-09-25)

Items 1–4, 8 and 16 were resolved by dropping the clock peer: time and
random are now pure, derived from the runtime's own stamp on each log entry
(docs/ARCH.md, "Time and randomness"). Struck through, kept for the record.

1. ~~**Realtime reads are frequent**~~ (a round trip each). Resolved: reads
   are free; `date; ls | head -3` exchanges no messages.
2. ~~**Monotonic clocks are pure**~~. Resolved: every clock id reads the same
   per-thread clock — the current entry's stamp, +1 ns per read, never back.
3. ~~**`state` in a request**~~. Resolved: there is no time/random request.
4. ~~**Genesis is dated 0**~~. Resolved: the admin's genesis messages still
   say `at: 0`, but their log entries carry the runtime's stamp.
5. **Hello has no freshness.** A captured hello can be replayed on the
   socket (local unix socket, so low risk). A runtime-issued challenge (a
   counter is enough; transport needn't be deterministic) would close it.
6. **Seq allocation edge.** The runtime's own messages are now only
   `result`s; a result's seq is reused from the chain on re-execution, but a
   crash between storing it and appending the `finished` update that names it
   makes the restarted runtime allocate a new seq, which a replay would not.
   Fix: write both in one store transaction.
7. **Re-execution cost** grows with the thread: restart replays it from its
   origin (verifying every update). Long threads want checkpoints (a
   program-level checkpoint record).
8. ~~**Duplicate replies**~~ to time/random requests. Gone with them; the
   question returns with the first real peer call (first valid reply wins?).
9. **Held outbound messages are in memory.** A message to an unconnected
   peer is in the store but its delivery queue is not; results to a client
   that disconnected are not redelivered. A durable outbox is a derived query
   ("messages from the runtime with no reply"), not yet written.
10. **Output is stored.** The `finished` update and the `result` message
    carry stdout/stderr/tree (recomputable cache per VM.md). Needs a size
    cap and a pruning story.
11. **Modules and trees enter by the side door.** `skein-dev scan`/`install`
    write objects straight into the store file as a stand-in for the client.
    The real path is messages carrying (or announcing, then streaming) the
    objects, and a program registration message naming module CIDs; the
    shell program's module CIDs are pinned in code for now.
12. **The wallet edge is an import.** `main.ts` imports `../wallet.ts`
    (HTTP to wallet-api); it is the one allowed escape from the isolation
    rule. The wallet's signatures are deterministic (RFC 6979, checked for
    both ProtoWallet and wallet-api) — replay depends on it for results.
13. **Identities share one wallet here.** runtime, admin, david and timer are
    keyIDs under one wallet; a real client signs with its own.
14. **Stat times are the epoch** (git records no times). `ls -l` shows 1970.
    Could use the thread's clock instead.
15. **Stale socket**: the runtime cannot unlink one (no fs); `bin/skein`
    removes it when `ss -xl` shows no listener.
16. ~~**The `sig` in `{time, state, sig}`**~~. Resolved: stamps are unsigned;
    the checkpoint signature covers them.
17. **Random has no seed.** ARCH.md says the runtime "draws a seed" and
    writes it into the entry; as built (per the design change), random_get is
    a SHA-256 stream keyed by (entry CID, thread origin) and nothing is drawn
    or stored. It is predictable from public records: never for secrets (the
    wallet does those). Decide whether a drawn, stored seed is wanted.
18. **Stamp resolution** is Date.now() (ms) as `[sec, nsec]`; nothing inside
    depends on it being finer. process.hrtime could add sub-ms precision.
19. **Sleep needs an input to wake.** Time passes inside only when an entry
    is admitted. `main.ts` admits a `tick` (signed by `timer`) about once a
    second (`SKEIN_TICK_MS`) while any thread sleeps, and never otherwise, so
    ticks are in the log and replay exactly — but they are log noise, and a
    sleep's real duration is quantised to the tick period.
20. **Stamps are the runtime's word.** They are unsigned and trusted as
    written; tampering shows up only against a checkpoint signature. A
    runtime with a wrong clock stamps wrong times, monotonically.

## Later (David, 2026-09-26)

- Propose binary wire-format extensions to BRC-169 (the envelope) and BRC-33
  (the messagebox message), so dag-cbor bodies aren't wrapped in JSON, hex
  and base64 at several levels.
- Raise upstream: BRC-169 §7.2 names no derivation for the envelope
  signature and its example signs with the raw identity key; skein uses
  `[2, "metanet handles envelope"]`, key id `"1"`, counterparty `anyone`.

## From the envelope/handler build (2026-09-25)

Settled by the build, for the record: `hello`, `tick`, the `timer` identity,
the unix socket (items 5, 15, 19 above) are gone; wakes are signed entries
written by `main.ts`'s timer at each deadline, one per wake. Identities no
longer share one wallet (13): the instance has its own; the owner is another
wallet. The old `~/.skein/runtime.db` was moved to `runtime.db.socket-era`.

21. **The root key is in the runtime process.** The edge (`inbox.ts`) derives
    message keys from `SKEIN_INSTANCE_WIF`, and it runs in the same process as
    the machine (`main.ts` reads the env). Nothing inside the machine sees it,
    but "the runtime never holds the key" holds only by code discipline. A
    separate host-edge process that hands `{envelope, key}` to the runtime
    over a local channel would make it structural.
22. **Freshness is judged against admission time.** An envelope older than
    `SKEIN_FRESHNESS_MS` when the runtime gets to it is rejected and
    acknowledged — so a runtime that was down for 10 minutes drops what
    arrived meanwhile (the live run dropped the client's earlier `objects`
    bundle exactly so). Judging `created` against the messagebox's own
    arrival time (`created_at`, which the server stamps) would keep replay
    protection without losing mail; it trusts the server's clock.
23. **The messagebox server** (`@bopen-io/messagebox-server` in `1sat serve`)
    takes `sender` from the BRC-103 session (good: the authenticated
    submitter) and dedupes by `messageId` (a UNIQUE column). It does not look
    inside bodies, so it cannot enforce `sender == envelope.sender.identityKey`
    or reject bad envelope signatures; the edge does both. BRC-169 §8 policy
    at the box would need a server change.
24. **Outbound is fire-once.** An emit is sealed and sent right after the
    step that made it is recorded; a crash in between, or a send that fails,
    loses it (logged only). A durable outbox is a query: emits with no
    `sent` record (the messagebox's messageId, recorded as an attested
    answer).
25. **A handler that errors says nothing.** If run-handler fails before it
    launches (bad body, decryption failure), its thread errors and no reply
    is emitted; the client waits forever. An error envelope in `results`
    from an errored first step (the runtime could emit it, or the handler
    could always exit 0 and reply) is the obvious fix.
26. **Modules still enter by the side door.** `skein-dev install`
    (`bin/skein-runtime` runs it) puts brush, coreutils and the handlers into
    the store; they are 4–10 MB, over the 1 MiB bundle, and a record cannot
    be split across bundles yet. Chunked records (a manifest record plus
    parts) would let `objects` carry them — and a program registration
    through a config box would replace the pins.
27. **Programs share the instance's wallet grants.** Every handler calls the
    wallet as origin `skein`; the runtime allows only key/crypto calls
    (getPublicKey, encrypt, decrypt, createHmac, verifyHmac,
    createSignature, verifySignature — no actions, certificates or
    discovery), but within those any protocol the instance is granted. A
    per-program protocol allowlist in the program record would narrow it.
28. **Wire interop bug.** go-sdk's `CreateSignature` with empty `Data`
    produces a frame @bsv/sdk's `WalletWireProcessor` rejects ("read exceeds
    available data"). Non-empty data round-trips (`program.test.ts`). To
    report upstream.
29. **`get` is not gated by reachability.** A program can read any record in
    the store by CID. VM.md's gating (reachable from the thread's inputs)
    is not implemented.
30. **Subscriptions are fixed at genesis.** There is no config entry kind to
    add a box or change a handler; a new instance (new genesis) is the only
    way. A `config` box from the owner, routed to a config handler whose
    reveals the scheduler honours, would be the in-log way.
31. **Handler binaries are big.** 4 MB each (Go runtime + fxamacker/cbor +
    crypto); wire-probe, which links go-sdk, is 8 MB. fxamacker was chosen over
    go-ipld-prime for size and a plain struct API; TinyGo could cut both by
    an order of magnitude if its wasip1 target handles `go:wasmimport` with
    JSPI as Go does.
32. **Owner handles are config.** Outbound envelopes need
    `recipient.{handle, domain}`; the run-handler copies the sender's from its
    envelope and the edge falls back to `SKEIN_OWNER_HANDLE`. BRC-169
    resolution (handle → identity, and back) is not used.
33. **Step outputs are stored.** A handler step's update carries its
    stdout/stderr, and the shell's `finished` update its whole result
    (VM.md: recomputable cache). Same size question as item 10.
