# Messages

How messages enter and leave a skein instance, as built at log format 8.
**The instance is an HTTP server; BRC-169 is discovery; BRC-103/104 is the
network; messages are state.** Skein is a state process: every message a
transport carries in is appended as received and the front door is stepped
on it; sessions are state; a synchronous client waits on the thread. **Two
doors** (#135): the kernel's door admits messages only — a key, a
signature, a row — and a read is a `call` the host serves over the current
state, nothing admitted, nothing logged ("The front door: two doors",
below). There
is **one way out**: a step `emit`s a message to a key the address book
names, or an event, and ends waiting, and the answer is an entry. **A skein
receives mail only where it verifies the sender itself** (#126 step 4,
#144): a BRC-169 envelope at its own front door (`/sendMessage`: the
envelope's signature is the sender's proof, whoever carries it), a BRC-104
session to its own front door (`/sendMessage` without an envelope, which
another instance reaches with `authfetch`), or libp2p.
Anything inside a body that must mean something on its own signs itself (a
claim, a payment). A remote messagebox is a wallet's, never a skein's.
**Intentions** (#126) are events the runtime answers as it is wired — a
`deadline`, a `fetch` (the host signs the request with the instance's key
to its waker or its HTTP proxy, whose signed answer comes back); a program
has no reason to know who those services are. **The signature boundary is
absolute**: every request out is signed by the instance's key and
recorded, every answer in is signed and admitted. The one direct HTTP path
is the kernel's `authfetch` (BRC-104, signed and checked in the kernel, a
recorded call); mail to a peer's messagebox goes that way. **Broadcast out
and proof in are unauthenticated, self-validating events** through
specific wiring (an optional status provider reports statuses as signed
messages); a **beacon** is an event the libp2p node beats on its own clock;
and **a schedule is a message to the cron provider**. **The kernel is the machine, four tables and the signer**:
objects, heads with their owner, one dispatch table (routes, boxes and
libp2p topics are its rows), the address book; the admin operations are the
kernel's own, on messages from the owner or a delegate; an app writes only
heads under its own name. The host is transports + providers + store +
signer; it routes nothing ("The dispatch table", below).

## The persistence rule (#68: skein is a state process)

Every package a transport carries in is **appended as received**, and every
step is recorded. There is no in-memory execution path:

- a request — an HTTP request, a GossipSub message, a stream frame — is one
  log entry (`request`), the package as the transport carried it: headers,
  signatures and all. The host verifies nothing;
- **the door** (#121, docs/VM.md "The door") runs before the entry is
  written, read-only: the kernel matches the dispatch row, the transport's
  middleware verifies the sender (BRC-104, GossipSub's signature, a
  provider's or a claim's own signature), and the row's `filter` runs on the package's content
  (`beef`: every BEEF decoded, its transactions stored once as blocks, every
  BUMP checked against `chain/state`, the bytes replaced by a pointer
  record — **no BEEF bytes are logged**). The outcome is the entry either
  way: the admission (`door`), or a refusal (`refused: {stage, reason,
  status, code?}`), stored, which runs nothing. The door is lossless for
  anything a signature covers: what it rewrites is reconstructible to the
  exact bytes;
- the instance's middleware (the front door) is stepped on an admitted
  entry, as the request's own thread: it routes and answers (it verified at
  the door). A refusal there (no session, no route, a read rule) is that
  step's answer: recorded, and nothing else changes;
- a read — a poll, a listing, a lookup — costs its entry and moves nothing,
  as a web server's access log records a GET; growth is a pruning question;
- a handshake is a request like any other: its step writes the session as a
  record (sessions are state, below);
- a message that arrived is a `mail` record the front door's step routes
  (its id, as before, the record's CID); an acknowledgement moves the
  reader's pointer;
- what the instance sends is part of the step that sends it (the signed
  message record it emitted, listed in the update's `emitted`), not an
  entry; what comes back — a peer's reply, a provider's answer — is an
  entry like any other arrival;
- the blocks a step puts before it commits are the **write cache** (the
  records a handler builds and reads back): a cache in front of the store,
  not a different kind of execution.

A reader with the log can check every message: the request that carried it
is in the log as received, and the mail record carries the BRC-104 signed
request (below), which verifies with the instance's key alone.

## The route table, the grants and the kernel's operations (#77, #143)

The kernel keeps its tables: **objects** (blocks by CID), **heads** (name →
root), the **route table** (the dispatch chain), the **address book** and
the **grants** (the head `grants`). David Case (2026-10-08): "permissions and
routing might be two entirely different things." The route table is one
chain of routes

```
{transport: "mailbox" | "event" | "http" | "libp2p" | "local", address, prefix?: true,
 filters?: ["kernel.brc104" | "kernel.beef" | "<app>.<filter>"],
 program?: <program record CID> | "kernel", fn?, app?, …settings}
```

— a box (`mailbox`: messages; `event`: the host's wiring, never a message),
an HTTP path (prefix or exact), a libp2p topic or `/<protocol>` (exact);
what runs on the package before anything is recorded (`filters`); which
program's function is stepped or called, or which of the kernel's own
operations runs — or, for an http route with no program, nothing: a **read
route**, its filters answer. No route says who may send (docs/VM.md "The
route table" for the full rules). Who may run a function is the **gate**'s:
the roles that gate it (an app record's `roles`, the genesis's), the
principal the filters yielded, and the grants. A program never writes these
tables. Every change is an **admin message** at one of the kernel's admin
boxes, gated by **root**, which the kernel itself performs — no program is
stepped:

| box | body | the operation |
|---|---|---|
| `objects` | `{records: [{cid, bytes}], root?}` | each block stored under its CID (hash-checked); `root` → `main` if there is none |
| `head` | `{name, tree}` | the head advanced to a record in the store (not `billing` or `grants`: the kernel's) |
| `dispatch` | `{op: "add" \| "remove", row}` | the route added (replacing the route with its key: transport, address, prefix), or removed |
| `peers` | `{op: "add", key, transport?, address? \| url?, handle?, domain?}` \| `{op: "remove", key}` | the address book |
| `grant` | `{op: "add" \| "remove", role, principal}` | the grants (#143): `root` or `<app>.<role>` to (or from) a key |
| `claim` | `{messagebox?, handle?, domain?}` | an image's claim route, open (#89): **root is granted to the message's sender** (#127, #143; a body's key is not read), the claim route removed, the head `claim` → `{claimant: <the sender>, messagebox?, handle?, domain?}`, the claimant's messagebox into the address book (source `claim`) — in one step; refused if root is held or the sender is not a key |

Every genesis seeds the admin routes and its `root` (the initial root
holders: the host skein's operator key, #142); an image (the default image,
docs/BOOTSTRAP.md) names no root and seeds the claim route instead: the
claimant's own message takes it (#127) — sent to the instance (a bare
image: the first claim's sender is root; `skein claim`), or signed before
the instance existed and forwarded by the host's instance manager as its
first entry (`create`, #90), before the instance is published. A claim is
the one message that may name **no recipient**: the mail record without
`recipient`, box `claim`, and one of the few a sender signs itself (#126
step 4: no session of the instance's carries a claim forwarded into it) —
`[2, "metanet handles envelope"]`, key `send`, counterparty anyone, the
sender's key alone checks it; SDK `message.zig` ≥ 0.6.1, the front door, the
kernel's `isMail`. Any other message naming none is not admitted.
Delegating administration is root granting root (or an app's role) to
another key. A refused operation (a bad body, a record not in the store)
is a log line and nothing written; a message the gate refuses (the sender
holds no role the function needs) is recorded and nothing runs. The client
commands: `skein install|uninstall|routes|grant|peers|host|claim|deploy`
build root's messages, sign them in the client's process with the
operator's key and send them — over the host's control socket (op
`message`: a signed `local` request) on the host machine, else on one
BRC-104 session (#124, #142, docs/APPS.md §3). An app's own writes are
heads under its name, `<app>/…` (docs/VM.md, "Heads"); the front door's
sessions are `frontdoor/sessions`.

## The instance as an HTTP server

Each instance is an HTTP server at an origin of its own. Its **front door**
(`programs/frontdoor`, Zig) is the program that answers. The host's HTTP
transport (`src/host/router.ts`) picks the instance by URL and hands the
request to the kernel's door (below): what the door admits is a `request`
entry and the kernel steps the front door on it — the host holds the
client's connection until that thread has come to rest and returns its
answer as the HTTP response (#66, "A synchronous client waits on the
thread", below); what the door answers itself (a read route, a rejection,
the gate's refusal) comes back at once, nothing logged. The host holds no
mail and no sessions, and verifies nothing.

### The front door: one table, filters, the gate (#135, #143)

Decided 2026-10-07 (David): "The security boundary is absolute." Corrected
the same day: "The security boundary is signed or validatable. Validated."
And 2026-10-08: a filter is "an unlogged handler for a request that
determines how it gets handled within the system"; routing and permission
are apart. Every HTTP request goes to the kernel's door
(`src/host/frontdoor.ts` `serveHttp` → `admit`; kernel-zig `scheduler.zig`
`door`):

1. **The route.** The one table, by path: the exact route first, then the
   longest prefix. No route: 404, no entry (signed when the request is).
2. **The filters**, in the route's order, before anything is recorded, over
   the request and the state as it stands: `kernel.brc104` (the BRC-104
   request check — the session in `frontdoor/sessions` by its `yourNonce`,
   not expired, and the signature, through the signer; the principal is the
   client's key; no `x-bsv-auth-*` headers, an unknown or expired session or
   a bad signature: 401, the stock client shakes hands), `kernel.beef`
   (every BEEF in the body decoded and every BUMP checked against the chain
   app's headers; the bytes replaced by the pointer record; a BUMP that does
   not check 400; no BEEF and no principal before it 400 "nothing to
   validate" — signed or validated), and an app's own (`<app>.<filter>`, a
   call in the deterministic profile). Each passes the request on (with a
   principal, with blocks it stored), rejects it, or answers it. A route
   lists only what it names: `["kernel.brc104"]` signed only;
   `["kernel.beef"]` validated (an overlay's `/submit`: the stock
   TopicBroadcaster's plain POST is admitted, with no sender key);
   `["kernel.brc104", "kernel.beef"]` signed, and validated if it carries a
   BEEF; `["kernel.brc169"]` BRC-169 mail (below, "The messagebox"); none —
   anyone.
3. **The gate.** The roles that gate the route's function (the app
   record's `roles`; the genesis's: the explorer is root's) against the
   principal: root passes anything, `user` any principal, an app role its
   holders; no principal 401, the wrong one 403.
4. **The outcome.** A rejection, a filter's answer (a **read route**: no
   handler — the site's pages, a lookup, a resolver: anyone, any method,
   signed or not; the fuel on the host's meter) and the gate's refusal
   write **no entry**: the host answers at once — signed on the request's
   session when the request is signed and its session verifies (the front
   door's fn `respond`, a call), plain otherwise. What passes is the entry
   — `door: {principal?, verified?, filters, beefs?, blocks?}` — and the
   front door's step on it runs the route's handler (its `caller` the
   principal) and signs its answer on the session when the request is
   signed (#135: a signed request gets a signed answer, BRC-104 §6.4,
   whatever the route's filters). The handshake (`/.well-known/auth`) is a
   route of its own to the front door's `handshake`, no filters.

| path (examples) | route |
|---|---|
| `/site/*`, root's `/`, `/onboard/resolve`, `/onboard/search`, `/onboard/manifest.json`, `/onboard/bsvalias/id/*`, `/<overlay>/lookup`, `/<overlay>/listTopicManagers` … | read routes: filters only, anyone, nothing logged |
| `/sendMessage` (the default image) | `kernel.brc169`: a BRC-169 envelope, signed by its sender; any other message signed on a session |
| `/listMessages`, `/acknowledgeMessage`, `/onboard/register`, `/onboard/profile`, `/onboard/call`, `/amm/call`, `/explore*` | `kernel.brc104`: signed |
| `/<overlay>/submit` | `kernel.beef`: validated |

```
request {kind: "http", method, path, route, query, headers: {name: value}, body: bytes}
entry   {kind: "log", prev, n, time, request: <that record, as the filters handed it back>, transport: "http", door}
```

`path` is what the client sent (what BRC-104 signs), `route` what the route
table sees (the host strips `/@<handle>`), header names lower-cased. A
request the door answers is the same record, kept nowhere.

```
http://<handle>.localhost:<port>/…     the instance's origin (the Host header)
http://<host>:<port>/@<handle>/…       the same instance, a dev form: the host strips the prefix for the routes
```

**Auth is by key.** `kernel.brc104` establishes who a request is from; the
caller is the identity key the session proved (`door.principal` on the
entry); there is no account, no handle check, no envelope. Answers are
signed on the session through the instance's signer (the kernel's
`wallet`, a recorded call of the step; a call's for what the door answers).

- **Sessions are state** (#68). The BRC-103 session table is records the
  front door writes on the handshake and `kernel.brc104` reads; a handshake
  is a request like any other, and its step writes the new session.
  Sessions survive a restart (a new kernel process, a crash, an idle
  stop). Replay needs no session besides: each logged request carries the
  sender key, the 104 signature and both nonces.
  - **Where.** The head `frontdoor/sessions` (#77: the front door's own,
    under its name; `programs/frontdoor/sessions.zig`, read by
    kernel-zig `door.zig` `sessionOf`): `{kind: "sessions", buckets:
    [<bucket> × 16]}`, each bucket `{kind: "session-bucket", sessions:
    [{nonce, peer: bytes(33), peerNonce, created}]}`; a session lives in
    bucket sha256(nonce)[0] mod 16. `nonce` is ours (what a request's
    `yourNonce` names); `created` the handshake entry's time.
  - **Lookup and expiry.** A request's session is found by its `yourNonce`.
    Expiry: `defaults.sessionTtlMs` (a day) from `created`, judged by the
    request's time. An unknown or expired session gets a plain 401, and the
    standard client shakes hands again by itself.
  - **Bounds and replay.** A handshake drops the expired sessions and, past
    1024, the oldest. A replayed initialRequest (the peer and initial nonce
    of a session held) is refused. A replayed signed request verifies (its
    nonce is not remembered); a replayed write is the same mail record,
    which the kernel admits once (the `unique` map).
- **Routes are the table's** (#77, #143): an app's install adds its routes
  under `/<app>/` through the kernel's `dispatch` operation (docs/APPS.md
  §3); root adds its own anywhere (`skein routes add|remove`: no `app`, so
  an app's upgrade or uninstall leaves them — the site at `/` is one, the
  read route `{http, /, prefix, filters: ["site.get"], root: "www"}`). The
  front door never sees the table: it gets the route (`match`) and calls
  its handler, an in-VM call of `program`'s `fn` in its step; what that
  receives and returns is the program-facing contract below ("Route
  handlers").
- **Files** (#52; #125: skein-sdk's `files` module): any handler — or a
  filter — serves a site with `files.serve` over the tree it picks
  (shruggr/skein-site: its own app record's `tree`). A read route's filter
  `get` with settings `{root?, index?}` answers `GET`/`HEAD` with the file
  at `<root>/<path>` in that tree — `path` the route past the prefix,
  percent-decoded; a path ending in `/` its `index`, default `index.html`;
  a directory without the `/` a 301 to it. The `ETag` is the blob's CID,
  and `If-None-Match` naming it is a 304. 404 for a missing file or a path
  that escapes; 405 for another method. No entry, no head moves.
- **The explorer** is a route behind `kernel.brc104` whose function is
  gated by root (the genesis's `roles: {root: ["frontdoor.explore"]}`):
  every genesis has it; nobody reads an image's before its claim; others
  get 403, signed, nothing logged. Its answer is a read of live state made
  after the request's thread (fn `read` with the entry's request).
  Granting another key the explorer is granting it root.

### Route handlers: the program-facing contract (#68, #66)

A route handler is a program function the front door calls, in-VM, in its
step on a request, once the request has verified (or, unsigned on an open
route — sender `*`, a system tree's `auth: "none"` — at once). Being part of that step, everything the handler does —
records it puts, records it keeps, threads it launches, records or threads
it awaits, heads it moves, recorded calls it makes — is the step's, on the
request's thread, recorded and replayed with it. Its input is the ordinary
in-VM call input (`kind: "call"`, `fn`, the genesis facts, `now` = the time of
the entry that drove the step, `step: {thread, step, entry, at}`) with `arg`
(dag-cbor):

```
{ caller?:     bytes(33)       the identity the BRC-104 session proved (absent for an unsigned request, on an open route)
  method, path, route, query,  the request as received (path as the client signed it; route as the table saw it)
  headers:     {name: value}   names lower-cased, x-bsv-auth-* included
  body:        bytes | <cid>  as received; #121: on a row whose `filter` is `beef`, the BEEF's pointer record (docs/VM.md "The door")
  contentType: text            the media type alone
  session?:    {payload, signature, nonce, yourNonce}   the 104 proof, to keep in what the handler writes (no payload when a filter replaced the body: reconstructible)
  match:       the dispatch row that matched, as the table holds it (`address`, `prefix: true` for a prefix row;
               a handler's own settings: static's root, index; the install's app). #79: no pre-#77 keys
  request:     <cid>           the request record: the package as received (its entry is `step.entry`)
  resolved?:   [{thread, state: "finished" | "errored", result?, error?}]   called again: the thread it waited on
  event?, reply?, woke?        called again: what else woke the request's thread (an awaited subject, a reply, a deadline) }
```

For libp2p routes the request fields are the message's (`transport:
"libp2p"`, `topic | protocol`, `from`, `key`: the 33-byte key out of `from`,
`seqno?`, `signature?`, `body`, and `match`), below.

It answers (dag-cbor on stdout), one of:

```
{status, type?, body: bytes, headers?: {name: value}, admit?: [entry]}   the answer, now
{wait: true, admit?: [entry]}                                            not yet: it launched, or awaits, the thread the answer depends on
{read: true}                                                             the answer is a read of live state, made after (the explorer)
```

- **The answer.** `status`, `type` (default `application/json`), `body`,
  and `headers` (but for `content-type` and `x-bsv-*`, the front door's).
  The front door signs it on the client's session (BRC-104 response
  headers) and it is the last update of the request's thread: its
  `result.stdout` is `{status, headers, body, admit?}`. That is the
  **answer record** the host reads when the thread comes to rest; nothing
  else is written for it.
- **What it writes.** Records it puts and keeps, heads it moves, threads it
  launches: the step's. Messages and events for the instance to route go in
  `admit`, as `{mail: <mail record>, body: <body's dag-cbor bytes>}` or
  `{event: <record>, box}`: the kernel routes each after the step, in
  order, exactly as it routes the entry of that kind (a message by its
  `replyTo`, else by its `mailbox` row on `(sender, box)`; an event by its
  `subject`, else the first `mailbox` row from anyone on `box`). A message is
  admitted once (its record's CID in the `unique` map): the same message
  again is recorded with its request and routed nowhere.
- **Waiting: how it names the thread the client waits on.** A handler whose
  answer depends on more steps — a broadcast to be accepted, a peer's
  reply — starts the work as a thread of its own with the `launch` import
  (the request's thread then waits on it, as any step waits on what it
  launched), or, when that work is already under way (a resubmission while
  the first submission is pending), `await`s that thread's origin CID
  (the kernel refuses to await a thread that has already come to rest:
  its state is there to read), and answers `{wait: true}`. It may instead
  `await` a record (a message it sent, a subject) or set a `deadline`, like
  any step. The request's thread ends its step `waiting`; when what it
  waits on arrives — the launched or awaited thread comes to rest
  (`finished` or `errored`), the awaited record's entry, the deadline — the
  front door is stepped again and calls the handler again with the same
  request plus `resolved` (or `event`, `reply`, `woke`). It answers from the
  state as it stands then. That work's own thread ends its steps as any
  thread does: `waiting` on what it needs (an `await`, a `deadline`), and
  `finished` when its result is in the state — only `finished` or
  `errored` answers a waiting client (#66).
- **A read of live state.** A handler whose answer reads what no step may
  (the explorer: the log as it stands is not a function of the request's
  place in it) answers `{read: true}` when called in a step (its input has
  `step`). The request's thread still verified it and applied the read
  rule, and ends; the host then makes a kernel `call` of the front door's
  fn `read`, which calls the handler again — as a call, over the current
  state — and signs its answer on the session (not recorded).
- **Replay.** The handler runs again in the request's steps on replay, over
  the same state at the same place in the log, and must answer the same;
  its recorded calls (the signer's signatures) are served from the log.

### A synchronous client waits on the thread (#66)

The host appends the request and holds the client's connection until the
request's thread comes to rest for good — `finished` or `errored`, never
merely `waiting` — then answers with that thread's answer (errored: 500 with
its message). However many entries the thread takes (a broadcast and its
status, a peer's reply), the client sees one answer. A second request that
concerns the same work (a resubmission of the same transaction, a poll on
the same flow) has its own request thread, which awaits the same work
thread and answers from the same state: the same answer. Past the host's
bound (`answerWaitMs`, `SKEIN_ANSWER_WAIT_MS`, default two minutes) the
client gets 503 + `Retry-After` and the thread goes on; so does a client
still waiting when the host shuts down. Asynchronous flows are the same
picture with nobody waiting. The kernel's side: the serve frame `answer
{entry, wait}` (kernel-zig/README.md, "serve").

A request's thread steps on `callFuelLimit` (the budget the front door had
as a call, default 10^10), not `fuelPerStep`; a thread it launches steps on
`fuelPerStep` like any other.

The **default routes**: the BRC-33 messagebox (`/sendMessage`,
`/listMessages`, `/acknowledgeMessage`, at the root and under `/messagebox`)
and the explorer (`/explore…`, read op `explore`: the log, threads, a thread,
a head, a record, what points at a record (`/explore/edges/<cid>?rel=`, #92),
as DAG-JSON; `programs/frontdoor/explore.zig`). The management site (an
app, shruggr/skein-site: `/site/`, and `/` by the owner's row, #125; not in
the default image) reads a skein through these routes (docs/APPS.md §3,
"The management page"); each read is a request entry, nothing else written.

**The standard AuthFetch** (`@bsv/sdk`, and the `@bsv/message-box-client` over it)
keeps one session per origin and shakes hands at `<origin>/.well-known/auth`.
It is served by the host-name form: one origin per instance, so one session
per instance. The `/@<handle>` form works for a client that sends its
handshake under the prefix too — `RawBox` (`src/client/raw.ts`) rewrites
`/.well-known/auth` to `/@<handle>/.well-known/auth` — and signs the path it
sent, which is what the front door verifies.

## The log, format 8

```
entry    {kind: "log", prev, n, time, genesis | request+transport (+ door | refused, #121) | mail | event+box}
door     {verified?, filter?, beefs?: [<pointer record>], bodies?: [{of, is}]}       the door's admission (docs/VM.md "The door")
refused  {stage: "middleware" | "filter", reason, status, code?}                   a refusal at the door: stored, nothing runs
request  http:   {kind: "http", method, path, route, query, headers: {name: value}, body: bytes}
         libp2p: {kind: "p2p", topic, from: bytes, seqno: bytes(8), signature: bytes, body: bytes}
                 {kind: "p2p-frame", protocol, from: bytes, body: bytes}
         local:  {kind: "message", message: <a mail record>, body: bytes}       signed, or the loopback (below)
mail     {kind: "mail", op: "put", sender: bytes(33), recipient: bytes(33), box, body: <cid>, subject?: <cid>,
          json?: true, session?: {payload: bytes, signature: bytes, nonce, yourNonce}
          | nonce?: bytes(16), signature?: bytes | envelope?: <cid>}
```

Entries are unsigned (#9): the sender signed its request, `prev` fixes the
order, `time` is the host's clock at admission (#10). A `request` names
the package as received (#121: as the door hands it back — a BEEF replaced by its pointer record on a row whose `filter` is `beef`) and its transport, whose middleware the kernel
steps on it (the genesis's front door for `http`, `libp2p` and `local`; a
genesis may name others in `middleware: {<transport>: <program>}`). A
`local` request is what the host carries in itself (below, "Outbound"): a
provider's answer or a forwarded claim — the door (#121: the front door's fn
`verify`) checks the message's signature against its sender and that its
body is the one named — or the loopback (#79), this instance's own emit to
itself, unsigned, which the door admits because the record is in the
instance's store (the kernel put it when the step emitted it). No host
admits a message directly (K2): `admit` refuses a `mail` entry, and every
message arrives inside a request — the browser page's own messages as
`http` requests on its session with its instance (#126 step 4). A mail entry
is only in a log written before that. A
store in an older format is refused for running (`kernel-zig/src/log.zig`
has the shapes).

- **A message is its mail record.** Its sender is proven by the transport
  that carried it (#126 step 4), or by its BRC-169 envelope (#144:
  `envelope`, the envelope's signed part, which the door checked and
  stored; the body is the plaintext). A
  client's message: `sender` is the session's identity, `session` the
  BRC-104 signed request (the payload that carried the body, its signature
  and nonces), `json` set when the client sent JSON (so the answer to it goes
  back as JSON). An instance's emitted message (#70) is the record the
  instance emitted — `nonce` (the emit's own: two threads asking the same
  thing are two messages) and `subject?`, no `session` — kept the same by
  the recipient, whose front door took it on the sender's BRC-104 session
  (`sender` the session's identity) or over libp2p (`sender` the peer's key):
  the request entry it was admitted from holds the proof, and both sides know
  the message by one CID. `signature` is on the records no session of the
  instance's carries: a provider's answer (#70), a claim (#127), the
  instance's request an intention's answer carries (#126) — and on every
  emitted message in a log written before #126 step 4 (read, never written:
  replay serves that signer call from the log). `body` is the dag-cbor record
  beside it. A box a client
  names never starts with `:` (reserved for the host's own boxes).
- **A message's id is the CID of its mail record.** Sender and recipient
  compute it alike; a reply names it in its body's `replyTo`. A second
  admission of the same record routes nothing (the kernel's `unique` map;
  so for a libp2p `p2p` event record, below): as an entry of its own it is
  refused, routed out of a request it is recorded with that request.
- **Routing** (`scheduler.zig` processMail), for a message to this instance:
  a body with a `replyTo` CID resumes the thread awaiting that record, if the
  record is a message this instance sent to the replying sender; otherwise
  (no such thread, or `replyTo` not a CID) it is recorded and nothing runs. A
  message with no `replyTo` is routed by the dispatch table's `mailbox`
  rows on `(sender, box)`, first match wins (#77; a kernel row is an admin
  operation the kernel performs; another row launches its program); no
  row: recorded, nothing runs. A routed message with a `subject` (#65: a
  status provider's status, about a transaction) steps the thread whose
  tip awaits that subject, with input `message: {message, body, box,
  sender, subject}`; with no such thread the row's program gets `{message,
  body, box, sender}`.
- **Events** (no sender, self-validating) come only through the host's
  specific wiring, never an open box: its feeds (#29: headers), its
  broadcaster's proofs (#65: `{kind: "proof", subject, txid, path, …}` in box
  `chain`), and what a front door's step routes (`:ack`; #51: an accepted
  libp2p message, `p2p` in `libp2p:<topic>`, below). An event goes to the
  thread awaiting its `subject`, else to the first `mailbox` row **from
  anyone** whose address is the entry's box (or `*`); none: recorded,
  nothing runs. The handler gets `{event, box, subject?}`.
- **Wakes and ticks are signed messages** (#69, #126): a step's `deadline`
  and a shell's `sleep` are `deadline` events the host's waker keeps; its
  answer, a signed message naming the event and carrying the instance's
  signed request for it, steps the thread (`woke`); a schedule is a message
  to the cron provider, whose ticks are messages into the box it names. `skein-host event` sends a tick from the cron provider by hand.

## The messagebox

`programs/messagebox` (Zig) is the BRC-33 messagebox inside the instance,
called by the front door's routes. Bodies are JSON read as DAG-JSON
(`{"/": "<cid>"}` a link, `{"/": {"bytes": "<base64>"}}` bytes), or BRC-231
(`Content-Type: application/cbor`: `recipient` 33 bytes, `body` dag-cbor
bytes); the answer is in the form asked.

- **sendMessage** → one message to admit (`admit`): the mail record
  (`sender` the caller) and its body, which the kernel routes after the
  front door's step — a BRC-169 envelope the door opened (#144, below:
  `envelope` the signed part, the body the plaintext as a byte string, the
  sender the envelope's), the client's form (`session`, `json?`), or, for a
  BRC-231 message that names `nonce` (and `subject?`), another instance's
  emit delivered on its own session, kept as the record it emitted (#126
  step 4). A message carrying a `signature` is refused (400): the session or
  the envelope is the proof. Accepted when something takes it: for this instance's
  own boxes, a dispatch row on `(sender, box)` — the kernel's own, or a
  program's — or a reply to a message this instance sent that sender; for
  the identity it keeps a mailbox for (its owner), a row whose program is
  the messagebox. Refused, only the request is recorded. The answer carries `id` (the record's CID) and
  `results` echoing the client's `messageId`.
- **listMessages** is a read: the caller's list in that box, `{messageId,
  sender, body, …}` with `messageId` the mail record's CID (JSON: the body as
  DAG-JSON text). Its request is the only record.
- **acknowledgeMessage** → one event to admit: `{kind: "ack", reader, ids,
  session}` in `:ack`, which the messagebox, stepped, applies: the reader's
  pointer moves. The records stay in the log.

State: the head `mailbox` names `{kind: "mailbox", lists: [{recipient, box,
list}]}`, each `{kind: "mail-list", recipient, box, acked, messages: [{id,
at}]}` — the unacknowledged messages in arrival order. An instance's own
routed boxes keep no list: admission is the acknowledgement, the log is
the queue. **A mailbox exists only where a row to the messagebox
exists**: a message no row sends the messagebox is refused (`403`).

Delivery out is the messagebox's delivery thread, which `emit`s (#70: no
step has an http import).

### Mail is BRC-169 (#144)

Mail to a skein is a BRC-169 envelope delivered to its own messagebox:
BRC-33 `sendMessage` at the skein's origin (the `messagebox` its handle
resolves to), in BRC-231's form —

```
POST /sendMessage   Content-Type: application/cbor
{message: {recipient: bytes(33) <the skein's key>, messageBox, body: <the §7.3 envelope, dag-cbor bytes>}}
```

— checked by the route's filter, `kernel.brc169` (docs/APPS.md §2): one
signature (the sender's, over the envelope without `content` and
`signature`, checked with the sender's key alone), no handshake, any
courier; the recipient is this skein (its key, and the genesis's handle
and domain — the `+tag` is not part of it); `content` (BRC-78) is
decrypted through the skein's signer and must hash to `contentHash`,
which this skein requires; an envelope whose signed part the skein holds
already is a replay (409: the envelope has no nonce, its signed part's CID
is its identity). The message is kept as a mail record from the envelope's
sender in `messageBox` (BRC-33's box; `recipient.tag` stays in the signed
part, as metadata), naming the signed part (`envelope`), its body the
plaintext (a MIME entity, kept as a byte string). It is routed like any
message: the box's route, the gate on the sender. `quoteId` and `payment`
(§8's toll) are not read. A `sendMessage` whose body is no envelope is
checked as BRC-33 has it (`kernel.brc104`: the session's key).

The one box the default image routes is `metanet_inbox`, to the wallet's
`internalize`: funding by a BRC-169 delivery message (docs/WALLET.md
"Funding").

## Mailbox instances

A mailbox instance is a **wallet's** messagebox, never a skein's (#126 step
4): a skein receives mail only at its own front door (or over libp2p), where
it verifies the sender itself; a messagebox someone else keeps can only hand
on what was sent to it, which the receiving skein could not verify. There is
no mailbox pull path into a skein: the browser page reads its identity's
mailbox with its wallet and shows what is there, and if the user wants their
instance to act on something, the user sends the instance a message of
their own, on their own session with it.

An identity outside the host — David's wallet, the inference peer, a browser
tab — gets its mail kept by a **mailbox instance**: an instance with only the
front door and the messagebox, whose dispatch rows send `:ack` and every
message from anyone in any box (`*`) to the messagebox, for its owner. Its
sessions are records like any instance's (#68). It has an identity of its own (its signer's key;
the BRC-104 counterparty), and keeps the owner's mail as the owner's.

Every mailbox instance is made by the instance manager's `create` with image
`mailbox` (#113, `Router.createInstance`; "The providers", below): the row
`kind: mailbox`, its owner and domain, the store booted with the owner in its
genesis (no claim), published at once. The same owner and handle again
answers for the row that is there; a key with another mailbox here is
refused. Two callers:

- **A registration** (#103, #113), the user's path. The host's own origin
  carries it into the host skein, where the onboarding app
  (shruggr/skein-onboard ≥ 0.2.0) takes it. The contract, exactly:

  1. `GET <host>/.well-known/skein-host` → `{origin, domain}`: the router's
     origin and the **handle domain** — the onboarding app's
     `config.onboard.domain`, the one setting every handle on the host is at
     (`skein.nexus` in production: `handle@skein.nexus`). Answered at every
     host name, an instance's origin too, so a page an instance serves finds
     it on its own origin.
  2. The wallet signs the UTF-8 text `register <username>@<domain>` (the
     domain from step 1, lower case) with `createSignature({protocolID: [2,
     "skein register"], keyID: <username>, counterparty: "anyone", data})`.
     The domain is in the text, so a signature for one host is not good at
     another.
  3. `POST <origin>/account/register` over the wallet's BRC-104 session
     with the host's origin (#135: a registration is a write, so a signed
     request; the stock AuthFetch, its handshake at `<origin>/.well-known/auth`
     the host skein's), body JSON `{username, identityKey,
     signature}`: the registrant is the session's identity — no session
     401, an `identityKey` that is not the session's 403 (skein-onboard
     ≥ 0.3.3); `username` a host name label (a-z, 0-9, `-`, 1 to 63, not
     starting or ending with `-`), `identityKey` the key (hex, 33 bytes),
     `signature` hex DER. The router appends it to the host skein as a
     request entry (route `/onboard/register`); nothing in the router
     checks it.
  4. The answer, when the app's thread has asked the instance manager for
     the mailbox and the certifier for the certificate and recorded both:
     `200 {handle, domain, identityKey, messagebox: <the mailbox's origin>,
     certificate, keyringForSubject}` — the handle certificate for the key's
     wallet to keep (`acquireCertificate`, `acquisitionProtocol: "direct"`,
     `keyringRevealer: "certifier"`; "BRC-169 is discovery", below).
     Refusals are `{error}`: 400 not JSON, not the three fields, not a
     label; 401 the signature does not verify for that key over that text;
     409 the name is reserved (`id`, `host`), is another key's (a handle
     here or an instance's), or the key holds another handle here (one key,
     one handle); 500 the thread failed.

  **The same key and name again** registers nothing new: the mailbox stands,
  and a new certificate is issued under a **new serial number** (each issue
  has its own: the hash of its issuance record), so a wallet that removed the
  earlier one (`relinquishCertificate`, which the toolbox keeps as a deleted
  row unique on type, certifier and serial) can acquire it again. The earlier
  certificate stays in the host skein's records, the trail revocation will
  use.

  **The profile** (#104) goes to the same app: `POST <origin>/account/profile`,
  body JSON `{handle, record: <base64 of the DAG-CBOR profile bytes>,
  signature: <hex DER>}` — the record `{domain, name?, avatar?}`
  (`@1sat/utils` `encodeProfile`), its `domain` the handle domain, signed by
  the handle's key with `createSignature({protocolID: [1, "metanet handles
  profile"], keyID: "1", counterparty: "anyone", data: <the bytes>})` →
  `200 {handle, profile, displayName?, avatarURL?}`; 401 another key's
  signature, 400 another domain or shape, 404 no such handle. The app keeps
  it (`onboard/profiles/<handle>`); resolve and search serve it. (Before
  #113 the page wrote it to the mailbox instance's head `profile`; the host
  reads that no more.)
- **The operator**, out of band: `skein-host add <handle> --mailbox --owner
  <key> [--domain d]` calls the same `createInstance` through a router of
  its own — for a host with no host skein (a dev host, `up.sh`'s `david` and
  `infer`). Such a mailbox has no record in the onboarding app, so it is not
  certified and does not resolve until it is adopted: `skein-host
  import-handles` sends `{fn: "onboard.adopt", args: {handle, owner}}` to
  `/onboard/call` as the host skein's owner for each mailbox row the app has
  no record of (registrations made before #113 too); the app records and
  certifies it at its domain as a registration would. `skein-host mailboxes`
  lists them.

The host's resolve endpoint answers a mailbox instance's handle with its
owner's key and the instance's origin.

## Outbound: emit, the address book and the providers

(#70, #67.) This is the program-facing contract for everything that leaves
an instance. A step never talks to the network: it **emits a
message** to an identity key the address book names, ends `waiting` on it,
and the answer — a peer's reply, a provider's answer — is an entry that
steps the thread again. **External communication is a thread.**

### emit

```
emit(message) → <cid>    preview1: skein.emit(msg, len, out, cap) → n   (the CID, binary; n < 0: the error)
                         WIT:      emit: func(message: list<u8>) -> result<cid, string>
                         Zig:      sk.emit(a, to, box, body: Value, subject: ?cid) → cid; sk.send(a, to, box, body)
message  dag-cbor {to: bytes(33), box: text, body: bytes (the body record's canonical dag-cbor), subject?: <cid>}
record   {kind: "mail", op: "put", sender: bytes(33), recipient: bytes(33), box, body: <cid>, subject?: <cid>,
          nonce: bytes(16)}
```

- The kernel builds the record (`sender` the instance, `recipient` = `to`),
  puts it and the body, and returns its CID: the message's id, what an
  answer's `replyTo` names. `nonce` is the first 16 bytes of sha256(thread ‖
  step ‖ the emit's place in the step): two threads asking the same thing
  send two messages. **Unsigned** (#126 step 4): no signer call; the
  transport that carries it proves its sender — the instance's own BRC-104
  session with the recipient's front door (its delivery thread's
  `authfetch`), libp2p (the peer), or, for a provider on its host, the host
  itself, which carries what its own kernel hands it. The recipient keeps
  the same record. A log written before signed every emit (`[2, "metanet
  handles envelope"]`, key `send`, counterparty anyone, over the record
  without `signature`; a recorded signer call at that place in the step):
  replay serves that call when the log holds it for that very record, and
  the record is the signed one it was (scheduler.zig `oldEnvelope`) — read,
  never written.
- It goes out **when the step ends without error** (an errored step sends
  nothing), listed on the step's update as `emitted`. Replay sends
  nothing. At a start the kernel hands
  over again every emitted message a waiting thread still awaits; a host
  acts on a message once.
- **An event instead of a message** (#65, #119): `emit({event: <name>,
  …fields})`, addressed to no one, unsigned. The kernel lists the record on
  the update (`emitted`) and hands it to the host after the commit
  (transport `event`, address the name); the host acts on it by its wiring,
  or ignores it with a log line (the step is not told). Any name is
  accepted; the events the reference host wires:

  | event | record | the host |
  |---|---|---|
  | `broadcast` (#65) | `{kind: "broadcast", tx, beef?}` | its broadcaster posts the transaction to Arcade — below, "Broadcast out, proofs and statuses in"; re-offered at a start while the thread awaits it |
  | `subscribe` (#119) | `{kind: "event", event: "subscribe", app, topic, program, fn, filter?}` | a subscription: its libp2p node subscribes `topic`; the kernel delivers a message on it to `app`'s `program` at `fn` — "libp2p (#51)", below |
  | `unsubscribe` (#119) | `{kind: "event", event: "unsubscribe", app, topic}` | `app`'s subscription to `topic` ends; the node leaves the topic when nothing else takes it |
  | `deadline` (#126) | `{kind: "event", event: "deadline", at, thread, step, app?}` — the kernel records it (the `deadline` import, a shell's sleep), never an emit | an intention: its waker answers at `at` (below, "Intentions"); re-offered at a start while the thread awaits it |
  | `fetch` (#126) | `{kind: "event", event: "fetch", method, url, headers?, body?, timeoutMs?, maxBytes?, thread, step, app?}` (`sk.fetch`; the kernel adds `thread`, `step`) | an intention: its HTTP proxy performs it and answers (below, "Intentions"); re-offered at a start while the thread awaits it |
  | `beacon` (#126) | `{kind: "event", event: "beacon", app, topic, every, body}` | its libp2p node publishes a new frame on `topic` every `every` ms — `body`, the beat's time, the instance's signature — logging nothing per beat, without subscribing the topic — "libp2p (#51)", below |
  | `unbeacon` (#126) | `{kind: "event", event: "unbeacon", app, topic}` | `app`'s beacon on `topic` stops |
  | `liveness` (#138) | `{kind: "event", event: "liveness", app, topic, window}` | its liveness tool: the node subscribes `topic` without admitting its messages and keeps the verified beacon beats newer than `window` ms, the latest per sender, served at `GET /<app>/.live/<topic>` — "Liveness (#138)", below |
  | `unliveness` (#138) | `{kind: "event", event: "unliveness", app, topic}` | `app`'s liveness on `topic` ends: its set is gone, the node leaves the topic when nothing else takes it |
  | any other | `{kind: "event", event: <name>, app?, …fields}` | nothing: a log line |

  A non-broadcast record is `{kind: "event", event, app?, …the emit's
  fields}`: `app` is the kernel's, the `app` of the emitting program's record
  when that record is installed (#114: a genesis program, a dispatch row's,
  or one listed at `<app>/app`); an uninstalled record's event names no app,
  and a host that follows events by app (the libp2p node) ignores it. An emit naming
  `kind` or `app` is refused. It is handed over once; a host that needs it
  after a restart reads it from the log (the kernel writes nothing else).
  The kernel checks `subscribe` / `unsubscribe` as they are emitted — the
  emit fails with its reason, and nothing is listed: the emitting program is
  an installed app's; `topic` is text with no space or NUL and not a
  `/<protocol>`; a subscribe's `program` is a role in the app's record at
  `<app>/app` and its `fn` is not empty (`filter`, if any, a door filter the
  kernel has); an unsubscribe names a subscription the app has (an app
  unsubscribes only its own). It checks a `beacon` (an installed app's;
  a topic; `every` from 1 000 ms to a day; `body` bytes, at most 64 KiB)
  and an `unbeacon` (an installed app's; a topic), a `liveness` (an
  installed app's; a topic; `window` an integer from 1 000 ms to a day) and
  an `unliveness` (an installed app's; a topic), and a `fetch` (a method,
  an http(s) `url`, headers text, a body bytes; `thread` and `step` are
  its own).
- **Errors** (the call's; the step may catch them): `emit: want {to:
  <33-byte key>, box, body: <dag-cbor bytes>, subject?: <cid>}, {event:
  "broadcast", tx: <cid>, beef?: bytes} or {event: <name>, …fields}` ·
  ``emit: event <name>: a name is not empty and has no space or NUL`` ·
  ``emit: an event's `kind` and `app` are the kernel's to set`` · `emit:
  subscribe names its program: …` | `emit: subscribe: "<role>" is not a
  program of app <app> …` | `emit: subscribe names the function delivered to
  …` | `emit: <subscribe|unsubscribe>: topic "<t>" is not a topic …` | `emit:
  unsubscribe: app <app> has no subscription to <t> …` | `emit: <…>: the
  emitting program is not installed …` · `emit: the
  message is not dag-cbor` · ``emit: `to` is not an identity key (33
  bytes): emit to a key, not a handle (resolve the handle first)`` · `emit:
  the box is empty or starts with ':' (reserved)` · `emit: the body is not
  dag-cbor` | `… not IPLD` | `… not canonical dag-cbor` · ``emit: `subject`
  is not a CID`` · ``emit: no route to <hex>: not in the address book, and
  the genesis has no messagebox program to deliver it`` · `emit: <hex> is
  reached by mailbox, and the genesis has no messagebox program to deliver
  it` · `emit: the signer did not sign the message` (replaying a log before #126
  step 4 only) · in a kernel call,
  `emit: a kernel call sends nothing (emit from a step)`.

### Awaiting the answer

`await` the message's CID (`sk.awaitRecord`) and end the step; it rests
`waiting` with the CID in `awaits`. The thread is stepped again by:

| input | when |
|---|---|
| `reply: {message, body, box, sender, replyTo}` | a message from the recipient whose body names `replyTo: <the CID>` (`sk.replyOf`; `get` the body) |
| `undelivered: {message, error}` | a `mailbox` recipient's delivery thread gave up: no answer can come |
| `woke: true` | the waker's answer to the step's `deadline` (#126: its signed message naming the `deadline` event) |
| `event: {event, box, subject}` | an event about a record the step awaits (#65: a transaction's proof, awaiting its CID) |
| `message: {message, body, box, sender, subject}` | a subscribed sender's message about a record the step awaits (#65: a status provider's status) |

Several messages, a subject and a deadline may be awaited at once; whichever
comes first steps the thread, which awaits again what it still needs. An
answer nothing awaits any more is recorded and runs nothing. A reply is
routed only if the awaited record is a message this instance sent **to the
replying sender** — a provider answers as itself, so its key is what the
address book names — or an intention this instance recorded, answered with
the instance's own signed request for it to the replying sender (below).

### Intentions: deadline and fetch (#126)

A program says what it wants and awaits it; the runtime does it as it is
wired, and the answer is an entry.

| intention | recorded | awaited | answer (a `reply` or a wake) |
|---|---|---|---|
| `deadline(until_ms)` (and a shell's `sleep`) | when the step ends waiting: `{kind: "event", event: "deadline", at, thread, step, app?}`, in `emitted` and `awaits` | by the kernel | at `at`: `woke: true` (a shell carries on past its sleep); one stamped before `at` runs nothing |
| `sk.fetch(a, method, url, headers, body)` / `sk.fetchWith(…, {timeout_ms, max_bytes})` | the emit `{event: "fetch", method, url, headers?, body?, timeoutMs?, maxBytes?}` → `{kind: "event", event: "fetch", …, thread, step, app?}` | by the program (`sk.fetch` awaits its CID) | `reply: {message, body, box, sender, replyTo}`, the body `{replyTo, request, status, headers, body}` or `{replyTo, request, error}` (`sk.replyOf`) |

**How it is answered.** The kernel hands the event to the host after the
step's commit (transport `event`, address the name; again at a start while
a thread awaits it). The host's wrapper — it holds the instance's signer —
signs a request for it with the instance's key: the mail record `{kind:
"mail", op: "put", sender: <the instance>, recipient: <the service's key>,
box, body: <the event's CID>, nonce, signature}` (BRC-169's signing: the one
message the instance's key signs, since no session of the instance's carries
the answer back), and sends it where the host is wired (`Providers.route`: the
reference host's own waker, box `wake`, and HTTP proxy, box `fetch`, both
`local`; which service and which transport is host wiring — not an
instance setting, not an address-book entry the program reads). The
service answers with a signed message from its key, to the instance, in
that box, its body `{replyTo: <the event's CID>, request: <that signed
request>, …}`, appended as a `local` request. The front door checks the
answer's signature; the kernel checks the request — the instance's own,
signed, to the answering key, for that event — and steps the thread
awaiting the event. Both signatures are in the log. A message naming the
event without such a request is recorded and runs nothing. A log before
#126 (a deadline was a wake-me message to the waker, answered by
`replyTo`) replays as it was written.

### The address book

The head `peers` — who the instance can reach, and how:

```
{kind: "peers", peers: [{key, peer: <cid>}]}                                   sorted by key
{kind: "peer", key: bytes(33), transport: "mailbox" | "libp2p" | "local", address: text,
 handle?: text, domain?: text, since: ms, source: "genesis" | "admin" | "claim"}
```

| transport | address | how a message goes out |
|---|---|---|
| `mailbox` | the recipient's messagebox URL | the instance's own **delivery thread** (below): a BRC-104 POST with the kernel's `authfetch` |
| `libp2p` | a peer ID, or `topic:<name>` | the host's libp2p node: the package `{message, body}` (dag-cbor) as one frame on `/skein/message/1.0.0`, or published on the topic; the libp2p provider answers in box `sent`: `{replyTo, sent: true}` or `{replyTo, seqno, recipients}`, or `{replyTo, error}` |
| `local` | a provider's name on this host | handed to the provider |

An entry is a key, a transport and an address (#126). Nothing in skein
finds a service by a role: the kernel finds no waker (a deadline is an
intention), and a program that messages one of its host's services reads
the entry by where it is reached (`sk.peerAt(a, "local", "cron")`) or is
given the key. There is no `role` (a module built before skein-sdk 0.7.0
that finds a provider by one finds none: rebuild it on 0.7.0). Receiving needs none of this: a
sender is authenticated by the transport (a BRC-104 session to the front
door, or libp2p; a host provider's answer by its own signature) and admitted by a dispatch row, whether or not the instance can
answer it.

The address book is one of the kernel's four tables (#77). Who writes it:

- **the genesis**, once: `addressBook: [{key, transport, address,
  handle?, domain?}]` (source `genesis`) — the host seeds its providers
  (`local`, address the provider's name: `fetch`, `waker`, `cron`; `libp2p`
  when it runs libp2p, `status` when it has an Arcade) and the owner's
  mailbox (an older genesis's `role` is read and not kept);
- **the kernel's `peers` operation** (the admin box `peers`, the owner's
  by every genesis, or a delegate's; source `admin`): `{op: "add", key,
  transport?, address? | url?, handle?, domain?}` | `{op: "remove",
  key}` — `url` alone, or no `transport`, is a mailbox. No program runs.
  `skein peers add <key> <address> [--transport t]
  [--handle h@d]` / `remove <key>`, sent by the owner's wallet (#124), and
  `skein-host peers <agent> list`; `scripts/host/up.sh` writes the owner,
  the inference peer and the other agents into every agent this way;
and nothing else: **no program writes it** (#87). Every program of the
instance emits as the instance, and no default row admits the instance's
own key to an admin box, so a program's `peers` message finds no row —
recorded, nothing runs. A key the owner adds as a sender on the `peers` row
may change it too; nothing else can.

A later record for the same key replaces it (a party that moved hosts).
`sk.peers`, `sk.peerOf(key)`, `sk.peerAt(transport, address)` and `sk.peerByHandle(handle, domain)` read it.

**What the resolve program finds** it keeps under its own name (#87), not in
the address book — the head `resolve/peers`:

```
{kind: "resolutions", peers: [{key, peer: <cid>}]}                             sorted by key
{kind: "resolution", key: bytes(33), transport: "mailbox", address: <messagebox URL>,
 handle: text, domain: text, since: ms, source: "resolve" | "claim"}
```

A lookup's thread finishes with the record's CID (a link). A message to a
key the address book does not name goes to the messagebox's delivery thread
all the same (the kernel cannot know the resolve program's records; the
delivery thread can): it reads the address book first, then this record,
and fails "no route to <hex>: not in the address book, and not resolved"
when neither names the key. The owner may copy a resolution into the
address book with a `peers` message (the management page proposes such
rows as it proposes dispatch rows at install). **Registration is
application wiring, not core**: nothing registers itself or takes claims;
an application that wants senders to make themselves reachable writes a row
of its own (e.g. `{"address": "register", "sender": "*", "program":
"resolve"}`: the resolve program keeps a claim `{handle, domain}` — or a
BRC-169 envelope's sender — only if it resolves to the sender, source
`claim`).

### The providers

A provider is a recipient with an identity of its own that carries a
message out and answers. The reference host runs seven
(`src/host/providers.ts`): `fetch`, `waker`, `cron`, `libp2p`, `status`,
`manager` (the instance manager, #90) and `certifier` (#113) — the last two
the host skein's only; their
keys are the host's business (children of its master secret), the instance
knows them from its address book. Every answer is a signed message from
the provider to the instance — the record an `emit` makes with its
`signature` (BRC-169's way: a `local` package has no session of the
instance's to prove its sender; an instance's message to a provider is
unsigned, the host carrying what its own kernel hands it, #126 step 4),
`subject` echoed, a fresh `nonce` — in the box asked (`frame`
for a stream's frames), its body `{replyTo: <the message>, …}`; a failure is
`{replyTo, error}`. It arrives as a `local` request (`{kind: "message",
message, body}`): the front door checks the signature and the body, and the
message routes by `replyTo` to the thread awaiting it.

| provider (`local` address) | box | body | answer body (beside `replyTo`) |
|---|---|---|---|
| `fetch` | `fetch` | the instance's signed request for a `fetch` intention (#126: its body the event's CID; above, "Intentions") | `{replyTo: <the event>, request, status, headers, body: bytes}` — the HTTP proxy; a URL of the host's own is answered in process, any other goes out when the host allows it (`SKEIN_HTTP=fetch`). `maxBytes` (#91): a response body over it is not carried in, and the answer is `{error}` (the git app bounds its pack this way). (A module built before skein-sdk 0.7.0 still emits `{method, url, …}` to it as a message; answered `{replyTo, status, headers, body}`) |
| `waker` | `wake` | the instance's signed request for a `deadline` intention (#126) | `{replyTo: <the event>, request, at}`, at `at` (#69, below) |
| `cron` | `cron` | `{fn: "tick", every: ms \| at: ms, box, body?, name}` · `{fn: "stop", name}` | `{name, next}` · `{name, stopped}`; then each tick, a message of its own into `box` (#69, below) |
| `libp2p` | `publish` | `{topic, body: bytes}` | `{seqno: bytes(8), recipients}` |
| | `dial` | `{peer, protocol}` | `{stream}`; then each frame read, in box `frame`: `{stream, body}`, and its end `{stream, closed: true, error?}` — all answering the dial |
| | `send` | `{stream, body: bytes}` | `{}` |
| | `close` | `{stream}` | `{}` |
| `status` | — | takes no messages (an error answer) | it speaks first: each status of a transaction the instance holds, box `chain/status` (#65, #128, below) |
| `manager` | `create` | `{handle, owner: bytes(33), image?, domain?, claim?: {message, body: bytes}}` | `{handle, identity: bytes(33), url}`: image `default` (or none) — a new instance from the default image, `claim` (required: `owner`'s own signed claim, naming no recipient, #127) forwarded into it as its first entry and taken before its hostname is published, then started (#90, below); image `mailbox` (#113) — a mailbox instance for `owner`, published at once, the same owner and handle again the same answer ("Mailbox instances", above). `domain`: the handle's domain, recorded with the row (default `localhost`) |
| | `start` | `{handle}` | `{handle, started: true, url}`: published and started |
| | `stop` | `{handle}` | `{handle, stopped: true}`: unpublished and stopped |
| `certifier` | `issue` | `{handle, domain, subject: bytes(33), serialNumber, issuance?}` | `{certificate, holder: {certificate, keyringForSubject}, serialNumber, issuance?}`: the handle certificate for handle@domain → subject under that serial, signed by the certifier key — the resolver's copy and the holder's (#113; "BRC-169 is discovery", below). Records nothing |

The overlay's gossip (#74, docs/OVERLAY.md "Gossip") is `publish`
messages, not awaited (the answer is recorded and runs nothing): on
`<topic>` the body is the submission's BEEF as received; on `<topic>-admit`
the dag-cbor `{txid, topics: {<topic>: {outputsToAdmit, coinsToRetain}}}`;
on `<topic>-proof` the dag-cbor `{txid, blockHash, blockHeight, bump:
bytes}` (txid and block hash hex, display order).

`sk.fetch(a, method, url, headers, body)` records the `fetch` intention and
awaits it; the reply's body is the answer (above, "Intentions"). A broadcast is not a message to
anyone (#65, below); the chain app (#78) is the one program that emits it (#79: the wallet and the overlay apps send the chain app an `ingest` instead).

**The instance manager** (#90) and **the certifier** (#113) are in the host
skein's address book alone (`skein-host init` writes that genesis; no
other instance's book names them), and they act only on a message from the
host skein's identity, sent from the host skein: any other is not acted on
and not answered (a line in the host's log). A host skein made before #113
has no `certifier` entry: the owner's `peers` message adds it (`skein
peers add <certifier key> certifier --transport local
--instance <the host skein>`) (the key: what the
host's manifest published as `metanet.trust.publicKey` before #113 — the
master secret's child under `[2, "skein provider"]`, key ID `certifier`). A refusal is an answer: `{error}` for a handle that is not a
hostname label or is taken, an owner that is not a key, another image, a
refused claim, no claim, a claim whose sender is not `owner`; `start`/`stop`
of the host skein itself. It signs no claim (#127): in `create` it forwards
the owner's own — signed by the owner's wallet before the instance existed,
naming no recipient — as a `local` request, unchanged. The row exists
disabled until the kernel has processed the claim (the front door checked
the signature; the signer's admin rows written, the claim row removed), and
only then is it enabled, which publishes the hostname: the claim is the
instance's first entry after its genesis. The onboarding app
(shruggr/skein-onboard) is the host skein's program that asks it
(docs/ARCH.md, "The host skein").

**How a host obtains its providers' keys is its own business**, not core:
the reference host derives them from its master secret (`src/host/signer.ts`
`providerKey`: a BRC-42 child under `[2, "skein provider"]`, key ID the
name); the browser page from a secret it keeps. A system tree names a
provider as a row's sender by `$<name>` (`$status`, `$cron`), which the
host resolves at genesis; a row from a provider the host has not is left
out.

### Broadcast out, proofs and statuses in (#65)

A transaction is self-validating, so neither its broadcast nor its proof is
a signed message to or from anyone. Only how it *stands* on the network
(Arcade's word) needs an attestation, and that is optional.

**The chain app is the recipient of all three** (#78): an instance's chain
state — headers, transactions, proofs, spends, settlement, broadcasts — is
global to it and has one writer, the chain module
([shruggr/skein-chain](https://github.com/shruggr/skein-chain), its
contract that repo's docs/CHAIN.md), under `chain/state`. It takes the
host's header feeds and the broadcaster's proofs (events in box `chain`),
the status provider's messages (box `chain/status`, its optional row from
`$status`; #128: a manifest's box is relative to the app, `"status"` → `chain/status`), and is the only thing that emits the broadcast event. Anything
else that needs a transaction on the chain sends it a BEEF —
`{fn: "ingest", args: {beef}}` in box `chain` — and is answered at its
address. The wallet and the overlay apps are programs of the same
instance: they emit the ingest to the instance itself (docs/VM.md "emit":
the host's loopback), routed by the chain app's box route (#143: no sender —
the route names `kernel.beef`, and the chain app judges its caller), end
their step awaiting that message, and each answer steps them again (#79). The
answers come at once when it arrives proven, else on each state change
(`accepted` on the first status that is not a rejection, `proven` on its
proof, `rejected`), several `{fn, request, replyTo, result}` answers to one
request. **Every unproven transaction at rest has a registered broadcast**
(a record in the chain state's `broadcasts`); proof triggering is the answer
to that broadcast — the chain app's thread awaits the transaction's CID —
not separate wiring. Its routes (its manifest, #143):

```
{"transport": "event", "address": "", "handler": "chain"}                     the host's events (feeds, the broadcaster's proofs)
{"address": "", "filters": ["kernel.beef"], "handler": "chain"}              messages: the instance's own apps, root
{"address": "status", "handler": "chain"}                                    the status provider, box chain/status
```

Neither the wallet nor an overlay app takes these events or broadcasts
(#79). The rest of this section is the wire contract between the host and
the chain app.

**Broadcast out is an event.**

```
emit({event: "broadcast", tx: <the transaction's CID>, beef?: bytes})   → the event record's CID
record  {kind: "broadcast", tx: <cid>, beef?: bytes}                     (Zig: sk.broadcast(a, tx, beef))
```

- `tx` is a `bitcoin-tx` CID of a transaction in the store; `beef` (its
  Atomic BEEF) gives a broadcaster the ancestry it needs (Extended Format).
  No recipient, no signature, no signer call. The record is listed in the
  step's `emitted` with the messages, recorded, never re-executed on replay,
  and goes out when the step ends without error — handed to the host
  (transport `event`) — and again at a start while the thread awaits the
  transaction's CID. (Any other event name is accepted since #119: "emit",
  above.) Errors: `emit: a broadcast names its transaction: …` · `emit:
  <cid> is not a transaction in the store (put it first)` · ``emit: `beef` is
  bytes (an Atomic BEEF)``.
- The step then `await`s the transaction's CID (with a `deadline` at its
  abandonment) and ends. The instance never sees a URL, a 503 or a retry.
- **The reference host's wiring** (`src/host/arc.ts`): a durable queue in
  host.db, the transaction posted to its one Arcade under its callback token
  (Extended Format), retried with backoff while Arcade does not take it (a
  503, no answer), taken up again after a restart, given up after a day. A
  host with no Arcade drops the event (a line in its log); the instance
  abandons the transaction in time.

**Proof in is an event**, through specific wiring — never an open box:

```
event (box "chain")  {kind: "proof", subject: <tx CID>, txid (hex), path: bytes (BRC-74), blockHash?, blockHeight?}
```

- The reference host admits it from its Arcade session (a MINED or IMMUTABLE
  status carrying the BUMP, by SSE or webhook), the same way it admits a
  header from a feed, into **every instance whose state holds the
  transaction** (a `has` read of its CID). It steps the thread awaiting the
  transaction (input `event`), else the first `mailbox` row on `chain` from `event` (or anyone): the chain app's.
- The VM records a proof only when its root is the header's at that height
  in the instance's own chain (a header not held yet leaves it pending).
  Nothing is signed; nothing needs to be.
- The overlay's `libp2p:<topic>-proof` route (#74) is the other wiring: a
  peer's proof for a transaction the overlay admitted under that topic (or
  holds pending), checked in the call against the instance's own chain and
  admitted as this same event with `via: "libp2p:<topic>-proof"` (so it is
  not re-published); anything it cannot check is `ignore`.

**The status provider is optional.** Intermediate and terminal statuses
reach an instance only as signed messages from a status provider it
subscribes to:

```
message  box "chain/status", subject: <tx CID>, from the status provider's key (no replyTo)
body     {kind: "status", txid (hex), txStatus, blockHash?, blockHeight?, extraInfo?}
         txStatus: RECEIVED, SENT_TO_NETWORK, ACCEPTED_BY_NETWORK, SEEN_ON_NETWORK, SEEN_MULTIPLE_NODES,
                   MINED / IMMUTABLE (with no path), REJECTED, DOUBLE_SPEND_ATTEMPTED, INVALID, MALFORMED
```

- **Taking statuses** is a row `{transport: "mailbox", address: "chain/status",
  sender: <the provider's key>, program}` (the chain app's manifest writes
  `{"address": "status", …}`, resolved under its name, #128; a system tree writes
  `{"address": "chain/status", "sender": "$status", "program": "chain"}`, #78), and
  the provider in the address book (at `local` `status`), which the genesis seeds
  when the host has one — how a program knows one speaks to it. The message
  steps the thread awaiting the transaction (input `message`), else the
  row's program (args `{message, body, box: "chain/status", sender}`). An
  instance with no such row records the message and runs nothing.
- The reference host's status provider is its broadcaster's identity (key ID
  `status`): every status Arcade reports but a proof — its answer to the
  post (RECEIVED; a 400 as REJECTED with `extraInfo` its reason) and its SSE
  and webhook statuses — goes to every instance holding the transaction,
  once (a redelivery writes nothing; the answer to a later broadcaster's
  post reaches it even if routed before). Arcade does not sign its statuses:
  the provider's signature is the attestation.
- **Without a status provider** an instance still works: it learns
  acceptance by the proof arriving, and rejection by a competing proof
  (`double-spent`) or abandonment at `walletAbandonMs`.
- Arcade itself may later be the status sender (a signed-message callback
  beside webhook and SSE): an instance would subscribe to Arcade's key
  instead, and nothing on its side changes.

**The overlay's gate** (shruggr/skein-overlay docs/OVERLAY.md, #73, #79):
there is no setting, and the overlay holds no chain state. A submission is
handed to the chain app (`ingest`) and admitted on the chain app's
**first** admitting answer — `accepted` (a status provider's first status
that is not a rejection) or `proven` (a validated proof) — and never on
`rejected`. With no status provider subscribed (a `status` row), no status
ever arrives, so the chain app answers only at the proof and the overlay
admits there. Admission on validation alone is not a mode. A submission
admitted on `accepted` keeps listening (the overlay's watch of the same
ingest message): `proven` publishes its `-proof`, a later `rejected`
removes its judgements.

### Scheduling: the waker and the cron provider (#69)

A schedule originates in a step, never in host configuration; the wake or
the tick comes back as a signed message from the service's identity,
verified at the front door like any message.

**The waker** (#126): a step's `deadline(until_ms)` and a shell's `sleep`
are `deadline` intentions (above, "Intentions"). The host's waker keeps
each in its own timers (once per event: a kernel's start hands over again
what a waiting thread awaits) and at `at` answers with its signed message
`{replyTo: <the event>, request, at}` in box `wake`: the thread steps with
`woke: true` (one stamped before `at` runs nothing); a shell is re-executed
from its origin and carries on past the sleep under that entry. (A wake-me
message to it in box `wake`, `{at: ms}` — a kernel before #126 — is still
answered `{replyTo, at}`.)

**The cron provider** (the host's, at `local` `cron`; box `cron`):

```
tick  {fn: "tick", every: <ms> | at: <ms since the epoch>, box, body?: {…}, name}
      → {replyTo, name, next: <ms>}
      then each tick: a message from the provider into `box` (no replyTo):
      {...body, kind: body.kind ?? "cron", name, due: <ms>}
stop  {fn: "stop", name}   → {replyTo, name, stopped: true | false}
error → {replyTo, error}   ("the cron provider takes {fn: "tick", …} or {fn: "stop", name} in box "cron"": …)
```

- A schedule is the instance's, by `name`: a tick request replaces the one
  of that name. `every` ticks at once, then on its grid; a tick the
  provider was late for is one tick, never a burst (the next grid point
  after now). `at` ticks once — at `at`, or at once if past — and is then
  gone. `box` is a box name (not empty, not starting `:`); `body` a map.
- **A tick is routed by the dispatch table** on (the cron provider's key,
  `box`), or a row from anyone on `box`: the program gets `{message, body,
  box, sender}`. The reference host wakes an idle-stopped instance for a
  tick only if a row in it takes that box.
- **The reference host's cron provider** (`src/host/cron.ts`) keeps the
  schedules in host.db (`cron_schedule`): at a host start each `every`
  schedule ticks once (a restart is a late tick), each `at` one at its time.
  `skein-host event <agent> <box> [json]` sends a tick due now by hand.

**Local or remote, the address book decides.** A provider's key is in the
address book with a transport: `local` (the host hands the message to its
own provider, no transport, no handshake) or `mailbox` (the instance's own
delivery thread carries it over BRC-103/104 to the provider's messagebox —
a paid tick service elsewhere). The program does not know which: it emits
to the key it is given or the one its host serves (`sk.peerAt(a, "local",
"cron")`; #126: no roles) and its ticks come back the same way. `src/peers/cron.ts` is a remote cron service: it collects its
mailbox's `cron` box and answers, and ticks, at the sender's messagebox
(its own address book's), on a BRC-104 session of its own.

### Delivery to a messagebox: authfetch (#70, #126)

A `mailbox` recipient's message is delivered by the instance itself: the
kernel launches the messagebox program as the message's **delivery thread**
(origin `{program: messagebox, args: {message, transport: "mailbox"}}`),
which POSTs it with the kernel's **`authfetch`** (#126,
`programs/messagebox/deliver.zig`):

```
step 1   authfetch(<url>, {POST /sendMessage, content-type application/cbor, BRC-231 CBOR {message:
         {recipient, messageBox, body, subject?, nonce}} — the BRC-33 message, and the emit's own
         subject and nonce; no signature});
         200 → finished {delivered: <cid>, url, attempt} (the recipient keeps the same record under
         the same CID; another CID in the answer fails the delivery)
```

- **The session** is the kernel's (docs/VM.md "authfetch"): per server base
  URL, in memory, the BRC-103 handshake made when there is none and again
  when the server answers 401; the request signed and the answer checked
  through the signer; the exchange a recorded call on the step. `server` is
  the identity that answered the handshake — the recipient's own, or a
  mailbox instance's for a mailbox kept for someone. Sending never tells
  the peer who we are beyond the session (no claim, no registration, #40).
- **The session is the proof** (#126 step 4): the recipient's front door
  verifies the BRC-104 request and keeps the record with `sender` the
  session's identity; nothing in the message is signed. A mailbox instance
  keeping mail for a wallet keeps it for that wallet to read; it is never
  forwarded into a skein ("Mailbox instances", above).
- **Failure.** `transient: …` (no answer, 5xx, 408, 425, 429) is tried again
  `defaults.sendRetryMs` later (default 30 000; a `deadline`) up to
  `defaults.sendAttempts` attempts in all (default 3); anything else, or
  the last attempt, ends the delivery thread errored, and the thread
  awaiting the message is stepped with `undelivered: {message, error}`.
- **Two instances on one host** deliver to each other through the router's
  in-process path (authfetch's bytes go there too).

A program that speaks another request/response protocol to a BRC-104
server uses `authfetch` the same way; a plain HTTP request is a `fetch`
intention (the host's proxy, signed by the instance's key).

### Resolving a handle

`emit` takes a key, never a handle. A handle is looked up by **launching**
the resolve program (`sk.launchResolve(a, in, handle, domain, key?)`; args
`{handle, domain, key?}`): this step then waits on that thread, and when it
comes to rest the launcher is stepped again — finished, the resolve
program's records (`resolve/peers`, #87) name the handle (the thread's
result is the record's CID), and the launcher may emit to the key; errored, the
lookup failed (`transient: …` when no answer came, or a 5xx). `key` is the
identity the launcher expects; another answer is refused.

## BRC-169 is discovery

BRC-169 is used for one thing: a handle to an identity key and a messagebox
URL. It is a program, not the core: the resolve program's thread fetches
`https://<domain>/manifest.json` (`metanet.handles.resolve`, default
`/.well-known/metanet-handles/resolve`), then `GET <resolve>?handle=<handle>`
→ `{identityKey, messagebox, …}`, each GET an emit to the `fetch` provider
and its answer the next step, and keeps `{kind: "resolution", transport:
"mailbox", address: <messagebox>, …}` (source `resolve`) under its own head
`resolve/peers` — never the address book (#87). The instance's own domain is looked up at
`defaults.resolveOrigin` (a dev host). The BRC-52 certificate in the answer
is neither checked nor kept: the program reads `identityKey` and
`messagebox`.

**The host's BRC-169 server is the host skein's onboarding app** (#113,
shruggr/skein-onboard ≥ 0.2.0). The router answers none of it: a request
at the host's own origin (a host name whose first label is no instance) for
one of these goes to the host skein, as any request goes to its instance —
appended as a request entry, the app's route handler answering:

| at the host's origin | the host skein's route |
|---|---|
| `GET /manifest.json` | `/onboard/manifest.json` |
| `GET /.well-known/metanet-handles/resolve` | `/onboard/resolve` |
| `GET /.well-known/metanet-handles/search` | `/onboard/search` |
| `GET /bsvalias/id/<handle>[@<domain>]` | `/onboard/bsvalias/id/…` (a prefix row) |
| `POST /.well-known/auth` | `/.well-known/auth` (the BRC-103 handshake: the host skein's session, #135) |
| `POST /account/register` | `/onboard/register` ("Mailbox instances", above; signed, #135) |
| `POST /account/profile` | `/onboard/profile` |

A host with no host skein answers them 404. The app's configuration
(`config.onboard` of its installed manifest, written at the host skein's
birth from the host's settings, #142, or by `skein install
images/host/apps/onboard --config <file.json>`): `domain`, the **handle domain** (default
`localhost`); `origin`, where the manifest says resolve and search are
(default `https://<domain>`); `name`, `note`, `icon`, the host's
presentation in `metanet.trust` (§5.1); `ordfs`, the ORDFS content route
`avatarURL` is derived under (default `https://api.1sat.app/content`; empty:
none). The domain is never the request's host name: one setting, used by
register, resolve, search, the paymail PKI and the manager's `create` (the
row's domain).

**The records** (the app's heads, its write scope `onboard/…`):

```
onboard/instances/<handle>  → the instance manager's answer record ({handle, identity, url}, signed)
onboard/handles/<handle>    → the current certificate record:
    {kind: "handle-certificate", handle, domain, subject: bytes(33), messagebox, issuedAt,
     serialNumber, issuance: <issuance record>, prev?: <the certificate record before>,
     certificate: <the resolver's copy>, holder: {certificate, keyringForSubject}}
onboard/profiles/<handle>   → {kind: "handle-profile", handle, subject, profile: bytes, signature: bytes}
onboard/index               → {kind: "onboard-index", handles: {<handle>: <certificate record>},
                               keys: {<subject hex>: <handle>}}
```

**Issuing a certificate** (a registration, an adoption, and `onboard.create`
for the new skein's own identity). The app's thread puts the **issuance
record** `{kind: "handle-issuance", handle, domain, subject, messagebox,
issuedAt, request, prev?}`; the serial number is base64 of its SHA-256 (the
digest its CID names), so every issue has its own. It asks the host's
**certifier** (a provider the host skein's address book alone names, as the
instance manager; "The providers", below) `issue {handle, domain, subject,
serialNumber, issuance}`; the certifier signs and records nothing. Its
answer `{certificate, holder: {certificate, keyringForSubject},
serialNumber, issuance}` becomes the certificate record, the head
`onboard/handles/<handle>` moves to it, and the index follows. The key stays
with the host (the certifier key, the master's child under `[2, "skein
provider"]`, key ID `certifier`); the request and the signed answer are
entries in the host skein.

The two copies of one issue are the same binding (type §4.5's, serial
number, subject the identity key, certifier the certifier key, revocation
outpoint):

- **the resolver's copy** (`certificate`): the SDK's `Certificate.sign`,
  `fields.handle` and `fields.domain` Base64 of the plaintext (as §A.3; not
  BRC-52 field encryption, so any resolver can check them, §4.1 rule 3);
- **the holder's copy** (`holder`, #103): `MasterCertificate.issueCertificateForSubject`
  — BRC-52 field encryption and `keyringForSubject`, the field keys
  encrypted for the subject — because a BRC-100 wallet's
  `acquireCertificate` (direct) takes only that (wallet-toolbox rebuilds a
  `MasterCertificate`, which wants a keyring entry per field). The page
  passes it with `keyringRevealer: "certifier"`; later
  `listCertificates({certifiers: [<the manifest's certifier>], types: [<the
  handle type>]})` returns it, its `keyring` decrypts `handle` and `domain`
  (`MasterCertificate.decryptFields`, the certifier as counterparty), and a
  resolve gives the messagebox.

**Revocation is not implemented: the host has no wallet.** The
`revocationOutpoint` is BRC-52's disabled sentinel (64 zeros, `.0`), not an
outpoint the certifier controls (§4.1, §4.2); the five-minute `ttl` is all
that bounds a resolver's copy. Every issue is kept (each record's `prev`),
which is what revocation will use.

**The manifest** (§5.1): `metanet.trust` — `name`, `note`, `icon` from the
app's config, each only when set, and `publicKey`, the certifier key (the
address book's `certifier` entry) — and `metanet.handles` (`version` "1.0",
`resolve` and `search` under the configured origin).

**Resolve** (§5.2): `GET /.well-known/metanet-handles/resolve?handle=<handle>`
(or `<handle>@<domain>`, `@` first or not, a `+tag` dropped, any case;
without a domain, the handle domain) → `{metanetHandles: "1.0", handle,
domain, identityKey, certificate, messagebox, ttl: 300, revoked: false}` from
the handle's current certificate record: `certificate` the resolver's copy
as issued (not signed again per request), `identityKey` its subject — a
mailbox instance's owner, or an onboarded skein's own identity — and
`messagebox` the instance's origin. Errors are §5.3's (`400
malformed-handle`; `404 handle-not-found`, another domain included). With
a kept profile (#104) the answer adds (§5.1 item 3: clients ignore fields
they do not know)

```
profile: {record: <base64 of the DAG-CBOR bytes>, signature: <hex DER>,
          protocolID: [1, "metanet handles profile"], keyID: "1"}
displayName: <the name>                      §5.6's hints, derived for
avatarURL: <ordfs>/<txid>_<vout>             standard clients; unattested
```

The profile is the record the OpNS name coin carries in its `profile` field
(1sat-sdk#83): DAG-CBOR `{domain, name?, avatar?}`, written and read with
`@1sat/utils`' `encodeProfile` and `decodeProfile`; `avatar` is the 36-byte
outpoint of an image inscription (`@1sat/templates`' `outpointToBytes`).
The app checks it when it is posted (the signature for the handle's key,
its `domain` the handle domain) and serves it only for that key. Our page
verifies `profile` itself against the identity key and shows it as signed
by the handle's key; the hints only without one, as unattested (§2.4 item
8).

**Search** (§5.6, #104): `GET /.well-known/metanet-handles/search?q=&limit=`
→ `{metanetHandles: "1.0", results: [{handle, identityKey, displayName?,
avatarURL?, profile?}], truncated}`: the handles the app has records of, in
handle order, whose handle or profile name contains `q` (any case; an empty
`q` lists them all), at most `limit` (default 20, at most 100). Results are
hints: no certificate comes with them.

**The paymail PKI**: `GET /bsvalias/id/<handle>[@<domain>]` → `{bsvalias:
"1.0", handle: "<handle>@<domain>", pubkey}` from the same records (without
a domain, the handle domain); 404 `{error: "not found"}`.

An emitted message carries no BRC-169 envelope signature (#126 step 4): a
BRC-169 peer knows its sender by the BRC-104 session it came on.

## Calls

Route handling is never a kernel call any more (#68): every request is a
step. The kernel `call` (a program's function over the current state, no
entry, no writes, fuel-limited by `defaults.callFuelLimit`; docs/VM.md,
"Calls") stays for **host-side reads that are genuinely not requests**:
the answer of a route whose handler answered `{read: true}` (the
explorer's: the front door's fn `read`), and later the broadcaster's
questions of an instance (#65). A call needs no determinism: nothing it
does is recorded. Its fuel is charged to the host's ledger. From a step, an
in-VM `call` is part of the step (its recorded calls and head moves are the
step's) — that is how the front door calls a route handler.

### Calling an app: `{fn, args}` and the answer message (#72)

An app's box takes `{fn: "<interface>.<function>", args}` (docs/APPS.md
§4). Its handler (the SDK's `app.serve`, skein-sdk ≥ 0.3.0: it reads `<app>/app`) answers with a
message to the sender, in the same box, when the address book reaches the
sender:

```
{fn, request: <the request message's CID>, replyTo: <the same CID>, result}
{fn, request, replyTo, error: {code: "bad-request" | "unknown-fn" | "bad-args" | "read-only" | "failed", message}}
```

`replyTo` routes it as a reply: a program that emitted the call and awaits
the message's CID is stepped with it (`reply`, above). Over HTTP, the
app's route `{transport: "http", address: "/call", filters: ["kernel.brc104"],
handler: "<role>.call"}` takes the same `{fn, args}` as the POST body and answers `{fn,
result}` or `{fn, error}` on the connection (200; 400, 403 `not-admitted`,
404, 409, 500).

## libp2p (#51)

The same front door, another transport. The host's libp2p node
(docs/ARCH.md) appends each GossipSub message on a subscribed topic (inside
GossipSub's async validator, so forwarding waits on it) and each frame read
from an inbound stream on a served protocol as a `request` entry, transport
`libp2p`, as received, and waits on the thread the front door is stepped on
(#66) for its answer:

```
request {kind: "p2p", topic, from: bytes (the peer ID's multihash), seqno: bytes(8), signature: bytes, body: bytes}
        {kind: "p2p-frame", protocol, from: bytes, body: bytes}
answer  {verdict: "accept" | "reject" | "ignore", reason?, admit?: [entry], body?: bytes, close?: bool}
```

- **Routing.** The kernel matches the route table's `libp2p` routes (#115,
  #143, dispatch.zig `forLibp2p`) and hands the front door the route: the
  one whose address is the topic or `/<protocol>` exactly (the publisher's
  key, from `from`, is the principal: the transport's own check).
  `{transport: "libp2p", address: <topic>, filters?, program, fn}` for a
  topic, `address: "/<protocol>"` for a stream protocol (from
  `etc/dispatch.json`; a protocol's handler named in
  `etc/config.json` `libp2p.protocols` becomes its row; or installed by an
  app, #72: a manifest's pre-configured topic, OpNS style). A topic no row
  is at is matched by a **subscription** (below). Neither: `ignore`. The
  handler gets `match`, the row that matched, as an HTTP row's handler does.
- **Subscriptions** (#119). An app takes a topic at run time by emitting
  `subscribe {topic, program, fn, filter?}` (an event: "Outbound: emit",
  above), and gives it up with `unsubscribe {topic}`; nothing is declared in
  its manifest. A subscription is the delivery record: the kernel delivers a
  message on that exact topic to the app's `program` (a role in its record
  at `<app>/app`, resolved when the message comes) at `fn` — the front door
  is handed `{transport: "libp2p", address: <topic>, program: <the role's
  record>, fn, app, filters?}` as `match` (a subscription's `filter`, the
  SDK's `"beef"`, is `kernel.beef`), and the door, its filters and the
  handler's call run exactly as for a route. No row is needed
  or consulted for it. A subscription is the app's own, keyed by (app,
  topic): an app's subscribe replaces its own; another app's subscribe of the
  same topic is that app's and does not take the topic — the first standing
  subscription delivers; an unsubscribe ends only the emitting app's. **A
  topic with both a row and a subscription: the row wins** (a row at the
  topic, whatever its sender rule, and the subscription delivers nothing).
  The subscriptions are derived, never written: the fold, in log order, of
  every `subscribe` / `unsubscribe` record the steps' updates list in
  `emitted` — by the processed entry's `n`, the step's `at`, the thread's
  `at`, the thread's CID, the step's place in its thread, the event's place
  in `emitted` (kernel-zig/src/subscriptions.zig `fold`). The kernel keeps
  the fold in memory and folds again after a step that subscribed or
  unsubscribed; replay folds the same. A subscription whose app's record no
  longer names the role (an uninstall) delivers nothing.
- **Beacons** (#126). An app declares once `beacon {topic, every: <ms>,
  body: bytes}` (an event, checked as it is emitted: an installed app's, a
  topic, `every` from 1 000 ms to a day, `body` at most 64 KiB) and stops it
  with `unbeacon {topic}`; no answer comes. The instance's node publishes
  a NEW message on `topic` every `every` ms on its own clock — the declared
  body plus the beat's time, signed by the instance's signer (as the host
  signs an intention request), so each beat is fresh and attributable to
  the instance — and logs nothing per beat. The beat as published (p2p.ts
  `beaconFrame`; `beaconBeat` reads and checks one):

      dag-cbor {body: bytes, at: int (ms since the epoch, the host's clock),
                sender: bytes(33) (the instance's identity key),
                signature: bytes (DER)}

  `signature` is the instance's, [2, "metanet handles envelope"] / key ID
  `send` / counterparty anyone, over sha2-256 of dag-cbor {kind: "beacon",
  topic, body, at, sender} — the topic is signed, not carried. GossipSub
  signs the message too, with the node's peer key. A receiver checks the
  signature against `sender` and `at` against its own clock. The beacon does not make
  the node subscribe the topic (a node with nothing else to do is started
  for it). Keyed by (app, topic) like a subscription; the host folds them
  from the log (src/host/p2p.ts `beaconsOf`) and follows them live; an
  app's beacons stop when its rows are gone (an uninstall). If the host is
  down, nothing beats: a true heartbeat.
- **Liveness (#138).** Who is beating on a topic stays outside the log: an
  app declares once per topic `liveness {topic, window: <ms>}` (an event,
  checked as it is emitted: an installed app's, a topic, `window` an
  integer from 1 000 ms to a day) and stops it with `unliveness {topic}`;
  no answer comes. Keyed by (app, topic) — an app's liveness replaces its
  own window — folded from the log like the beacons (kernel-zig/src/
  subscriptions.zig `livenessFold`; the host's src/host/liveness.ts
  `livenessOf`), followed live; an app's liveness ends when its rows are
  gone (an uninstall). The runtime's liveness tool (src/host/liveness.ts),
  for each such topic:
  - subscribes it at the instance's own node **without admitting** its
    messages: no front-door call, no entry, nothing logged (a topic that a
    row or subscription also takes is admitted as before, and the tool sees
    it too);
  - reads each message as a beacon beat (above) and checks its signature
    against `sender`; one that does not verify is dropped (GossipSub:
    reject);
  - keeps the beats newer than `window` (by `at`, against the host's clock;
    one dated more than a window ahead is not believed), the latest per
    sender, with the peer that published it; the node's **own** beats on
    the topic are written into the same set (gossip does not echo them);
  - holds them in memory only: empty after a restart until the next beats.

  The set is served by the host on the instance's origin, no program in
  between:

      GET /<app>/.live/<topic>     (http://<handle>.localhost:<port>/… or /@<handle>/…)
      200 [{sender: <identity key, hex>, at: <ms>, body: <base64>, from: <peer ID>}, …]   newest first,
          only the beats newer than that app's window
      404 when <app> keeps no liveness for <topic>

  An unsigned read: no entry, nothing logged; metered as a read (bytes
  served, billing.ts). A runtime without the tool records the events and
  nothing happens. Beats are unbilled for now (#130).
- **What the node subscribes** (#72, #77, #119). The instance's node takes
  the genesis's `libp2p` (topics, protocols, listen), the topics and
  protocols named by the `libp2p` rows added since the genesis — an app's
  install (src/host/p2p.ts `libp2pConfig`); a genesis row alone subscribes
  nothing: a tree says what its node takes in `config.libp2p` — and every
  topic a subscription takes. After the kernel has processed what the host
  handed it, the host reads the table (the kernel's `dispatch` frame); when
  its chain's tip moved, it declares the config again: new topics subscribed
  and protocols handled, removed ones unsubscribed and unhandled, on the
  running node — started if the instance had none, stopped when nothing is
  left. No restart. A `subscribe` / `unsubscribe` event handed over after
  its step's commit changes the subscriptions the host follows and declares
  the config again the same way; the host does not route: an inbound message
  goes to the kernel, which finds the row or the subscription. **After a
  restart the host recovers by reading** (David, 2026-10-05): at hydrate,
  beside reading the dispatch table, it folds the log the kernel's way
  (src/host/p2p.ts `subscriptionsOf`). The app does not emit again and the
  kernel writes nothing for it; another host may keep them otherwise.
- **Verify at the door** (#121). For a topic message the front door's fn
  `verify` checks, from the request alone and before its entry is written,
  that `from` is a secp256k1 peer ID (identity multihash of
  the key's protobuf) and that `signature` is its ECDSA signature (DER,
  sha2-256) over `"libp2p-pubsub:"` ‖ protobuf `{1: from, 2: body, 3: seqno,
  4: topic}` — GossipSub's StrictSign. A bad one is turned away (`reject`;
  #143: no entry), and nothing runs. Then the route's filters (an overlay's
  `<topic>` route: `kernel.beef`, the body's BEEF decoded and replaced by its
  pointer record; a bad BUMP is `reject`; no chain state to check it by,
  `ignore`).
  Then the handler (the route's program and fn, an in-VM call) gets the
  request plus `key` (the 33-byte key out of `from`) and `request` (the
  record's CID), and judges from state: `{verdict, admit?}`. A handler that
  fails is `ignore` (cannot evaluate: no penalty for the forwarder). The
  record as logged re-verifies once its body is put back (docs/VM.md "The
  door": lossless): a redelivery carries the original bytes, is decoded to
  the same record, and is `seen`.
- **What accept admits.** The message itself first, as an event:

  ```
  {event: {kind: "p2p", topic, from: bytes, seqno: bytes(8), signature: bytes, body: bytes}, box: "libp2p:<topic>"}
  ```

  — the request record — and then every entry the handler returned in
  `admit`, unchanged: the same entries the `http` side routes for the same
  handler (#57: persistence is not a transport concern; an overlay's
  `submit` on a `libp2p:<topic>` route persists what `POST /submit`
  persists). The kernel routes them after the step, in order. The request
  entry re-verifies from the log alone, with no host: the publisher's key
  is in `from`, and the signature covers topic, seqno, from and body — the
  same guarantee as a mail record's sender, 104 signature and nonces. The
  `p2p` event routes as any event: the thread awaiting its `subject` (none
  here), else a `mailbox` row from anyone on `libp2p:<topic>`; with none
  nothing runs. **Reject and ignore are recorded refusals**: the request's
  entry and thread, nothing else (a handler's `admit` beside them is
  dropped).
- **A redelivered message** (#42, decided 2026-09-30) is recorded as
  received and ignored. The record is content-addressed (topic, from,
  seqno, signature, body), so GossipSub delivering the same message again —
  after its seen-cache expired, or from another peer — is the same record;
  its first accept put it in the kernel's `unique` map, and the front
  door's first step is told (`seen`) and answers `ignore` (no forward, no
  penalty) with nothing routed. A message ignored or rejected before is
  judged again on redelivery. Other events (a feed's header or status) are
  not unique.
- **Streams.** A frame is not signed (the stream is authenticated by Noise;
  `from` is the remote peer). The handler answers `{body?, admit?, close?,
  verdict?}`: `body` is written back on the stream as one frame, `admit`
  (entries, as an HTTP route handler returns them) is routed, `close` or
  `reject` ends the stream. A frame's handler may wait on a thread as an
  HTTP route's may (`{wait: true}`); the frame's answer is written back when
  the request's thread comes to rest.
- **Fuel** is each request thread's, on its updates.

- **Messages** (#70). A frame on `/skein/message/1.0.0` (which every
  node serves) and a message on a topic no route takes are read as a package
  `{message, body}`: a mail record for this instance and its body. Its
  sender must be the key the transport proved (#126 step 4: the stream's
  Noise peer, the GossipSub publisher — `from`); the record carries no
  signature. The front door checks the record and its body and admits it;
  one from another sender is `reject`, one for another identity `ignore`,
  and a frame that is not a package is `reject` (on a topic, `ignore`). The
  reference host's peer key is not the instance's identity: it is a child of
  the instance's root key (#129: [2, "skein instance"], key ID
  `libp2p:<handle>`, counterparty self — what the instance's signer answers
  for getPublicKey with those arguments, so a program knows its own peer
  ID). A receiver cannot tie that child to the identity (a self-derived key
  is computable only by its holder), so an instance's own emit over libp2p
  names a sender its peer ID does not carry, and is refused
  (equiv/emit-events.ts pins it; #126 call 4, open).

Outbound is the `libp2p` provider (above, "The providers"): a step emits
`publish`, `dial`, `send` or `close` to it and awaits the answer; a dialed
stream's frames come back as messages in box `frame`. A message to an
address book entry with `transport: "libp2p"` is carried as a package
`{message, body}` (unsigned). Messagebox delivery stays HTTP.

## Fuel

Every request's fuel is on its thread's updates, in the log (#68), like
every step's: fuel accounting is a query over the log. The host's **fuel ledger**
(host.db `fuel_ledger`: instance, caller, op, calls, fuel; `skein-host
ledger`) keeps what is not in the log: the kernel calls it makes (a read
after a request's thread, op `<route> (read)`).

## Billing (#130)

The wire of billing (docs/VM.md "Billing" is the kernel's side,
scripts/host/README.md "Billing" the host's):

| what | from → to | shape |
|---|---|---|
| the host row | the owner → the skein, box `dispatch` (`skein host`) | `{op: "add", row: {transport: "mailbox", address: "billing", sender: <host key>, program: "kernel", fn: "tick", x, rates?}}` |
| a tick | the host's billing key → the skein, the host row's box, a signed `local` message | `{kind: "tick", at, allowance, fuel, served, log?: <cid of the host's period record>}` |
| a payment | the skein's pay step → its host, the event `payment` (no recipient: the host is the payee) | `{kind: "event", event: "payment", txid: <bitcoin-tx CID>, tx: <Atomic BEEF>, outputIndex, amount, to: <host key>, remittance: {derivationPrefix, derivationSuffix, senderIdentityKey}, checkpoint: <state record CID>}` |
| a funding | anyone → the skein: a BRC-169 envelope by `sendMessage` into `metanet_inbox` (#144), routed to the wallet's `internalize` | the plaintext a BRC-232 transaction delivery: `Content-Type: application/vnd.metanet.transaction+cbor`, DAG-CBOR `{memo?, txid, beef, outputs: [{outputIndex, protocol: "wallet payment", derivationPrefix, derivationSuffix, senderIdentityKey}]}` (docs/WALLET.md "Funding"); root may also send the wallet's `internalize` message on a route of its own |

A skein its host has closed (asleep, or terms the host does not serve) is
sent nothing — a request is 402 — but its funding route: a POST at a route
of its table whose filters name `kernel.brc169`, a BRC-231 `sendMessage`
whose body is an envelope and whose box is routed to the genesis wallet's
`internalize` (src/host/billing.ts `fundingRequest`). The host does not
open the envelope; the door does. The pay step after it wakes the skein.

The payment's transaction has two outputs before any change: the host's
(P2PKH to the BRC-29 key `[2, "3241645161d8"]`, key ID `"<prefix>
<suffix>"`, derived for the host by the skein, counterparty the host's key)
and the checkpoint (0 sats, `OP_FALSE OP_RETURN <the CID, binary>`).

## Chat between instances

An instance talks to another the way David talks to it: a `chat`. There is
one chat body, the same in both directions, whoever the parties are: a new
conversation has no `replyTo`; everything after it is a `chat` **reply**
(`replyTo` = the id of the message it answers). A conversation is pairwise —
one sender, one recipient, `replyTo` one parent — and a thread is one party's
participation in one conversation.

The loop (the chat app, shruggr/skein-chat `programs/loop`, #83) gives the model a `message` tool beside `bash`:

```
message {to: "@handle@domain", text}
```

- **Addressing.** The loop finds the handle in its address book, else in
  the resolve program's records (`resolve/peers`, #87), else
  launches the resolve program (`sk.launchResolve`) and rests on it; when it
  comes to rest the call runs again. A handle that does not resolve is an
  error result.
- **Who the loop sends to, and what it replies to.** Every chat the loop sends
  replies to the recipient's latest message in this thread, if it has one —
  the chats of the party that opened the thread (its user turns), or a party's
  replies to our messages — and rests `waiting` on the answer, as on an
  `infer`:

  | situation | box | to | replyTo |
  |---|---|---|---|
  | the turn's answer (plain text, or an inference error) | `chat` | the opener | the opener's latest message here |
  | `message` to the opener, or to a party that replied to one of our messages | `chat` | that party | their latest message here |
  | `message` to anyone else | `chat` | that party | none: a new conversation there |

  The answer carries `{text, tree, thread, replyTo}` (the working tree and the
  thread, for David's client); a `message` carries `{text, replyTo?}` — no
  tree: trees do not cross instances.
- **The other side.** A chat with `replyTo` is a reply: it resumes the thread
  whose tip awaits that message (sent to the replying sender) before any
  dispatch row, in any box; a reply nothing awaits is recorded and nothing
  runs. A resumed thread that rests on a `message` takes the reply as that
  call's result, `{of: <their chat>, role: "tool", call, to, sent: <our chat>,
  text}`; one that rests on its answer takes it as the next user turn.
- **Undeliverable.** A send whose delivery thread gives up — a key neither
  the address book nor the resolve program's records name (#87: at once), or
  after its retries — steps the loop with `undelivered`. Either way a `message` becomes
  an error result for the model (`{of, role: "tool", call, to, error}`) and the
  loop goes on; its `infer`, an `error` turn answered to the opener as an
  inference error; its answer to the opener, an `error` turn, and the thread
  **finishes**, since the reply it awaited cannot come. Replies to `infer`
  arrive in `completions`, which the genesis `collect`s (default
  `["completions"]`).
- **Two agents alternate on one thread each.** Martha's `message` to Kurt
  opens a conversation on Kurt's side (one thread there); inside Martha's
  thread it is one step: send, wait, resume. If Kurt calls `message` back to
  Martha, that is a reply to her chat and resumes her waiting step with it as
  the result; her next `message` to Kurt replies to his and resumes his; his
  plain answer at the end of his turn replies to her latest too.
- **One at a time.** A step waits on threads or on replies, not both: several
  tool calls in one completion run in order, each `bash` a shell thread and
  each `message` a reply-await. The shell is the shell app's (#83): the
  loop launches the shell program its app record names (head `shell/app`);
  an instance without the shell app answers a `bash` call with exit 127,
  "the shell app is not installed".
- **Inbound.** A new `chat` (no `replyTo`) is routed by the dispatch table; the chat
  app asks for a `chat` row with sender `*` beside the owner's (#83: the
  genesis has none), so other agents can open one.

## Inside the instance

- **Routing** is by the **dispatch table** on `(sender, box)`, first match
  wins, over the rows as they stand when the entry is processed
  (docs/VM.md, "The dispatch table"), seeded by the genesis and changed
  only by the kernel's `dispatch` operation on the owner's (or a
  delegate's) messages. A row may admit anyone (`*`) and take any box (`*`;
  the mailbox instance's catch-all). The program is the **box's program**:
  `(owner, run) → run-handler` (the shell app's row, #83); a kernel row is the kernel's own operation.
- **The handler** knows the box's message shape; its arguments name the
  message record and the body; it reads the body and launches the next thread.
- **A handler that errors** ends its thread `errored`, and that is all: no
  reply, no bounce.
- **Replay protection** is the mail record's uniqueness: the same record is
  admitted once, whoever delivers it.
- **Results** go to the sender of the request that started the thread, sent
  by the step (`send`), so their id is known and recorded before the step
  ends.
- **Nothing is a message that isn't one.** Genesis is starting state; a
  session and an acknowledgement are events, not messages.

## The infer protocol

Between the loop (shruggr/skein-chat `programs/loop`) and the inference peer (`src/peers/infer.ts`,
`bin/skein-infer`), as decided in issue #12. The peer is **stateful**: it
holds each sender's conversation graph; the engine behind it (an
OpenAI-compatible endpoint) is not. Requests go in the peer's `infer` box (its
mailbox instance), replies come back in the instance's `completions` box with
`replyTo` = the request's id, as for any reply. Both bodies are dag-cbor
records. The peer reads its mailbox instance with raw BRC-33
(`SKEIN_MAILBOX_URL`) and answers a sender at the messagebox its own address
book names for it (`SKEIN_INFER_PEERS`, default `~/.skein/infer-peers.json`:
`{"<key hex>": "<messagebox URL>"}`, which `scripts/host/up.sh` writes for
every agent; read again when it changes). A request from a key not in it has
nowhere to go: dropped, with one line.

**Nodes.** A node is one of the loop's `turn` records exactly as the instance
keeps it, so its CID is the same on both sides. Every turn names the turn
before it:

```
{kind: "turn", parent?: <turn cid>, of, role, …}   (the system turn, the root, has no parent)
```

so a conversation is a chain of nodes keyed by CID, and a fork or a revert is
nothing more than a node naming an earlier parent. What each role carries is
listed in shruggr/skein-chat `programs/loop/main.zig`.

**Request** (`infer`):

```
{ model: "<provider>/<model>", thinking?: "off"|"low"|"medium"|"high", tools?: [<OpenAI tool>],
  parent?: <node cid>, nodes: [<turn>, …] }
```

- `nodes` are the turns new since the last request on this conversation, in
  order: `nodes[0].parent` is `parent`, each later node's is the one before.
  The loop sends the turns from its latest assistant turn on and names that
  parent. The first request of a conversation has no `parent` and carries the
  whole conversation, root first.
- `model` and `thinking` are per request. The loop takes them from the
  latest user turn — a `chat` may carry `model` and `thinking` beside `text`
  — else from the genesis defaults (`defaults.model`, else `ripper/qwen38`;
  `defaults.thinking`). The peer maps `model` to its provider table
  (`<provider>/<model>`: the provider's `baseUrl` and `apiKey`, the engine's
  model name after the slash) and `thinking` to the engine's
  `chat_template_kwargs.enable_thinking` and `reasoning_effort`; absent, the
  engine's default.

**The peer.** It checks that the nodes chain, stores them, and walks from the
newest node back through `parent` to the root. The path becomes the engine's
whole chat: system → `system`, user → `user` (`text`, then its
`annotations`, if any), assistant → `assistant` (`content`, `tool_calls`),
tool → `tool` (`tool_call_id` = `call`; a shell's `exit N`, stdout and
`[stderr]`, or a message's answer, or `error: …`); other roles (the loop's
`error` turns) are left out. Nodes are held per sender identity — one
sender's CIDs never reach another's chat — in memory (the most recently used
`SKEIN_INFER_NODES`, default 50000) and on disk (`SKEIN_INFER_CACHE`, default
`$SKEIN_HOME/infer-cache`, one file per node at `<sender>/<cid>`, checked
against the CID when read back; `""` for memory only). Nothing prunes the
directory.

**Reply** (`completions`), one of:

```
{ replyTo, message: {role: "assistant", content?, reasoning?, tool_calls?}, usage?, model, ms }
{ replyTo, missing: [<node cid>] }
{ replyTo, error }
```

- **`missing`** is the peer's 404: it does not hold a node the request needs
  and names the first it could not find. No engine call is made.
- **The loop on `missing`** keeps a note beside its turns, `{kind: "missing",
  of: <completions message>, missing}`, and sends the whole conversation again
  (an ordinary `infer` with no `parent`) and awaits that. It retries once:
  `missing` again right after the resend, or for a request that already
  carried the whole conversation, is an inference error.
- A request with `messages` and no `nodes` (a loop from before this
  protocol) is passed to the engine as it is.

## The turn stream

As decided in issue #19. The answer to the opener is still the `chat` reply
with `replyTo` (above), and it still closes the turn. Beside it, the loop can
send the opener ordinary messages in its **`turn`** box: one per event, a
dag-cbor record with a `kind`, sent in the step where it happens, in order,
and never awaited (a failure to send one is ignored). The front end (easel,
#16) reads it.

**Config** (genesis `defaults`, strings; both off by default):

- `defaults.tools`: the optional tools to offer the model, a comma-separated
  list of `say`, `present`, `annotate`. A tool not named is not offered.
- `defaults.stream`: `"on"` sends the non-model kinds as well (`thinking`,
  `log`, `error`, and the opener's own annotations).

**Tools.** `say`, `present` and `annotate` are ordinary tools, called when the
conversation's rules call for them, not by default and not once per turn:

```
say      {text}
present  {page: <markdown or HTML>, blocks?: [{id, …}]}     (ids unique; other fields are kept as given)
annotate {present: <cid>, block?, note}                      (a page presented in this thread; block one of its ids)
```

Each call puts its record, keeps it in the thread, sends it to the opener in
`turn`, and answers the model with a `tool` turn `{of: <the record>, role:
"tool", call, text}` whose text is JSON: `{"say": "<cid>"}`, `{"present":
"<cid>", "blocks": [<ids>]}`, `{"annotation": "<cid>"}`. Bad arguments are an
error result and nothing is sent.

**The opener's annotations.** A `chat` may carry `annotations: [{present:
<cid>, block?, note}]` beside `text`. The loop keeps them on the user turn
and puts each as an annotation record of that turn, kept, and (with
`stream`) sent back in `turn` with its CID.

**Records** (`of` is always a CID; the kept ones are exactly the bodies
sent):

```
{kind: "say",        of: <assistant turn>, call, text}                                   kept · tools
{kind: "present",    of: <assistant turn>, call, page, blocks?}                          kept · tools
{kind: "annotation", of: <assistant turn>, by: "model", call, present, block?, note}     kept · tools
{kind: "annotation", of: <user turn>,      by: "user", present, block?, note}            kept · sent with stream
{kind: "thinking",   of: <assistant turn>, text}                                         a completion's reasoning · stream
{kind: "log",        of: <assistant turn>, call, name, event: "started"}                 a tool call begun · stream
{kind: "log",        of: <tool turn>,      call, name, event: "finished", exitCode?, tree?, error?}   · stream
{kind: "error",      of: <error turn>,     error}                                        · stream
```

`log`, `thinking` and `error` are sent, not kept: the turns hold the same
facts.

## Mail and the session

Mail to a skein is BRC-169 (above, "Mail is BRC-169"): the envelope's
signature is the proof, whoever carries it, and the recipient decrypts
what the courier could not read. A message on a BRC-104 session to the
skein's own front door (another instance's emit through `authfetch`, a
client's own message) is proven by the session instead: the mail record
keeps the signed request, so the proof outlives the session and verifies
from the log with the instance's key alone. What signs itself besides is
what no session of the recipient's carries: a claim, a host provider's
answer, and anything inside a body that must mean something on its own.

## Bodies

A body is **dag-cbor**: the same encoding as every record, so a body is a
record with a CID. JSON clients send and read DAG-JSON; BRC-231 clients send
the bytes.
