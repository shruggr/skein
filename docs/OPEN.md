# Open questions raised by building

Notes from the builds of 2026-09-25/26 that are still live. Items that
were done or superseded since have been removed; the numbers are kept so
older references still resolve. Current open items, decisions and what is
ready to build are in the tracker, issue #31; where this file and an issue
disagree, the issue is right.

## The thread model (2026-09-24)

4. **Orphaned launch on crash.** A launch can be opened but its `launched`
   record not yet written when the process dies. Recovery would relaunch,
   so a shell command could run twice. A two-phase launch (reserve, then
   confirm) would close it; is it worth it?
5. **Step requests carry full history**, so storage grows quadratically with
   turn count. Retrieval over compaction (the successor carries almost
   nothing) is the intended fix; when?

## The shell (2026-09-25)

The kernel runs the shell (`kernel-zig/src/shell.zig`): brush and uutils
coreutils as WASI modules over the tree. The modules and the toolset are
the shell app's (shruggr/skein-shell, #83), named by its shell program
record.

1. **Pipelines run stage by stage.** Every external command runs to
   completion before the next starts; pipes are in-memory buffers capped at
   64 MiB. Deterministic by construction, but `yes | head` ends only when the
   cap makes `yes` fail, and streaming (`tail -f`), coprocesses and process
   substitution `<(…)` do not work.
3. **Empty directories** are kept as empty git trees so `mkdir d` survives
   into the next command. `scan` drops empty directories, so
   `scan(materialize(t)) ≠ t` when `t` has one. Keep, or drop at commit?
4. **Modes.** WASI preview1 has no permission bits and no chmod: the exec bit
   comes only from the input tree, new files are 100644, `test -x` is
   "exists". A `chmod` import plus a patched `chmod` would close this if
   programs need it.
10. **brush gaps seen**: `exec` is a unix-only builtin (so `exec 3>file`
    fails), `**/*.txt` with globstar missed top-level matches, errors read
    `error: command not found: x` rather than bash's wording.
11. **Devices**: `/dev/null` and `/dev/std{in,out,err}` are synthesized
    unless the tree has its own `/dev`; no `/dev/zero`, `/dev/urandom`,
    `/dev/fd/*`.

## The runtime and the clock (2026-09-25)

7. **Re-execution cost** grows with the thread: a restart re-executes a
   thread's cut-off step from the log. Long threads want checkpoints.
10. **Output is stored.** A step's update carries its stdout, stderr and
    tree (recomputable cache per VM.md). Needs a size cap and a pruning
    story; the store may forget what no head reaches (retention, #31).
14. **Stat times are the epoch** (git records no times). `ls -l` shows 1970.
    Could use the thread's clock instead.
18. **Stamp resolution** is the host's `Date.now()` (ms) as `[sec, nsec]`;
    nothing inside depends on it being finer.
20. **Stamps are the host's word.** They are unsigned and trusted as
    written; tampering shows only against a checkpoint signature. A host
    with a wrong clock stamps wrong times, monotonically.

## Programs and messages (2026-09-25)

27. ~~**Programs share the instance's wallet grants.**~~ Resolved by the
    2026-10-01 decisions (#31): wallet access is not gated per program; the
    signer is infrastructure every program on the instance reaches.
28. **Wire interop bug.** go-sdk's `CreateSignature` with empty `Data`
    produces a frame @bsv/sdk's `WalletWireProcessor` rejects ("read exceeds
    available data"). Non-empty data round-trips. To report upstream.
29. ~~**`get` is not gated by reachability.**~~ Resolved by the 2026-10-01
    decisions (#31): reads are global by CID; holding a CID is the
    permission, and data meant to be private is encrypted.
36. **One answer per await.** The first admitted message that names an
    awaited CID from the right identity wakes the thread; a second is
    recorded only. A peer that streams partial results would need `awaits`
    to stay until a final message.
38. **The chat loop replays its whole conversation every step.** It walks
    its chain back from `tip` and re-reads every turn (O(turns) `get`s per
    step). No context budget, no summarising, no truncation beyond the
    16 KiB tool-output cap.
39. **The inference peer is trusted for the model's word and nothing else.**
    Its completion is signed and recorded; the loop acts on it (runs `bash`
    in the shell, which only touches trees). There is no per-thread step
    limit or tool-call cap.
40. **`thinking` is a genesis default** (`defaults.thinking`), not in the
    `chat` shape. A `chat` field or a per-conversation setting would let the
    sender choose.

## Known leftovers in the tree

Dead or legacy code, not yet removed: `host-go/` (a shell experiment, not a
host); `src/runtime/log.ts`, a format-1 reader
the node host still imports; `attested` in `src/runtime/records.ts` and
`types.ts`.
