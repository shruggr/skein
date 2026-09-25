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

`runShell` (src/shell.ts) runs patched brush + uutils coreutils as WASI
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
