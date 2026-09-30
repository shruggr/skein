# Messages

How messages enter and leave a skein instance. Settled with David on
2026-09-25/26, revised by issue #33 (the router) and rewritten for issue #40:
**the instance is an HTTP server; BRC-169 is discovery; BRC-103/104 is the
network; messages are state.** This replaces the BRC-169 envelopes of the
core flow, the kernel's `emit` and `resolve` imports, the host's `auth.ts`,
the router's mailbox keeping, outcome entries and peer seeding.

## The persistence rule

An instance keeps **messages** and nothing else from the outside:

- a message that arrived is one log entry (a `mail` record);
- a read — a poll, a listing, a lookup, an explorer page — writes nothing:
  no entry, no byte;
- authentication writes nothing: a handshake and the verification of a signed
  request only touch the in-memory session table (sessions are not state,
  below);
- an acknowledgement is one entry (the reader's pointer moves);
- what the instance sends is part of the step that sends it (a recorded
  `http` call and the record it put), not an entry.

A reader with the log can check every message: the mail record carries the
BRC-104 signed request that brought it (below), which verifies with the
instance's key alone.

## The instance as an HTTP server

Each instance is an HTTP server at an origin of its own. Its **front door**
(`programs/frontdoor`, Zig) is the program that answers: the host calls it —
a kernel `call` of fn `http` with the raw request — and returns what it
answers as the HTTP response. The router (`src/host/router.ts`) is a reverse
proxy: it picks the instance by URL and forwards; it holds no mail, and of
auth only each running kernel's session table, which it passes to the front
door and never reads.

```
http://<handle>.localhost:<port>/…     the instance's origin (the Host header)
http://<host>:<port>/@<handle>/…       the same instance, a dev form: the router strips the prefix for the routes
```

**Auth is by key.** The front door runs BRC-103/104 itself: the handshake at
`/.well-known/auth` and the verification of every general message, against the
instance's session table (below). The caller is the identity key the session
proved; there is no account, no handle check, no envelope. Answers are signed
on the session through the instance's oracle (the kernel's `wallet`, recorded
only when a step makes it; a call's is not recorded).

- **Sessions are not state.** Replay never needs a session: each logged
  message carries the sender key, the 104 signature and both nonces, so its
  authorship verifies from the entry alone. A session only serves the next
  request, which is network work, so it lives in memory and never in the log:
  a handshake writes nothing, and neither does a verified request.
  - **Where.** The table belongs to the instance's kernel process: the host
    keeps it beside the process (`Kernel.scratch`, `src/host/kernel.ts`), an
    opaque key → bytes map it never reads. `callFrontDoor` passes it in the
    front door's call argument (`scratch`) and applies the changes the answer
    lists (`scratch: [{key, value?}]`, no value: drop) before it answers the
    client, so the request right after a handshake is served. Only the front
    door understands an entry: key = our session nonce, value (dag-cbor)
    `{peer, peerNonce, created}`. A new kernel process (a restart, a crash, an
    idle stop) starts with an empty table.
  - **Lookup and expiry.** A request's session is found by its `yourNonce`.
    Expiry: `defaults.sessionTtlMs` (a day) from the in-memory record's
    `created` (the router's clock at the handshake). An unknown or expired
    session gets a plain 401, and the stock client shakes hands again by
    itself; the cost of a restart is that one round trip per client.
  - **Bounds and replay.** A handshake drops the expired sessions and, past
    1024, the oldest (the host caps the table at 4096 keys besides). A
    replayed initialRequest (the peer and initial nonce of a session held) is
    refused. A replayed signed request verifies (its nonce is not
    remembered: a replayed read reads again); a replayed write is the same
    mail record, which the kernel admits once.
  - **Later.** With many instances per host the table can be cached out when
    an instance is stopped; for now instances are not stopped until resource
    contention appears (the router's idle stop is off by default).
- **Routes** (the genesis's `routes`, from `etc/routes.json`): `[{path |
  prefix, program: <cid>, fn, auth?: "none", read?: <op>}]`, exact paths first,
  then the longest prefix. `auth` defaults to BRC-104; `"none"` is for open
  routes (an overlay's submit and lookup). The handler is an in-VM call of
  `program`'s `fn` with `{caller?, method, path, route, query, headers, body,
  contentType, session?}`; it answers `{status, type?, body, admit?, then?}`.
- **Reads** (the genesis's `reads`, from `etc/reads.json`): `[{caller?: <key>,
  op}]`. A route with `read: op` answers only a caller the table allows (no
  caller: anyone); others get 403, signed. The stock reads: the owner may
  `explore`.
- **Writes.** A handler that wants a write returns entries for the host to
  admit — `{mail: <record>, body}` or `{event: <record>, box}` — and optionally
  `then: {program, fn, arg}`, a call the host makes once they are processed
  (an overlay submit's answer, which a step computes).

The **stock routes**: the BRC-33 messagebox (`/sendMessage`,
`/listMessages`, `/acknowledgeMessage`, at the root and under `/messagebox`)
and the explorer (`/explore…`, read op `explore`: the log, threads, a thread,
a head, a record, as DAG-JSON; `programs/frontdoor/explore.zig`).

**The stock AuthFetch** (`@bsv/sdk`, and the `@bsv/message-box-client` over it)
keeps one session per origin and shakes hands at `<origin>/.well-known/auth`.
It is served by the host-name form: one origin per instance, so one session
per instance. The `/@<handle>` form works for a client that sends its
handshake under the prefix too — `RawBox` (`src/client/raw.ts`) rewrites
`/.well-known/auth` to `/@<handle>/.well-known/auth` — and signs the path it
sent, which is what the front door verifies.

## The log, format 3

```
entry  {kind: "log", prev, n, time, genesis | mail | wake | event+box}
mail   {kind: "mail", op: "put", sender: bytes(33), recipient: bytes(33), box, body: <cid>, json?: true,
        session?: {payload: bytes, signature: bytes, nonce, yourNonce}}
```

Entries are unsigned (#9): the sender signed its request, `prev` fixes the
order, `time` is the router's clock at admission (#10). A store in an older
format is refused (`kernel-zig/src/log.zig` has the shapes).

- **A message is its mail record.** `sender` is the session's identity,
  `session` the BRC-104 signed request (the payload that carried the body, its
  signature and nonces), `body` the dag-cbor record beside it, `json` set when
  the client sent JSON (so the answer to it goes back as JSON). A box a client
  names never starts with `:` (reserved for the host's own boxes).
- **A message's id is the CID of its mail record.** Sender and recipient
  compute it alike; a reply names it in its body's `replyTo`. A second
  admission of the same record is refused (the kernel's `unique` map; so is
  a libp2p `p2p` event record's, below).
- **Routing** (`scheduler.zig` processMail), for a message to this instance:
  a body with a `replyTo` CID resumes the thread awaiting that record, if the
  record is a message this instance sent to the replying sender; otherwise
  (no such thread, or `replyTo` not a CID) it is recorded and nothing runs. A
  message with no `replyTo` is routed by subscription on `(sender, box)`,
  first match wins; the handler gets `{message, body, box, sender}`. No
  subscription: recorded, nothing runs.
- **Events** are the host's feeds (#29: headers, proofs, statuses) and the
  front door's writes (`:ack`; #51: an accepted libp2p message, `p2p` in
  `libp2p:<topic>`, below), routed by box or `subject`.
- **Wakes** are a sleeper's deadline, one entry each — or, for a thread
  resting on a libp2p `receive`, the arrival of a frame on its stream (#51).

## The messagebox

`programs/messagebox` (Zig) is the BRC-33 messagebox inside the instance,
called by the front door's routes. Bodies are JSON read as DAG-JSON
(`{"/": "<cid>"}` a link, `{"/": {"bytes": "<base64>"}}` bytes), or BRC-231
(`Content-Type: application/cbor`: `recipient` 33 bytes, `body` dag-cbor
bytes); the answer is in the form asked.

- **sendMessage** → one entry to admit: the mail record put (`sender` the
  caller) and its body. Accepted when something takes it: for this instance's
  own boxes, a subscription on `(sender, box)` or a reply to a message this
  instance sent that sender; for the identity it keeps a mailbox for (its
  owner), a subscription whose handler is the messagebox. Refused, nothing is
  written. The answer carries `id` (the record's CID) and `results` echoing
  the client's `messageId`.
- **listMessages** is a read: the caller's list in that box, `{messageId,
  sender, body, …}` with `messageId` the mail record's CID (JSON: the body as
  DAG-JSON text). Nothing is written.
- **acknowledgeMessage** → one entry: `{kind: "ack", reader, ids, session}` in
  `:ack`, which the messagebox, stepped, applies: the reader's pointer moves.
  The records stay in the log.

State: the head `mailbox` names `{kind: "mailbox", lists: [{recipient, box,
list}]}`, each `{kind: "mail-list", recipient, box, acked, messages: [{id,
at}]}` — the unacknowledged messages in arrival order. An instance's own
subscribed boxes keep no list: admission is the acknowledgement, the log is
the queue. **A mailbox exists only where a subscription to the messagebox
exists**: a message the messagebox is not subscribed to keep is refused
(`403`).

## Mailbox instances

An identity outside the host — David's wallet, the inference peer, a browser
tab — gets its mail kept by a **mailbox instance**: an instance with only the
front door and the messagebox, whose genesis subscribes `:ack` → messagebox
and everything from anyone in any box → messagebox, for its owner. Its
sessions are in memory like any instance's. It has an identity of its own (its oracle's key;
the BRC-104 counterparty), and keeps the owner's mail as the owner's.

- `skein-host add <handle> --mailbox --owner <key>` makes one; `skein-host
  mailboxes` lists them.
- `POST /account/register {username, identityKey, signature}` on the router
  makes one for the caller: `signature` (hex) under `[2, "skein register"]`,
  key ID the username, counterparty anyone, over `register <username>` —
  proof that the key's holder asked. The answer: `{identityKey, username,
  handle, messagebox: <its origin>}`.
- The router's resolve endpoint answers a mailbox instance's handle with its
  owner's key and the instance's origin.

## Delivery

An instance delivers its own messages: the messagebox program's `send`
(`deliver.zig`), called from a step — the loop's `message` tool, its `infer`
and its answer, the run handler's result (`sk.send`, programs/lib) — as a BRC-103/104
client of the recipient's messagebox.

```
send {to: <key>, box, body: <dag-cbor bytes>, handle?, domain?}  →  {id: <cid>}
```

- **Where.** The address book (head `peers`, below) gives the recipient's
  URL; for the owner, the genesis's `defaults.ownerMessagebox`; else, with a
  handle, the resolve program on first contact. A key in none of them, with no
  handle to resolve, is **no route**: a permanent failure (`no route to <key>:
  not in the address book …`).
- **The session.** One outbound session per peer, kept as a small record
  (head `outbound`: `{peer, url, ours, theirs, server, created}`). `server` is
  the identity that answered the handshake — the recipient's own, or a mailbox
  instance's for a mailbox kept for someone (the URL names whose mailbox; the
  session proves who answers). Sending never tells the peer who we are: no
  claim, no registration (#40). Whether the peer can answer is its own
  address book's business.
- **The request** is a recorded `http` POST of `/sendMessage` as BRC-231
  CBOR: request and response are on the step's update, so replay never touches
  the network. The answer's signature is verified; a 401 means the session is
  gone: shake hands again and send once more.
- **The id.** `send` puts the same mail record the recipient keeps (sender
  this instance, the session proof included) and answers with its CID, so a
  reply's `replyTo` names a record this instance holds and can `await`.
- **Failure** is the call's error, in the step: `transient: …` for no answer,
  5xx, 408, 425, 429 (`skein.Transient`; the caller may try again later),
  anything else permanent. There is no outcome entry. The loop's `message`
  tool tries a transient failure again: it keeps a `retry` note beside the
  turns and rests on a deadline `defaults.sendRetryMs` ahead (default
  30 000), and the wake runs the call again; after `defaults.sendAttempts`
  attempts in all (default 3) the failure is the tool's error result, as a
  permanent one is at once. (Its `infer` and its answer are not retried: an
  answer that cannot be delivered — no route, say — is an error turn, the
  thread ends, and the step's log line carries it once, `stderr: loop: could
  not deliver the answer: …`.)
- **Local delivery.** The kernels' `http` goes through the router
  (`Router.http`): a URL of the host's own is dispatched in process through
  the same front-door path, no socket; any other goes out (`SKEIN_HTTP=fetch`,
  or the router's `http` option).

## The address book

Sending to anyone needs their mailbox URL, and optionally their handle
(display, resolution): that is the **address book**, key → `{mailbox,
handle?}`. Receiving needs none of it: the key authenticates (the front
door's BRC-104), the subscription decides. The two are independent — a
sender on an open box (`chat` from anyone) is admitted whether or not the
instance can answer it.

The address book is the head `peers`: `{kind: "peers", peers: [{key, peer}]}`,
each `{kind: "peer", key, url, handle?, domain?, since, source}`. It is
written **only by the instance's own programs** — the host never seeds it:

- the **resolve** program (`programs/resolve`): called from a step (`resolve
  {handle, domain, key?}`), it looks the handle up and writes the record
  (source `resolve`);
- the box **`peers`** (the owner, as admin): `{op: "add", key, url, handle?,
  domain?}` | `{op: "remove", key}` (source `admin`). This is configuration:
  `skein-host peers <agent> add <key> <mailbox-url> [--handle h@d]` /
  `remove <key>` / `list`; `scripts/host/up.sh` writes the owner and the
  inference peer into every agent this way, and the roster step (`skein-host
  deploy`, `roster --deploy`) the other agents.

**Registration is application wiring, not core.** Nothing in the core
registers itself or takes claims: the messagebox's `send` never posts one, and
the stock genesis has no `register` box. An application that wants senders to
enter themselves subscribes a box of its own in its `etc/subscriptions.json`
— e.g. `{"box": "register", "handler": "resolve"}`: the resolve program's
claim handler takes `{handle, domain}` (or a BRC-169 envelope's sender),
resolves it, and writes the record only if it resolves to the sender (source
`claim`) — or a program of its own with its own rules on who may.

The owner is the one peer a genesis names: `etc/config.json` `owner:
{messagebox}` (or the host's `ownerMessagebox`, its mailbox instance on the
host) becomes `defaults.ownerMessagebox`.

## BRC-169 is discovery

BRC-169 is used for one thing: a handle to an identity key and a messagebox
URL. It is a program, not the core: the resolve program fetches
`https://<domain>/manifest.json` (`metanet.handles.resolve`, default
`/.well-known/metanet-handles/resolve`), then `GET <resolve>?handle=<handle>`
→ `{identityKey, messagebox, …}`, as recorded `http` calls. The instance's own
domain is looked up at `defaults.resolveOrigin` (a dev host). The BRC-52
certificate is recorded, not checked (`unchecked`). The router publishes the
manifest and the resolve endpoint for its instances (`{handle, domain,
identityKey, messagebox}`), and the paymail PKI (`/bsvalias/id`).

## Calls

The front door, a route handler, a listing and a lookup are **kernel calls**:
a program's function run over the current state, with no entry and no
writes, fuel-limited (`defaults.callFuelLimit`) and charged. A call needs no
determinism: nothing it does is recorded, because nothing it does is kept.
From a step, an in-VM `call` is part of the step (its recorded calls and head
moves are the step's). `docs/VM.md`, "Calls".

## libp2p (#51)

The same front door, another transport. The router's libp2p host
(docs/ARCH.md) makes one kernel `call` of the front door, fn **`libp2p`**,
for each GossipSub message on a subscribed topic (inside GossipSub's async
validator, so forwarding waits on it) and for each frame read from an inbound
stream on a served protocol:

```
call   {transport: "libp2p", topic | protocol, from: bytes (the peer ID's multihash),
        seqno?: bytes(8), signature?: bytes, body: bytes}
answer {verdict: "accept" | "reject" | "ignore", reason?, admit?: [entry], body?: bytes, close?: bool}
```

- **Routing.** The routes table gains `libp2p:` sources: `{path:
  "libp2p:<topic>", program, fn}` for a topic, `libp2p:<protocol>` for a
  stream protocol (from `etc/routes.json`; a protocol's handler named in
  `etc/config.json` `libp2p.protocols` becomes its route). No route: `ignore`.
- **Verify before admit.** For a topic message the front door checks, from
  the call alone, that `from` is a secp256k1 peer ID (identity multihash of the
  key's protobuf) and that `signature` is its ECDSA signature (DER, sha2-256)
  over `"libp2p-pubsub:"` ‖ protobuf `{1: from, 2: body, 3: seqno, 4: topic}`
  — GossipSub's StrictSign. A bad one is `reject`, and no handler runs. Then
  the handler (the route's program and fn, an in-VM call) gets the call plus
  `key` (the 33-byte key out of `from`) and judges from state: `{verdict,
  admit?}`. A handler that fails is `ignore` (cannot evaluate: no penalty for
  the forwarder).
- **The entries.** Accept returns the message's own entry first:

  ```
  {event: {kind: "p2p", topic, from: bytes, seqno: bytes(8), signature: bytes, body: bytes}, box: "libp2p:<topic>"}
  ```

  and then every entry the handler returned in `admit`, unchanged — the same
  entries the `http` side forwards for the same handler (#57: persistence is
  not a transport concern; an overlay's `submit` on a `libp2p:<topic>` route
  persists what `POST /submit` persists). The router appends them in order.
  The `p2p` entry re-verifies from the log alone, with no router: the
  publisher's key is in `from`, and the signature covers topic, seqno, from
  and body — the same guarantee as a mail record's sender, 104 signature and
  nonces. It routes as any event: the thread awaiting its `subject` (none
  here), else a sender-less subscription on `libp2p:<topic>`; with none it is
  recorded and nothing runs. **Reject and ignore write nothing** — no entry,
  no byte (a handler's `admit` beside a reject or ignore is dropped).
- **A redelivered message writes nothing either** (#42, decided
  2026-09-30). The event record is content-addressed (topic, from, seqno,
  signature, body), so GossipSub delivering the same message again — after
  its seen-cache expired, or from another peer — makes the same record, and
  the kernel's `unique` map (which already keeps a mail record to one
  admission) refuses a second entry for a `p2p` event record at admit: no
  entry, no byte. The router stops at that refusal, and the `p2p` entry comes
  first, so none of the handler's entries is appended either — an answer's
  entries go in together or not at all. The router answers GossipSub
  `ignore` (no forward, no penalty). Other events (a feed's header or status)
  are not unique.
- **Streams.** A frame is not signed (the stream is authenticated by Noise;
  `from` is the remote peer). The handler answers `{body?, admit?, close?,
  verdict?}`: `body` is written back on the stream as one frame, `admit`
  (entries, as an HTTP route handler returns them) is admitted, `close` or
  `reject` ends the stream.
- **Fuel.** Each of these calls is charged to the fuel ledger: caller the
  peer ID (base58), op the route source (`libp2p:<topic>`).

Outbound (publish, dial, send, receive, close) is the kernel's `libp2p`
import, recorded on the step's update like `http` (docs/VM.md, "libp2p").
Messagebox delivery stays HTTP.

## Fuel

Every front-door call's fuel is charged to the host's **fuel ledger**
(host.db `fuel_ledger`: instance, caller, op, calls, fuel), aggregated in
memory and flushed periodically; `skein-host ledger` prints it. Reads are not
free, only unrecorded.

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

- **Addressing.** The loop finds the handle in its address book, else calls the
  resolve program (`skein.Resolve`), which writes the peer record with the
  step. A handle that does not resolve is an error result.
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
- **Undeliverable.** A send that fails fails in the step: a `message` becomes
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
- **Inbound.** A new `chat` (no `replyTo`) is routed by subscription; the stock
  genesis seeds `{box: "chat"}` with no sender, so other agents can open one.

## Inside the instance

- **Routing** is by **subscription** on `(sender, box)`, first match wins,
  over the rules as they stand when the entry is processed: the instance's
  subscriptions chain (docs/VM.md, "Subscriptions"), seeded by the genesis and
  changed only by `subscribe` messages from whoever is subscribed to that box.
  A rule may name no sender (anyone) and no box (any box; the mailbox
  instance's catch-all). The handler is the **box's handler program**: `(owner,
  run) → run-handler`.
- **The handler** knows the box's message shape; its arguments name the
  message record and the body; it reads the body and launches the next thread.
- **A handler that errors** ends its thread `errored`, and that is all: no
  reply, no bounce.
- **Replay protection** is the mail record's uniqueness: the same record is
  admitted once, whoever delivers it.
- **Results** go to the sender of the request that started the thread, sent
  by the step (`send`), so their id is known and recorded before the step
  ends.
- **Nothing is a message that isn't one.** Genesis is starting state; a wake
  is an entry with no sender; a session and an acknowledgement are events, not
  messages.

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
#16) subscribes to it.

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
and nothing else.

## Bodies

A body is **dag-cbor**: the same encoding as every record, so a body is a
record with a CID. JSON clients send and read DAG-JSON; BRC-231 clients send
the bytes.
