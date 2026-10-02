# Messages

How messages enter and leave a skein instance, as built at log format 8.
**The instance is an HTTP server; BRC-169 is discovery; BRC-103/104 is the
network; messages are state.** Skein is a state process: every package a
transport carries in is appended as received and the front door is stepped
on it; sessions are state; a synchronous client waits on the thread. There
is **one way out**: a step `emit`s a signed message to a key the address
book names and ends waiting, and the answer is an entry. **Broadcast out and
proof in are unauthenticated, self-validating events** through specific
wiring (an optional status provider reports statuses as signed messages),
and **scheduling is a message to a provider** (the waker, the cron
provider). **The kernel is the machine, four tables and the oracle**:
objects, heads with their owner, one dispatch table (routes, boxes and
libp2p topics are its rows), the address book; the admin operations are the
kernel's own, on messages from the owner or a delegate; an app writes only
heads under its own name. The host is transports + providers + store +
oracle; it routes nothing ("The dispatch table", below).

## The persistence rule (#68: skein is a state process)

Every package a transport carries in is **appended as received**, and every
step is recorded. There is no in-memory execution path:

- a request — an HTTP request, a GossipSub message, a stream frame — is one
  log entry (`request`), the package as the transport carried it: headers,
  signatures and all. The host verifies nothing;
- the instance's middleware (the front door) is stepped on it, as the
  request's own thread: it verifies, routes, and answers. A refusal (a bad
  signature, no session, no route, a read rule) is that step's answer:
  recorded, and nothing else changes;
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
  decoded BEEF a submit judges, say): a cache in front of the store, not a
  different kind of execution.

A reader with the log can check every message: the request that carried it
is in the log as received, and the mail record carries the BRC-104 signed
request (below), which verifies with the instance's key alone.

## The dispatch table and the kernel's operations (#77)

The kernel keeps four tables: **objects** (blocks by CID), **heads** (name →
root, with an owner: the app the name is under), the **dispatch table** and
the **address book**. The dispatch table is one chain of rows

```
{transport: "mailbox" | "http" | "libp2p" | "local", address, prefix?: true,
 sender: "*" | "event" | "session" | bytes(33), program: <program record CID> | "kernel", fn?, …settings}
```

— a box, an HTTP path (prefix or exact), a libp2p topic or `/<protocol>`;
who may send there (`event`, #79: events only — the host's wiring and a
route's admits, never a message); which program is stepped or called, or which of the
kernel's own operations runs. A route and a subscription differ only in
where the address comes from; first match wins (docs/VM.md, "The dispatch
table", for the full rules). A program never writes the table: there is no
`subscribe` import, no `routes` head. Every change is an **admin message**
from the owner or a delegate at one of the kernel's admin boxes, which the
kernel itself performs — no program is stepped:

| box | body | the operation |
|---|---|---|
| `objects` | `{records: [{cid, bytes}], root?}` | each block stored under its CID (hash-checked); `root` → `main` if there is none |
| `head` | `{name, tree}` | the head advanced to a record in the store (owner = the name's app) |
| `dispatch` | `{op: "add" \| "remove", row}` | the row added (replacing the row with its key: transport, address, prefix, sender), or removed |
| `peers` | `{op: "add", key, transport?, address? \| url?, role?, handle?, domain?}` \| `{op: "remove", key}` | the address book |

Every genesis seeds the owner's four admin rows (`sender` the owner,
`program` `kernel`); delegating administration is the owner adding a row
with the same operation and another sender. A refused operation (a bad
body, a record not in the store) is a log line and nothing written. The
client commands: `skein import` (objects), `skein head`, `skein dispatch`,
`skein-host dispatch`, `skein-host peers`, and `skein-host install`
(docs/APPS.md). An app's own writes are heads under its name,
`<app>/…` (docs/VM.md, "Heads"); the front door's sessions are
`frontdoor/sessions`.

## The instance as an HTTP server

Each instance is an HTTP server at an origin of its own. Its **front door**
(`programs/frontdoor`, Zig) is the program that answers: the host appends
the raw request as a `request` entry and the kernel steps the front door on
it; the host holds the client's connection until that thread has come to
rest and returns its answer as the HTTP response (#66, "A synchronous
client waits on the thread", below). The host's HTTP transport (`src/host/router.ts`)
picks the instance by URL and appends; it holds no mail and no sessions,
and verifies nothing.

```
request {kind: "http", method, path, route, query, headers: {name: value}, body: bytes}
entry   {kind: "log", prev, n, time, request: <that record>, transport: "http"}
```

`path` is what the client sent (what BRC-104 signs), `route` what the
dispatch table sees (the host strips `/@<handle>`), header names lower-cased.

```
http://<handle>.localhost:<port>/…     the instance's origin (the Host header)
http://<host>:<port>/@<handle>/…       the same instance, a dev form: the host strips the prefix for the rows
```

**Auth is by key.** The front door runs BRC-103/104 itself, in its step on
the request: the handshake at `/.well-known/auth` and the verification of
every general message, against the instance's session table (below). The
caller is the identity key the session proved; there is no account, no
handle check, no envelope. Answers are signed on the session through the
instance's oracle (the kernel's `wallet`, a recorded call of the step).

- **Sessions are state** (#68). The BRC-103 session table is records the
  front door reads and writes; a handshake is a request like any other,
  and its step writes the new session. Sessions survive a restart (a new
  kernel process, a crash, an idle stop): a client's session is there when
  the instance comes back. Replay needs no session besides: each logged
  message carries the sender key, the 104 signature and both nonces.
  - **Where.** The head `frontdoor/sessions` (#77: the front door's own,
    under its name; `programs/frontdoor/sessions.zig`):
    `{kind: "sessions", buckets: [<bucket> × 16]}`, each bucket `{kind:
    "session-bucket", sessions: [{nonce, peer: bytes(33), peerNonce,
    created}]}`; a session lives in bucket sha256(nonce)[0] mod 16, so a
    request reads one small record and a handshake rewrites the buckets it
    changes and the root. `nonce` is ours (what a request's `yourNonce`
    names); `created` the handshake entry's time.
  - **Lookup and expiry.** A request's session is found by its `yourNonce`.
    Expiry: `defaults.sessionTtlMs` (a day) from `created`, judged by the
    request entry's time. An unknown or expired session gets a plain 401,
    and the standard client shakes hands again by itself.
  - **Bounds and replay.** A handshake drops the expired sessions and, past
    1024, the oldest. A replayed initialRequest (the peer and initial nonce
    of a session held) is refused. A replayed signed request verifies (its
    nonce is not remembered: a replayed read reads again); a replayed write
    is the same mail record, which the kernel admits once (the `unique` map).
    The records are prunable like any others; nothing prunes them yet.
- **Routes are rows of the dispatch table** (#77, below): the `http` rows
  `{transport: "http", address: <path>, prefix?: true, sender: "*" |
  "session" | <key>, program: <cid>, fn, read?: <op>, …the handler's
  settings}`, exact addresses first, then the longest prefix. `sender`
  `"*"` is an open route (no session: an overlay's submit and lookup);
  `"session"` needs a BRC-104 session, any identity; a key needs a session
  proving that identity (another's is 403). The genesis seeds the default
  rows; an app's install adds its rows under `/<app>/` through the kernel's
  `dispatch` operation (docs/APPS.md §3); the front door reads the table as
  it stands on every request. The handler is an in-VM call of `program`'s
  `fn` in the front door's step; what it receives and returns is the
  program-facing contract below ("Route handlers").
- **Static files** (#52, `programs/static`): the handler for a site. A row
  `{transport: "http", address, prefix?, sender: "*", program: static, fn: "get",
  root?, index?}` answers `GET`/`HEAD` with the file at `<root>/<path>` in the
  `main` head's tree — `path` the route past the prefix, percent-decoded;
  `root` default the tree's top; a path ending in `/` (or an exact route on
  a directory) its `index`, default `index.html`; a directory without the
  `/` a 301 to it. `type` comes from the extension (html, css, js, mjs,
  json, map, svg, png, jpg, gif, webp, ico, txt, md, wasm, woff2, pdf; else
  `application/octet-stream`). The `ETag` is the blob's CID (git-raw,
  sha1), and `If-None-Match` naming it is a 304. 404 for a missing file, a
  non-file (link, submodule), a `..` segment, a NUL or a bad escape (nothing
  outside the root is served); 405 for another method (`Allow: GET, HEAD`).
  A read: its request's entry, and no head moves.
- **Reads** (the genesis's `reads`, from `etc/reads.json`): `[{caller?: <key>,
  op}]`. A route with `read: op` answers only a caller the table allows (no
  caller: anyone); others get 403, signed — a refusal, recorded on the
  request's thread. The default reads: the owner may `explore`.

### Route handlers: the program-facing contract (#68, #66)

A route handler is a program function the front door calls, in-VM, in its
step on a request, once the request has verified (or, on an `auth: "none"`
route, at once). Being part of that step, everything the handler does —
records it puts, records it keeps, threads it launches, records or threads
it awaits, heads it moves, recorded calls it makes — is the step's, on the
request's thread, recorded and replayed with it. Its input is the ordinary
in-VM call input (`kind: "call"`, `fn`, the genesis facts, `now` = the time of
the entry that drove the step, `step: {thread, step, entry, at}`) with `arg`
(dag-cbor):

```
{ caller?:     bytes(33)       the identity the BRC-104 session proved (absent on an open route)
  method, path, route, query,  the request as received (path as the client signed it; route as the table saw it)
  headers:     {name: value}   names lower-cased, x-bsv-auth-* included
  body:        bytes
  contentType: text            the media type alone
  session?:    {payload, signature, nonce, yourNonce}   the 104 proof, to keep in what the handler writes
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
  its recorded calls (the oracle's signatures) are served from the log.

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
a head, a record, as DAG-JSON; `programs/frontdoor/explore.zig`).

**The standard AuthFetch** (`@bsv/sdk`, and the `@bsv/message-box-client` over it)
keeps one session per origin and shakes hands at `<origin>/.well-known/auth`.
It is served by the host-name form: one origin per instance, so one session
per instance. The `/@<handle>` form works for a client that sends its
handshake under the prefix too — `RawBox` (`src/client/raw.ts`) rewrites
`/.well-known/auth` to `/@<handle>/.well-known/auth` — and signs the path it
sent, which is what the front door verifies.

## The log, format 8

```
entry    {kind: "log", prev, n, time, genesis | request+transport | mail | event+box}
request  http:   {kind: "http", method, path, route, query, headers: {name: value}, body: bytes}
         libp2p: {kind: "p2p", topic, from: bytes, seqno: bytes(8), signature: bytes, body: bytes}
                 {kind: "p2p-frame", protocol, from: bytes, body: bytes}
         local:  {kind: "message", message: <a signed mail record>, body: bytes}
mail     {kind: "mail", op: "put", sender: bytes(33), recipient: bytes(33), box, body: <cid>, subject?: <cid>,
          json?: true, session?: {payload: bytes, signature: bytes, nonce, yourNonce}
          | nonce?: bytes(16), signature?: bytes}
```

Entries are unsigned (#9): the sender signed its request, `prev` fixes the
order, `time` is the host's clock at admission (#10). A `request` names
the package as received and its transport, whose middleware the kernel
steps on it (the genesis's front door for `http`, `libp2p` and `local`; a
genesis may name others in `middleware: {<transport>: <program>}`). A
`local` request is a provider's answer on this host (below, "Outbound"): the
front door checks the message's signature against its sender and that its
body is the one named, and admits it. A mail entry is what a host that admits a message directly
writes (the browser's); the node host's messages arrive inside requests. A
store in an older format is refused for running (`kernel-zig/src/log.zig`
has the shapes).

- **A message is its mail record.** A client's message: `sender` is the
  session's identity, `session` the BRC-104 signed request (the payload that
  carried the body, its signature and nonces), `json` set when the client
  sent JSON (so the answer to it goes back as JSON). An emitted message (an
  instance's or a provider's, #70) carries its own `signature` and `nonce`
  instead, and keeps it whatever carried it. `body` is the dag-cbor record
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
- **Wakes and ticks are messages** (#69): a step's `deadline` and a shell's
  `sleep` are wake-me messages to the waker, whose answer routes as a reply
  (`woke`); a schedule is a message to the cron provider, whose ticks are
  messages into the box it names. `skein-host event` sends a tick from the cron provider by hand.

## The messagebox

`programs/messagebox` (Zig) is the BRC-33 messagebox inside the instance,
called by the front door's routes. Bodies are JSON read as DAG-JSON
(`{"/": "<cid>"}` a link, `{"/": {"bytes": "<base64>"}}` bytes), or BRC-231
(`Content-Type: application/cbor`: `recipient` 33 bytes, `body` dag-cbor
bytes); the answer is in the form asked.

- **sendMessage** → one message to admit (`admit`): the mail record
  (`sender` the caller) and its body, which the kernel routes after the
  front door's step. Accepted when something takes it: for this instance's
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

## Mailbox instances

An identity outside the host — David's wallet, the inference peer, a browser
tab — gets its mail kept by a **mailbox instance**: an instance with only the
front door and the messagebox, whose dispatch rows send `:ack` and every
message from anyone in any box (`*`) to the messagebox, for its owner. Its
sessions are records like any instance's (#68). It has an identity of its own (its oracle's key;
the BRC-104 counterparty), and keeps the owner's mail as the owner's.

- `skein-host add <handle> --mailbox --owner <key>` makes one; `skein-host
  mailboxes` lists them.
- `POST /account/register {username, identityKey, signature}` on the host
  makes one for the caller: `signature` (hex) under `[2, "skein register"]`,
  key ID the username, counterparty anyone, over `register <username>` —
  proof that the key's holder asked. The answer: `{identityKey, username,
  handle, messagebox: <its origin>}`.
- The host's resolve endpoint answers a mailbox instance's handle with its
  owner's key and the instance's origin.

## Outbound: emit, the address book and the providers

(#70, #67.) This is the program-facing contract for everything that leaves
an instance. A step never talks to the network: it **emits a signed
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
          nonce: bytes(16), signature: bytes}
```

- The kernel builds the record (`sender` the instance, `recipient` = `to`),
  signs it through the oracle — DER ECDSA by the sender's BRC-42 child for
  `[2, "metanet handles envelope"]`, key ID `send`, counterparty anyone,
  over the dag-cbor of the record without `signature` (BRC-169 §7.2/§7.3's
  signing on skein's record; anyone verifies it with the sender's key) —
  puts it and the body, and returns its CID: the message's id, what an
  answer's `replyTo` names. `nonce` is the first 16 bytes of sha256(thread ‖
  step ‖ the emit's place in the step): two threads asking the same thing
  send two messages.
- It goes out **when the step ends without error** (an errored step sends
  nothing), listed on the step's update as `emitted`. Replay re-signs from
  the recorded oracle answer and sends nothing. At a start the kernel hands
  over again every emitted message a waiting thread still awaits; a host
  acts on a message once.
- **An event instead of a message** (#65): `emit({event: "broadcast", tx,
  beef?})` — below, "Broadcast out, proofs and statuses in".
- **Errors** (the call's; the step may catch them): `emit: want {to:
  <33-byte key>, box, body: <dag-cbor bytes>, subject?: <cid>} or {event:
  "broadcast", tx: <cid>, beef?: bytes}` · `emit: the
  message is not dag-cbor` · ``emit: `to` is not an identity key (33
  bytes): emit to a key, not a handle (resolve the handle first)`` · `emit:
  the box is empty or starts with ':' (reserved)` · `emit: the body is not
  dag-cbor` | `… not IPLD` | `… not canonical dag-cbor` · ``emit: `subject`
  is not a CID`` · ``emit: no route to <hex>: not in the address book
  (resolve its handle, or add it to the `peers` box)`` · `emit: <hex> is
  reached by mailbox, and the genesis has no messagebox program to deliver
  it` · `emit: the oracle did not sign the message` · in a kernel call,
  `emit: a kernel call sends nothing (emit from a step)`.

### Awaiting the answer

`await` the message's CID (`sk.awaitRecord`) and end the step; it rests
`waiting` with the CID in `awaits`. The thread is stepped again by:

| input | when |
|---|---|
| `reply: {message, body, box, sender, replyTo}` | a message from the recipient whose body names `replyTo: <the CID>` (`sk.replyOf`; `get` the body) |
| `undelivered: {message, error}` | a `mailbox` recipient's delivery thread gave up: no answer can come |
| `woke: true` | the waker's answer to the step's `deadline` |
| `event: {event, box, subject}` | an event about a record the step awaits (#65: a transaction's proof, awaiting its CID) |
| `message: {message, body, box, sender, subject}` | a subscribed sender's message about a record the step awaits (#65: a status provider's status) |

Several messages, a subject and a deadline may be awaited at once; whichever
comes first steps the thread, which awaits again what it still needs. An
answer nothing awaits any more is recorded and runs nothing. A reply is
routed only if the awaited record is a message this instance sent **to the
replying sender** — a provider answers as itself, so its key is what the
address book names.

`deadline(until_ms)` is sugar over the same: when the step ends waiting it
emits `{at: until_ms}` in box `wake` to the address book's `waker` and
awaits it; the answer `{replyTo, at}` steps the thread with `woke: true`. A
shell's `sleep` is the same message (#69, below "Scheduling").

### The address book

The head `peers` — who the instance can reach, and how:

```
{kind: "peers", peers: [{key, peer: <cid>}]}                                   sorted by key
{kind: "peer", key: bytes(33), transport: "mailbox" | "libp2p" | "local", address: text,
 role?: text, handle?: text, domain?: text, since: ms, source: "genesis" | "admin" | "resolve" | "claim"}
```

| transport | address | how a message goes out |
|---|---|---|
| `mailbox` | the recipient's messagebox URL | the instance's own **delivery thread** (below): BRC-103/104, through the `fetch` provider |
| `libp2p` | a peer ID, or `topic:<name>` | the host's libp2p node: the package `{message, body}` (dag-cbor) as one frame on `/skein/message/1.0.0`, or published on the topic; the libp2p provider answers in box `sent`: `{replyTo, sent: true}` or `{replyTo, seqno, recipients}`, or `{replyTo, error}` |
| `local` | a provider's name on this host | handed to the provider |

`role` is the part an entry plays for the instance — `fetch`, `waker`,
`cron`, `libp2p`, `status`: how a program finds a provider (`sk.provider(a,
role)`; `deadline` and a shell's sleep find the waker). Receiving needs none of this: a
sender is authenticated by its key (a BRC-104 session or the message's own
signature) and admitted by subscription, whether or not the instance can
answer it.

The address book is one of the kernel's four tables (#77). Who writes it:

- **the genesis**, once: `addressBook: [{key, transport, address, role?,
  handle?, domain?}]` (source `genesis`) — the host seeds its providers
  (role = the provider's name; `libp2p` when it runs libp2p, `status` when
  it has an Arcade) and the owner's mailbox;
- **the kernel's `peers` operation** (the admin box `peers`, the owner's
  by every genesis, or a delegate's; source `admin`): `{op: "add", key,
  transport?, address? | url?, role?, handle?, domain?}` | `{op: "remove",
  key}` — `url` alone, or no `transport`, is a mailbox. No program runs.
  `skein-host peers <agent> add <key> <address> [--transport t] [--role r]
  [--handle h@d]` / `remove <key>` / `list`; `scripts/host/up.sh` writes the
  owner and the inference peer into every agent this way, and the roster
  step (`skein-host deploy`, `roster --deploy`) the other agents;
- **the resolve program**, from a BRC-169 lookup (source `resolve` or
  `claim`; below) — through the kernel's `peers` operation, not by writing
  the table (#79: no program reaches a kernel table): it emits `{op: "add",
  key, transport: "mailbox", address, handle, domain, source}` in box
  `peers` to the instance itself (the host's loopback), admitted by the
  default system's delegate row `{peers, sender: $self, program: kernel, fn:
  peers}` (where resolve is wired), and the kernel answers the thread
  awaiting that message (input `admin`) once the entry is written. Every
  program of the instance emits as the instance, so that row lets any of
  them write the address book (the other tables stay the owner's): for
  David to review.

A later record for the same key replaces it (a party that moved hosts).
`sk.peers`, `sk.peerOf(key)` and `sk.peerByHandle(handle, domain)` read it.
**Registration is application wiring, not core**: nothing registers itself
or takes claims; an application that wants senders to enter themselves
writes a row of its own (e.g. `{"address": "register", "sender": "*",
"program": "resolve"}`: the resolve program writes a claim `{handle,
domain}` — or a BRC-169 envelope's sender — only if it resolves to the
sender, source `claim`).

### The providers

A provider is a recipient with an identity of its own that carries a
message out and answers. The reference host runs five
(`src/host/providers.ts`): `fetch`, `waker`, `cron`, `libp2p` and `status`; their
keys are the host's business (children of its master secret), the instance
knows them from its address book. Every answer is a signed message from
the provider to the instance — the same record an `emit` makes, signed the
same way, `subject` echoed, a fresh `nonce` — in the box asked (`frame`
for a stream's frames), its body `{replyTo: <the message>, …}`; a failure is
`{replyTo, error}`. It arrives as a `local` request (`{kind: "message",
message, body}`): the front door checks the signature and the body, and the
message routes by `replyTo` to the thread awaiting it.

| role | box | body | answer body (beside `replyTo`) |
|---|---|---|---|
| `fetch` | `fetch` | `{method, url, headers?: {name: value}, body?: bytes, timeoutMs?}` | `{status, headers, body: bytes}` — the HTTP proxy; a URL of the host's own is answered in process, any other goes out when the host allows it (`SKEIN_HTTP=fetch`) |
| `waker` | `wake` | `{at: ms}` | `{at}`, at `at` (#69, below) |
| `cron` | `cron` | `{fn: "tick", every: ms \| at: ms, box, body?, name}` · `{fn: "stop", name}` | `{name, next}` · `{name, stopped}`; then each tick, a message of its own into `box` (#69, below) |
| `libp2p` | `publish` | `{topic, body: bytes}` | `{seqno: bytes(8), recipients}` |
| | `dial` | `{peer, protocol}` | `{stream}`; then each frame read, in box `frame`: `{stream, body}`, and its end `{stream, closed: true, error?}` — all answering the dial |
| | `send` | `{stream, body: bytes}` | `{}` |
| | `close` | `{stream}` | `{}` |
| `status` | — | takes no messages (an error answer) | it speaks first: each status of a transaction the instance holds, box `status` (#65, below) |

The overlay's gossip (#74, docs/OVERLAY.md "Gossip") is `publish`
messages, not awaited (the answer is recorded and runs nothing): on
`<topic>` the body is the submission's BEEF as received; on `<topic>-admit`
the dag-cbor `{txid, topics: {<topic>: {outputsToAdmit, coinsToRetain}}}`;
on `<topic>-proof` the dag-cbor `{txid, blockHash, blockHeight, bump:
bytes}` (txid and block hash hex, display order).

`sk.fetch(a, method, url, headers, body)` emits to the fetch provider and
awaits it; the reply's body is the answer. A broadcast is not a message to
anyone (#65, below); the chain app (#78) is the one program that emits it (#79: the wallet and the overlay apps send the chain app an `ingest` instead).

**How a host obtains its providers' keys is its own business**, not core:
the reference host derives them from its master secret (`src/host/oracle.ts`
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
the status provider's messages (box `status`, its optional row from
`$status`), and is the only thing that emits the broadcast event. Anything
else that needs a transaction on the chain sends it a BEEF —
`{fn: "ingest", args: {beef}}` in box `chain` — and is answered at its
address. The wallet and the overlay apps are programs of the same
instance: they emit the ingest to the instance itself (docs/VM.md "emit":
the host's loopback), admitted by the chain app's row from `$self`, end
their step awaiting that message, and each answer steps them again (#79).
The owner may call it too (its row from `$owner`); nobody else can. The
answers come at once when it arrives proven, else on each state change
(`accepted` on the first status that is not a rejection, `proven` on its
proof, `rejected`), several `{fn, request, replyTo, result}` answers to one
request. **Every unproven transaction at rest has a registered broadcast**
(a record in the chain state's `broadcasts`); proof triggering is the answer
to that broadcast — the chain app's thread awaits the transaction's CID —
not separate wiring. Its rows (its manifest; or a system tree's
`etc/dispatch.json` with `bin/chain.wasm`, writing under its default scope
`chain/`) — specific wiring, not an open box (#79):

```
{"address": "chain",  "sender": "event",   "program": "chain"}                     the host's events (feeds, the broadcaster's proofs)
{"address": "chain",  "sender": "$self",   "program": "chain"}                     the instance's own apps (the wallet, the overlay apps)
{"address": "chain",  "sender": "$owner",  "program": "chain"}                     the owner
{"address": "status", "sender": "$status", "program": "chain", "optional": true}   the status provider (left out without one)
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
  No recipient, no signature, no oracle call. The record is listed in the
  step's `emitted` with the messages, recorded, never re-executed on replay,
  and goes out when the step ends without error — handed to the host
  (transport `event`) — and again at a start while the thread awaits the
  transaction's CID. Errors: `emit: no event "<x>" (the one event is
  "broadcast")` · `emit: a broadcast names its transaction: …` · `emit:
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
message  box "status", subject: <tx CID>, from the status provider's key (no replyTo)
body     {kind: "status", txid (hex), txStatus, blockHash?, blockHeight?, extraInfo?}
         txStatus: RECEIVED, SENT_TO_NETWORK, ACCEPTED_BY_NETWORK, SEEN_ON_NETWORK, SEEN_MULTIPLE_NODES,
                   MINED / IMMUTABLE (with no path), REJECTED, DOUBLE_SPEND_ATTEMPTED, INVALID, MALFORMED
```

- **Taking statuses** is a row `{transport: "mailbox", address: "status",
  sender: <the provider's key>, program}` (a system tree writes
  `{"address": "status", "sender": "$status", "program": "chain"}`, #78), and
  the provider in the address book (role `status`), which the genesis seeds
  when the host has one — how a program knows one speaks to it. The message
  steps the thread awaiting the transaction (input `message`), else the
  row's program (args `{message, body, box: "status", sender}`). An
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
`rejected`. With no status provider subscribed (role `status`), no status
ever arrives, so the chain app answers only at the proof and the overlay
admits there. Admission on validation alone is not a mode. A submission
admitted on `accepted` keeps listening (the overlay's watch of the same
ingest message): `proven` publishes its `-proof`, a later `rejected`
removes its judgements.

### Scheduling: the waker and the cron provider (#69)

Scheduling is a message to a provider. The schedule originates in a step,
never in host configuration; the wake or the tick comes back as a signed
message from the provider's identity, verified at the front door like any
message.

**The waker** (role `waker`, box `wake`):

| ask | body | answer |
|---|---|---|
| a step's `deadline(until_ms)` (sugar), or a program's own emit | `{at: ms}` | `{replyTo, at}` at `at` — steps the thread with `woke: true`; one stamped before `at` runs nothing |
| a shell's `sleep` (the kernel emits it) | `{at: ms}` | the same; the shell is re-executed from its origin and carries on past the sleep under that entry |
| anything else | | `{replyTo, error: "the waker takes {at: ms} in box \"wake\""}` |

A shell's wake-me is signed through the oracle (the call recorded on its
waiting update with `emitted` and `awaits`). No waker in the address book:
`deadline` fails (`deadline: no waker in the address book (an entry with
role "waker")`), and a shell's sleep errors the shell (`sleep: no waker in
the address book …`). The waker keeps what it owes in its own timers; at a
start the kernel hands it again every wake-me a waiting thread still awaits.

**The cron provider** (role `cron`, box `cron`):

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
a paid tick service, a waker elsewhere). The program does not know which:
it emits to the key `sk.provider(a, "cron")` names and its ticks come back
the same way. `src/peers/cron.ts` is a remote cron service: it collects its
mailbox's `cron` box and answers, and ticks, at the sender's messagebox
(its own address book's), on a BRC-104 session of its own.

### The outbound BRC-103/104 pattern (delivery)

A `mailbox` recipient's message is delivered by the instance itself: the
kernel launches the messagebox program as the message's **delivery thread**
(origin `{program: messagebox, args: {message, transport: "mailbox"}}`),
which is a BRC-103/104 client of the recipient's messagebox, its HTTP each
an emit to the `fetch` provider (`programs/messagebox/deliver.zig`):

```
step 1   no session with that messagebox:  POST <url>/.well-known/auth (the BRC-103 initialRequest) → await
step 2   the initialResponse: its signature over both nonces checked, the session kept;
         the BRC-104-signed POST <url>/sendMessage, BRC-231 CBOR {message: {recipient, messageBox,
         body, signature, subject?, nonce}} — the signed message itself → await
step 3   the answer: its signature checked against the session; 200 → finished {delivered: <cid>, url}
         (the recipient keeps the same record under the same CID). A 401: shake hands again, once.
```

- **The session** is the instance's own, one per peer: head `outbound`,
  `{kind: "outbound", sessions: [{key, session: <cid>}]}`, each `{kind:
  "outbound-session", peer, url, ours, theirs, server, created}`. `server`
  is the identity that answered the handshake — the recipient's own, or a
  mailbox instance's for a mailbox kept for someone. Sending never tells
  the peer who we are beyond the session (no claim, no registration, #40).
- **Failure.** `transient: …` (no answer, 5xx, 408, 425, 429) is tried again
  `defaults.sendRetryMs` later (default 30 000; a `deadline`) up to
  `defaults.sendAttempts` attempts in all (default 3); anything else, or
  the last attempt, ends the delivery thread errored, and the thread
  awaiting the message is stepped with `undelivered: {message, error}`.
- **Two instances on one host** deliver to each other through the fetch
  provider's in-process path; since nothing waits mid-step, two that send
  to each other at once no longer wait on each other.

A program that speaks another request/response protocol over HTTP follows
the same shape: build and sign the request in a step, emit it to the
`fetch` provider, await, check the answer in the next step, keep any
session as a record.

### Resolving a handle

`emit` takes a key, never a handle. A handle is looked up by **launching**
the resolve program (`sk.launchResolve(a, in, handle, domain, key?)`; args
`{handle, domain, key?}`): this step then waits on that thread, and when it
comes to rest the launcher is stepped again — finished, the address book
names the handle (the thread's result is the peer record); errored, the
lookup failed (`transient: …` when no answer came, or a 5xx). `key` is the
identity the launcher expects; another answer is refused.

## BRC-169 is discovery

BRC-169 is used for one thing: a handle to an identity key and a messagebox
URL. It is a program, not the core: the resolve program's thread fetches
`https://<domain>/manifest.json` (`metanet.handles.resolve`, default
`/.well-known/metanet-handles/resolve`), then `GET <resolve>?handle=<handle>`
→ `{identityKey, messagebox, …}`, each GET an emit to the `fetch` provider
and its answer the next step, and writes `{transport: "mailbox", address:
<messagebox>}` (source `resolve`). The instance's own domain is looked up at
`defaults.resolveOrigin` (a dev host). The BRC-52 certificate is recorded,
not checked (`unchecked`). The host publishes the manifest and the resolve
endpoint for its instances (`{handle, domain, identityKey, messagebox}`),
and the paymail PKI (`/bsvalias/id`). An emitted message is signed the way
BRC-169 signs an envelope (above), so a BRC-169 peer can check it.

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
app's row `{transport: "http", address: "/call", sender: "session", fn:
"call"}` takes the same `{fn, args}` as the POST body and answers `{fn,
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

- **Routing.** The dispatch table's `libp2p` rows: `{transport: "libp2p",
  address: <topic>, sender: "*", program, fn}` for a topic, `address:
  "/<protocol>"` for a stream protocol (from `etc/dispatch.json`, or the
  older `etc/routes.json`'s `libp2p:` paths; a protocol's handler named in
  `etc/config.json` `libp2p.protocols` becomes its row; or installed by an
  app, #72). No row: `ignore`. The handler gets `match`, the row that
  matched, as an HTTP row's handler does.
- **What the node subscribes** (#72, #77). The instance's node takes the
  genesis's `libp2p` (topics, protocols, listen) plus the topics and
  protocols named by the `libp2p` rows added since the genesis — an app's
  install (src/host/p2p.ts `libp2pConfig`); a genesis row alone subscribes
  nothing: a tree says what its node takes in `config.libp2p`. After the kernel has processed what the host handed it,
  the host reads the table (the kernel's `dispatch` frame); when its chain's
  tip moved, it declares the config again: new topics subscribed and
  protocols handled, removed ones unsubscribed and unhandled, on the
  running node — started if the instance had none, stopped when nothing is
  left. No restart.
- **Verify in the step.** For a topic message the front door checks, from
  the request alone, that `from` is a secp256k1 peer ID (identity multihash of
  the key's protobuf) and that `signature` is its ECDSA signature (DER,
  sha2-256) over `"libp2p-pubsub:"` ‖ protobuf `{1: from, 2: body, 3: seqno,
  4: topic}` — GossipSub's StrictSign. A bad one is `reject`, and no handler
  runs. Then the handler (the route's program and fn, an in-VM call) gets the
  request plus `key` (the 33-byte key out of `from`) and `request` (the
  record's CID), and judges from state: `{verdict, admit?}`. A handler that
  fails is `ignore` (cannot evaluate: no penalty for the forwarder).
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

- **Signed messages** (#70). A frame on `/skein/message/1.0.0` (which every
  node serves) and a message on a topic no route takes are read as a package
  `{message, body}`: a signed mail record for this instance and its body.
  The front door checks the signature as for a `local` request and admits
  it; one for another identity is `ignore`, and a frame that is not a
  package is `reject` (on a topic, `ignore`).

Outbound is the `libp2p` provider (above, "The providers"): a step emits
`publish`, `dial`, `send` or `close` to it and awaits the answer; a dialed
stream's frames come back as messages in box `frame`. A message to an
address book entry with `transport: "libp2p"` is carried as a signed
package. Messagebox delivery stays HTTP.

## Fuel

Every request's fuel is on its thread's updates, in the log (#68), like
every step's: billing is a query over the log. The host's **fuel ledger**
(host.db `fuel_ledger`: instance, caller, op, calls, fuel; `skein-host
ledger`) keeps what is not in the log: the kernel calls it makes (a read
after a request's thread, op `<route> (read)`).

## Chat between instances

An instance talks to another the way David talks to it: a `chat`. There is
one chat body, the same in both directions, whoever the parties are: a new
conversation has no `replyTo`; everything after it is a `chat` **reply**
(`replyTo` = the id of the message it answers). A conversation is pairwise —
one sender, one recipient, `replyTo` one parent — and a thread is one party's
participation in one conversation.

The loop (`programs/loop`) gives the model a `message` tool beside `bash`:

```
message {to: "@handle@domain", text}
```

- **Addressing.** The loop finds the handle in its address book, else
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
  subscription, in any box; a reply nothing awaits is recorded and nothing
  runs. A resumed thread that rests on a `message` takes the reply as that
  call's result, `{of: <their chat>, role: "tool", call, to, sent: <our chat>,
  text}`; one that rests on its answer takes it as the next user turn.
- **Undeliverable.** A send to a key with no route fails in the step; one
  whose delivery thread gives up (after its retries) steps the loop with
  `undelivered`. Either way a `message` becomes
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
  each `message` a reply-await.
- **Inbound.** A new `chat` (no `replyTo`) is routed by the dispatch table; the default
  genesis seeds a `chat` row with sender `*`, so other agents can open one.

## Inside the instance

- **Routing** is by the **dispatch table** on `(sender, box)`, first match
  wins, over the rows as they stand when the entry is processed
  (docs/VM.md, "The dispatch table"), seeded by the genesis and changed
  only by the kernel's `dispatch` operation on the owner's (or a
  delegate's) messages. A row may admit anyone (`*`) and take any box (`*`;
  the mailbox instance's catch-all). The program is the **box's program**:
  `(owner, run) → run-handler`; a kernel row is the kernel's own operation.
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

Between the loop (`programs/loop`) and the inference peer (`src/peers/infer.ts`,
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
listed in `programs/loop/main.go`.

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

## Why no envelope

The first design wrapped every message in a BRC-169 envelope: signed metadata,
a content hash, BRC-78 encryption to the recipient, relayed through a shared
messagebox. With the recipient's own front door at the other end of a
BRC-104 session, none of that carries weight: the session proves the sender,
TLS (or localhost) keeps the wire private, and the recipient is the host. The
mail record keeps the signed request, so the proof outlives the session and
verifies from the log with the instance's key alone. Replay needs the log
and nothing else. (#70 brought back one part of it: an emitted message is
signed itself, BRC-169's way, because it may travel by a provider or over
libp2p, with no session to prove its sender. Still no encryption and no
shared relay.)

## Bodies

A body is **dag-cbor**: the same encoding as every record, so a body is a
record with a CID. JSON clients send and read DAG-JSON; BRC-231 clients send
the bytes.
