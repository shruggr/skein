# Architecture

The one-page picture. **The instance is an HTTP server; BRC-103/104 is the
network; BRC-169 is discovery; messages are state.** Skein is a state
process: every package a transport carries in is appended to the log as
received, every step is recorded, and the log is the only input. The
detail lives in `VM.md` (the machine), `MESSAGES.md` (the wire), `APPS.md`
(apps) and `BOOTSTRAP.md` (genesis). `ARCHITECTURE-MAP.html` draws it: the
host process, the instance's five frames, the kernel's modules, one request
end to end, and what state lives where (open it in a browser).

Three layers:

1. **The kernel** (`kernel-zig/`): the machine, its four tables, and the
   `wallet` import that reaches the host's signer.
2. **Apps**: everything else, each a tree of WASI programs installed under
   its own name.
3. **Hosts**: whatever drives a kernel from outside. The node host
   (`src/host/`, `skein-host`) and the browser host (`web/kernel/`) exist.

## The kernel

The kernel is a WASI machine: its import table is its system-call surface,
and the userland is anything compiled to plain WASI (Zig, Rust
`wasm32-wasip1`, wasi-sdk C/C++, Go `wasip1`, interpreters as modules).
Programs run as WASI preview1 modules or WASI 0.2 components over wasmtime.

Inside:

- the **store**: records by CID (skein's dag-cbor records, git objects,
  Bitcoin structures), chains, and the index (one Merkle search tree per
  query, one state record holding every root; `VM.md`, "The index");
- the **scheduler**: consumes the log in order, one entry and one step at a
  time, and routes by the dispatch table — every transport's packages
  matched there, first match wins (#115);
- **programs**: stepped by the scheduler, with imports for the virtual
  filesystem, reads by CID, heads, threads (`launch`, `await`, `deadline`,
  `call`), the signer (`wallet`), `emit` (a signed message, or an event:
  an intention the runtime answers, a broadcast, a subscription, a beacon)
  and `authfetch` (#126: the kernel's BRC-104 client, a recorded call — the
  one direct HTTP path);
- **requests**: every package a transport carries in is an entry, and the
  instance's front door (a program) is stepped on it as the request's own
  thread, handed the row the kernel matched; the front door verifies who
  the package is from (BRC-103/104, GossipSub's signature) and runs the
  row's handler (`VM.md`, "Requests");
- **calls**: a program function run over current state with no entry and no
  writes, for host-side reads that are not requests (the explorer's;
  `VM.md`, "Calls");
- the **virtual filesystem**: trees from the store, seen through WASI. The
  shell and its tools run over it. It is the only filesystem there is.

**The four tables.** Objects (blocks by CID); heads (name → root, each with
an owner, the app its name is under); the dispatch table (rows of
transport, address, sender condition, program: boxes, HTTP paths and libp2p
topics alike, first match wins, a row is the permission); the address book
(key → transport and address; providers are `local` rows). Each has one
admin operation, `objects`, `head`, `dispatch`, `peers`, which the kernel
performs itself on a message at an admin row from the owner or a delegate.
No program writes a kernel table. The kernel matches every transport's
rows itself (#115, `dispatch.zig`); the front door verifies the claim the
match was made on. (`VM.md`, "The dispatch table, and the
kernel's four tables".)

**Write scope by name, reads by CID.** No app writes another app's data,
and the kernel enforces it: an app's programs `advance` only heads under
the app's name (`chain/state`, `wallet/state`, `overlay/ls_demo`). The
scope is read from a program record only when the owner installed that
record — a genesis program, a dispatch row's program, or one listed in its
app's record at `<app>/app` — so a record a program puts itself, claiming
another app's name, runs when launched or called and writes no head
(`VM.md`, "Heads"). Any program reads any record whose CID it holds. A
program that needs a pointer it does not hold calls the owning app, and
calls hand back CIDs, not data.

**Syscalls.** Pure ones (files, pipes, spawn, stdio, clock, random) are
answered inside, deterministically, and never recorded. The one recorded
call is the signer (`wallet`): its request and answer are written on the
step, and replay serves them from there. Everything that leaves is `emit`:
a signed message to a key in the address book, or a broadcast event, sent
by the host after the step commits. The answer is a new entry, signed by
whoever answered. A program waiting on an answer is a thread at rest; the
scheduler steps it again when the answer arrives, and a restart re-executes
it from the log.

**Time and randomness** are not inputs. The host stamps each entry when it
appends it. Inside a step, now is `max(last + 1, stamp + fuel)`: one
nanosecond per unit of fuel, never repeating, never going back, recomputed
exactly on replay. Random bytes are a stream keyed by the entry's and the
thread's CIDs; nothing may use them for secrets, which the signer makes.
Sleep and deadlines are intentions (#126): the kernel records a
`deadline` event the host's waker keeps, and its signed answer is an entry.
**The signature boundary is absolute**: every request out is signed by the
instance's key and recorded (an emit's signature, the host's signed request
for an intention, authfetch's), and every answer in is signed.

**Fuel** is on for every step and summed across everything in it; running
out ends the step errored, deterministically, and it is never retried.

The kernel has no disk, network or process table, and a step has no
clock. A `call` (no entry, never replayed) is the exception: when the host
passes no `now` it reads the process clock, and its random stream is
seeded from the OS (`serve.zig`, `scheduler.zig`); the explorer's read
answer is such a call, signed in a wallet call that is not recorded. The
"WASI host" that satisfies a module's imports is inside the kernel.

## Apps

Everything outside the kernel is an app under its own name: the front door
(the BRC-103/104 middleware), the messagebox, resolve, the wallet, the
chain app, static sites, overlays, the shell, chat, and anything else. An
instance runs only the apps its genesis wires or its owner installs. An app
is a tree with `etc/app.json`: its programs, configuration, the interfaces
it provides and requires, the dispatch rows it asks for, and optional
start and stop messages. Install sends the kernel's admin operations as the
owner. `APPS.md` is the specification.

| app | where | what |
|---|---|---|
| front door | `programs/frontdoor` | BRC-103/104 on every request, sessions under `frontdoor/sessions`, the HTTP and libp2p rows, signed answers |
| messagebox | `programs/messagebox` | BRC-33 send/list/ack; delivery threads to other instances' messageboxes |
| resolve | `programs/resolve` | BRC-169 handle lookup; keeps what it finds under `resolve/peers` and answers with the record's CID (never the address book) |
| wallet | `programs/wallet` | coins, actions, drafts under `wallet/state`; reads `chain/state`; ingests by message to the chain app (`WALLET.md`). Not installable: a genesis-wired program the kernel pins, with no `etc/app.json`; `wallet` is a reserved app name |
| chain | shruggr/skein-chain | the one writer of `chain/state`: headers, transactions, proofs, spends, broadcasts; ingest a BEEF; the only broadcaster |
| overlay | shruggr/skein-overlay | BRC-22/24 over topic managers and lookup services; state under `<app>/…`; admits on the chain app's answer |
| site | shruggr/skein-site | the management page (#92): its own tree's `www` at `/site/` (and at `/` by the owner's row), served with skein-sdk's `files` (#125: the static app archived; serving files is a function any handler calls) |
| shell | shruggr/skein-shell | `run` (a command over a tree), and the shell itself: brush, coreutils and the toolset as modules of its tree, run by the kernel (#83); a userland is this app, not something every skein has |
| chat | shruggr/skein-chat | `chat`: the turn loop; its `bash` calls run the shell app's shell when the instance has it (#83) |

**The chain app.** The chain state is one head, `chain/state`, owned by
the chain app; nobody else writes it. Its interface is ingest a BEEF: what
arrives proven (its BUMPs verify against the headers) is recorded and the
caller answered at once; what arrives unproven is recorded, broadcast, and
the caller answered on each state change (`accepted`, `proven`,
`rejected`). Every unproven transaction it holds has a broadcast
registered, so the proof is the answer to that broadcast. Headers and
proofs arrive as events, statuses as messages from the status provider.
The wallet and each overlay keep their own records under their own names
and read `chain/state` by CID; spent, live and settled are computed at read
time. Today an answer set ends at `proven` or `rejected`; the decided
direction (#31, 2026-10-02) is that a reference to a transaction is a
subscription for the transaction's life, so a reorg or a proven
conflicting spend reaches every registrant.

**Overlays.** An overlay is the engine (shruggr/skein-overlay) plus its own
topic managers and lookup services, installed under one name, wired from
`config.overlay`. It serves `<base>/submit` and `<base>/lookup`, its
BRC-23 base URL `https://<handle>.<host>/<app>` (`/@<handle>/<app>` on the
host's origin without wildcard DNS). Submit
decodes the BEEF once into the step's write cache, asks the topic managers
to judge it by CID, and hands it to the chain app; the submission is
admitted on the chain app's first `accepted` or `proven` answer. Nothing
persists unless a topic takes it, apart from the request. Lookup services
keep their own maps under `<app>/ls_<service>`. Two overlays run on one
instance over the one `chain/state`.

## Everything outside is a peer

Anything that acts on the world is a peer: an identity that exchanges
messages with the instance, proven by its session or its signature.
Peers include a person's client (`bin/skein`, the bopen-skein front end),
the inference peer (`bin/skein-infer`), other instances on any host, and
the providers.

**The address book** says who an instance can reach and how: key →
`{transport: mailbox | libp2p | local, address, handle?}` (#126: nothing
finds a service by a role; `role` is still written for modules built
before skein-sdk 0.7.0 until #126's last step). The genesis seeds it (the
host's providers at `local` <name>, the owner's mailbox); after
that it changes only through the kernel's `peers` operation, on a message
signed by the owner (`skein plan peers`, sent by the owner's wallet) or by a key the owner added as a
sender on the `peers` row. No program writes it: every program emits as the
instance, and no row admits the instance's own key to an admin box. The
resolve program keeps what a BRC-169 lookup finds under its own name
(`resolve/peers`); a message to a key the address book does not name goes to
the messagebox's delivery thread, which reads that record. Nothing registers
itself. A key in neither is "no route": the delivery fails.

**Mailbox instances.** An identity outside the host (a person's wallet, the
inference peer, a browser tab) has its mail kept by an instance of its own
with only the front door and the messagebox.

## The host

A host is **transports + providers + store + signer**. It verifies nothing
and routes nothing: transports append whole packages as received, the
kernel's dispatch table picks each one's row (HTTP paths, libp2p topics
and protocols, boxes alike), and the instance's front door verifies the
package and runs the row's handler. A transport may ignore a package whose content the store already
holds (deduplication by hash is not verification). The kernel's surface is
five frames: in, **admit** (append an entry and run the steps it drives),
**answer** (wait until a request's thread comes to rest), **call** (run a
function, no entry, no writes); out, **wallet** (signing requests) and
**emit** (what a committed step sent). `admit` takes requests and events,
never a message as the host's word: a message comes in inside the package
that carried it, and the front door verifies it. The host's `append` frame
writes only the genesis entry, as the log's first; every other entry is
admitted. `skein-kernel serve` answers more than
these (`kernel-zig/src/serve.zig`): reads (`get`, `has`, `tip`, `head`,
`genesis`, `dispatch`, `boxes`, `byEnvelope`, `programs`), blocks at boot
(`put`, `putblock`, `restore`), and process control (`start`, `running`,
`idle`, `say`, `fatal`).

The node host (`skein-host run`, `src/host/router.ts` and its neighbours):

- **The HTTP transport.** Each instance has its own origin,
  `http://<handle>.localhost:<port>` or `/@<handle>` on the host's origin.
  The host picks the instance by the URL (a handshake does not name its
  recipient), appends the request as a `request` entry, and holds the
  connection until the thread comes to rest; past `answerWaitMs` (two
  minutes) or at shutdown, 503 + Retry-After. Sessions are the front door's
  records under `frontdoor/sessions`, so they survive a restart. Every
  request is an entry; a read moves nothing.
- **The libp2p node** (`src/host/p2p.ts`): one js-libp2p node per instance
  whose genesis config declares `libp2p` or whose installed apps added
  libp2p rows; it follows the dispatch table live as apps install and
  uninstall. Its peer key is a secp256k1 child of the master secret, never a
  wallet root. GossipSub with StrictSign, noise + yamux, TCP and WebSocket,
  optional Kademlia DHT with topic rendezvous, mDNS, bootstrap peers,
  circuit relays. Each topic message or stream frame is appended as a
  request; the front door's verdict (accept, reject, ignore) is GossipSub's.
  It beats the apps' beacons (#126: a body published on a topic every
  `every` ms, nothing logged per beat, the topic not subscribed).
- **authfetch's bytes** (#126): the kernel asks the host for one HTTP
  exchange at a time (the serve frame `http`); the router carries it (its
  own URLs in process), and signs and checks nothing — the kernel did.
- **The providers** (`src/host/providers.ts`): recipients of what an
  instance emits, each with a key of its own (a child of the master secret)
  and a `local` row in the address book. `fetch` (the web proxy: it answers
  `fetch` intentions, #126) and `waker` (`deadline` intentions: deadlines and
  sleeps) — for an intention the host signs the request with the
  instance's key and routes it as it is wired (`Providers.route`), and the
  answer carries that request — `cron` (`{fn: "tick", every | at, box, body?,
  name}`; schedules in host.db), `libp2p` (publish, dial, send, close),
  `status` (Arcade's word on a transaction), `manager` (the instance
  manager: below, "The host skein"), `certifier` (#113: it signs handle
  certificates for the host skein's onboarding app). Each answer is a signed
  message appended as a `local` request. A provider may also be remote (a
  cron service reached by mailbox, `src/peers/cron.ts`). A message the
  instance sends itself loops back through the host as transport `local`,
  address `self`.
- **The broadcaster** (`src/host/arc.ts`): one Arcade per host
  (`SKEIN_ARC_URL`, `SKEIN_ARC_TOKEN`). A broadcast is an unsigned event
  (`{kind: "broadcast", tx, beef?}`), queued durably in host.db and posted
  under the host's callback token, retried with backoff. One SSE
  subscription to Arcade (resumed with `Last-Event-ID`) and its webhooks
  (`POST /arc/callback`) bring statuses back. What Arcade says of a
  transaction goes to every instance whose store holds it: a merkle path as
  a proof event in box `chain`, anything else as a signed message from the
  status provider, which an instance takes only through a `$status` row.
- **Feeds** (`src/host/feeds.ts`): SSE header streams an instance declares
  in its config, one connection per URL, each header appended as an event
  (box `chain` by default). The chain app validates. The host has a feed of
  its own besides (`SKEIN_HEADERS_URL`, #102): every enabled instance whose
  dispatch table takes events in box `chain` (the chain app's `event` row)
  is subscribed to it, the others not, and the router keeps that current
  as the table changes (an install subscribes, an uninstall unsubscribes).
  A header comes as hex or as chaintracks' JSON (Arcade's
  `/chaintracks/v2/tip/stream`: the 80 bytes are serialized from its
  fields, and one whose `hash` is not theirs is dropped).
- **The store**: one SQLite file per instance
  (`$SKEIN_HOME/instances/<handle>/runtime.db`), written by the kernel
  process.
- **The signer** (`src/host/signer.ts`): one master secret
  (`$SKEIN_HOME/master.key`); each instance's root key is a BRC-42 child of
  it (key ID = the handle), answered by a ProtoWallet in the host process.
  The kernel and programs see only public keys and the signatures they ask
  for. Entries are not signed: the sender signed its request, `prev` fixes
  the order, and the stamp is the host's word.
- **Kernels**: `skein-kernel serve` per instance (`src/host/kernel.ts`,
  length-prefixed dag-cbor frames on stdin/stdout), started on demand and
  not stopped unless `SKEIN_IDLE_MS` is set. Recovery after a crash is
  replay at hydrate time: a step that was cut off runs again.
- **Discovery** (#113): BRC-169 for the host's handles (`/manifest.json`,
  `/.well-known/metanet-handles/resolve` and `/search`, the paymail PKI)
  and registration (`POST /account/register`, `/account/profile`) are
  answered by the host skein's onboarding app; the router's own origin — a
  hostname whose first label is no instance — maps those paths onto the
  host skein's routes, as transport only (each request an entry there).
  `SKEIN_ROUTER_ORIGIN` (default `http://127.0.0.1:<port>`) is where they
  are and what geneses record as `resolveOrigin`. The certifier key (a
  child of the master secret, the `certifier` provider's) is
  `metanet.trust.publicKey`; the app records every certificate it has
  signed, each with a serial of its own. Revocation is not implemented — the
  host has no wallet: the certificate's revocation outpoint is BRC-52's
  disabled sentinel (docs/MESSAGES.md, "BRC-169 is discovery").
- **The fuel ledger**: a request's fuel is on its thread's updates in the
  log; the host's own kernel calls (the explorer's reads) are charged in
  host.db (`skein-host ledger`), per instance and caller: the identity the
  front door verified on the request's thread (its `read` answer names
  it), not a header as the client sent it.
- **The control socket** (`$SKEIN_HOME/host.sock`): `skein-host event`
  sends a cron tick by hand through the running host. (No claim: the host
  holds no owner's key, #127.)

`scripts/host/README.md` has the commands, ports and environment.

### The host skein (#90)

The host runs one instance of its own: the **host skein**, the operator's.
`skein-host init --owner <key>` creates it (handle `host` by default) from
the default image, a bare image the operator then claims from a wallet
(#127: `skein plan claim`, `skein send`; its claim row admits anyone until
then, so the operator does it first), and host.db
records which row it is (`skein-host list` shows it as kind `host`). It is
an ordinary instance under the same transports, with one difference: its
address book, and no other, has entries for the **instance manager** and
the **certifier** (#113). What about the host is state or conversation
belongs in it (today: the onboarding app, the instances it created, the
handles it registered and the certificates issued for them); the HTTP
transport and the libp2p node stay native, and host.db keeps its side
tables (instances, the fuel ledger, cron, the broadcast queue).

The **instance manager** (provider `manager`, a key of its own like the
others) creates, starts and stops this host's instances. It acts only for
the host skein: its entry exists in the host skein's address book alone,
and a message from any other sender is not acted on and not answered. Each
message is answered with a signed message:

- `create {handle, owner, image?, domain?, claim}` → `{handle, identity, url}`. The row is
  added disabled (no hostname) at `domain` (#113: the onboarding app's
  handle domain; when none is given, the host's: the onboarding app's
  `config.onboard.domain`, else the host name of `SKEIN_ROUTER_ORIGIN`), the identity derived from the master
  secret, the store booted from the image (`default`),
  the kernel started, and `claim` — the owner's own claim `{message, body}`,
  signed by the owner's wallet before the instance existed and naming no
  recipient (#127) — forwarded into it as a `local` request, its first
  entry: the front door checks the signature, the kernel takes the owner
  from the signer. The manager signs nothing for the owner; a claim whose
  sender is not `owner` is refused. Only once the kernel has written the
  owner's admin rows is the row enabled, which publishes the hostname: no
  request can reach the claim row first. `url` is the instance's origin
  (`SKEIN_INSTANCE_ORIGIN`, default `http://<handle>.localhost:<port>`).
  Image `mailbox` (#113): a mailbox instance for `owner` (its owner in its
  genesis, no claim), published at once — what a registration asks for.
- `start {handle}` → `{handle, started: true, url}`; `stop {handle}` →
  `{handle, stopped: true}`: published and started, or unpublished and
  stopped. Not the host skein itself.
- A refusal is an answer `{error}`: a handle that is not a hostname label
  or is taken or reserved (`id`, `host`, and the first label of the
  router's own origin, which never routes to an instance), an owner that
  is not a key, another image, no claim, another key's claim, a refused
  claim (the instance left unpublished). Every row, however it is
  made, has a hostname label for a handle.

The **onboarding app** (shruggr/skein-onboard), installed in the host
skein, is how a stranger gets a skein: `POST /onboard/call {fn:
"onboard.create", args: {handle, image?, claim}}` over any BRC-104 session,
`claim` the caller's own signed claim (#127). Its
handler records the request and launches a thread, and the client waits
on that thread (#66). The thread applies the policy (free and ungated
today; not a reserved name), emits `create` to the instance manager with
the session's key as the owner and the claim as it came, and rests. On the answer it points
`onboard/instances/<handle>` at the manager's answer record, has the
certifier sign the new skein's handle certificate (for its own identity)
and records it, and finishes; the page gets `{handle, identity, url}`. The
management page calls it (shruggr/skein-site, #92: docs/APPS.md §3 "The
management page"), served by the host skein itself.

The same app is the host's **BRC-169 server and registrar** (#113,
skein-onboard 0.2.0): a registration (`POST /account/register` at the
host's origin, signed over `register <name>@<domain>`) is a thread that
asks the manager for a mailbox instance (`create`, image `mailbox`) and the
certifier for the certificate (`issue`), records the certificate under
`onboard/handles/<handle>` (each issue a new serial: the hash of its
issuance record; `prev` the trail) and answers the holder's copy;
resolve, search, the manifest and the paymail PKI read those records. The
handle domain is its `config.onboard.domain`, the one setting. The message
sequence and the records: docs/MESSAGES.md "Mailbox instances" and
"BRC-169 is discovery".

## The browser host

The same kernel compiled for `wasm32-freestanding` (`zig build web`) runs
in a Worker, programs on V8 with fuel counted by instrumentation (the same
numbers as wasmtime's), the store in IndexedDB, preview1 modules only
(`web/kernel/host.ts`). One instance whose identity is the connected
wallet's: `wallet` goes to the page's BRC-100 wallet, `emit` to the page's
own providers (fetch, waker: the intentions, signed by the page's wallet as
the instance), `http` (authfetch's bytes) to the page's fetch. In: the
page's chat, a poll of the page identity's mailbox instance, and the
waker's timers — each message a
`local` request carrying a signed message (the page's own signed by its
wallet, a polled one as the mailbox kept it), verified by the front door;
the page admits no unsigned message. Nothing runs while the
tab is closed. Logs cross between browser and native in both directions.

## Genesis

An instance boots from a system tree (`bin/*.wasm` or `.cid`,
`etc/config.json`, `etc/dispatch.json`, `etc/reads.json`, its own files) or
a chain packet (a BEEF bag plus a scope, verified offline). The genesis
names the tree and seeds the dispatch table: the owner's four admin rows
first, then the tree's. Without a tree the host writes its default system
in code through the same writer. A packet whose scope is a state record is
a checkpoint. **The default image** (`images/default`, #89) is a tree whose
genesis names no owner: it carries the claim row instead, and the first
claim — its sender is the owner (#127): the owner's own message, or a claim
the owner signed before the instance existed, forwarded by the instance
manager — writes the owner's admin rows and removes the row. `BOOTSTRAP.md` has the detail.

## Files in and out

In: a peer hashes a directory into git blobs and trees and sends them to
the kernel's `objects` operation; a message names the root CID. A thread's
working tree is that CID; a message that names none starts from `main`,
which only an explicit act moves (`VM.md`, "Heads").

Out: a result names a tree CID. A peer that wants bytes on a disk fetches
the objects and materialises them. The kernel never writes to a disk.
