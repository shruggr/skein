# Architecture

The one-page picture, as settled with David on 2026-09-25 and revised by
issue #40: **the instance is an HTTP server; BRC-169 is discovery;
BRC-103/104 is the network; messages are state.** Where `VM.md` talks about a
"host" with services beside the runtime, this note supersedes it: there is no
such layer.

## The runtime is the whole system

The skein runtime is the only thing that communicates into or out of an
instance. Its edges are:

1. **Messages** — in through the instance's front door (BRC-33 on a
   BRC-103/104 session: the session proves the sender), out through its own
   messagebox program as an HTTP client. This is the only channel for another
   party's word.
2. **The wallet** — the instance's oracle, for signing, verifying,
   encrypting, decrypting and deriving. Keys never enter the runtime.
3. **HTTP** — the `http` import: a recorded call (request and response on the
   step's update), how delivery and discovery reach the network.

Everything else that looks like an input — a model completion, a tree of
files, a person's line — is a message from another identity, proven by its
session.

The host's side of these edges is small: it admits the entries a front door
returns, feeds (headers, proofs, statuses), and wakes; it answers `wallet` and
`http`; it calls the front door with each HTTP request. `MESSAGES.md` has the
message path end to end.

Time and randomness are different: they are not another party's statement
inside a message. When the host admits an input it reads its clock and writes
the time into that log entry ("this arrived at *t*"; `MESSAGES.md`; since
#33 the entry is not signed: the stamp is the environment's word, and the
sequence is the order).
Inside the machine, "now" is the entry's time plus the fuel the step has
burnt so far at one nanosecond per unit, and never the same value twice
(so time always moves forward and never backwards; issue #38, Zig kernel —
the frozen TS runtime still advances one nanosecond per read),
and random bytes are a stream keyed by the entry's CID — no seed is recorded,
because a recorded seed is exactly as visible as a derived one. Nothing
inside the machine may use that randomness for secrets; the wallet does
that, with real entropy, on the other side of the boundary. A program
that sleeps rests until an input stamped at or after its deadline arrives.
Nothing inside ever asks outside for time. Replay reads the stamps back, so
it is exact; the checkpoint signature covers them all at once. (An earlier
version of this note had a signed clock peer; it was signing the runtime's
own word, and is gone.)

Inside the runtime:

- the **store**: records (skein records, git-shaped file objects), chains,
  the tip index;
- the **scheduler**: consumes the message log in order, routes by
  subscription (the subscriptions chain), steps programs;
- **programs**: WASI modules stepped by the scheduler, with imports only for
  the virtual filesystem, the store by CID, heads, the wallet, `http`, and
  `call` (another program's function, in the VM); nothing emits: a program
  that sends a message calls the messagebox program, which delivers over
  `http`;
- **calls**: a program's function run over the current state with no entry
  and no writes — how the host asks the instance anything (the front door is
  one: `docs/VM.md`, "Calls");
- the **virtual filesystem**: trees from the store, seen through WASI; the
  wasm shell and its tools run over it. It is the only filesystem the runtime
  has.

The runtime has no access to a disk, a network, a clock or a process table.
Nothing in its code imports `node:fs`, `node:child_process` or `fetch`
(`http` is answered by the host, recorded, replayed). The
"WASI host" — the code that satisfies a module's imports — is *inside* the
runtime; it is not a host in any other sense.

## Everything outside is a peer

Anything that acts on the world is a **peer**: an identity that exchanges
messages with the runtime, proven by its BRC-104 session. The runtime cannot tell, and does not care,
whether a peer is a process on the same machine or a service across the
network. Peers include:

- **David's client** — runs as David on his desktop. It scans a directory
  into tree objects and *sends* the tree to the instance's front door; sends
  his prompts; reads pages and spoken lines from his mailbox instance; signs
  with his wallet. It is a peer, not part of skein.
- **inference** — a peer that turns a prompt message into a completion
  message (ripper's vLLM behind it).
- **a machine** — a peer that receives "run this on the host" and answers
  with the signed result. This is the sysadmin path and the toolchain path
  (`go build`, `npm test`): the command runs outside, the result is a
  recorded input.
- **mailbox instances** — an identity outside the host (David's wallet, the
  inference peer, a browser tab) has its mail kept by an instance of its own
  with only the front door and the messagebox (`MESSAGES.md`, "Mailbox
  instances").
- **other instances** — peers like any other, on this host or another.

Who an instance can reach is its **peer table** (head `peers`), written only
by its own programs: a BRC-169 resolve (the resolve program), the owner as
admin (box `peers`), a claim a peer sent (box `register`), checked by a
resolve. The host never seeds it; the one peer a genesis names is the owner
(`etc/config.json` `owner.messagebox`).

A peer may be a thin proxy that receives messages and runs things on a real
host; what makes that acceptable is that its result is signed by the peer's
identity and enters the log as a message. The runtime's record of the world
is exactly the set of messages peers sent it.

## How a file gets in and out

In: a peer (the client) hashes a directory into git blob and tree objects,
sends them (box `objects`), and sends a message naming the root CID. The runtime stores the
objects and the message; a thread's working tree is that CID. A message that
names no tree starts from the instance's `main` head, which only an explicit
act moves (`VM.md`, "Heads").

Out: a thread's result names a tree CID. A peer that wants bytes on a disk
fetches the objects and materializes them, or pushes them as a git commit
through gib. The runtime never writes to a disk.

## The router (issues #33, #40)

The host is a **router**: a reverse proxy in front of instances that are HTTP
servers. The kernel's surface is small: out go `wallet` (the signing oracle)
and `http`; in come **admit an entry and run the step**, and **call a
function** (no entry, no writes).

- **Transport** ends at the instance: each has an origin of its own,
  `http://<handle>.localhost:<port>` (or `/@<handle>` on the router's own
  origin, for our clients). The router picks the instance by the URL — routing
  comes before authentication, because a handshake does not name its
  recipient — and forwards the request as one kernel `call` of the instance's
  **front door** (`programs/frontdoor`), which runs BRC-103/104 against the
  session records in the instance's state, routes by its routes table
  (`etc/routes.json`), checks its reads table (`etc/reads.json`), calls the
  handler and signs the answer. The router has no auth state and keeps no
  mail. The stock AuthFetch (one session per origin, handshake at
  `<origin>/.well-known/auth`) is served by the host-name form.
- **Writes and reads.** A handler that writes returns entries for the router
  to admit (a message, an acknowledgement, a session); a read returns an
  answer and nothing else — ten thousand polls write no entry and no byte.
  `MESSAGES.md`, "The persistence rule".
- **Mailbox instances**: an identity outside the host gets an instance of its
  own for its mail (`skein-host add <h> --mailbox --owner <key>`, or a signed
  `POST /account/register {username, identityKey, signature}`).
- **Delivery** is the instance's: its messagebox program sends over the
  kernel's `http`, on its own BRC-104 session with the recipient's front door.
  The router answers a URL of its own in process (no socket) and sends any
  other out.
- **Discovery.** The router publishes BRC-169 for its instances
  (`/manifest.json`, `/.well-known/metanet-handles/resolve`: `{identityKey,
  messagebox}`) and the paymail PKI; an instance looks others up with its
  resolve program. BRC-169 is discovery only.
- **The fuel ledger**: every front-door call's fuel is charged to (instance,
  caller, op) in host.db (`fuel_ledger`; `skein-host ledger`).
- **Feeds** (`src/host/feeds.ts`): the router holds long-lived subscriptions
  an instance declares in its config (`etc/config.json` `feeds`, carried by
  the genesis) — an SSE header stream (`{kind: "headers", url}`) and ARC's
  status callbacks (`{kind: "arc-callback", token?}` at `POST
  /callback/<handle>`) — and admits each item as a plain `header` / `status`
  entry (`Router.admitEvent`) through a bounded per-instance queue; SSE
  reconnects with backoff. It judges nothing: the instance's chain tracker
  validates.
- **Hydration**: an instance is a kernel the router can load
  (`src/host/kernel.ts`: `skein-kernel serve` over the instance's store,
  length-prefixed dag-cbor frames on stdin/stdout). The router starts it on
  demand and stops it when it has been idle `SKEIN_IDLE_MS`; recovery after an
  environment failure happens at hydrate time from the log (a thread whose
  step was cut off runs again; a deterministic error is recorded and never
  retried).
- **The waker** is the router's timer: the kernel reports its sleepers; the
  router keeps each instance's earliest deadline, and when it comes it
  hydrates the instance and admits the wake.
- **The oracle** (#18): one master secret (`$SKEIN_HOME/master.key`), a
  per-instance root key derived from it with BRC-42/43 (`[2, "skein
  instance"]`, key ID = the handle, self), a ProtoWallet each
  (`src/host/oracle.ts`) answering the kernel's `wallet` import in process.
  Provisioning an instance is picking a handle (`skein-host add`).
- **No host key** (#9): entries are unsigned — the sender signed its request
  (kept in the mail record), `prev` fixes its place, the stamp is the
  environment's word. Time (#10): the router stamps each entry at admission;
  the sequence is the order.
- **Format 3** (#40): `{kind: "log", prev, n, time, genesis | mail | wake |
  event+box}`; a message is its mail record, and the record's CID is the
  message's id. `kernel-zig/src/log.zig` has the shapes.

## Bootstrap (issue #4)

An instance boots from a **system tree**: `bin/*.wasm` handlers (or their
CIDs), `etc/config.json` and `etc/subscriptions.json`, and its own files. The
loader (`src/host/boot.ts`) pre-fills the store with the tree's objects and
writes the genesis from it. The genesis names the tree, and processing it sets
`main` there. The front door's routes and reads come from `etc/routes.json`
and `etc/reads.json` (else the stock ones). There is one loader and it takes two sources: a directory
(`skein-host add <h> --boot <dir>`) or a chain packet, which is a BEEF bag plus
a scope, verified offline (`--packet`, `src/host/packet.ts`). A packet whose
scope is a state record is a checkpoint: it is restored, and its index is not
rebuilt. Rows without a tree get the stock system in code, through the same
writer. See `docs/BOOTSTRAP.md`.

## The browser as a host (issue #35)

The same Zig kernel compiled to wasm (`kernel-zig`, `zig build web`) runs in a
browser tab: in a Worker, programs on V8 with fuel counted by instrumentation
(the same numbers as wasmtime's), the store in IndexedDB. A browser deployment
is a skein host with a front end (#16): the page is the instance's router, for
one instance whose identity is the connected wallet's (Yours) — user, instance
and host are the same identity on three separate interfaces
(`web/kernel/host.ts`):

- **out**: `wallet` → the page's BRC-100 wallet; `http` → fetch: the
  instance's messagebox program delivers its messages itself (a BRC-104
  client) and its resolve program looks handles up.
- **in**, the same one call: the page's chat (a message from the user,
  admitted directly), a poll of the page identity's mailbox instance on the
  host (registered by the page, `listMessages` on a BRC-104 session, each
  message admitted, acknowledged once durable), and a timer for wakes.
- **intermittent**: nothing runs while the tab is closed; inbound waits in the
  mailbox instance and wakes fire late, when the page is next open.

The proof page is `web/kernel/` (no framework; `node web/kernel/serve.ts`,
cross-origin isolated). Easel (#16) builds on this.

## Overlay services (issue #36)

An instance can be a BRC-22/24 overlay node, served by its own front door:
its `etc/routes.json` names the overlay engine's route handlers (`POST
/submit`, `POST /lookup`, overlay-express's listing and documentation
routes, all open). A submit is the one write: the handler checks the BEEF
against the held headers as a read and returns the `submit` entry to admit
(the `overlay` program, stepped, launches the topic managers and records their
judgements); the answer is a `then` call reading the STEAK back. A lookup is
a read: an in-VM call of the lookup service's program. What topics admit is
kept as index maps in the same state record as the wallet's (wallet-zig
`overlay.zig`), so a transaction's settlement (#37) is one thing for both: a
rejection makes its admittances vanish. See `docs/OVERLAY.md`.

## Processes on David's machines, today

- `skein-host run` — the router on `127.0.0.1:8100` (each instance at
  `http://<handle>.localhost:8100`), a- `1sat serve wallet-api` — the clients' wallets only: the dev owner (3322)
  and the inference peer (3323). No wallet per instance, no host wallet, no
  `1sat serve` messagebox (their scripts are kept, marked legacy).
- a **client** — David's terminal (`bin/skein`, raw BRC-33 on a BRC-104
  session) or the bopen-skein front end (Yours wallet): scans, prompts,
  renders, signs as David; sends to the instance's front door and reads his
  mailbox instance.
- **peers** — inference (`bin/skein-infer`, ripper behind it), each with its
  own identity and a mailbox instance here.

The v1 daemon glued a runtime and a local client into one process and let
the "skein" CLI read the disk. That is the thing this note corrects.

## The kernel, in one paragraph (added later on 2026-09-25)

Skein is a WASI machine: the runtime's import table is its kernel, and the
userland is anything compiled to plain WASI (Rust `wasm32-wasip1`, wasi-sdk
C/C++, Go `wasip1`, interpreters as modules). Programs target WASI, never
skein. Syscalls are of two kinds. **Pure** ones — files, pipes, spawn, stdio
— are answered inside, deterministically, and never recorded. **Attested**
ones — anything that leaves the runtime: the wallet, `http` (a message
delivered to a peer, a fetch, a resolve) — are recorded and replayed. A
message to a peer (inference, run-on-machine) goes out as an `http` call and
its answer comes back as a message. Time and random are pure: they derive from the
stamp the runtime wrote on the current log entry.
Request/response *is* attestation; peers all look the same from inside. A
program waiting on an recorded call is an ordinary thread at rest: the
suspended instance is its transient handle, the scheduler wakes it when the
reply arrives, and a restart re-executes it from the log. Pipeline stages are
threads too; their records are recomputable cache. Which syscall is bound to
what — inside, or routed out — is instance configuration in the log, so a
mock is just a binding to a bundle, and replay uses the binding the original
run used.
