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
(so time always moves forward and never backwards; issue #38),
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
  the virtual filesystem, the store by CID, heads, the wallet, `http`,
  `libp2p` (#51: publish, dial, send, receive, close — recorded like `http`), and
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

Who an instance can reach is its **address book** (head `peers`: key →
mailbox URL, handle optional), written only by its own programs: a BRC-169
resolve (the resolve program), or the owner as admin (box `peers`:
configuration, `skein-host peers`; up.sh and the roster step write the
owner, the inference peer and the other agents into every agent). The host
never seeds it; the one peer a genesis names is the owner (`etc/config.json`
`owner.messagebox`). Receiving is separate: the key authenticates, the
subscriptions decide. Nothing registers itself — no claims in the core; a
registration flow (a `register` box wired to the resolve program's claim
handler, or to a program with its own rules) is application wiring
(MESSAGES.md, "The address book"). A key in no address book is "no route":
the send fails once, permanently.

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
servers. The kernel's surface is small: out go `wallet` (the signing oracle),
`http` and `libp2p` (#51); in come **admit an entry and run the step**, and
**call a function** (no entry, no writes).

The router's components, each the sockets for one kind of traffic, none of
them judging anything (the instance does, through its front door):

- the **HTTP proxy** — instances' origins, the front door `call` per request,
  the kernels' outbound `http` (below);
- the **feeds** — SSE headers and ARC callbacks, admitted as plain entries
  (below);
- the **libp2p host** (#43, #51; `src/host/p2p.ts`) — one js-libp2p node per
  instance that declares `libp2p` in its config, inside the router process
  (below).

- **Transport** ends at the instance: each has an origin of its own,
  `http://<handle>.localhost:<port>` (or `/@<handle>` on the router's own
  origin, for our clients). The router picks the instance by the URL — routing
  comes before authentication, because a handshake does not name its
  recipient — and forwards the request as one kernel `call` of the instance's
  **front door** (`programs/frontdoor`), which runs BRC-103/104 against the
  instance's session table, routes by its routes table
  (`etc/routes.json`), checks its reads table (`etc/reads.json`), calls the
  handler and signs the answer. The router keeps no mail. The stock AuthFetch
  (one session per origin, handshake at `<origin>/.well-known/auth`) is
  served by the host-name form.
- **Sessions are not state.** The session table lives in memory with the
  instance's kernel process (`Kernel.scratch`, an opaque key → bytes map the
  router passes in each front-door call and updates from its answer; only the
  front door reads it) and never in the log: a message's entry carries the
  sender key, the 104 signature and both nonces, so replay needs no session.
  A new process starts with an empty table; a client's next request gets a
  401 and the stock client shakes hands again (one round trip).
  `MESSAGES.md`, "Sessions are not state".
- **Writes and reads.** A handler that writes returns entries for the router
  to admit (a message, an acknowledgement); a read returns an answer and
  nothing else — ten thousand polls write no entry and no byte, and a
  handshake writes nothing either. `MESSAGES.md`, "The persistence rule".
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
  the genesis) — an SSE header stream (`{kind: "headers", url}`), one
  connection per URL fanned out — and admits each item as a plain `header`
  entry (`Router.admitEvent`) through a bounded per-instance queue; SSE
  reconnects with backoff. It judges nothing: the instance's chain tracker
  validates.
- **The broadcaster** (#58, `src/host/arc.ts`): one Arcade per host
  (`SKEIN_ARC_URL`, `SKEIN_ARC_TOKEN`). Instances broadcast through the
  router's route — `POST /arc/v1/tx`, `GET /arc/v1/tx/<txid>`, reached by
  the kernel's recorded `http` (a new genesis names it as
  `defaults.walletArc`) — a plain proxy to Arcade under the host's one
  callback token that answers what Arcade answered (unreachable: 503, a
  transient failure the wallet re-asks at its deadline). No queue on the
  host: the wallet's `broadcast` record is the queue. The router holds **one
  SSE subscription** to Arcade for the whole host (the header feeds' SSE
  client), resumed with `Last-Event-ID` from host.db; Arcade's webhooks
  (`POST /arc/callback`, the token as bearer) take the same path. Each
  status is admitted as a `status` entry into **every instance whose state
  holds the transaction** (read, never written: the kernel's `has` of the
  tx CID, cached per txid — the asker, a sweep of every enabled instance at
  a txid's first status, then the running ones), once per txid + status +
  block hash (host.db).
- **The libp2p host** (#43, #51; `src/host/p2p.ts`): the runtime has no
  network, so libp2p is the router's too. One node per instance whose genesis
  carries `libp2p` (from `etc/config.json`: `topics`, `protocols`, `listen`),
  started at hydration, all in the router process, each with its **own peer
  key**: a secp256k1 child of the master secret (`[2, "skein instance"]`, key
  ID `libp2p:<handle>`, self — never a wallet root); the peer ID is the
  identity multihash of the compressed key, so the key reads out of the peer
  ID and `skein-host list` / `identity --peer` print it for every row.
  GossipSub with StrictSign, noise + yamux, TCP and WebSocket listeners (WSS
  with a certificate; plain WS on loopback for dev), Kademlia DHT `off |
  client | server` with topic-name rendezvous (provide and find the CID v1 raw
  sha2-256 of the topic name, as go-p2p-message-bus does), mDNS, bootstrap
  peers kept connected, circuit relays — host-wide from `SKEIN_LIBP2P_*`
  (scripts/host/README.md).
  - **Inbound through the front door.** Each GossipSub message on a
    subscribed topic is judged by GossipSub's async topic validator, which
    makes one front-door `call` (fn `libp2p`) tagged `{transport: "libp2p",
    topic, from, seqno, signature, body}` and waits on it; the front door
    verifies the signature, routes by `libp2p:<topic>`, and its handler
    answers accept | reject | ignore. The verdict is GossipSub's (accept:
    admit + forward; reject: drop, the delivering peer penalised; ignore:
    drop). Accept returns one `p2p` entry, admitted before the verdict goes
    back (docs/MESSAGES.md, "libp2p"). Reject and ignore write nothing.
    Inbound streams: per protocol, the router reads length-prefixed frames,
    calls the front door the same way (`libp2p:<protocol>`, no signature:
    the stream is Noise's) and writes the handler's answer back. The calls'
    fuel goes to the ledger (caller: the peer ID; op: the route source).
  - **Outbound, the kernel's `libp2p` import**: publish, dial, send, receive,
    close, answered here and recorded by the kernel on the step's update. A
    `receive` with no frame waiting answers `{pending}` and the thread rests;
    the frame's arrival makes the router admit the thread's wake at once
    (docs/VM.md, "libp2p").
- **Hydration**: an instance is a kernel the router can load
  (`src/host/kernel.ts`: `skein-kernel serve` over the instance's store,
  length-prefixed dag-cbor frames on stdin/stdout). The router starts it on
  demand and, by default, never stops it: instances are not stopped until
  resource contention appears (then the in-memory session table would be
  cached out). `SKEIN_IDLE_MS` > 0 stops one idle that long, dropping its
  sessions (its clients re-handshake); recovery after an
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
routes, all open). A submit is the one write (#50): the handler decodes the
BEEF once into records in its call's overlay, checks it against the held
headers and calls the topic managers on the transaction's CID, all as a
read. Only if a topic takes it does it return the `submit` entry to admit.
The `overlay` program, stepped on that entry, holds the records, records the
judgements and calls the lookup services' hooks. The answer is a `then` call
reading the STEAK back. A lookup is a read: an in-VM call of the lookup
service's program, which answers from its own maps (head `ls:<service>`),
written only through its hooks. What topics admit is kept as index maps in
the same state record as the wallet's (wallet-zig `overlay.zig`), so a
transaction's settlement (#37) is one thing for both: a rejection makes its
admittances vanish, and the services are told. See `docs/OVERLAY.md`.

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
skein. (The stock programs — the handlers, the loop, the messagebox, the
front door — are all Zig since #54; Go `wasip1` remains a userland target
for third-party programs.) Syscalls are of two kinds. **Pure** ones — files, pipes, spawn, stdio
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
