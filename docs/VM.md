# Skein as a virtual machine

The machine as built at log format 8. `ARCH.md` is the one-page picture,
`MESSAGES.md` the wire. (The v1 model this replaced is
historical.)

## One sentence

A skein instance is a deterministic virtual machine: its storage is a
content-addressed graph, its programs execute inside it over an immutable
filesystem, its only inputs are an ordered log of entries (packages as received), and
its only outputs are messages and broadcast events. A host feeds it inputs and carries out its
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
  and updates, chains and tips: a pointer to an origin
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
compiled to WASI; the shell app's `toolset/README.md`, shruggr/skein-shell) runs in the shell over a project
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
- **Write scope by name** (#77, format 8). A head's name is `<app>/<rest>`
  and its owner is `<app>` (a bare name is its own owner; every head update
  carries `owner`). `advance` succeeds only when the name is in the stepping
  program's write scope: an app's program (its record's `app`, written by the
  install) writes `<app>/…` and nothing else; a program the genesis wired
  (no app record) writes only what the genesis's `scopes` list under its
  name (`{frontdoor: ["frontdoor/"], messagebox: ["mailbox", "outbound"],
  resolve: ["resolve/"], wallet: ["wallet/"], chain: ["chain/"]}` by default;
  `chain` since #78, the chain module wired at boot; `wallet/` since #79;
  `resolve/` since #87, its records of what it found) — a bare head name, or a
  prefix ending in `/`. An in-VM callee writes in its own scope, not its
  caller's. There are no other grants (#79: the transitional `heads` on
  program records, the alias head `<app>` and the resolve program's
  `peers` scope are gone). Anything else is `advance: <name> is outside the
  write scope of <program>`.
- The owner moves one by sending `{name, tree}` to the admin box `head`
  (`skein head <name> <tree>`): the kernel's own `head` operation (below,
  "The dispatch table") advances it — no program runs. The app's root head
  `<app>/app` is created this way at install.
- `main` is the default: `run` with no tree, and a new `chat` with no tree
  (the shell app's and the chat app's, #83), start from `main`'s tree (the empty tree if there is no `main`). The loop
  records that tree in the opening turn it keeps.
- An import sets `main` when the instance has none: the client names the root
  on the last `objects` bundle, and the kernel's `objects` operation advances
  `main` to it.

### The dispatch table, and the kernel's four tables (#77, format 8)

The kernel is the machine, four tables and the `wallet` (oracle) import.
The tables are **objects** (the store: blocks by CID, global, unowned),
**heads** (name → root, with its owner, above), the **dispatch table** and
the **address book** (`peers`, docs/MESSAGES.md). No program import reaches
a table: a step's writes are its `put`/`keep` records and the heads in its
scope; everything else is an **admin operation the kernel itself performs**
on a message at an admin box from the owner or a delegate — no program is
stepped, no elevated scope exists. The host (transports + providers + store
+ oracle) routes nothing: the dispatch table does.

The dispatch table is one chain per instance: origin `{kind: "dispatch"}`,
one update per change `{op: "add" | "remove", row, thread?, input, at}`,
the rows the updates folded in order (`kernel-zig/src/dispatch.zig`;
`src/runtime/dispatch.ts` reads it). A row:

```
{transport: "mailbox" | "http" | "libp2p" | "local", address, prefix?: true,
 sender: "*" | "event" | "session" | bytes(33), program: <program record CID> | "kernel", fn?, …settings}
```

A route, a subscription and a libp2p topic or protocol differ only in where
the address comes from: a `mailbox` row's address is a box (`*`: any box, a
mailbox instance's catch-all); an `http` row's a path (`prefix: true` for a
prefix; exact paths match first, then the longest prefix); a `libp2p` row's
a pubsub topic, or `/<protocol>` for a stream protocol. `sender` is who the
row admits: `*` anyone (an open route; it takes events too), `event`
(mailbox only, #79) events and never a message — the host's wiring into a
box (a feed's header, the broadcaster's proof, a route's admit), so a box
that takes events need not be open; a key that identity (a message's
sender, or the BRC-104 session's; the instance's own key admits its own
programs' messages, below "emit"), `session` (http only) any identity with
a session. `program` is the handler, or the
string `kernel`: an admin row, `fn` its operation. The rest is the
handler's own (static's `root` and `index`, a route's `read` op, the
install's `app`), carried to it as `match`. A row's key is (transport,
address, prefix, sender): `add` replaces the row with that key in place, else
appends; `remove` deletes it. **First match wins**, in table order; a reply
routes before any row (docs/MESSAGES.md). Replay writes the same chain. No
`local` row fires today: a provider's answer is a message, routed by its
`mailbox` row (to review).

- **The genesis carries the seed.** Every genesis gets the owner's four admin
  rows first — `{mailbox, objects | head | dispatch | peers, $owner, kernel}`
  — then its own `dispatch` (src/host/genesis.ts; the default seed: the
  reserved box the host admits into, `:ack` → the messagebox, and the
  default HTTP rows — no `run`, no `chat`: those are the shell app's and
  the chat app's rows, #83; a mailbox
  instance's: `:ack` and `*` → the messagebox), written as the chain's first
  updates when the genesis entry is processed (no `thread`). A genesis
  naming `subscriptions` or `routes` is refused. Sessions are state, but no
  table: the front door keeps them under its own head `frontdoor/sessions`
  (#68, MESSAGES.md). No `register` box: registration is application wiring
  (an application's own etc/dispatch.json, BOOTSTRAP.md).
- **The admin operations**, one per table, taken by the kernel on a message
  at a row whose program is `kernel` (validated whole, then written under
  the entry; a refusal is a log line and nothing written; replay performs
  them again from the message):
  - `objects` — `{records: [{cid, bytes}], root?}`: each block stored under
    its CID (hash-checked); `root` becomes `main` if there is none.
  - `head` — `{name, tree}`: the head advanced to a record in the store
    (owner = the name's app).
  - `dispatch` — `{op: "add" | "remove", row}`: the table changed (a program
    row's record and module must be in the store).
  - `peers` — `{op: "add", key, transport?, address? | url?, role?, handle?,
    domain?}` | `{op: "remove", key}`: the address book (`source` "admin").
  `skein head`, `bin/skein import` (objects), `skein dispatch add|remove
  [--sender key] <box> <handler>` / `skein-host dispatch <handle> …`,
  `skein-host peers` send them. No reply. **No program reaches a kernel
  table** (#87): every program emits as the instance, and no default row
  admits the instance's own key to an admin box, so a program's message to
  one (`peers`, say) finds no row — recorded, nothing runs. The resolve
  program keeps what it finds under its own name (`resolve/peers`); the
  address book changes only on the owner's messages (or a key the owner
  added as a sender on the `peers` row).
- **A row is the permission.** Who may administer is whoever an admin row
  admits: the genesis writes the owner's; delegating is the owner adding a
  row with the same operation and another sender, through `dispatch` —
  signed and logged like any entry. A message at an admin box from anyone
  else matches no row: recorded, nothing runs.
- **Registering a program** is a row to its CID. Its record (and module)
  must be in the store first: `objects` delivers them. There is no
  `subscribe` import (skein-sdk 0.3.0).
- Nothing polls for messages (#40): a message arrives at the instance's front
  door (a `sendMessage` request, appended as an entry, #68) and the front
  door's step routes it; a row added at runtime takes messages from the
  next one.
- A store whose log predates the table has none, so nothing would route:
  the runtime refuses to start it ("before format 8"). It needs a new
  genesis (no migration).

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
- the record store, read-only, by CID (`get`): global, holding a CID is the permission;
- the connected wallet's BRC-100 operations (sign, verify, encrypt, decrypt,
  derive): the oracle, answered synchronously and recorded;
- **`emit`** (#70): a signed message to a recipient the address book names —
  the one way out (below, "emit");
- the entry's time stamp, advanced by fuel (below, "The clock inside a step runs on fuel").

Not provided: wall clock, random, threads, network, host filesystem. A WASI
program with only these imports is deterministic by construction, so replay
re-executes it and gets the same tree and the same output.

The LLM-facing `bash` tool is a **wasm shell**: a bash-compatible shell
compiled to WASI (brush) running programs that are themselves WASI modules
(uutils coreutils and whatever else is registered), all over the tree-backed
filesystem. Agents keep writing ordinary shell commands; what runs them is
inside the machine and limited to the tools the instance has registered.
That is the "deterministic container with a limited toolset". The kernel
runs it (kernel-zig/src/shell.zig) from a **shell program record** —
`code: {ts: "shell"}`, its `modules` and `support` by raw CID — which the
shell app's install writes (#83; docs/APPS.md §6b): the modules are that
app's, and an instance without the shell app has no shell.

Script runtimes are two of those programs (issue #25; the shell app's `toolset/README.md`,
"Script runtimes"; the skills audit in `docs/SKILLS.md`): `qjs` (QuickJS-ng,
also `node` with a small file + stdio shim) and `python`/`python3` (CPython
3.14). A `#!` script in the tree runs under its interpreter when that is a
registered program. Python's stdlib is a support file of the shell program
(a raw block, like the modules; the record's `support.python`), mounted read-only for python processes only
at `/opt/skein/python`; it is not part of the tree and never committed.

A step function is the same idea one level up: the turn loop is a program
whose input is the thread tip and the message that woke it, and whose output
is records to append. A message out is part of the step's update: the step
`emit`s it (#70), the update lists it, and it goes out when the step ends
without error; its answer is an entry that steps the thread again (#67:
external communication is a thread).

### The ABI: preview1 modules and WASI 0.2 components

(Issue #34; built in the Zig kernel, `kernel-zig/src/component.zig`, README
"Components".) A program's `code.wasm` may be either of two binaries, and
the kernel runs both:

- a **preview1 core module**, which imports `wasi_snapshot_preview1` and the
  `skein` namespace (pointers into its memory, `f(…, out, cap) → n`, with
  `take`/`error`; `kernel-zig/src/program.zig`);
- a **WASI 0.2 component**, which targets the world `skein:kernel/handler`
  (the SDK's `wit/skein.wit`, shruggr/skein-sdk, #75). That is WASI 0.2.12's `cli`, `clocks`, `filesystem`,
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

### emit: the one way out (#70, #67)

A step never asks the world anything mid-step but the oracle. **External
communication is a thread**: the step emits a signed message, ends
`waiting` on what it expects, and the answer arrives as an entry that steps
the thread again. There is no `http` import, no `libp2p` import and no
`wasi:http` (format 6 removed them, and with them the recorded http/libp2p
calls and the host's attestation of them, #62); a program reaches the
network by emitting to a provider — the HTTP proxy, the libp2p node — whose
answer is a signed message like any other.

```
emit(message) → <cid>     preview1: skein.emit(msg, len, out, cap) → n (the CID, binary; n < 0: the error)
                          WIT:      emit: func(message: list<u8>) -> result<cid, string>
message   dag-cbor {to: bytes(33), box: text, body: bytes, subject?: <cid>}
          or an event (#65): {event: "broadcast", tx: <cid>, beef?: bytes}
```

- `to` is the recipient's identity key — never a handle (resolve it first:
  the resolve program, docs/MESSAGES.md "BRC-169 is discovery"). It goes
  out by its entry in the **address book** (the head `peers`, as this step
  leaves it); a key the address book does not name goes to the `mailbox`
  transport's middleware, the messagebox's delivery thread, which reads the
  resolve program's record of the key (`resolve/peers`, #87: a step whose
  resolve has finished may emit to the key at once) and fails "no route"
  when there is none; with no messagebox program in the genesis the emit
  fails. The instance's own identity (`self.identity` in the step's input)
  needs no entry (#79): **one app of an instance asks another** this way
  (the wallet or an overlay app sending the chain app an `ingest`; never a
  kernel admin box, which no row opens to the instance's key). It goes out by
  the host's loopback (transport `local`, address `self`), comes back as a
  `local` request signed by the instance, and routes like any message: a
  dispatch row from the instance's own key (a manifest's `$self`) admits
  it; the answer, from the instance to the instance, steps the thread
  awaiting it by `replyTo`. (An answer — a body naming `replyTo` — to the
  instance's own key goes where the address book says that key is reached
  when it says so: an instance that is its own owner, the browser page, #16,
  names its own mailbox there, and its answers to its owner are for the
  person. To review.)
  `box` is not empty and does not start with `:`. `body` is the canonical
  dag-cbor of the body record. `subject` names what the message is about
  (a transaction's CID); a provider's answer carries it back.
- The kernel builds the **message record**, signs it through the oracle
  (a recorded call, an `oracle` record, as a program's own `wallet` calls
  are), puts it and the body, lists its CID on the step's update
  (`emitted`) and returns the CID — the message's id, what a reply's
  `replyTo` names:

  ```
  {kind: "mail", op: "put", sender: bytes(33), recipient: bytes(33), box, body: <cid>,
   subject?: <cid>, nonce: bytes(16), signature: bytes}
  ```

  `signature` is BRC-169's signing (§7.2/§7.3) on skein's record: DER
  ECDSA by the sender's BRC-42 child for `[2, "metanet handles envelope"]`,
  key ID `send`, counterparty anyone, over sha256 of the dag-cbor of the
  record without `signature` — anyone checks it with the sender's key.
  `nonce` is sha256(thread ‖ step ‖ the emit's place in it)'s first 16
  bytes: two threads asking the same thing send two messages.
- It goes out **when the step ends without error** (an errored step's
  emits are dropped), by the recipient's transport (docs/MESSAGES.md, "The
  address book"): a `mailbox` recipient's by the instance's own delivery
  thread (the messagebox program, launched by the kernel: the instance holds
  its own BRC-103/104 sessions), a `local` provider's, a `libp2p`
  recipient's or the instance's own (the loopback, `local` to `self`)
  handed to the host once the step is committed (the serve frame `emit`). At a start the kernel hands over again what a waiting
  thread still awaits (a host restart loses nothing a provider had); a host
  acts on a message once. Replay re-signs from the recorded oracle answer
  and sends nothing.
- **Errors** (the call's): `emit: want {to: <33-byte key>, box, body:
  <dag-cbor bytes>, subject?: <cid>}` · `emit: the message is not dag-cbor`
  · ``emit: `to` is not an identity key (33 bytes): emit to a key, not a
  handle (resolve the handle first)`` · `emit: the box is empty or starts
  with ':' (reserved)` · `emit: the body is not dag-cbor` | `… not IPLD` |
  `… not canonical dag-cbor` · ``emit: `subject` is not a CID`` · ``emit:
  no route to <hex>: not in the address book, and the genesis has no
  messagebox program to deliver it`` · `emit: <hex> is reached by mailbox, and the
  genesis has no messagebox program to deliver it` · `emit: the oracle did
  not sign the message` · in a kernel call, `emit: a kernel call sends
  nothing (emit from a step)`.

**Awaiting the answer.** `await` the message's CID and end the step: it
ends `waiting` with the CID in `awaits`. The answer is a message from the
recipient whose body names `replyTo: <the CID>`; it steps the thread with
input `reply: {message, body, box, sender, replyTo}` (`get` the body).
Several messages, a subject (the events about it) and a deadline may be
awaited at once; whichever comes first steps the thread, which awaits again
what it still needs (a later answer to a message no longer awaited is
recorded and runs nothing). A message to a `mailbox` recipient whose
delivery gives up (its delivery thread errors) steps the thread awaiting it
with `undelivered: {message, error}`: no answer can come.

**deadline** stays, as sugar: `deadline(until_ms)` records the deadline
(`until` on the update) and, when the step ends waiting, emits `{at:
until_ms}` in box `wake` to the address book's **waker** (the entry with
role `waker`) and awaits it. The waker's answer `{replyTo, at}` steps the
thread with `woke: true`; one stamped before `at` runs nothing. Errors:
`deadline: not after the step's time`, `deadline: no waker in the address
book (an entry with role "waker")`. **A shell's `sleep`** is the same
message (#69): the kernel signs the wake-me through the oracle (the call on
the shell's waiting update, with the message in `emitted` and `awaits`),
and the waker's answer re-executes the shell from its origin, which carries
on past the sleep under that entry (no waker: the shell errors, `sleep: no
waker in the address book …`). There is no `wake` entry (format 7) and the
kernel keeps no sleepers of its own: the waker holds what it owes, and at a
start the kernel hands it again every wake-me a waiting thread still
awaits. (The index's `sleepers` map — until ‖ origin of every thread
resting with a deadline — stays as a derived read for `skein-kernel dump`;
nothing wakes from it.)

**Broadcast out is an event** (#65): `emit({event: "broadcast", tx:
<cid>, beef?: bytes})` lists `{kind: "broadcast", tx, beef?}` in the
step's `emitted` — unsigned, addressed to no one — and the host carries it
(serve frame `emit`, transport `event`); the step awaits the transaction's
CID. Its proof comes back as an event (box `chain`), its statuses as a
subscribed status provider's messages (input `message`). Since #79 the one
program that does this is the chain app's (shruggr/skein-chain); the
wallet and the overlay apps send it an `ingest` instead and await its
answers. docs/MESSAGES.md, "Broadcast out, proofs and statuses in".

**Components** (WASI 0.2) import `emit` from `skein:kernel/skein` like
every other call; the world has no `wasi:http`. `kernel-zig/test/components/
fetch.wasm` (programs/test/fetch) is the fixture: it emits a GET to the `fetch`
provider and writes the answer's body on its next step.

The program-facing contract — the address book's shape, each provider's
boxes and answers, the outbound BRC-103/104 pattern — is docs/MESSAGES.md,
"Outbound: emit, the address book and the providers".

### Calls: reading the state without an entry (#40)

Beside the one call in that writes — **admit** an entry, and the steps it
drives — the kernel has a second call in, **`call`**: run a program as a
function over the current state and return a value. It writes nothing.

- **The ABI** is the program's ordinary entry (`_start`, or `wasi:cli/run`
  for a component), so it is the same for preview1 modules and components.
  `input()` returns `{kind: "call", fn, arg: bytes, caller?, now, self:
  {handle, domain, identity}, owner, programs, peers, defaults, names,
  reads, dispatch: [<row>], pending: [entry CIDs
  admitted and not yet processed], state: <the committed state record>}`
  (an in-VM call from a step adds `step: {thread, step, entry, at}`);
  the program dispatches on `fn` and writes its result to stdout. A non-zero
  exit is the error, with the last line of stderr as its message. The
  serve frame is `{op: "call", v: {program: <CID or a genesis program's
  name>, fn, arg, caller?, now?}}` → `{ok, result | error, fuel}`; the
  browser build takes the same frame through `skein_call`.
- **No entry, no writes.** `get`, `head` and the store read as they stand;
  `put` and `putblock` keep their records in the call's write cache only (so
  a program can build a record and read it back), and `keep`, `launch`, `await`, `advance`,
  `emit` and `deadline` are refused (a call sends nothing). The oracle
  (`wallet`) is answered by the host and **not recorded**.
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
- **What calls are for** (#68). Not requests: every request is an entry
  and the front door is stepped on it ("Requests", below). A kernel call is
  for host-side reads that are genuinely not requests — the answer of a
  route that is a read of live state (the explorer: the front door's fn
  `read`, made by the host after the request's thread ended), and later
  the broadcaster's questions of an instance (#65). From a step, an in-VM
  call is how the front door calls a route handler.
- **The write cache.** The blocks a step puts before its update commits —
  the overlay's submit decodes the BEEF once into `bitcoin-tx` blocks and
  merkle nodes with `putblock` and runs SPV and the topic managers over
  them through `get` (#50, docs/OVERLAY.md) — are a cache in front of the
  store, not a different kind of execution; a kernel call's puts are the
  same cache, dropped with the call. When a cache flushes, and what it may
  forget that nothing reaches, is the store's policy (retention).

### Requests: the front door stepped on the package (#68, #66)

Every package a transport carries in is an entry, as received:
`{kind: "log", …, request: <record>, transport}` (docs/MESSAGES.md, "The
log"). Processing it launches the transport's middleware — the genesis's
`middleware[transport]`, else its front door for `http`, `libp2p` and
`local` (#70: a provider's signed message, its signature checked;
`scheduler.zig` `middlewareOf`) — as
the **request's thread**: origin `{kind: "thread", program: <middleware>,
args: {request, transport}, launchedBy: <the request record>, input: <the
entry>, at}`, a function of the entry, so the host can ask after it.

- **Its steps' input** adds the dispatch table's rows (`dispatch`, #77) and
  the genesis's `reads`, and on the first step `seen` (the entry that first admitted this very record, if the
  `unique` map holds it: a redelivered GossipSub message). They run on
  `callFuelLimit` (the budget the front door had as a call), not
  `fuelPerStep`.
- **Its answer** is its stdout. What it lists in `admit` — `{mail: <mail
  record>, body}` or `{event: <record>, box}` — the kernel routes after the
  step, under the entry that drove it, exactly as it would route an entry of
  that kind; a message, and a libp2p `p2p` event, once (the `unique` map:
  `markUnique`). A function of the step's update, so replay routes the same.
- **At rest** (`finished` or `errored`) its last update is the request's
  answer. The kernel tells the host at once (the serve frame `answer`,
  kernel-zig/README.md), mid-drain, before what the step routed runs.
- **Waiting on a thread.** Beside the threads it launched, a step may
  `await` any thread's origin CID: when that thread comes to rest (finished
  or errored) every thread awaiting it steps, under the entry that brought it
  to rest, with `resolved: [{thread, state, result, error}]` (as for
  launched threads). Awaiting a thread already at rest is refused (its
  state is there to read). This is how a request waits on work another
  request started (#66: a resubmission, a poll on the same flow).

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

Fuel accounting is a query over the log: the sum of `fuel` per thread, instance or
period (`skein-kernel fuel <db> [--since n]`), verifiable by anyone who
replays the log. Fuel does not cover host time outside the VM (oracle,
peers, providers); storage and messages are visible in the log already.

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
deadline from this clock and rests the thread on a wake-me to the waker
(#69); the waker's answer's stamp starts the next segment, its fuel counted
from zero. (Before #38: the stamp, then
+1 ns per read.)

## Messages

(Issue #40, #68, #70, #65, #69, #77; `kernel-zig/src/log.zig`, log format 8.) Skein is a
state process: the log is every package that arrived, as received, and an
entry is one of

```
entry  {kind: "log", prev, n, time, genesis | request+transport | mail | event+box}
mail   {kind: "mail", op: "put", sender, recipient, box, body: <cid>, subject?, json?,
        session?: {payload, signature, nonce, yourNonce} | nonce?, signature?}
```

- **`request`**: a package as a transport carried it in (an HTTP request, a
  GossipSub message, a stream frame), which the front door is stepped on
  ("Requests", above; the record shapes in docs/MESSAGES.md).
- **`mail`** is a message that arrived at the front door: its sender is
  proven by the BRC-104 session it came on (`session` keeps the signed
  request, so the log verifies with keys alone) or, for a message another
  instance or a provider emitted, by its own `signature` (#70, "emit"
  above); its body is a record of its own. The node host's messages arrive in
  requests, and the front door's step routes them; a host may admit one as
  an entry of its own (`admit(entry, {body})`: the browser's). The mail
  record's CID is the message's id — what the sender computes too, and what
  a reply's `replyTo` names; the same record is admitted once (the `unique`
  map). It is routed to
  the thread awaiting the message its body's `replyTo` names (a reply is from
  the identity that message was sent to), else by its dispatch row on
  (sender, box) — a kernel row is an admin operation, any other launches
  the row's program.
- **`event`** in a box: a self-validating record from the host's specific
  wiring (#29: a header from a feed; #65: a transaction's proof from the
  broadcaster), or one a front door's step routes (`:ack`, an accepted
  libp2p message, a gossiped `submit`), routed by its `subject` or by the
  first `mailbox` row from anyone on its box.
  (No `wake` entry since format 7: wakes and ticks are providers' messages, #69.)
- **`genesis`**: who the instance is, its programs, the dispatch table's
  seed, the write scopes of its genesis-wired programs, its reads.

Every request is an entry, a read's too; what a read moves is nothing. A
message leaves an instance by `emit` (above): the address book (the head
`peers`, one of the kernel's tables: seeded by the genesis with the host's
providers and the owner's mailbox, written by the kernel's `peers`
operation on the owner's messages only) names how each key is reached; for
a key it does not name, the delivery thread reads the resolve program's
record (`resolve/peers`, #87). A store in an older
format is refused (start a new store).

## Time

Time cannot be computed inside, so it is an input: the host stamps each
entry when it appends it, and inside a step the clock is that stamp plus
the fuel burnt so far ("The clock inside a step runs on fuel", above).
Sleep and deadlines are messages to the waker provider, whose answer is an
entry. A gib checkpoint can bind a state hash to a block time, which anyone
can verify.

## Threads and steps

A thread is the unit the scheduler acts on (origin = which program with
which args and who launched it; updates = where each step stopped). A step
is one run of the program on one input.

- **Every thread is launched by a record**: a step (a tool call, a subagent,
  a model call) or an inbound message (a person's opening line, a message,
  a cron event). "Top-level" means launched by a message.
- **A person is an identity.** A thread that needs a person waits on *a
  message from that identity* (the `await` import on the message it sent).
  A `replyTo` is what makes their messages resume waiting threads while a stranger's are routed to a
  handler program or refused. **Scheduling is a message to a provider**
  (#69): a program
  that wants ticks emits `{fn: "tick", every: <ms> | at: <ms>, box, body?,
  name}` to the cron provider (the address book's `cron`) and each tick comes
  back as a signed message from the provider's identity into `box`, routed
  by the instance's row for it; `{fn: "stop", name}` ends it. The
  message's entry stamp is its time, `due` which tick it is. The
  contract (shapes, answers, errors, local or remote) is docs/MESSAGES.md,
  "Scheduling". `skein-host event <handle> <box> [json]` sends a tick due
  now from the host's cron provider by hand.

A transaction's chain state (accepted, proven, rejected) is the chain
app's, under `chain/state`; every reader computes settlement from it at
read time, and a rejection is what a read sees once the chain state holds
it. Nothing is deleted: history stays, and a thread that depended on a
transaction reads its state again when the chain app answers (WALLET.md,
"Settlement").

## Routing

Routing is a **row in the dispatch table**, not a permission check made at
delivery time: `(transport, address, sender) → program` ("The dispatch
table" under "The filesystem" above, beside "Heads"). Delivery is a pure
function of the message and the rows as of that point in the log. No match →
recorded, nothing runs.

## Host

Everything that is not the machine is the host: transports + providers +
store + oracle (`ARCH.md`, "The host"). Its surfaces into the machine are
the kernel's frames: admit, answer and call in; `wallet` (the signer) and
`emit` out. There is no execution service: commands run inside. The
boundary is a wire protocol (dag-cbor frames, WASI imports), not a language
interface, so a host can be reimplemented (the browser host is one)
without the machine noticing.

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

Each instance has its own store (on the node host, one SQLite file per
instance). A program reads a record by naming its CID and can never
enumerate the store; holding a CID is the permission. Instances talk to
each other only by messages.

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
range or a prefix: `log` (n → entry), `unique` (message CID, or a libp2p `p2p` event record's CID → entry),
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
kept bitcoin transaction (seq 0). The kernel
derives them (index.zig, as sqlite.ts did) from:

| source | rel |
|---|---|
| an origin's `refs: [{to, rel, locator?}]` | the ref's own |
| an origin's `launchedBy` | `launched-by` |
| an update's `waitingOn` | `depends-on` |
| an update's `resolution` | `resolves` |
| an update's `emit` of type `launched` | `launched` |
| each record the step **kept** (`keep`) with `refs: [{to, rel, locator?}]` (#37) | the ref's own |
| each **bitcoin transaction** the step kept (#42): its inputs, from the block itself at seq 0 | `spends` (an input, locator = the vout) |

**Only transaction inputs are edges** (#42, decided 2026-09-30). A kept
header or merkle node contributes none: they stay records with forward links
(a header's `previousblockhash` and `merkleroot`, a node's two children, as
decoded), but nothing asks the reverse questions ("which header follows",
"which node has this child"), and at chain scale they would cost ~200 bytes
per header and ~4 KB per proven transaction for nothing. A proof is read
downward from the block's root (docs/WALLET.md "Proofs").

A kept transaction's edges are keyed `to ‖ block CID ‖ 0 ‖ ord`, like an
origin's own: they do not depend on which thread kept it or when, so a
block kept again adds nothing. The trigger is **keep**, not `putblock`: a
bare put leaves no trace in the chains, and the edges map is a function of
the chains (a rebuild from the log comes to the same root). The wallet keeps
every bitcoin block it holds (headers, transactions, merkle nodes), so "who
spent txid:vout" is a prefix scan on the transaction's CID and a locator
filter — its `spends` edges replaced the wallet's `spenders` map (one entry
per input of every held transaction, as before). The explorer walks the
graph by forward links, not edges: header → merkle root → nodes →
transactions → what they spend (as do packets, src/host/packet.ts).

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
only `mentions` the transaction nothing happens: settlement is state to
read, not an event to deliver — the thread reads it the next time it acts.

## Checkpoints

A checkpoint is a commit of the log and the records it reaches, pushed as a
gib head. The head's outpoint timestamps the whole instance on chain;
rebuilding at any checkpoint is replay to there. gib's git↔chain mapping is
reused between the host's store and real repositories. Checkpointing is the
irreversible-sharing line.
