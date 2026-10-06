# Skein as a virtual machine

The machine as built at log format 8. `ARCH.md` is the one-page picture,
`MESSAGES.md` the wire. (The v1 model this replaced is
historical.)

## One sentence

A skein instance is a deterministic virtual machine: its storage is a
content-addressed graph, its programs execute inside it over an immutable
filesystem, its only inputs are an ordered log of entries (packages as received), and
its only outputs are messages and events (a broadcast, or any name a host wires, #119). A host feeds it inputs and carries out its
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
  name (`{frontdoor: ["frontdoor/"], messagebox: ["mailbox"],
  resolve: ["resolve/"], wallet: ["wallet/"], chain: ["chain/"]}` by default;
  `chain` since #78, the chain module wired at boot; `wallet/` since #79;
  `resolve/` since #87, its records of what it found) — a bare head name, or a
  prefix ending in `/`. An in-VM callee writes in its own scope, not its
  caller's. There are no other grants (#79: the transitional `heads` on
  program records, the alias head `<app>` and the resolve program's
  `peers` scope are gone). Anything else is `advance: <name> is outside the
  write scope of <program>`.
- **Only an installed record has a scope** (K1, enforced). A record's `app`
  and `name` are its own claims, and any step can `put` a program record,
  so the kernel reads a scope from a record only when the owner installed
  that record: a **genesis program** (the genesis's `programs` or
  `middleware`), the **program of a dispatch row** (only the owner's admin
  messages change the table), or one **listed under `programs` in the app
  record at `<app>/app`** for the `app` it names — which writes `<app>/…`
  only (that head is the install's, or the app's own: an app can grant only
  its own scope). Any other record runs — `launch` and `call` take any
  program record (reads are global, holding a CID is the permission) — and
  writes no head: its `advance` is `advance: <name> is outside the write
  scope of <program>: its program record <cid> is not installed …`. The
  kernel looks this up at the record's first `advance` in a step, over the
  tables as they stand at that point in the log (the same on replay), and
  keeps the answer for the rest of the step
  (`kernel-zig/src/scheduler.zig` `installedAs`).
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

The kernel is the machine, four tables and the `wallet` (signer) import.
The tables are **objects** (the store: blocks by CID, global, unowned),
**heads** (name → root, with its owner, above), the **dispatch table** and
the **address book** (`peers`, docs/MESSAGES.md). No program import reaches
a table: a step's writes are its `put`/`keep` records and the heads in its
scope; everything else is an **admin operation the kernel itself performs**
on a message at an admin box from the owner or a delegate — no program is
stepped, no elevated scope exists. The host (transports + providers + store
+ signer) routes nothing: the dispatch table does.

The dispatch table is one chain per instance: origin `{kind: "dispatch"}`,
one update per change `{op: "add" | "remove", row, thread?, input, at}`,
the rows the updates folded in order (`kernel-zig/src/dispatch.zig`;
`src/runtime/dispatch.ts` reads it and matches with the same rules, both
checked against `kernel-zig/test/dispatch-cases.json`). A row:

```
{transport: "mailbox" | "http" | "libp2p" | "local", address, prefix?: true,
 sender: "*" | "event" | "session" | bytes(33), program: <program record CID> | "kernel", fn?,
 filter?: "beef", …settings}
```

A route, a box and a libp2p topic or protocol differ only in where
the address comes from: a `mailbox` row's address is a box (`*`: any box, a
mailbox instance's catch-all); an `http` row's a path (`prefix: true` for a
prefix; exact paths match first, then the longest prefix); a `libp2p` row's
a pubsub topic, or `/<protocol>` for a stream protocol. `sender` is who the
row admits: `*` anyone (an open route; it takes events too), `event`
(mailbox only, #79) events and never a message — the host's wiring into a
box (a feed's header, the broadcaster's proof, a route's admit), so a box
that takes events need not be open; a key that identity (a message's
sender, the BRC-104 session's, a libp2p peer's; the instance's own key
admits its own programs' messages, below "emit"), `session` (http only)
any identity with a session. **Every other sender is a key** (#121): the
owner's rows name the owner's key — the genesis's, or, for an image, the
key the claim brings (the claim writes the explorer row with it). #115's
`owner` symbol (the instance's owner as the kernel sees it at the request)
is gone: nothing writes it, and a row a log already holds with it is still
read that way, so such a log replays. A row is the permission: who may read the explorer is the
explorer row's sender (there is no reads table since #115). `program` is
the handler, or the string `kernel`: an admin row, `fn` its operation (or the
claim, or the host's `tick`: #130, "Billing" below).
`filter` (#121) names what the kernel's door runs on the package's content
before the entry is written ("The door", below, "Requests"): `beef`. The
rest is the handler's own (a file handler's `root` and `index`, #125; the install's
`app`), carried to it as `match`. A row's key is (transport, address,
prefix, sender): `add` replaces the row with that key in place, else
appends; `remove` deletes it. Replay writes the same chain.

**The kernel matches every transport** (#115, `dispatch.zig` `first`, one
walk): **first match wins**, in table order, among the rows of the
package's transport at its address whose sender rule takes who it is from;
a reply routes before any row (docs/MESSAGES.md).

- `mailbox`: a message (from its sender) or an event (no sender: a `*` or
  `event` row) in a box; the row's address is the box or `*`.
- `http`: the path the request names (`route`), exact rows first, then
  prefix rows, longest first; who it is from is the identity it claims
  (`x-bsv-auth-identity-key`), none without one. With no row, the kernel
  says why: no row at the path (404), a row there needs a session and none
  is claimed (401), none there takes the claimed identity (403). A
  restrictive row does not shadow a less specific one: the request falls
  through to the next row that takes it.
- `libp2p`: the topic or `/<protocol>`, exactly, from the peer's key (its peer ID); a topic no row
  is at goes to the app that subscribed it (#119, "emit" below), and a row at the topic wins.
- `local`: no row fires today: a provider's answer is a message, routed by
  its `mailbox` row (to review).

For a request the kernel hands the front door the row it matched (step
input `match`, or `refused`), never the table. Since #121 the sender is
verified **at the door**, before the entry is written ("Requests", below):
the BRC-104 session and signature of the identity the kernel matched on
for a row whose sender is not `*` (the claimed key must be the session's),
a topic message's GossipSub signature, a `local` message's own signature (a
provider's answer, a forwarded claim) or, for the loopback, its record in
the store — the transport's middleware's fn `verify`, called by the kernel. The front
door's step then answers the handshake (a request like any other: its step
writes the session) and runs the row's handler, trusting what the door
recorded (`door.verified`). Matching on the claim and then verifying it is
the same as verifying and then matching: the handler runs only when the
claim held. (A genesis written before #115 carries the front
door's `reads` and pins a front door that matched for itself; its request
steps still get `dispatch` and `reads`, and a row's `read` op is checked
against those reads in the kernel's match.)

- **The genesis carries the seed.** Every genesis that names an owner gets
  the owner's four admin rows first — `{mailbox, objects | head | dispatch |
  peers, $owner, kernel}` — then its own `dispatch` (src/host/genesis.ts; the default seed: the
  reserved box the host admits into, `:ack` → the messagebox, and the
  default HTTP rows — no `run`, no `chat`: those are the shell app's and
  the chat app's rows, #83; a mailbox
  instance's: `:ack` and `*` → the messagebox), written as the chain's first
  updates when the genesis entry is processed (no `thread`). A genesis
  naming `subscriptions` or `routes` is refused. Sessions are state, but no
  table: the front door keeps them under its own head `frontdoor/sessions`
  (#68, MESSAGES.md). No `register` box: registration is application wiring
  (an application's own etc/dispatch.json, BOOTSTRAP.md). An **image**
  (#89: the default image, BOOTSTRAP.md) names no owner and has no admin
  rows: its one kernel row is the claim row, `{mailbox, claim, *, kernel,
  claim}`.
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
  - `peers` — `{op: "add", key, transport?, address? | url?, handle?,
    domain?}` | `{op: "remove", key}`: the address book (`source` "admin").
    An entry is a key, a transport and an address (#126: no roles; a `role`
    an older client sends is not kept).
  - `claim` (#89, #127) — `{messagebox?, handle?, domain?}`, at an image's
    claim row (from anyone). **The owner is the message's sender** — the
    verified signer — never a key in the body (a body's `owner` is not
    read); a sender that is not an identity key is refused. In one step the
    sender's four admin rows are added, and (#121) the explorer row with the
    sender's key (`{http, /explore, prefix, <owner>, <the genesis's front
    door>, explore}`; #126: there is no `owner` sender symbol any more —
    every sender is a key), the claim row is removed, the head `claim` points at
    `{owner: <the sender>, messagebox?, handle?, domain?}` (what was
    claimed), and with a `messagebox` the owner's address-book entry is
    written (`source` "claim"). Refused when the genesis names an owner or
    the table has an admin row; a second claim finds no row. The instance's
    owner — the step and call input `owner` — is the genesis's, else the key
    the head `claim` names (none before the claim). Two ways it arrives:
    the owner's own message to the instance (a bare image: whoever sends the
    claim first owns it — `skein plan claim`, then `skein send`); or a claim
    the owner signed **before the instance existed**, naming no recipient —
    the one message that may name none (the mail record without
    `recipient`, signed by its sender — one of the few messages that sign
    themselves (#126 step 4: no session of the instance's carries it) —
    BRC-169's `[2, "metanet handles envelope"]`, key `send`, counterparty
    anyone, so the sender's key alone checks it) — which the host's instance manager forwards into
    a new instance as its first entry, a `local` request (`create`, #90,
    MESSAGES.md). The host signs nothing for the owner.
  `skein head`, `bin/skein import` (objects), `skein dispatch add|remove
  [--sender key] <box> <handler>` send them, and `skein plan
  install|uninstall|dispatch|peers|deploy|claim` builds them for any BRC-100
  wallet to send (#124). No reply. **No program reaches a kernel
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
  derive): the signer, answered synchronously and recorded;
- **`emit`** (#70): a message to a recipient the address book names (unsigned:
  its transport proves its sender, #126 step 4),
  or an event — an intention the runtime answers (#126: a `deadline`, a
  `fetch`) or one it acts on (a broadcast, a subscription, a beacon) — the
  way out (below, "emit");
- **`authfetch`** (#126): a BRC-104 request to a server, signed and checked in
  the kernel through the signer, a recorded call — the one direct HTTP path
  (below, "authfetch");
- the entry's time stamp, advanced by fuel (below, "The clock inside a step runs on fuel").

Not provided: wall clock, random, threads, plain network, host filesystem.
A WASI program with only these imports is deterministic by construction, so
replay re-executes it and gets the same tree and the same output (the
signer's answers and authfetch's exchanges are served from the recorded
calls).

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

A step never asks the world anything mid-step but the signer and, through
the kernel, a BRC-104 server (`authfetch`, #126 — both recorded calls).
**External communication is a thread**: the step emits a message or
records an intention, ends `waiting` on what it expects, and the answer
arrives as an entry that steps the thread again. There is no plain `http`
import, no `libp2p` import and no `wasi:http` (format 6 removed them, and
with them the recorded http/libp2p calls and the host's attestation of
them, #62). **The signature boundary is absolute** (#126): every request out
is signed by the instance's key and recorded, every answer in is signed and
admitted by a row or by the instance's own signed request it answers. A
program reaches the network by an intention the runtime answers (`fetch`:
the host signs the request with the instance's key to its HTTP proxy, whose
signed answer comes back), by a message to a service (the libp2p node, the
cron provider), or by `authfetch` (signed in the kernel).

```
emit(message) → <cid>     preview1: skein.emit(msg, len, out, cap) → n (the CID, binary; n < 0: the error)
                          WIT:      emit: func(message: list<u8>) -> result<cid, string>
message   dag-cbor {to: bytes(33), box: text, body: bytes, subject?: <cid>}
          or an event (#65, #119, #126): {event: "broadcast", tx: <cid>, beef?: bytes}
                                   {event: "fetch", method, url, headers?, body?, timeoutMs?, maxBytes?}
                                   {event: "beacon", topic, every, body} | {event: "unbeacon", topic}
                                   {event: <any other name>, …fields}
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
  `local` request as it is (unsigned, #126 step 4: the front door admits it
  as the instance's own emit, its record in the store), and routes like any message: a
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
- The kernel builds the **message record**, puts it and the body, lists
  its CID on the step's update (`emitted`) and returns the CID — the
  message's id, what a reply's `replyTo` names:

  ```
  {kind: "mail", op: "put", sender: bytes(33), recipient: bytes(33), box, body: <cid>,
   subject?: <cid>, nonce: bytes(16)}
  ```

  `nonce` is sha256(thread ‖ step ‖ the emit's place in it)'s first 16
  bytes: two threads asking the same thing send two messages. **No
  signature** (#126 step 4): a skein receives mail only where it verifies
  the sender itself — the recipient's front door on the sender's BRC-104
  session (the delivery thread's `authfetch`), or libp2p — and keeps the
  same record, so both know the message by one CID. A log written before
  #126 step 4 signed every emit through the signer (a recorded `oracle`
  call: BRC-169's `[2, "metanet handles envelope"]`, key `send`,
  counterparty anyone, over the record without `signature`); replay serves
  that call when the log holds it at that place in the step for that very
  record, and puts the signed record it was (scheduler.zig `oldEnvelope`) —
  read, never written.
- It goes out **when the step ends without error** (an errored step's
  emits are dropped), by the recipient's transport (docs/MESSAGES.md, "The
  address book"): a `mailbox` recipient's by the instance's own delivery
  thread (the messagebox program, launched by the kernel, POSTs it with
  `authfetch`: the kernel holds the BRC-103/104 sessions, #126), a `local` provider's, a `libp2p`
  recipient's or the instance's own (the loopback, `local` to `self`)
  handed to the host once the step is committed (the serve frame `emit`). At a start the kernel hands over again what a waiting
  thread still awaits (a host restart loses nothing a provider had); a host
  acts on a message once. Replay sends nothing.
- **Events are open (#119).** `{event: <name>, …}` is addressed to no one
  and signed by no one: the kernel puts a record, lists it on the update
  (`emitted`, beside the messages) and hands it to the host after the
  commit (transport `event`, address the name). The host acts on it by its
  wiring for that name, or ignores it (a log line; the step is not told):
  an event nobody wires costs a record in the log, nothing else.
  - `broadcast` (#65): `{event: "broadcast", tx: <a held transaction's
    CID>, beef?}` → the record `{kind: "broadcast", tx, beef?}` (unchanged
    from #65: the transaction proves itself). The host's broadcaster posts
    it to Arcade; the step awaits the transaction's CID, and at a start a
    broadcast still awaited is handed over again.
  - Any other name: `{event: <name>, …fields}` → the record `{kind: "event",
    event: <name>, app?: <app>, …fields}` — the emit's other fields as they
    are, and `app` set by the kernel: the `app` of the emitting program's
    record (the thread's, or an in-VM callee's) **when that record is
    installed** (#114's rule: a genesis program, a dispatch row's program,
    or one listed in its app's record at `<app>/app`). An uninstalled
    record's event — one a step put and launched or called — carries no
    `app`, and a host following events by app ignores it. An emit naming `kind` or
    `app` itself is refused. Handed over once (the host recovers by reading
    the log, not by a re-offer). Replay puts the same records.
  - `subscribe` / `unsubscribe` (#119) are **subscriptions**, and the kernel
    reads them too. `{event: "subscribe", topic, program: <role>, fn,
    filter?}` says: deliver a libp2p message on `topic` to this app's
    `program` (a role in its record at `<app>/app`) at `fn`; `{event:
    "unsubscribe", topic}` ends it. The kernel checks each as it is emitted
    (an installed app's program; a topic, not a `/<protocol>`; the role is
    the app's and `fn` not empty; an unsubscribe of the app's own
    subscription) and refuses the emit otherwise. The subscriptions are the
    fold of these records in log order — derived, never written; a
    subscription is keyed by (app, topic), and the first standing one for a
    topic delivers. An inbound message on a topic no dispatch row is at goes
    to that subscription's program and fn through the door, as a row's
    handler would; a row at the topic wins. The host's libp2p node
    subscribes the topics they take (docs/MESSAGES.md "libp2p (#51)").
  - `fetch` (#126) is an **intention**: `{event: "fetch", method, url,
    headers?: {name: text}, body?: bytes, timeoutMs?, maxBytes?}` → the
    record `{kind: "event", event: "fetch", …, thread, step, app?}` (the
    kernel adds `thread` and `step`: the request is this step's own; its shape
    is checked as it is emitted). The step awaits its CID (sk.fetch does). The
    runtime answers it as the host is wired (below, "Intentions").
  - `beacon` / `unbeacon` (#126): `{event: "beacon", topic, every: <ms ≥
    1000, ≤ a day>, body: bytes (≤ 64 KiB)}` declares once that the
    instance's libp2p node publishes `body` on `topic` every `every` ms;
    `{event: "unbeacon", topic}` stops it. Like a subscription: an
    installed app's (refused otherwise), keyed by (app, topic), folded by the
    host from the log; no answer comes. The node beats on its own clock
    (GossipSub signs each publish with its key), logs nothing per beat and
    does not subscribe the topic; a beacon stands until its app's unbeacon
    or its app's uninstall (no row of the app left). "If the server goes
    down, it will not be pinging that beacon": a true heartbeat.
  - `payment` (#130): the kernel's pay step's alone (below, "Billing"); any
    other step's emit of it is refused.
  - The events the reference host wires today: `broadcast` (Arcade),
    `subscribe` / `unsubscribe` and `beacon` / `unbeacon` (its libp2p
    node), `deadline` and `fetch` (intentions: its waker, its HTTP proxy).
- **Errors** (the call's): `emit: want {to: <33-byte key>, box, body:
  <dag-cbor bytes>, subject?: <cid>}, {event: "broadcast", tx: <cid>, beef?:
  bytes} or {event: <name>, …fields}` · ``emit: event <name>: a name is not
  empty and has no space or NUL`` · ``emit: an event's `kind` and `app` are
  the kernel's to set`` · a refused subscription (`emit: subscribe names
  its program: …`, `emit: subscribe: "<role>" is not a program of app
  <app> …`, `emit: subscribe names the function delivered to …`, `emit:
  <subscribe|unsubscribe>: topic "<t>" is not a topic …`, `emit:
  unsubscribe: app <app> has no subscription to <t> …`, `emit: <…>: the
  emitting program is not installed …`) · `emit: the message is not dag-cbor`
  · ``emit: `to` is not an identity key (33 bytes): emit to a key, not a
  handle (resolve the handle first)`` · `emit: the box is empty or starts
  with ':' (reserved)` · `emit: the body is not dag-cbor` | `… not IPLD` |
  `… not canonical dag-cbor` · ``emit: `subject` is not a CID`` · ``emit:
  no route to <hex>: not in the address book, and the genesis has no
  messagebox program to deliver it`` · `emit: <hex> is reached by mailbox, and the
  genesis has no messagebox program to deliver it` · `emit: the signer did
  not sign the message` (replaying a log before #126 step 4) · `emit: fetch: <why>` (a fetch that is
  not one) · a refused beacon (`emit: beacon: every <n> ms: from 1000 ms to
  a day`, `emit: beacon: \`body\` is the bytes published at each beat`, `emit:
  <beacon|unbeacon>: the emitting program is not installed …`) · in a kernel
  call, `emit: a kernel call sends nothing (emit from a step)`.

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

**Intentions** (#126): a program says what it wants; how it is done is the
runtime's wiring. A program has no reason to know who the waker or the HTTP
proxy is.

- **deadline**: `deadline(until_ms)` records `until` on the update and,
  when the step ends waiting, the event `{kind: "event", event: "deadline",
  at: until_ms, thread, step, app?}` — listed in `emitted` and awaited (no
  signer call, no message). **A shell's `sleep`** is the same event on the
  shell's waiting update (#69). Errors: `deadline: not after the step's time`.
- **fetch**: the `fetch` event above, awaited.
- **The answer.** The host's wrapper signs a request for the intention with
  the instance's key — the mail record `{kind: "mail", op: "put", sender:
  <the instance>, recipient: <the service>, box, body: <the event's CID>,
  nonce, signature}` — and sends it where the host is wired (the reference
  host: its own waker, box `wake`; its HTTP proxy, box `fetch`; another
  host could send it to a remote service by mailbox or BRC-104). The
  service answers with a signed message from its key whose body names the
  event (`replyTo`) and carries that request (`request`), admitted as a
  `local` request: the front door checks its signature, and the kernel
  checks that `request` is this instance's own, signed, to the answering
  key, for that event (the instance asked that key). Both are in the log.
  The thread awaiting the event steps: at a deadline with `woke: true` (one
  stamped before `at` runs nothing; a shell is re-executed from its origin
  and carries on past its sleep under that entry), at a fetch with `reply:
  {message, body, box, sender, replyTo}`, the body `{replyTo, request,
  status, headers, body}` or `{replyTo, request, error}`. Anything else
  naming the event is recorded and runs nothing.
- At a start the kernel hands over again every event a waiting thread still
  awaits (a host restart loses no timer); a host acts on one once. There is
  no `wake` entry (format 7) and the kernel keeps no sleepers of its own.
  (The index's `sleepers` map — until ‖ origin of every thread resting with
  a deadline — stays as a derived read for `skein-kernel dump`; nothing
  wakes from it.) A log written before #126 (a deadline was a signed
  wake-me to the waker, answered by `replyTo`) replays as it was written.

### authfetch: the kernel's BRC-104 client (#126)

```
authfetch(request) → answer   preview1: skein.authfetch(req, len, out, cap) → n (n < 0: the error)
                              WIT:      authfetch: func(request: list<u8>) -> result<list<u8>, string>
request   dag-cbor {url: <the server's base URL>, method? (POST), path? (/; its ?query too),
                    headers?: {name: text}, body?: bytes, timeoutMs?}
answer    dag-cbor {status, headers: {name: text}, body: bytes}
```

The kernel is the client (kernel-zig/src/authfetch.zig): the BRC-103
session with the server at `url` (the handshake at `<url>/.well-known/auth`,
kept in memory per base URL, made again when the server answers 401 or the
process restarts), the request signed BRC-104's way (the
SimplifiedFetchTransport framing: a stock server takes it), the answer's
signature and identity checked — all through the signer. The runtime only
moves bytes (the serve frame `http` the kernel asks the host: `{method,
url, headers, body, timeoutMs?}` → `{status, headers, body}` | `{error}`).
A 2xx answer must be signed; a failure from something in front of the
server may come unsigned and is returned as it is. No answer at all is a
failure whose message starts `transient: `.

The whole exchange is **one recorded call** at (thread, step, i), as a
signer call is: `{kind: "authfetch", thread, step, i, request: bytes, answer?:
bytes | error?: text, calls: [{request, result}]}` (`calls`: every signer
frame it made). Replay serves the answer or the failure from the witness
and asks no one; a differing request is a divergence. The nonces and the
request id are real randomness (replay never makes them). A kernel `call`
refuses it (`authfetch: a kernel call talks to no one`). Errors: `authfetch:
want {url, …}` and the request's other shape errors, `authfetch: this host
carries no HTTP`, `transient: …`, `authfetch: …: the answer is not signed` |
`… does not verify` | `… is from another identity than the session's`.

The messagebox's delivery uses it: a message to a `mailbox` recipient is
POSTed to `<url>/sendMessage` with authfetch (docs/MESSAGES.md).

**Broadcast out is an event** (#65): `emit({event: "broadcast", tx:
<cid>, beef?: bytes})` lists `{kind: "broadcast", tx, beef?}` in the
step's `emitted` — unsigned, addressed to no one — and the host carries it
(serve frame `emit`, transport `event`); the step awaits the transaction's
CID. Its proof comes back as an event (box `chain`), its statuses as a
subscribed status provider's messages (input `message`). Since #79 the one
program that does this is the chain app's (shruggr/skein-chain); the
wallet and the overlay apps send it an `ingest` instead and await its
answers. docs/MESSAGES.md, "Broadcast out, proofs and statuses in".

**Components** (WASI 0.2) import `emit` and `authfetch` from
`skein:kernel/skein` like every other call; the world has no `wasi:http`.
`kernel-zig/test/components/fetch.wasm` (programs/test/fetch) is the
fixture: it records a `fetch` intention for a GET and writes the answer's
body on its next step.

The program-facing contract — the address book's shape, each provider's
boxes and answers, intentions, delivery to a messagebox (authfetch) — is docs/MESSAGES.md,
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
  `emit`, `deadline` and `authfetch` are refused (a call sends nothing). The signer
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
  and replay re-runs it with the step. The callee writes in its own scope
  ("Heads"): a callee record the owner did not install has none, so a call
  runs any program but lends no scope — not the caller's, and not one its
  record claims. A step sees its own head moves: a
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
  the records a handler builds and reads back through `get` (a submission
  framed with off-chain values, which the door does not take as a BEEF,
  is decoded by the overlay into `bitcoin-tx` blocks and merkle nodes
  there, #50, docs/OVERLAY.md) — are a cache in front of the
  store, not a different kind of execution; a kernel call's puts are the
  same cache, dropped with the call. When a cache flushes, and what it may
  forget that nothing reaches, is the store's policy (retention).

### The door: read-only, before anything is logged (#121)

A request's entry is written only after the **door** has run, in the
kernel's admission path (`scheduler.zig` `door`, `door.zig`), reading and
writing nothing but blocks:

1. **The row.** The kernel matches the package's dispatch row (#115).
2. **The sender.** The transport's middleware verifies who the package is
   from: a kernel call of its fn `verify` with the package (the genesis's
   `middleware` per transport — the front door: BRC-104 for http on a row
   that is not open, GossipSub's signature for a libp2p topic message, the
   message signature for a `local` package). It answers `{ok: true,
   verified?}` — `{caller, theirs, requestId}` for http, `{key}` for libp2p —
   or `{refused: {status, code?, reason}}`. A handshake is a request like
   any other: the door passes it and its step writes the session.
3. **The filter.** The row's `filter` setting names what the door runs on
   the package's content. For a `local` package (a message the host carried
   in) the row is the message's own: its `mailbox` row on (sender, box),
   none for a reply.
4. **The outcome is logged either way.** The admission: the entry names the
   package as the door hands it back and carries `door: {verified?,
   filter?, beefs?: [<pointer record>], bodies?: [{of, is}]}`. Or a
   refusal: `refused: {stage: "middleware" | "filter", reason, status,
   code?}` beside the package as far as the door got — a stored entry, as
   every refused request is, and **nothing runs** (no thread; a waiting
   client gets the refusal at once: `status`, and `{status: "error", code,
   description: reason}`; a libp2p message is `reject`, `ignore` when the
   instance cannot judge it). Only then does the row's program run, as
   the request's thread, trusting `door.verified` (an entry written before
   the door has none, and its step verifies as before). A row with no
   `filter` logs the package as received.

A middleware with no fn `verify` (a front door pinned before #121) gets
the package as received: no `door`, no filter, and its step verifies.

**The door is lossless for anything a signature covers.** What a filter
rewrites must be reconstructible to the exact bytes, so a reader of the log
(replay, an auditor) can put them back and re-check the signature: the
`beef` filter's encoder sits beside its decoder. A carried message's mail
record is never rewritten (its CID is the message's id, and a signature, if
it has one, covers its body's CID): the door puts the rewritten body beside it
(`door.bodies`, `{of: <the body the record names>, is: <the body put>}`)
and the kernel routes the message with that one; restored, it is the body
the record names. Decryption of a body encrypted to the instance is **not**
a door job: it stays a recorded signer call inside the step, so the
ciphertext and its signature stay in the log.

**The `beef` filter** — the one way a BEEF enters a skein, whatever the
route (an overlay's `/submit`, a payment in a mailbox, a Metanet delivery,
gossip, the chain app's own `ingest`). It walks the package's byte-string
values (an http body, a libp2p message's body, a carried message's body
fields: through maps and arrays) and takes those that start with a BEEF
pattern (`beef.zig` `patterns`, a table: BEEF V1 `01 00 be ef`, V2 `02 00
be ef`, Atomic BEEF `01 01 01 01` + txid, Outpoint BEEF `16 a7 be ef` +
txid + vout, BRC-62/96/95/158). For each:

- it decodes the BEEF; one that does not decode is a refusal;
- it checks **every BUMP** against the headers in the chain app's state
  (`chain/state`, read only: the header at the BUMP's height, its merkle
  root): a BUMP that does not give that root, a height with no header, a
  transaction marked with a BUMP that does not hold it — a refusal; no
  `chain/state` (no chain app, or one that has seen no header) — a refusal,
  saying so. A transaction no BUMP proves enters as unproven (SPV and status
  are the chain app's);
- it stores each transaction **once** as its `bitcoin-tx` block (CID =
  txid), each BUMP as the raw block of its bytes and the merkle nodes it
  reveals (a block the store holds is not written again);
- it puts the **pointer record** where the bytes were, a link:

```
{kind: "beef", form: "beef" | "atomic" | "outpoint", version: 1 | 2,
 subject: <bitcoin-tx CID>,             the Atomic/Outpoint BEEF's txid, else the last transaction
 vout?: int,                            an Outpoint BEEF's output
 txs: [<bitcoin-tx CID>, …],            every transaction in wire order (a V2 txid-only one too)
 marks: [<bump index> | null | "txid"], per transaction: what the wire says beside it
 bumps: [{height, path: <raw CID: the BUMP as received>,
          block: <bitcoin-block CID: the header checked> | null, proves: [<tx index>]}]}
```

A refusal still stores what decoded (the entry names the pointer record:
the bytes are reconstructible), but no merkle nodes. The encoder — the
exact wire bytes from the record and its blocks — is `beef.zig` `encode`
in the kernel, skein-sdk's `chain.record.beefOf` for programs (the chain
app's `ingest`, the overlay's gossip), `src/runtime/beef.ts` on the
host's side.

### Requests: the front door stepped on the package (#68, #66)

Every package a transport carries in is an entry — since #121 as the door
hands it back: `{kind: "log", …, request: <record>, transport, door? |
refused?}` (docs/MESSAGES.md, "The log"). Processing it launches the transport's middleware — the genesis's
`middleware[transport]`, else its front door for `http`, `libp2p` and
`local` (#70: a provider's signed answer or a forwarded claim, its
signature checked; the loopback, this instance's own emit, its record in the store;
`scheduler.zig` `middlewareOf`) — as
the **request's thread**: origin `{kind: "thread", program: <middleware>,
args: {request, transport}, launchedBy: <the request record>, input: <the
entry>, at}`, a function of the entry, so the host can ask after it.

- **Its steps' input** adds the dispatch row the kernel matched for the
  request (`match`, #115; for http with no row, `refused`: `path`,
  `session` or `sender`; "The dispatch table" above), and on the first step `seen` (the entry that first admitted this very record, if the
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
replays the log. Fuel does not cover host time outside the VM (signer,
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
deadline from this clock and rests the thread on a `deadline` event (#69,
#126); the answer's stamp starts the next segment, its fuel counted from
zero. (Before #38: the stamp, then
+1 ns per read.)

## Billing (#130): the skein meters itself and prepays its host

(`kernel-zig/src/billing.zig`, `scheduler.zig` "billing"; the host's side:
`src/host/billing.ts`, scripts/host/README.md "Billing".) A hosted skein
pays for its own hosting from its own wallet. The kernel meters what is in
its log; the host meters what never reaches it and reports it on a signed
tick; the kernel prepays the host block by block, and every payment
checkpoints the state on-chain. Nothing here runs without a host row: a
skein with none is not billed and behaves as it did.

**The host row** is the owner's grant of a host and its rates — a kernel row
of the dispatch table, written with an ordinary `dispatch` admin message
(`skein plan host`), updated or removed the same way:

```
{transport: "mailbox", address: "billing", sender: <the host's key>, program: "kernel", fn: "tick",
 x: <sats>, rates?: {fuel, storage, served, fetch, authfetch, publish}}
```

The first such row in table order is the host's (`billing.zig termsOf`); its
sender must be a key and `x` a whole number of sats ≥ 1, each rate a whole
number ≥ 0 (a missing one is 0: free). `x` is the block the skein prepays at
a time. The rates:

| rate | sats per | metered |
|---|---|---|
| `fuel` | 10^9 fuel | every step's fuel (a request's thread, a handler, a shell segment, the pay step itself); the host's read calls (on its tick) |
| `storage` | 10^6 bytes held for a day | at each tick, for the time since the last |
| `served` | 10^6 bytes the host served | on the host's tick |
| `fetch` | `fetch` intention | each one a step that ended without error recorded |
| `authfetch` | exchange | each recorded authfetch call |
| `publish` | libp2p publish | each message to the libp2p provider in box `publish`, or to a `libp2p` recipient at `topic:<name>` |

Other events (`deadline`, `subscribe`, `beacon`, …) are not metered.

**The billing state** is the head `billing`, written by the kernel alone: an
owner's `head` message naming it is refused, and so is every program's
`advance` (`billing` is a reserved app name too). Its record:

```
{kind: "billing", host: bytes(33), allowance: <sats>, paid: <sats>, tally: <nanosats>,
 lastTick: <ms>, ticks, tick: <the entry of the last tick>, bytes: <the store's size measured there>,
 payments, asleep: bool}
```

Allocation = (allowance + paid) sats; consumed = the tally (nanosats inside,
so a cheap rate still counts).

**The tick** (the kernel operation `tick`, at the host row): a message from
the host's key, signed by it (the door checks the signature, as a
provider's), in the row's box — `{kind: "tick", at: <the host's ms>,
allowance: <sats>, fuel: <its read calls' fuel since its last tick>, served:
<bytes served since>, log?: <the CID of its log record for the period>}`.
The host's first tick starts the state: its `allowance` (the host's free
allowance for this skein) is the allocation, `at` the last tick, its amounts
on the tally. Each later one charges storage — the store's bytes, measured
now (the backend's pages in use), for `at − lastTick` — and the host's
amounts, at the row's rates, and advances `lastTick`. A tick from another
key than the first tick row's is refused, as is one with a time before the
last tick's and one while asleep; a tick from a key with no row matches no
row (nothing runs). A tick from another host's key, once the owner moved
the row to it, starts a new state for that host. The measurement is an
input: a replay is served the source's measurement for that tick (the
witness reads the billing head's records), as it is a signer's answers.

**The meter**, after each entry is processed (`billingAfter`): what the
entry used — its steps' fuel, its billable events — at the row's rates goes
onto the tally, written under the entry (once). A function of the log, so a
replay writes the same.

**The pay step** (decided 5, 6): when the tally reaches the allocation, the
kernel launches a thread of the genesis's wallet program itself, under the
entry it processes —

```
{kind: "thread", program: <genesis programs.wallet>, args: {pay: {to: <the host's key>, x, checkpoint: <cid>}},
 launchedBy: <the entry>, input: <the entry>, at, nonce: "pay.<i>"}
```

— and runs it now. The wallet pays the host X, or everything it has (less
the fee) if that is less, to a BRC-29 key derived for the host
(counterparty the host's key), in one transaction whose other output, 0
sats, is `OP_FALSE OP_RETURN <checkpoint>`; it emits the transaction as the
event `payment` — `{kind: "event", event: "payment", txid: <bitcoin-tx>, tx:
<Atomic BEEF>, outputIndex, amount, to, remittance: {derivationPrefix,
derivationSuffix, senderIdentityKey}, checkpoint, thread, …}` — and ingests
it at the chain app as any transaction it builds. The kernel reads the
payment off the step (the output at `outputIndex` must carry `amount`, an
output of 0 sats must commit the checkpoint) and adds it to `paid`; while
the tally is still at the allocation it pays again (at most
`billing.MAX_PAYS` in one entry). No app can start, stop or alter it: only
the kernel launches a thread whose `launchedBy` is the entry it processes
(a launched thread is launched by a thread), the wallet refuses `pay`
otherwise, and the kernel refuses an emit of `payment` from anything but
that thread's own first step (`emit: payment: only the kernel's pay step
emits it`). The host is the payee: what it does with the event (keep it,
broadcast it) is its wiring.

**The checkpoint** is the state record as it stood when the entry before
the triggering one had been processed (`store.processedState`): the maps as
committed then, the log and its unique keys cut back to that entry (a host
admits ahead of processing). It is a function of the log up to that entry,
so a replay — which appends the whole log first — computes the same CID;
nothing is written for it (a store that had admitted no further committed
that very record).

**Asleep** (decided 8): when the tally is at the allocation and the pay
step pays nothing (an empty wallet, coins that do not cover the fee, no
wallet program in the genesis), the state is `asleep`. The host then
forwards nothing but payments and the instance's own messages to itself; the
kernel meters nothing (the tally freezes) and refuses ticks, and after each
entry it processes it runs the pay step again: one that pays wakes it
(`lastTick` moves to that entry's time, so the time asleep is not charged).

**Funding** (decided 7) is the wallet's: the default image's row
`{http, /wallet/fund, *, wallet, fund, filter: "beef"}` takes an Atomic BEEF
(the door's `beef` filter validates it: no signature) with BRC-100
internalizeAction's outputs in the header `x-skein-outputs`; the wallet's fn
`fund` internalizes it and ingests it at the chain app. A funding whose
transaction the chain app has not taken yet cannot be spent in a BEEF: the
pay step then pays with the coins the chain state holds, or nothing yet, and
the next entry (the chain app's ingest) tries again.

## Messages

(Issue #40, #68, #70, #65, #69, #77; `kernel-zig/src/log.zig`, log format 8.) Skein is a
state process: the log is every package that arrived, as received, and an
entry is one of

```
entry  {kind: "log", prev, n, time, genesis | request+transport (+ door | refused, #121) | mail | event+box}
mail   {kind: "mail", op: "put", sender, recipient, box, body: <cid>, subject?, json?,
        session?: {payload, signature, nonce, yourNonce} | nonce?, signature?}
        (#127: a claim, box `claim`, may name no recipient: signed before the instance existed, forwarded into it)
```

- **`request`**: a package as a transport carried it in (an HTTP request, a
  GossipSub message, a stream frame), which the front door is stepped on
  ("Requests", above; the record shapes in docs/MESSAGES.md).
- **`mail`** is a message that arrived at the front door: its sender is
  proven by the transport it came on (#126 step 4) — the BRC-104 session
  (`session` keeps a client's signed request, so the log verifies with keys
  alone; another instance's emit is kept as it emitted it, its proof the
  request entry it came in), libp2p (the peer) — or, for a host provider's
  answer and a forwarded claim, by its own `signature` (#70, #127); its body
  is a record of its own. Every host's messages arrive in requests, and the
  front door's step routes them: `admit` refuses a `mail` entry (K2) — a
  message is never the host's word. A provider's answer comes in as a
  `local` request `{kind: "message", message, body}`, its signature checked
  by the front door; the browser page's own messages come as `http`
  requests on its session with its instance (#126 step 4: it admits nothing
  from its mailbox instance, which is the user's). A `mail` entry
  in a log written before that still processes on replay. The mail
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
  (No `wake` entry since format 7: wakes and ticks are providers' signed messages, #69, #126.)
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
Sleep and deadlines are intentions the runtime keeps (#126: the `deadline`
event), and their answer is an entry: the waker's signed message. A gib checkpoint can bind a state hash to a block time, which anyone
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
store + signer (`ARCH.md`, "The host"). Its surfaces into the machine are
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
