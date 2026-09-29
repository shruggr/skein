# Skein as a virtual machine

The model as of 2026-09-25 morning, after the first build and one correction.
It supersedes `MODEL.md` where the two differ; `MODEL.md` remains what the v1
code implements until the code is reshaped to this. Reasoning is in the design
doc (https://claude.ai/code/artifact/25e9f57d-b1b0-452c-a523-96429fb1c64e),
the voice session it records, and the easel sessions of 2026-09-24/25.

## One sentence

A skein instance is a deterministic virtual machine: its storage is a
content-addressed graph, its programs execute inside it over an immutable
filesystem, its only inputs are an ordered log of signed messages, and its
only outputs are messages. A host feeds it inputs and carries out its
outputs; nothing the host does is part of the machine's state.

## The correction this version makes

The first draft of this model recorded every effect's *output* (a shell's
stdout, every resulting tree) and called that deterministic because replay
could read the recordings. That was event sourcing, not determinism: it made
wasm pointless (the host did the work) and grew the store with every
command. The model now is that **programs execute inside the machine,
deterministically, so their outputs are recomputable and are not stored.**
Only what is truly non-deterministic is recorded as input.

## Records

Everything durable is a **record**: one IPLD object identified by its CID.
(IPLD calls these blocks; that word is avoided here because of Bitcoin
blocks.) Two families:

- **Skein records**: dag-cbor maps under CIDv1 (dag-cbor, sha2-256). Origins
  and updates, chains and tips, as in `MODEL.md`: a pointer to an origin
  means "as it is now", a pointer to an update means "exactly this version",
  and the tip index is a rebuildable local convenience.
- **Filesystem records**: git-shaped objects — a blob is a git blob object, a
  tree is a git tree object — under CIDv1 with the `git-raw` codec and a sha1
  multihash, so a tree's CID *is* its git object id. A directory scanned into
  skein hashes identically to `git write-tree`; gib and real repositories
  need no translation. (UnixFS would have given IPFS-tooling interop instead;
  git interop was chosen.)

A record is stored once however many instances or trees reference it.

## The filesystem

The filesystem is part of the store. A working directory is a tree CID. A
program sees it through a Unix interface (below) but can never mutate a
record: writes build new blobs and new trees in memory, and a command's
result is a new root CID. Before/after trees are what the graph records; the
patch between them is derivable, exactly as a git commit is.

Anything outside the tree — the host's real filesystem, the network — is not
machine state and is unreachable from inside.

### The synthetic object directory

A repository in the tree is an ordinary git repository: `git` (real git,
compiled to WASI; `wasm/README.md`, "git") runs in the shell over a project
directory, and its `.git/` — `HEAD`, refs, `index`, `config` — is a set of
ordinary files in the tree. The exception is `.git/objects`. Each loose
object git keeps there is a git object the store already holds natively:
same bytes, same sha1, a git-raw record. Storing git's zlib file of it as a
blob would store everything twice. So the kernel's VFS makes that
directory synthetic (issue #2; Zig kernel only, `kernel-zig/src/objects.zig`
and `vfs.zig`):

- **In the tree**, `<repo>/.git/objects/xx/yyyy…` (any directory `xx` of
  two hex digits directly inside a `.git/objects`, any entry of 38 hex
  digits in it) is a **gitlink**: a tree entry of mode `160000` whose hash
  is the object's own id. The tree names the object and holds none of its
  bytes. This keeps the objects enumerable, so git's abbreviated ids and
  `fsck` work, and reachable from the tree like any other record.
- **A read** (open, stat, read) sees a read-only file: the git-raw record,
  fetched from the store and zlib-framed on the fly as git's loose-object
  format, header `<type> <size>\0` and content. The kernel writes stored
  (uncompressed) deflate blocks: a valid zlib stream, no compression cost,
  the same bytes on every host, and never stored. Opening one for writing
  is EACCES, as with git's own 0444 objects.
- **A write**: git writes `objects/xx/tmp_obj_…` as an ordinary file, then
  links or renames it to its name. At that moment the kernel inflates it,
  checks the header and the sha1 against the name (EIO if they differ, and
  nothing moves), and the file becomes the object. The record goes to the
  store when the run's tree is committed, once (a record the store already
  has is not written again). A file written straight to an object's name
  is checked the same way at commit, and stays an ordinary file if it is
  not that object. An object moved out of the directory becomes an
  ordinary file of its zlib bytes.
- **No packs.** Nothing new may be linked into `.git/objects/pack` (EPERM),
  so `git gc`/`git repack` fail there instead of writing every object again
  as a pack. The git build does no automatic maintenance.

So a repository's commits, trees and blobs are first-class records shared
with everything else. The tree a commit names is the same record as the
project directory's tree in the VFS, minus `.git` (and every subdirectory
is shared outright), so a deployed agent tree *is* its repository's tree.
`kernel-zig/equiv/git.ts` checks this on the Zig kernel: the verbs, the
commit tree against the VFS tree, one record per object and no zlib copy
anywhere, and replay giving the same trees.

The TypeScript runtime (frozen) does not have this feature. There, git
runs over plain files, and its loose objects are stored as zlib blobs.

### Heads

A **head** is a named pointer to a tree, kept as a chain like any other
instance state: origin `{kind: "head", name}` (so a head is found by encoding
its name), one update per move `{tree, thread, input, at}` naming the tree,
the thread whose step moved it, and the log entry that step processed. Replay
writes the same chain. A name never moved has no chain.

- A head moves only by an explicit act: a program's step calls the `advance`
  import (the tree must be in the store), and the move is written when that
  step ends without error; the step's update lists it (`heads`). Nothing moves
  a head at turn end, and a thread's tree stays private to the thread.
- The owner moves one by sending `{name, tree}` to box `head` (`skein head
  <name> <tree>`): `head-handler` reads the request (the plaintext body the
  log entry names) and advances the head.
- `main` is the default: `run` with no tree, and a new `chat` with no tree,
  start from `main`'s tree (the empty tree if there is no `main`). The loop
  records that tree in the opening turn it keeps.
- An import sets `main` when the instance has none: the client names the root
  on the last `objects` bundle, and `objects-handler` advances `main` to it.

### Subscriptions

The routing table is a chain too, one per instance: origin `{kind:
"subscriptions"}` (found by encoding it, like a head by its name), one update
per change `{op: "add" | "remove", sender?, box, handler, thread?, input,
at}`. The rules are the updates folded in order: `add` appends the rule
`(sender, box) → handler` at the end of the list, `remove` deletes it; an add
of a rule already listed, or a remove of one that is not, writes nothing. No
`sender` is any sender, and no `box` is any box (a genesis-only catch-all: a
mailbox instance's, #40). The scheduler routes each message (a `mail`
record, below "Messages") by the rules as they stand when its entry is
processed, first match wins, replies before any of them (docs/MESSAGES.md).
Replay writes the same chain.

- **The genesis carries only the seed.** Its `subscriptions` are written as
  the chain's first updates when the genesis entry is processed (no
  `thread`); nothing reads them for routing afterwards. By default
  (`STOCK_SUBSCRIPTIONS`, src/host/genesis.ts): the owner's `run`,
  `objects`, `head`, `chat`, `subscribe` and `peers` (→ `resolve`) boxes;
  `chat` from anyone; and the reserved box the host admits into, `:ack`
  (→ `messagebox`: a reader's pointer). A mailbox instance's seed is `:ack` and every message
  from anyone in any box to `messagebox` (`MAILBOX_SUBSCRIPTIONS`). Sessions
  are not state: the front door keeps them in memory, never in the log
  (MESSAGES.md). No `register` box: registration is application wiring
  (an application's own etc/subscriptions.json, BOOTSTRAP.md).
- The chain changes only by an explicit act: a program's step calls the
  `subscribe` import (the handler must be a program record in the store, a
  wasm program's module too), and the change is written when that step ends
  without error; the step's update lists it (`subscriptions`).
- The owner changes it by sending `{op, sender?, box, handler}` to box
  `subscribe` (`skein subscribe add|remove [--sender key] <box> <handler>`,
  `skein-host subscribe <handle> …`): `subscribe-handler` checks the handler
  is a program record and calls the import. No reply.
- **A subscription is the permission.** Who may change subscriptions is
  whoever is subscribed to `subscribe`: the genesis subscribes the owner, and
  delegating is the owner subscribing another sender to `subscribe`. A
  `subscribe` from anyone else is recorded, and nothing runs.
- **Registering a program** is subscribing a box to its CID. Its record (and
  module) must be in the store first: `objects` delivers them.
- Nothing polls for messages (#40): a message arrives at the instance's front
  door (a `sendMessage` request) and is admitted as an entry; a box
  subscribed at runtime takes messages from the next one.
- A store whose log predates the chain has no chain, so nothing would route:
  the runtime refuses to start it. It needs a new genesis (no migration).

## Programs and execution

A **program** is an immutable record: its code (a WASI module), its input
schema, and the host services it may message. Threads reference programs by
CID. A **tool** is a program with a declared calling shape; the definition an
LLM sees is derived from the record.

Programs run **inside** the machine as WASI modules or WASI 0.2 components
(below, "The ABI"). The host satisfies only
these imports:

- `wasi:filesystem`, backed by the current tree (reads resolve blobs, writes
  build new trees; the new root CID is part of the result);
- stdio (stdin from the pipeline, stdout and stderr captured);
- the record store, read-only, by CID (`get`), gated by reachability;
- the connected wallet's BRC-100 operations (sign, verify, encrypt, decrypt,
  derive);
- a **time attestation** (below).

Not provided: wall clock, random, threads, network, host filesystem. A WASI
program with only these imports is deterministic by construction, so replay
re-executes it and gets the same tree and the same output.

The LLM-facing `bash` tool is a **wasm shell**: a bash-compatible shell
compiled to WASI (brush) running programs that are themselves WASI modules
(uutils coreutils and whatever else is registered), all over the tree-backed
filesystem. Agents keep writing ordinary shell commands; what runs them is
inside the machine and limited to the tools the instance has registered.
That is the "deterministic container with a limited toolset".

Script runtimes are two of those programs (issue #25; `wasm/README.md`,
"Script runtimes"; the skills audit in `docs/SKILLS.md`): `qjs` (QuickJS-ng,
also `node` with a small file + stdio shim) and `python`/`python3` (CPython
3.14). A `#!` script in the tree runs under its interpreter when that is a
registered program. Python's stdlib is a support file of the shell program
(a raw block, like the modules), mounted read-only for python processes only
at `/opt/skein/python`; it is not part of the tree and never committed.

A step function is the same idea one level up: the turn loop is a program
whose input is the thread tip and the message that woke it, and whose output
is records to append. A message out is not an output of the step: the step
delivers it itself (#40), calling its messagebox program's `send`, whose
`http` request is recorded on the step like any other.

### The ABI: preview1 modules and WASI 0.2 components

(Issue #34; built in the Zig kernel, `kernel-zig/src/component.zig`, README
"Components".) A program's `code.wasm` may be either of two binaries, and
the kernel runs both:

- a **preview1 core module**, which imports `wasi_snapshot_preview1` and the
  `skein` namespace (pointers into its memory, `f(…, out, cap) → n`, with
  `take`/`error`; `src/runtime/wasi/skein-imports.ts`);
- a **WASI 0.2 component**, which targets the world `skein:kernel/handler`
  (`wit/skein.wit`). That is WASI 0.2.12's `cli`, `clocks`, `filesystem`,
  `io` and `random`, plus the interface `skein:kernel/skein`, and the export
  `wasi:cli/run`. The interface has the same calls as the `skein` namespace.
  Results come back through the canonical ABI, errors as
  `result<_, string>`, and `head` returns an `option`.

The kernel tells them apart by the binary's preamble. Both get **one
behaviour**, because the 0.2 imports are answered by the preview1
implementation itself:

- a `descriptor` is a process fd, and a stream reads and writes through
  `fd_read` and `fd_write`;
- the tree, errors and inode numbers are the same;
- the clock is the entry's stamp, and random is the entry-derived stream;
- the skein calls reach the same host functions.

Fuel is per wasmtime store, so a component draws on the step's budget the
same way.

A component's fuel is its own, not the module's: the preview1 adapter and
the canonical-ABI glue are instructions too. So the same program built for
both ABIs gives the same updates in every field but `fuel`, and its log
replays exactly on the ABI it ran on (`kernel-zig/equiv/abi.ts`).

The preview1 adapter and wasi-libc's 0.2 exit report any non-zero exit
status as 1, because `wasi:cli/exit` is ok/err.

### Outgoing HTTP: `wasi:http`, answered by the host and recorded

(Issue #15; built in the Zig kernel, `kernel-zig/src/component.zig` and
`http.zig`.) A component makes HTTP requests through standard
**`wasi:http/outgoing-handler`** (0.2.12, in the `handler` world) and knows
nothing of skein: a program built against `wasi:http` runs unmodified. HTTP is
a kernel call answered by the host — there is no provider peer and no message.

- **One recorded-call shape.** The kernel serializes the outgoing request
  into the shape a preview1 program hands the `skein.http` import itself:
  dag-cbor `{method, url, headers?, body?, options?}` — `url` is scheme
  (default `https`) `://` authority path-with-query (default `/`); `headers`
  is `{name: text}`, a name given more than once joined with `", "`; `body`
  only when the program wrote one; `options` only when a `request-options`
  set a timeout (`connectTimeout`, `firstByteTimeout`,
  `betweenBytesTimeout`, in ns). Both ABIs reach the same host function, so
  the wallet's two builds make byte-identical requests (`equiv/abi.ts`).
- **What is recorded.** Request and response go on the step's update as a
  recorded call (op `http`: the request bytes and the host's answer
  `{status, headers, body}`), like `wallet`. Nothing is
  suspended: the step waits for the host inside the call.
- **Replay** reads the response from the record and never touches the
  network. A request that differs from the recorded one is a divergence.
- **The host** (`src/host/router.ts`) answers with its handler (a test's
  stand-in) or, with `SKEIN_HTTP=fetch`, real requests; it applies the
  recorded options (connect + first-byte bound the wait for the head,
  between-bytes each body read). A host failure is the program's
  `error-code` `internal-error(message)`; it is not recorded (the step is
  then refused a witness on replay, as for the preview1 import).
- **Limits.** Bodies are buffered whole in both directions (at most 64 MiB
  out); the request is sent at the first `future-incoming-response.get`
  (its body is final then), and its future is always ready. No trailers:
  request trailers are refused (`internal-error`), response trailers are
  none. Response headers are what the host reports. No incoming handler, no
  sockets.
- **Long-lived feeds are not `wasi:http`**: the router holds SSE feeds and
  webhooks and admits each event as an entry (#29, #33).

A preview1 program keeps the `skein.http` import (the wallet's pinned build
uses it); it is the same code path underneath.

In the browser (issue #35) the same kernel, compiled to wasm, runs preview1
modules on V8 through a JS shim; components are not run there yet (refused
with a message). A preview1 program behaves the same on both engines — the
same imports answered by the same kernel code, the same fuel — so a log
written in the browser replays natively and the other way round.

### libp2p: one import, answered by the router and recorded (#51)

The runtime has no network; libp2p is the router's (docs/ARCH.md, "The
libp2p host"). Outbound, a step has one import, **`libp2p`**: preview1
`skein.libp2p(req, len, out, cap) → n` with a dag-cbor request, and in the
WIT the typed interface `skein:kernel/libp2p` (`publish`, `dial`, `send`,
`receive`, `close`), which the component host turns into the same request.
One recorded shape for both ABIs:

```
{op: "publish", topic, body}         → {seqno: bytes(8), recipients}     GossipSub, signed with the instance's peer key
{op: "dial", peer, protocol}         → {stream}                           peer: a peer ID, or a multiaddr with /p2p/<id>
{op: "send", stream, body}           → {}                                 one length-prefixed frame (unsigned varint)
{op: "receive", stream}              → {body} | {pending: true} | {closed: true}
{op: "close", stream}                → {}
any of them                          → {error}                            the call's failure (-1 / the WIT error)
```

- **Recorded like `http`.** Each call is an attested record on the step's
  update (op `libp2p`, the request bytes, the router's answer) — an
  `{error}` answer too, so a failed dial fails the same way on replay.
  Replay serves the recorded answer and never touches the network; a request
  that differs from the recorded one is a divergence.
- **`receive` rests.** A frame not yet there answers `{pending}`: the program
  sets a `deadline` (its timeout) and ends the step, and the thread rests. When
  a frame arrives on the stream the router admits a **wake** for the thread at
  once, before its deadline. The kernel steps a sleeper early only when its tip
  update's last recorded call is a `libp2p` receive answered `{pending}` (a
  function of the log: replay decides the same); any other early wake runs
  nothing. The woken step calls `receive` again and gets the frame (recorded).
  The stream id is the router's (unique across its restarts); after a restart
  the stream is gone and `receive` answers `{error}`.
- **Where it is refused.** In a kernel `call` (a call sends nothing: only a
  step does), and in the browser build ("libp2p: unsupported in the browser"),
  where nothing is recorded and the step sees the error; a store with
  recorded libp2p calls replays in the browser as natively.
- Published messages are signed by GossipSub with the instance's **peer key**
  (a child of the master secret, key ID `libp2p:<handle>`), never a wallet
  key. Inbound messages and stream frames are not an import: they reach the
  instance through its front door (docs/MESSAGES.md, "libp2p").

### Calls: reading the state without an entry (#40)

Beside the one call in that writes — **admit** an entry, and the steps it
drives — the kernel has a second call in, **`call`**: run a program as a
function over the current state and return a value. It writes nothing.

- **The ABI** is the program's ordinary entry (`_start`, or `wasi:cli/run`
  for a component), so it is the same for preview1 modules and components.
  `input()` returns `{kind: "call", fn, arg: bytes, caller?, now, self:
  {handle, domain, identity}, owner, programs, peers, defaults, names, routes,
  reads, subscriptions: [{sender?, box?, handler}], pending: [entry CIDs
  admitted and not yet processed], state: <the committed state record>}`
  (an in-VM call from a step adds `step: {thread, step, entry, at}`);
  the program dispatches on `fn` and writes its result to stdout. A non-zero
  exit is the error, with the last line of stderr as its message. The
  serve frame is `{op: "call", v: {program: <CID or a genesis program's
  name>, fn, arg, caller?, now?}}` → `{ok, result | error, fuel}`; the
  browser build takes the same frame through `skein_call`.
- **No entry, no writes.** `get`, `head` and the store read as they stand;
  `put` and `putblock` keep their records in memory for the call only (so a
  program can build a record and read it back, or return it for the host to
  admit), and `keep`, `launch`, `await`, `advance`, `subscribe` and
  `deadline` are refused. The oracle (`wallet`) and `http` are answered by
  the host and **not recorded**.
- **No determinism.** Nothing replays a call, so it needs none: its clock is
  the host's `now` (plus fuel, as in a step), its random is real entropy
  (a session nonce made there must not be guessable), and the host's answers
  are whatever they are at the time.
- **Fuel** is limited by `callFuelLimit` in the genesis's `defaults`
  (default 10^10) and reported with every answer, success or not, for the
  host's ledger; it is never in the log.
- **In-VM calls.** A program calls another with the `call` import
  (`call(program, fn, arg) → bytes`, preview1 and WIT alike). From a kernel
  `call` the callee reads only, in the same world (the records put, the
  fuel). From a **step** the callee is part of the step: its recorded calls,
  kept records, launches and head moves are the step's, on the step's fuel,
  and replay re-runs it with the step. A step sees its own head moves: a
  head a callee advanced reads back as moved in the rest of the step. Calls
  nest to depth 8; an answer is at most 64 MiB.
- **What calls are for.** The front door (`programs/frontdoor`) is a call:
  the host hands it each HTTP request (fn `http`), and a read — a poll, a
  lookup, the explorer — is answered from state with no entry and no byte
  written. A request that must write returns the entries for the host to
  admit (docs/MESSAGES.md, docs/ARCH.md).
- **The overlay's submit uses the call's overlay as a scratch store**
  (#50, docs/OVERLAY.md): the handler decodes the BEEF once into
  `bitcoin-tx` blocks and merkle nodes with `putblock`, checks SPV and runs
  the topic managers (in-VM calls) over them through `get`, and returns an
  entry only if a topic takes the transaction. A refused submission leaves
  the store byte-identical. The entry carries the decoded records, and the
  step that processes it keeps them and calls the lookup services' hooks,
  which move their own heads (`ls:<service>`).

### Fuel: every step is metered

(Issue #5; built in the Zig kernel, `kernel-zig/src/engine.zig`, README
"Fuel".) Every step runs with wasmtime's fuel on — an instruction count, not
a clock, so the same program and input burn the same fuel on every machine.
A step's fuel is the sum over every instance that ran in it (a handler
program; a shell and each program it spawns), and it is one more field on
the update that ends the step: `{state: "finished" | "errored" | "waiting",
…, fuel: <integer>}` (a `running` update, which starts a shell step, has
none). Replay verifies it like every other field: a different burn on
re-execution is a divergence.

One constant limits it: `fuelPerStep` in the genesis's `defaults` (default
10^12). A step that runs out ends `errored` with `error: {kind: "cant-do",
message: "fuel exhausted"}` and `fuel` equal to the limit — deterministic,
never retried. Per-tree limits (depth, steps) need no field: both are
countable from the chains.

The same count on every engine (issue #35): in the browser build the kernel
runs programs on V8, which has no fuel, so it rewrites each module to count
its own — the same costs, accounting points and checks as wasmtime's
(`kernel-zig/src/wasm_fuel.zig`, README "The browser build") — and meters that
counter. The fuel on an update does not depend on where the step ran: the
corpus replays in Chrome with identical updates and state.

Billing is a query over the log: the sum of `fuel` per thread, instance or
period (`skein-kernel fuel <db> [--since n]`), verifiable by anyone who
replays the log. Fuel does not cover host time outside the VM (oracle,
peers) or the router; storage and messages are visible in the log already.

### The clock inside a step runs on fuel

(Issue #38; Zig kernel, `kernel-zig/src/syscalls.zig` `ThreadClock`.) A
program's clock (`clock_time_get`, realtime and monotonic alike) reads

    t = max(last + 1, stamp + fuel × 1 ns)

where `stamp` is the time of the log entry that started the step, `fuel` is
what the step has burnt so far (its shared meter: a shell and every program
it spawns read one clock), and `last` is the previous read, so no two reads
are equal and time never goes back. **1 fuel unit = 1 ns**, a fixed
constant, not a calibration. Nothing is recorded: fuel is deterministic, so
replay and a fresh run read the same times. Time moves with work — a program
that waits on the clock inside a step (a busy-wait, a timeout loop) sees it
pass and ends on its own instead of spinning until fuel runs out, and
mid-step timestamps spread with real work. A shell's sleep takes its
deadline from this clock and rests the thread; the wake entry's stamp starts
the next segment, its fuel counted from zero. (Before #38: the stamp, then
+1 ns per read — still the TS runtime's clock, which is frozen.)

## Messages

(Issue #40; `kernel-zig/src/log.zig`, log format 3. The signed-message
design this section once described — every input a signed message, sends as
outbound messages the host carries out — is superseded.) Messages are state:
the log is what arrived, and an entry is one of

```
entry  {kind: "log", prev, n, time, genesis | mail | wake | event+box}
mail   {kind: "mail", op: "put", sender, recipient, box, body: <cid>, json?,
        session?: {payload, signature, nonce, yourNonce}}
```

- **`mail`** is a BRC-33 message that arrived at the front door: its sender
  is the identity of the BRC-104 session it came on (authentication is by
  key; `session` keeps the signed request, so the log verifies with keys
  alone), its body a record of its own (admitted with the entry:
  `admit(entry, {body})`). The mail record's CID is the message's id — what
  the sender computes too, and what a reply's `replyTo` names; a second
  admit of the same record is refused (the `unique` map). It is routed to
  the thread awaiting the message its body's `replyTo` names (a reply is from
  the identity that message was sent to), else by subscription on (sender,
  box).
- **`event`** in a box: a record from a feed the host holds (#29: a header,
  a proof, a status) or a front door's own write (`:ack`, an
  overlay's `submit`), routed by its `subject` or by box.
- **`wake`**: a sleeper's deadline.
- **`genesis`**: who the instance is, its programs, seed subscriptions,
  routes and reads.

Nothing a front door merely reads or verifies is an entry. A message leaves
an instance by the instance's own program: its messagebox's `send` (a BRC-104
client, over recorded `http`) to the recipient's messagebox URL, which its
address book names (written only by its own programs: `resolve`'s BRC-169
lookup, or the owner's `peers` box — the admin's configuration) or, for the
owner, the genesis's `defaults.ownerMessagebox`. A store in an older format
is refused (start a new store).

## Time

Time cannot be computed inside, so it is an input. Every time value is a host
**attestation** bound to the state it applied to:

```
{ time, state: <tip of the log>, sig }
```

A scheduling tick and a program's request for "now" are the same shape; an
unbound clock reading would have no place in replay. A gib checkpoint is the
same attestation with the chain as witness: the head's outpoint binds the
state hash to a block time, and that one anyone can verify.

## Threads, nodes, steps

As in `MODEL.md`: a thread is the unit the scheduler acts on (origin = which
program with which args and who launched it; updates = stop shapes); a node
is a request plus its typed emissions; a step is one model call's node; a
turn is a run of steps. Two changes from v1:

- **Every thread is launched by a record**: a step (a tool call, a subagent,
  a model call) or an inbound message (a person's opening line, a message,
  a cron event). "Top-level" means launched by a message.
- **There is no `david` runner.** A thread that needs a person waits on *a
  message from that identity* (the `await` import on the message it sent). The subscription table is what makes David's
  messages resolve waiting threads while a stranger's are routed to a
  handler program or refused. Cron is a time attestation that a subscription
  routes to whatever waits for it.

A transaction is a thread whose state chain is its finality (created,
broadcast, mined with merkle path, rejected, reorged), each transition an
inbound message. A rejection moves heads and never deletes: records that
depended on the transaction (transitively via `depends-on`) are marked
dropped and their threads' heads move back; the dead branch stays. The
expected pattern is a thread that waits for the finality it needs before
dependent work continues; optimistic versus gated is policy, deferred.

## Subscriptions

Routing is a **subscription**, not a permission check made at delivery time:
a rule `(sender?, box) → handler` in the instance's subscriptions chain
("Subscriptions" under "The filesystem" above, beside "Heads"). Delivery is
a pure function of the message and the rules as of that point in the log. No
match → recorded, nothing runs.

## Host

> Superseded by `ARCH.md`: there is no host layer beside the runtime.
> Everything outside is a peer reached by messages; clock and random are
> peers too. The table below is kept only to show what those peers cover.

Everything that is not the machine is the host. Its surfaces into the
machine are exactly three: **messages** (in and out), the **wallet** (BRC-100,
keys never enter), and **time attestations**. Its services behind those:

| service    | delivers in                            | carries out                    |
|------------|----------------------------------------|--------------------------------|
| store      | the shared record store                | —                              |
| inference  | model completions, signed              | model calls                    |
| wallet     | results                                | sign, broadcast, derive        |
| messages   | envelopes (BRC-33), a person's lines   | BRC-169 sends                  |
| chain      | finality events with merkle paths      | —                              |
| clock      | time attestations                      | —                              |

There is no execution service: commands run inside. The host's own
configuration — which endpoint `ripper` names, credentials for a service that
does not speak wallet auth — is host-side and invisible to the instance; a
provider name in a message is a routing label. In the target state the
wallet is the only secret.

The host/machine boundary is a **wire protocol** (signed dag-cbor messages,
WASI imports), not a language interface, so the host can be reimplemented
(Go, another machine) without the machine noticing. The first host is
Node/TypeScript; programs are Rust or anything else that targets WASI.

## Identity

- **One root identity key per instance.** Services derive keys under it
  (BRC-42); every record traces to the instance. The first record is its
  genesis, carried in a message from a derived identity that names the root
  (a BRC-100 wallet signs only with derived keys).
- **Every inbound record is signed by its source**, including host services.
  A service on another machine is just another identity exchanging signed
  messages; location is not part of the model.
- People, other instances and outside agents are known by their identity
  key and reached at their messagebox URL (#40): BRC-169 is only discovery
  (a handle → key and URL, the `resolve` program), not part of delivery.

## The shared store

The host keeps one record store shared by every instance on it. An
instance's graph is what is reachable from its own chains; it can read a
record only by naming its CID and can never enumerate the store, so gating is
by reachability. Instances talk to each other only by messages.

## What is stored

Inputs (the message log), the records programs append (threads, nodes,
emissions), and trees at the points something references them. Blocks are
not only dag-cbor: git objects (`git-raw`), wasm modules (`raw`), and bitcoin
data under their own hashes (dbl-sha2-256), decoded the IPLD way (#42,
`kernel-zig/src/bitcoin.zig`, after IPLD's bitcoin codecs, with bitcoind's
field names) — typed nodes with links:

| codec | bytes | node |
|---|---|---|
| `bitcoin-block` (0xb0), CID = block hash | an 80-byte header | `{version, previousblockhash → link(bitcoin-block) \| null (genesis), merkleroot → link(bitcoin-tx), time, bits, nonce}` |
| `bitcoin-tx` (0xb1), CID = txid | a transaction | `{version, vin: [{txid → link(bitcoin-tx), vout, script, sequence} \| {coinbase, sequence}], vout: [{value, script}], locktime}` |
| `bitcoin-tx` (0xb1), CID = merkle hash | exactly 64 bytes, left ‖ right | a merkle node `[left → link, right → link]` |

`putblock` takes the raw bytes and checks their hash; the decode is how the
kernel reads them. The 64-byte case is IPLD's convention: a merkle node
lives under `bitcoin-tx` (the tree's leaves are transactions), told apart by
its length. A 64-byte transaction would be ambiguous; it is malformed by
consensus-adjacent convention (Core refuses them, CVE-2017-12842), so 64
bytes always reads as a node. The header's merkle root names the root node
and each node its children, so a block's transaction tree is a DAG in the
store, held sparsely (the paths to a wallet's own transactions), and a
merkle proof is a walk down it (docs/WALLET.md "Proofs"); a transaction's
inputs link what they spend, so the ancestry is a DAG too. Links to blocks
not held point at absent CIDs (sparse, and fine). Intermediate
trees and command output are recomputable and may be kept as cache or
dropped; nothing depends on them. Pruning is a capacity decision, never a
correctness one.

## The index: maps in the store and one state record

(Issue #30; built in the Zig kernel, `kernel-zig/src/index.zig`, `mst.zig`.)
The questions the scheduler asks — which entry is number n, which entry
admitted this message, where is this chain's tip, which threads are not
finished, which sleep until when, which await a reply to this message, what
points at this record, what tree does this head name — are answered by
**persistent maps kept as records in the store**, not by database tables.
Each query shape is its own map, keyed so that the question is a lookup, a
range or a prefix: `log` (n → entry), `unique` (message CID → entry),
`chains` (origin → tip, seq), `updates` (origin ‖ seq → update), `threads`
and `resting` (at ‖ origin), `sleepers` (until ‖ origin), `awaits`
(record ‖ at ‖ origin), `edges` (target ‖ from ‖ seq ‖ ord → rel), `heads`
(name → tree).

A map is a **Merkle search tree** of dag-cbor nodes (fan-out ~32; a key's
level is the leading zero 5-bit groups of its sha2-256). It is canonical —
the same pairs give the same root CID in whatever order they arrived — and
updated copy-on-write like a git tree: a change writes new nodes along one
path and shares every other node with the previous version, which stays
readable.

One **state record** names it all:
`{kind: "skein-state", format: 1, log: <log tip>, cursor, heads: <root>, index: {<map>: <root>…}}`
(`format` 1: every step's update carries its fuel; a store without it predates
fuel and is not run on).
Its CID is the instance's single mutable pointer; the store is otherwise a
pure key→bytes map of immutable records (SQLite today; IndexedDB in a
browser, RocksDB on a server, a chain for checkpoints). The maps are a
function of the log and the trees are canonical, so the state record is a
function of the log: two machines that consumed the same log have the same
state CID, and a bootstrap packet can ship the index for a reader to verify
rather than rebuild. Old spine nodes and old state records are prunable like
intermediate trees; the log and what live chains reach are not.

### Edges and their relation kinds

The `edges` map is who points at what: target ‖ from ‖ seq ‖ ord →
`[rel, locator?]`, from a chain (a thread or node) at an update, or from a
kept bitcoin block (seq 0). The kernel
derives them (index.zig, as sqlite.ts did) from:

| source | rel |
|---|---|
| an origin's `refs: [{to, rel, locator?}]` | the ref's own |
| an origin's `launchedBy` | `launched-by` |
| an update's `waitingOn` | `depends-on` |
| an update's `resolution` | `resolves` |
| an update's `emit` of type `launched` | `launched` |
| each record the step **kept** (`keep`) with `refs: [{to, rel, locator?}]` (#37) | the ref's own |
| each **bitcoin block** the step kept (#42): its links, from the block itself at seq 0 | `spends` (an input, locator = the vout), `prev` / `merkleroot` (a header), `child` (a merkle node, locator 0 / 1) |

A kept bitcoin block's edges are keyed `to ‖ block CID ‖ 0 ‖ ord`, like an
origin's own: they do not depend on which thread kept it or when, so a
block kept again adds nothing. The trigger is **keep**, not `putblock`: a
bare put leaves no trace in the chains, and the edges map is a function of
the chains (a rebuild from the log comes to the same root). The wallet keeps
every bitcoin block it holds (headers, transactions, merkle nodes), so "who
spent txid:vout" is a prefix scan on the transaction's CID and a locator
filter — its `spends` edges replaced the wallet's `spenders` map (one entry
per input of every held transaction, as before), and the explorer walks the
graph: header → merkle root → nodes → transactions → what they spend.

Programs read the edges with the **`edges`** call: `edges(to, rel?)` →
dag-cbor `[{from, seq, rel, locator}]` in key order (from, seq, ord). It is a
read, answered from the index (a pure function of the log) plus the links
of the bitcoin blocks the step kept so far — exactly the edges its update
will add; other kept records' `refs` appear from the next step. A kernel
`call` reads the index only.

The kept-record `refs` are how a program says what a record it keeps stands on, with the
**relation kind** that decides whether a transaction's rejection (#37,
docs/WALLET.md "Settlement") matters to it:

| rel | meaning | propagates a rejection |
|---|---|---|
| `spends` | consumes an output of the target transaction | yes |
| `admits` | an overlay admitted an output of it (#36, docs/OVERLAY.md) | yes |
| `derives-from` | built on it (an action, a draft, a record computed from it) | yes |
| `mentions` | merely names it (a message, a turn, a wallet result) | no |

Propagation happens in **derived state**, never in threads: the wallet
recomputes its maps from the records that remain (a transaction's spenders
through its `spends` edges; its own `dependents` map carries the other
kinds, for records no thread keeps), and an overlay's admitted outputs will be
recomputed the same way (#36: a rejected transaction's admittances vanish,
a rejected spend frees what it consumed; docs/OVERLAY.md). A **thread** whose history took the
transaction as input is never replayed — the log never un-happens anything.
The rejection reaches it as a new input: a `status` entry for the
transaction's CID goes to the thread awaiting that subject, which continues
from where it stands (the fork-and-continue of #12, naming a different
parent); what it believed before stays as its history. For a thread that
only `mentions` the transaction nothing happens automatically; a program
that wants to know subscribes: the wallet's `watch` op opts an identity in
to `{kind: "settlement", txid, status, reason}` messages in its `settlement`
box, which a subscription on that box routes to the program.

## Checkpoints

A checkpoint is a commit of the log and the records it reaches, pushed as a
gib head. The head's outpoint timestamps the whole instance on chain;
rebuilding at any checkpoint is replay to there. gib's git↔chain mapping is
reused between the host's store and real repositories. Checkpointing is the
irreversible-sharing line.

## From v1 to this

v1 (`MODEL.md`, `main`) has the record store, chains and tips, the tree
store, signed messages, identities through a real BRC-100 wallet, and a
scheduler with runners. To reach this model, in order: the wasm shell over
the tree-backed filesystem (brush + uutils under a WASI host in Node); the
runtime as a message-log consumer with programs as step functions;
subscriptions; time attestations; replay that re-executes. An interrupted
attempt at the runtime part is on branch `wip/runtime-v2`; its execution
service ran host bash and is superseded by the shell.
