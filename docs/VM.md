# Skein as a virtual machine

This is the model as of 2026-09-25, after the first build. It supersedes
`MODEL.md` where the two differ; `MODEL.md` remains the description of what
the v1 code implements until the code is reshaped to this. Reasoning behind
each decision is in the design doc
(https://claude.ai/code/artifact/25e9f57d-b1b0-452c-a523-96429fb1c64e), the
voice session it records, and the easel session of 2026-09-24/25.

## One sentence

A skein instance is a deterministic state machine whose state is a
content-addressed graph, whose only input is an ordered log of signed
messages, and whose only outputs are messages; a host executes those
messages' effects and feeds the results back in.

## Records

Everything durable is a **record**: one dag-cbor map identified by its CIDv1
(dag-cbor, sha2-256). Records are immutable and link to each other by CID.
(IPLD calls these blocks; that word is avoided here because of Bitcoin
blocks.) Origins and updates, chains and tips are as in `MODEL.md`: a chain
is an origin plus its updates, a pointer to an origin means "as it is now",
a pointer to an update means "exactly this version", and the tip index is a
rebuildable local convenience, never part of the record.

## Messages

A **message** is a record signed by an identity. It is the only way anything
enters an instance and the only way anything leaves it.

```
message { kind: "message", from: <identity key>, to?: <identity key | handle>,
          seq: n /* per sender */, at, body, refs, sig }
```

Inbound messages, in order, are the instance's entire input. They include:

- a person's line (signed by their wallet — David's by the Yours wallet
  extension), an envelope from a BRC-33 messagebox addressed per BRC-169;
- a model completion, a process's output, a wallet result, a chain-tracking
  event (broadcast accepted, mined with merkle path, rejected) — each signed
  by the host service that produced it;
- a clock tick or cron event, signed by the admin key;
- configuration: subscriptions, tools, providers, written by the admin key.

Outbound messages are effects the instance asks the host for: run a model
call, run a command, apply a patch to the filesystem, sign or broadcast a
transaction, send to a BRC-169 recipient, set a timer. The host executes them
and the results come back as inbound messages.

Because every input is a signed message in a fixed order, replaying the log
against an empty graph reproduces the graph exactly. "What did this instance
see, and who told it" is a query over the log.

## Threads, nodes, steps

Unchanged from `MODEL.md`: a thread is the unit the scheduler acts on (origin
= what to run and who launched it; updates = stop shapes); a node is a
request plus its typed emissions; a step is one model call's node; a turn is
a run of steps. Two changes:

- **Every thread is launched by a record**: a step (a tool call, a subagent,
  a model call) or an inbound message (a person's opening line, a messagebox
  envelope, a cron event). There are no parent-less threads; "top-level" means
  launched by a message rather than by a step.
- **There is no `david` runner.** A thread that needs a person waits on *a
  message from that identity*. The subscription table (below) is what makes
  David's messages resolve waiting threads while a stranger's are routed to a
  handler or refused. Cron is the same: a tick is a message from the admin
  key that a subscription routes to whatever waits for it.

A transaction is a thread whose state chain is its finality (created,
broadcast, mined with merkle path, rejected, reorged), each transition an
inbound message. A rejection moves heads and never deletes: records that
depended on the transaction (transitively, via `depends-on`) are marked
dropped and their threads' heads move back to the last record before the
dependency; the dead branch stays. The expected pattern is a thread that
waits for the finality it needs before dependent work continues; whether the
instance proceeds optimistically or gates on finality is policy, deferred.

## Subscriptions

Routing is not a permission check made at delivery time; it is a
**subscription**, a record written by the admin key:

```
subscription { kind: "subscription", match: { from?, to?, kind?, … },
               handler: <tool CID | "resolve-waiter">, at }
```

Delivery is a pure function of the message and the subscription set as of
that point in the log. No subscription matches → the message is recorded and
nothing runs. This is what keeps replay deterministic.

## Runtime and host

The runtime holds exactly two surfaces:

1. **Messages** in and out, as above.
2. **The BRC-100 wallet interface** of its connected wallet: sign, verify,
   encrypt, decrypt, derive, create and internalize actions. Keys never enter
   the runtime; every operation goes through the wallet. This is how records
   can be stored encrypted and read back inside the instance.

Everything else is the **host**. The host executes outbound messages, signs
the results, and delivers inbound messages. Its services:

| service     | in                                   | out                              |
|-------------|--------------------------------------|----------------------------------|
| graph       | the record store (shared, see below) | —                                |
| inference   | model completions, signed            | model calls                      |
| execution   | process output, exit codes           | commands; filesystem patches     |
| wallet      | results                              | sign, broadcast, derive          |
| messages    | envelopes (BRC-33), person's lines   | BRC-169 sends                    |
| chain       | finality events with merkle paths    | —                                |
| clock       | ticks, cron events (admin-signed)    | timers                           |

The host's own configuration — which endpoint `ripper` names, the credential
for a service that does not speak wallet auth, where the filesystem is — is
host-side and invisible to the instance. A provider name in a message is a
routing label. In the target state the wallet is the only secret.

The host/runtime boundary is a **wire protocol** (signed dag-cbor messages),
not a language interface, so the host can be reimplemented (Go, another
machine) without the runtime noticing. The first host is Node/TypeScript.

## Identity

- **One root identity key per instance.** Services inside the instance derive
  keys under it (BRC-42), so every record inside traces to the instance and
  any counterparty can verify it. An instance's first record is its genesis,
  signed by its root key.
- **Every inbound record is signed by its source**, including host services.
  A service on another machine is then just another identity exchanging
  signed messages; location is not part of the model. This is what makes
  compute distributable.
- People, other instances, and outside agents are addressed per BRC-169 and
  reached through their messagebox. Delegation (scope, spend cap, expiry,
  revocable) is BRC-169 §9 and is how an instance acts for its owner.

## The shared store

The host keeps one content-addressed record store shared by every instance
on it (git trees overlap heavily; a record is stored once). An instance's
graph is what is reachable from its own chains. It can read a record only by
naming its CID, and the host never lets an instance enumerate the store, so
gating is by reachability. Instances talk to each other only by messages.

## Tools

A tool is an immutable record: its definition and, where it runs inside the
runtime, its code (wasm). Threads reference tools by CID; tools call each
other through the same interface the scheduler uses. Which tools an instance
has is part of its message history (written by the admin key), not of the
host. File edits by a tool are expressed as patches (the ORDFS vcdiff
format), applied to the host filesystem by the execution service; the
patch is a record, so the edit is in the graph before it is on disk.

## Checkpoints

A checkpoint is a commit of the log (and the records it reaches) pushed as a
gib head. The head's outpoint timestamps the whole instance state on chain;
rebuilding the instance at any checkpoint is replay to there. gib's
git↔chain mapping is reused between the host's store and real git repos.
Checkpointing is the irreversible-sharing line: before it a record is local
and disposable, after it anyone holding it needs its ancestry.

## What v1 already is, and what changes

v1 (`MODEL.md`, the code) already has: the record store, chains and tips,
the scheduler with two triggers, runners as the effect boundary, threads
for every launch, nodes with typed emissions, one rest per node, the loop.

To reach this model: inbound events become signed messages (from runners,
from people, from the clock); subscriptions replace the `david` runner and
`~/.skein/config.json`; a thread's launch record may be a message; the
wallet becomes the runtime's second surface; the host/runtime split becomes a
wire protocol. The store and scheduler stay.
