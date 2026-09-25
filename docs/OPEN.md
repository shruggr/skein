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
