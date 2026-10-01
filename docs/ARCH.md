# Architecture

The one-page picture, as settled with David on 2026-09-25 and revised by
issue #40: **the instance is an HTTP server; BRC-169 is discovery;
BRC-103/104 is the network; messages are state.** Where `VM.md` talks about a
"host" with services beside the runtime, this note supersedes it: there is no
such layer. Revised for the boundary rework's first build (#68, #66): skein
is a **state process** — every package a transport carries in is appended
as received and the instance's front door is stepped on it; sessions are
state; a synchronous client waits on the thread. The host is a light router
that verifies nothing (the tracker, #31, "The boundary rework", has the rest
of the rework: #70, #67, #65, #69).

## The runtime is the whole system

The skein runtime is the only thing that communicates into or out of an
instance. Its edges are:

1. **Messages** — in through the instance's front door (BRC-33 on a
   BRC-103/104 session, or a message signed by its sender), out by `emit`
   (#70): a signed message to a key the address book names. This is the
   only channel for another party's word.
2. **The wallet** — the instance's oracle, for signing, verifying,
   encrypting, decrypting and deriving. Keys never enter the runtime.

The network is not an edge of its own (#67: external communication is a
thread): a program reaches it by emitting to a **provider** — the HTTP
proxy, the libp2p node, the waker, the broadcaster — a recipient with an
identity whose answer is a signed message like any other.

Everything else that looks like an input — a model completion, a tree of
files, a person's line — is a message from another identity, proven by its
session.

The host's side of these edges is small: it appends every package a
transport carries in as received (#68: an HTTP request, a GossipSub message,
a stream frame — the front door is stepped on it inside), feeds (headers,
proofs, statuses) and wakes; it answers `wallet`; it runs the providers
and carries out what a step emitted, once the step is committed; it holds a
synchronous client's connection until the request's thread has come to rest
(#66). It verifies nothing. `MESSAGES.md` has the message path end to end.

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
  the virtual filesystem, the store by CID, heads, the wallet, `call`
  (another program's function, in the VM) and `emit` (#70: the one way
  out — a signed message, sent when the step ends; its answer an entry);
- **requests** (#68): every package a transport carries in is an entry,
  and the transport's middleware (the front door) is stepped on it as the
  request's own thread (`docs/VM.md`, "Requests");
- **calls**: a program's function run over the current state with no entry
  and no writes — for host-side reads that are not requests (the answer of a
  route that reads live state, the explorer's; `docs/VM.md`, "Calls");
- the **virtual filesystem**: trees from the store, seen through WASI; the
  wasm shell and its tools run over it. It is the only filesystem the runtime
  has.

The runtime has no access to a disk, a network, a clock or a process table.
Nothing in its code imports `node:fs`, `node:child_process` or `fetch`
(the network is reached by messages to the host's providers, #70). The
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

Who an instance can reach, and how, is its **address book** (head `peers`:
key → `{transport: mailbox | libp2p | local, address, role?, handle?}`,
#70). The genesis seeds it once (`addressBook`: the host's providers, by
role, and the owner's mailbox); after that only the instance's own programs
write it: a BRC-169 resolve (the resolve program), or the owner as admin
(box `peers`: configuration, `skein-host peers`; up.sh and the roster step
write the inference peer and the other agents into every agent). Receiving
is separate: the key authenticates, the subscriptions decide. Nothing
registers itself — no claims in the core; a registration flow (a `register`
box wired to the resolve program's claim handler, or to a program with its
own rules) is application wiring (MESSAGES.md, "Outbound"). A key in no
address book is "no route": the emit fails, permanently.

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
and what a committed step emitted (#70, the serve frame `emit`); in come
**admit an entry and run the step**,
**answer** (#66: wait on the thread a request entry launched), and **call a
function** (no entry, no writes: host-side reads).

The router's components, each the sockets for one kind of traffic, none of
them judging anything (the instance does, through its front door):

- the **HTTP proxy** — instances' origins, each request appended and waited
  on;
- the **providers** — fetch, waker, libp2p, broadcast: recipients of the
  instances' emitted messages (below);
- the **feeds** — SSE headers and ARC callbacks, admitted as plain entries
  (below);
- the **libp2p host** (#43, #51; `src/host/p2p.ts`) — one js-libp2p node per
  instance that declares `libp2p` in its config, inside the router process
  (below).

- **Transport** ends at the instance: each has an origin of its own,
  `http://<handle>.localhost:<port>` (or `/@<handle>` on the router's own
  origin, for our clients). The router picks the instance by the URL — routing
  comes before authentication, because a handshake does not name its
  recipient — and appends the request as received (#68), a `request` entry;
  the kernel steps the instance's **front door** (`programs/frontdoor`) on
  it, which runs BRC-103/104 against the instance's session table, routes
  by its routes table (`etc/routes.json`), checks its reads table
  (`etc/reads.json`), calls the handler and signs the answer. The router
  holds the client's connection until that thread comes to rest (#66) and
  returns its answer; past `answerWaitMs` (default two minutes) or at
  shutdown, 503 + Retry-After. The router keeps no mail and no sessions.
  The stock AuthFetch (one session per origin, handshake at
  `<origin>/.well-known/auth`) is served by the host-name form.
- **Sessions are state** (#68): records under the head `sessions`, written
  by the handshake's step and read by each signed request's; they survive a
  restart. `MESSAGES.md`, "Sessions are state".
- **Writes and reads.** Every request is an entry; a handler that writes
  admits what the kernel routes (a message, an acknowledgement) or starts a
  thread; a read moves nothing — a poll costs its entry, as an access log
  records a GET. `MESSAGES.md`, "The persistence rule".
- **Mailbox instances**: an identity outside the host gets an instance of its
  own for its mail (`skein-host add <h> --mailbox --owner <key>`, or a signed
  `POST /account/register {username, identityKey, signature}`).
- **Delivery** is the instance's: a message to a `mailbox` recipient gets a
  delivery thread (the messagebox program), on the instance's own BRC-104
  session with the recipient's front door, its HTTP through the fetch
  provider. The router answers a URL of its own in process (no socket) and
  sends any other out.
- **The providers** (#70, `src/host/providers.ts`): `fetch` (the HTTP
  proxy), `waker` (a `deadline`'s wake-me), `libp2p` (publish, dial, send,
  close) and `broadcast` (Arcade), each with a key of its own (a child of
  the master secret). The genesis seeds them in the instance's address book
  (`addressBook`, role = the name). The kernel hands the router what a
  committed step emitted to a `local` or `libp2p` recipient (the serve frame
  `emit`); each answer is a signed message appended as a `local` request,
  which the front door checks. Their whole contract: docs/MESSAGES.md,
  "Outbound".
- **Discovery.** The router publishes BRC-169 for its instances
  (`/manifest.json`, `/.well-known/metanet-handles/resolve`: `{identityKey,
  messagebox}`) and the paymail PKI; an instance looks others up with its
  resolve program. BRC-169 is discovery only.
- **The fuel ledger**: a request's fuel is on its thread's updates, in the
  log (#68); the kernel calls the router makes (a read after a request, the
  explorer's) are charged to (instance, caller, op) in host.db
  (`fuel_ledger`; `skein-host ledger`).
- **Feeds** (`src/host/feeds.ts`): the router holds long-lived subscriptions
  an instance declares in its config (`etc/config.json` `feeds`, carried by
  the genesis) — an SSE header stream (`{kind: "headers", url}`), one
  connection per URL fanned out — and admits each item as a plain `header`
  entry (`Router.admitEvent`) through a bounded per-instance queue; SSE
  reconnects with backoff. It judges nothing: the instance's chain tracker
  validates.
- **The broadcaster** (#58, #65, `src/host/arc.ts`): one Arcade per host
  (`SKEIN_ARC_URL`, `SKEIN_ARC_TOKEN`). A broadcast is an event, not a
  message (#65): the kernel hands the router each step's `{kind:
  "broadcast", tx, beef?}`, which goes into a durable queue (host.db
  `broadcast_queue`) and is posted to Arcade under the host's one callback
  token, retried with backoff while Arcade does not take it, taken up again
  after a restart. The router holds **one SSE subscription** to Arcade for
  the whole host (the header feeds' SSE client), resumed with
  `Last-Event-ID` from host.db; Arcade's webhooks (`POST /arc/callback`, the
  token as bearer) take the same path. What Arcade says of a transaction
  goes to **every instance whose state holds it** (read, never written: the
  kernel's `has` of the tx CID, cached per txid — the broadcasters, a sweep
  of every enabled instance at a txid's first status, then the running
  ones), once per txid + status + block hash (host.db): a merkle path as an
  unsigned **proof event** in box `chain`, anything else (its answer to the
  post included) as a signed message from the host's **status provider**,
  which an instance admits only if it subscribes to it.
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
    appends the message as received (#68: a `request` entry, `{kind: "p2p",
    topic, from, seqno, signature, body}`) and waits on the thread the front
    door is stepped on (#66); the front door verifies the signature, routes
    by `libp2p:<topic>`, and its handler answers accept | reject | ignore.
    The verdict is GossipSub's (accept: forward; reject: drop, the
    delivering peer penalised; ignore: drop). Accept admits the message as
    a `p2p` event, routed after the step (docs/MESSAGES.md, "libp2p");
    reject and ignore are recorded refusals. Inbound streams: per protocol,
    the router reads length-prefixed frames, appends each the same way
    (`{kind: "p2p-frame", protocol, from, body}`, no signature: the stream
    is Noise's) and writes the answer back.
  - **Outbound, the `libp2p` provider** (#70): publish, dial, send, close
    are messages to it, answered as signed messages; a dialed stream's
    frames come back in box `frame`. A message to an address book entry
    with `transport: "libp2p"` goes as a signed package, on the topic or as
    a frame on `/skein/message/1.0.0` (which every node serves).
- **Hydration**: an instance is a kernel the router can load
  (`src/host/kernel.ts`: `skein-kernel serve` over the instance's store,
  length-prefixed dag-cbor frames on stdin/stdout). The router starts it on
  demand and, by default, never stops it: instances are not stopped until
  resource contention appears. `SKEIN_IDLE_MS` > 0 stops one idle that long
  (its sessions are records: its clients go on); recovery after an
  environment failure happens at hydrate time from the log (a thread whose
  step was cut off runs again; a deterministic error is recorded and never
  retried).
- **The waker** is a provider (#70, #69): a program's `deadline` and a
  shell's sleep are wake-me messages to the `waker`, answered at their time
  (its timers; appending the answer hydrates an idle-stopped instance). At a
  start the kernel hands the waker again whatever a waiting thread awaits.
- **The cron provider** (#69, `src/host/cron.ts`): a schedule is a
  program's message to it (`{fn: "tick", every | at, box, body?, name}`);
  each tick is a signed message into the named box, kept in host.db
  (`cron_schedule`: an `every` one ticks once at a host start, a late tick
  once, an `at` one once), hydrating an idle-stopped instance only when
  something in it subscribes the box. A remote cron service is the same key
  reached by mailbox (`src/peers/cron.ts`). `skein-host event <handle> <box>
  [json]` sends a tick due now by hand: over the running router's control socket
  (`$SKEIN_HOME/host.sock`, mode 0600, one JSON line each way,
  `src/host/control.ts`; no HTTP route), else through a router of its own
  with the host down.
- **Closing** (#61): `Router.close()` stops everything the router started —
  the waker's, reaper's and ledger's timers (the owed fuel written), its
  servers, the feeds' and the broadcaster's SSE clients, the libp2p nodes and
  every kernel it spawned. `skein-host run`'s shutdown ends with it, and so
  does every one-shot command that builds a router (`add --boot/--packet`),
  which then exits.
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
- **Format 4** (#62): entries as format 3; every recorded `http`/`libp2p`
  call carries the host's attestation, and the genesis names the host's
  attest key (`attest`). Superseded by format 6.
- **Format 5** (#68): every package a transport carries in is a `request`
  entry (`{request: <record>, transport}`), the front door stepped on it;
  sessions are records (head `sessions`); what a request's step admits is
  routed by the kernel, a message once (the `unique` map). A format-4 store
  is refused for running (re-genesis). docs/VM.md ("Requests").
- **Format 6** (#70, #67): no `http` or `libp2p` calls and no attestations
  (format 4's are gone; a genesis naming `attest` is refused); the only
  recorded call is the oracle's (`{kind: "oracle", thread, step, i,
  request, result}`); an update lists what the step `emitted`, signed mail
  records (`nonce`, `signature`, `subject?`); the genesis seeds the address
  book (`addressBook`); requests gain the `local` transport (a provider's
  answer). A format-5 store is refused for running (re-genesis).

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

- **out**: `wallet` → the page's BRC-100 wallet; `emit` → the page's own
  providers (fetch, waker; a page-local key): the instance's messagebox
  program delivers its messages itself (a BRC-104 client) and its resolve
  program looks handles up, both through the page's fetch.
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
routes, all open). A submit is the one write (#50): the handler, in the
front door's step on the request, decodes the BEEF once into records in the
step's write cache, checks it against the held headers and calls the topic
managers on the transaction's CID. Only if a topic takes it does it launch
the submission's thread — the `overlay` program on the submit record, which
holds the records, broadcasts, records the judgements and calls the lookup
services' hooks — and the request waits on that thread (#66); when it
finishes the handler answers the STEAK from the state. A lookup is a read: an in-VM call of the lookup
service's program, which answers from its own maps (head `ls:<service>`),
written only through its hooks. What topics admit is kept as index maps in
the same state record as the wallet's (the SDK's wallet library, `sdk/wallet/src/overlay.zig`), so a
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
— are answered inside, deterministically, and never recorded. The one
**recorded** syscall is the oracle (`wallet`): its answer is a signature
already. Everything that leaves the runtime is a message (#70, #67): a step
`emit`s a signed message — to a peer (inference, run-on-machine) or to a
provider (a fetch, a publish, a wake, a broadcast) — and the answer comes
back as a message, an entry of its own, signed by whoever answered. Time
and random are pure: they derive from the stamp the runtime wrote on the
current log entry. Request/response is a pair of messages; peers and
providers all look the same from inside. (Format 4's host attestations of
recorded `http`/`libp2p` calls, #62, went with the calls: a provider's
answer is its own signed statement.) A
program waiting on an answer is an ordinary thread at rest: the
suspended instance is its transient handle, the scheduler wakes it when the
reply arrives, and a restart re-executes it from the log. Pipeline stages are
threads too; their records are recomputable cache. Which syscall is bound to
what — inside, or routed out — is instance configuration in the log, so a
mock is just a binding to a bundle, and replay uses the binding the original
run used.
