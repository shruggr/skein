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

## Programs and execution

A **program** is an immutable record: its code (a WASI module), its input
schema, and the host services it may message. Threads reference programs by
CID. A **tool** is a program with a declared calling shape; the definition an
LLM sees is derived from the record.

Programs run **inside** the machine as WASI modules. The host satisfies only
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

A step function is the same idea one level up: the turn loop is a program
whose input is the thread tip and the message that woke it, and whose output
is records to append and messages to emit. `step(tip, message) → {append,
emit}` with only the imports above.

## Messages

A **message** is a record signed by an identity. It is the only way anything
enters an instance and the only way anything leaves it.

```
message { kind: "message", from: <identity key>, to?: <identity key | handle>,
          seq: n /* per sender */, at, body, refs, sig }
```

Inbound messages, in order, are the instance's entire input:

- a person's line (signed by their wallet), an envelope from a BRC-33
  messagebox addressed per BRC-169;
- a model completion, a wallet result, a chain-tracking event (broadcast
  accepted, mined with merkle path, rejected) — signed by the host service
  that produced it;
- a time attestation, signed by the host;
- configuration: subscriptions, program registrations, written by the admin
  key.

Outbound messages are the effects only the outside can do: run a model call,
sign or broadcast a transaction, send to a BRC-169 recipient, request a
timestamp. The host carries them out and the results come back as inbound
messages. Running a command is **not** an outbound message: it happens inside.

Because every input is a signed message in a fixed order, replaying the log
against an empty store reproduces the graph exactly, re-executing programs
along the way. "What did this instance see, and who told it" is a query over
the log.

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
  a model call) or an inbound message (a person's opening line, an envelope,
  a cron event). "Top-level" means launched by a message.
- **There is no `david` runner.** A thread that needs a person waits on *a
  message from that identity*. The subscription table is what makes David's
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

Routing is a **subscription**, a record written by the admin key, not a
permission check made at delivery time:

```
subscription { kind: "subscription", match: { from?, to?, kind?, … },
               handler: <program CID | "resolve-waiter">, at }
```

Delivery is a pure function of the message and the subscription set as of
that point in the log. No match → recorded, nothing runs.

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
- People, other instances and outside agents are addressed per BRC-169 and
  reached through their messagebox. Delegation (scope, spend cap, expiry,
  revocable) is BRC-169 §9.

## The shared store

The host keeps one record store shared by every instance on it. An
instance's graph is what is reachable from its own chains; it can read a
record only by naming its CID and can never enumerate the store, so gating is
by reachability. Instances talk to each other only by messages.

## What is stored

Inputs (the message log), the records programs append (threads, nodes,
emissions), and trees at the points something references them. Intermediate
trees and command output are recomputable and may be kept as cache or
dropped; nothing depends on them. Pruning is a capacity decision, never a
correctness one.

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
