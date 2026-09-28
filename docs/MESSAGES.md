# Messages

How messages enter and leave a skein instance, as settled with David on
2026-09-25/26. This replaces the local-socket transport, the `hello` and
`tick` messages, and the auth-stage idea of the first runtime build.

## Since the router (issue #33)

This section overrides what follows wherever they differ; the sections below
describe the envelope, routing and the programs' protocols, which are
unchanged, and the providers of the TypeScript runtime (frozen), which the
router replaces.

**The host is a router** (`src/host/router.ts`) and the instance is the
messagebox host: `sendMessage`, `listMessages` and `acknowledgeMessage` are
answered by the router under BRC-103/104 mutual auth, with the paths and
shapes of the TypeScript messagebox (so the stock `@bsv/message-box-client`
works unchanged), at the same URL (`http://127.0.0.1:8100/messagebox`). There
is no poller and no delivery provider: a message to an instance is admitted
when it arrives (screened, decrypted through the instance's oracle, admitted
in the same request); an instance's emit to an identity on this host is
delivered in process, and its outcome admitted back (`delivered`, or `failed`
with the reason: `403 ERR_ACCOUNT_REQUIRED` for a recipient that is neither
an instance nor a registered mailbox). Nothing waits for a receipt; down
means down.

**Entries are unsigned** (format 2, #9 revised): `{kind: "log", prev, n,
time, genesis | envelope+box+body | wake | outcome | mail | event+box}`. The sender
signed the message, `prev` fixes the order, the stamp is the router's clock
at admission (#10); receipt order = log order = message order. The genesis
has no `host`. Identity keys, hashes and signatures are byte strings in every
record (`kernel-zig/src/log.zig`).

### Envelope forms

An envelope is kept **in the encoding it was made in** — a signature is over
the encoding it was made in (BRC-169 §7.3), and a message's id is the CID of
its signed part as kept:

| form | on the wire | kept as | signature over | who sends it |
|---|---|---|---|---|
| §7.2 JSON | the JSON object (BRC-33 JSON body) | the JSON-shaped record (keys, hash, signature as hex text) | SHA-256 of RFC 8785 of the envelope without `content`, `signature` | JSON clients: the front end, `bin/skein`, `skein-host deploy` |
| §7.3 dag-cbor | its dag-cbor bytes (BRC-231 body), or `{"dag-cbor": "<base64>"}` in a JSON body | the map, keys/hash/signature as bytes, `content` the BRC-78 bytes (dropped from the kept signed part) | SHA-256 of the dag-cbor of the map without `content`, `signature` | instances, the inference peer, BRC-231 clients |

Both sign under `[2, "metanet handles envelope"]`, key `"1"`, counterparty
`anyone`. A program answers a party in the form that party wrote to it in (a
JSON client can read only JSON); everything else it sends is §7.3
(`programs/envelope`). A request with `Content-Type: application/cbor` is
answered in dag-cbor (BRC-231: `recipient`/`sender` as 33 bytes, `body` as
bytes); a JSON listing shows a dag-cbor body as `{"dag-cbor": "<base64>"}`.

### Mail for hosted identities

`POST /account/register {username}` gives the caller a mailbox on this host,
kept by an instance (`SKEIN_MAILBOX_HOST`, default the first enabled row;
`skein-host mailboxes`). A message for it is admitted into the keeping
instance as a `mail` entry, `{op: "put", recipient, box, sender, messageId,
body, json?}`, which the **messagebox program** (`programs/messagebox`, Zig;
the genesis routes the reserved box `:mail` to it) keeps under the head
`mailbox`: `{kind: "mailbox", recipients: [{identity, mail}]}`, each
recipient's `{kind: "mail", identity, messages: [{messageId, box, sender,
body, json?, at}]}` in admission order. `listMessages` is a read of that
record through the kernel (no entry); `acknowledgeMessage` admits `{op:
"ack", recipient, messageIds}`. The mail is the instance's state: it outlives
the router. The program sees the authenticated sender as the entry's
`sender`.

### Sessions (in the instance)

Decided on #33 (2026-09-29): a BRC-103/104 session is with an **instance's
identity**, not the router's. The router forwards; it keeps nothing but the
identity → instance map.

- **Which instance.** The stock AuthFetch keeps one session per origin, so the
  route is per origin: a host name `<handle>.<domain>` reaches that instance;
  a `/@<handle>` path prefix does too, for a transport whose base URL names it
  (the rest of the path is what it signs); anything else — the bare
  `http://127.0.0.1:8100/messagebox` — is the **front instance**, the mailbox
  host (`SKEIN_MAILBOX_HOST`, default the first enabled row). `skein-host
  identity` prints the front instance's key: the BRC-104 counterparty of a
  client at the bare URL. A message for another instance, sent on a session
  with the front instance, is delivered as before (a full envelope, screened
  by its recipient).
- **In the VM.** Each authentication message is a plain `event` entry in the
  reserved box `:auth` (the stock genesis routes it to the messagebox
  program, `programs/messagebox/auth.zig`); the router awaits the step and
  reads the answer (head `auth`):

  ```
  {kind: "auth", op: "handshake", message}                      the initialRequest JSON as it came → our nonce, our signature
  {kind: "auth", op: "request", identityKey, nonce, yourNonce, signature, payload}
                                                                a signed request (payload: SimplifiedFetchTransport's framing) → verified, or not
  {kind: "auth", op: "respond", yourNonce, payload}             the response to sign on that session → nonce, signature
  {kind: "auth", op: "seal", emit, id}                          an emit, compact on a session with its recipient (below)
  ```

  Nonces are BRC-104's (16 bytes and their HMAC under `[2, "server hmac"]`,
  self — the 16 bytes printable ASCII, so the SDK's `verifyNonce` accepts
  them), signatures `[2, "auth message signature"]` with the peer, both
  through the kernel's `wallet` import (recorded calls). Sessions are records
  under the head `sessions`: `{kind: "session", peer, sessionNonce,
  peerNonce, created, lastSeen, authenticated, compact, seen}` (`seen`: the
  last 4096 message nonces, for replay). **Expiry** is the instance's policy,
  `defaults.sessionTtlMs` (genesis default a day), judged by entry stamps: a
  request on an expired session gets a plain 401 and the stock client shakes
  hands again by itself. Sessions outlive the router.
- **Proof from the log.** Every signed request is in the log (the event
  record: payload, signature, nonces), and every signature the instance made
  is a recorded call; all of them verify with the instance's key alone.

### Compact both ways

On a session with an instance, messages may be compact in **both
directions**; a party gets them only if it asked:

- **Client → instance**: a reply on the client's session with the
  recipient's instance (below, "Session replies").
- **Instance → client**: a client that sends the signed header
  `x-bsv-skein-compact: 1` on a request marks its session; the instance's
  emits to that identity (a kept mailbox) then go as `{type: "reply" |
  "message", replyTo?, id, body}` — `body` the plaintext dag-cbor, `id` the
  emitted envelope's CID (what a reply to it names) — signed on the session:
  the payload is that map's dag-cbor, signed under `[2, "auth message
  signature"]`, key ID `"<nonce> <client's session nonce>"`, counterparty the
  client. It is kept (and listed: BRC-231 as its bytes, JSON as `{"dag-cbor":
  base64}`) as that map plus `session: {payload, signature, nonce,
  yourNonce}`; its message id is SHA-256 of the payload. The client verifies
  it with its own wallet (counterparty: the sender). The stock
  `@bsv/message-box-client` never asks, so toward it (and the front end) the
  agent's messages stay full envelopes (as for `bin/skein` and the inference
  peer today); a BRC-231 client asks with `cborBoxClient(…, {compact:
  true})` (src/host/brc231.ts).

### Session replies

On a BRC-104 session with the recipient's instance (the one keeping the
recipient's mail, or the recipient itself), a reply may be the **compact** §7.3 form — `{type: "reply", replyTo, body}`,
dag-cbor, sent as a BRC-231 body — with `sender`, `recipient`, `host` and the
envelope signature left out, because the session supplies them. The first
message on a session, and anything for an external store-and-forward box,
keeps the full envelope; a compact message must answer something the
recipient holds (else `400`), and must travel as BRC-231 bytes, so the signed
request carries the body itself. Its `body` is the plaintext dag-cbor (no
BRC-78 layer: the session is with the recipient's host), so it is for
transports that are private themselves (TLS; localhost in dev).

It is a wire encoding, not a second kind of entry: it is admitted to the same
entry shape, `{envelope, box, body}`. Its envelope record carries the proof
instead of an envelope signature:

```
{type: "reply", replyTo, sender: {identityKey: bytes}, created, contentHash: bytes,
 messageId: bytes,                                   SHA-256 of the signed payload: the message id
 session: {payload, signature, nonce, yourNonce}}    the BRC-104 general message: the signed request and its signature and nonces
```

Authorship is the BRC-104 message signature over `payload` with the session
nonces; the instance verified it at the session (its `request` step), and
the record keeps it so the proof outlives the session: it verifies with the
instance's own key (a BRC-104 signature is to its counterparty — now the
instance, not the router). The kernel checks the record's
shape, that `messageId` is the payload's hash, that the payload carries the
body, and the body against `contentHash`; `replyTo` is read from the record
(a full envelope's is in its body), and the reply resumes the awaiting thread
exactly as a full one does. For a kept mailbox, the compact message is kept
as the dag-cbor of that record with its `body`.

## Topology

A **skein host** is a BRC-169 ecosystem host: it operates a domain, the
handle registry and attestation (BRC-52 handle certificates), the resolve
endpoint, and a messagebox with BRC-33 semantics. It hosts any number of
**instances**. Each instance has its own handle, its own identity key, and
therefore its own wallet; it acts for David under a BRC-169 §9 delegation
certificate his wallet issues (scope, per-action cap, expiry, revocable).

Routing: a sender resolves the handle to the host's messagebox and delivers
there; the host hands the message to the instance that owns the handle; the
instance routes by box; subscriptions take it from there.

BRC-103/104 mutual authentication between clients and the messagebox is
with the instance (#33, "Sessions (in the instance)", above): the router
forwards the handshake and every signed request into it, and the proofs are
in its log.

## The envelope

What arrives is a BRC-33 message — `recipient`, `messageBox`, `body` — whose
`body` is a **BRC-169 §7.2 envelope**, sent with the messagebox client's own
body encryption **off** (the envelope's metadata must stay readable for the
messagebox to enforce §8 policy and reject bad signatures; the client's
default would hide it).

```
{ metanetHandles, recipient: {handle, tag?, domain}, sender: {identityKey, handle?, domain?},
  created, quoteId?, payment?, contentHash, content, signature }
```

- `sender.identityKey` and `signature` are plaintext: provenance a third party
  can verify from the envelope alone.
- `contentHash` is the hex SHA-256 of the plaintext content (the dag-cbor
  body). It is in the signed part, so the sender's signature covers the
  content: anyone holding the plaintext can check who wrote it, with no key
  and no help from the recipient. A message is an authenticated call.
- `content` is a BRC-78 portable encrypted message: security level 2,
  protocol `message encryption`, a 256-bit key id per message carried in the
  serialization (random for a client; from the step's random stream for an
  instance, which only needs it to differ per message), counterparty the
  recipient. The encryption is **wire-level only**: it keeps the messagebox
  operator out and nothing more. The recipient decrypts it and checks the
  plaintext against `contentHash`.
- `payment`, when present, is a BRC-29 payment as Atomic BEEF, unbroadcast,
  to keys derived from the recipient's identity key, internalized by the
  recipient's wallet with `internalizeAction`.
- The box name is not in the envelope; it is the BRC-33 parameter beside it.
  BRC-169 leaves the choice of box to the sender.
- A message's **id** is the CID of its signed part: the envelope without
  `content`, as dag-cbor (`envelopeCid` in `src/client/client.ts`). It covers
  `contentHash`, so it names the content too; a `replyTo` names it.

### The signature derivation (an amendment to §7.2)

§7.2 says the signature is "by the key in `sender.identityKey`" and names no
derivation; its worked example verifies against the raw identity key. A
BRC-100 wallet never signs with the root key, so that cannot be produced
through the wallet interface. Skein follows the pattern the same document
uses for certificates (BRC-52: `[2, "certificate signature"]`, key id from
the object, counterparty `anyone`):

- protocol id `[2, "metanet handles envelope"]`
- key id: fixed (`"1"`)
- counterparty: `anyone` — the messagebox must be able to verify, and it is
  not the recipient

over SHA-256 of the RFC 8785 canonical envelope with `content` and
`signature` removed — `contentHash` included. A verifier derives the signing
key from `sender.identityKey` with those constants. Reusing one derived key
across envelopes is safe (RFC 6979 nonces); the identity key is already
plaintext, so a fresh key id would add no unlinkability. This is a proposed
revision to BRC-169 §7.2, to be raised upstream.

A second amendment: `contentHash` in the signed metadata. §7.2 as written
signs the envelope with `content` removed, so nothing but a successful BRC-78
decryption binds the content to the sender, and that proves authorship to the
recipient alone.

## Providers

The instance's boundary is a set of interfaces, each satisfied by a
**provider**; which provider fulfils which interface is kernel configuration
(`src/host/main.ts` wires them; tests wire mocks). The runtime (`src/runtime`:
scheduler and store) holds no session, no messagebox client, no clock and no
private key. It exposes `admit(entry, records)` for a finished, provider-signed
log entry; `sleepersDue()` (cued by `onSleep`) for the next deadline; and its
`outbox` for what it emits.

- **Message delivery** (`src/host/messagebox.ts`, for the local `1sat serve`
  host): a BRC-103/104 session to the messagebox as the instance, list, verify
  the sender's signature, decrypt, check the plaintext against `contentHash`,
  build the entry and sign it with the host wallet, `admit`, acknowledge. How a
  provider gets its messages (a messagebox, SSE, a local queue, a browser page
  writing entries directly) is its business; the entry it admits has one shape.
- **Ticks** (`src/host/tick.ts`): reads the next deadline and, at that moment,
  admits one wake entry, signed the same way. Every tick is recorded; there
  are no idle ticks, so an instance with nothing due stays asleep.
- **Outbound**: an `emit` stays, and it carries the **complete envelope**.
  The program seals it inside the step, through the instance's own wallet
  (the `wallet` import; `programs/envelope`), in this order: `getPublicKey`
  (its identity, the sender), `createSignature` over the signed part
  (`created` is the step's stamp, `sender` the genesis's handle and domain,
  `recipient` the handle the program resolved or the genesis's `names`),
  `encrypt` of the body to the recipient's key (BRC-78). Each wallet call is
  attested — recorded, and served from the record on replay, so replay needs
  no wallet. The runtime checks the emit with no wallet (signed by this
  instance, content from it to the emit's `to`, `contentHash` the body's),
  stores its signed part — whose CID is the message id, what a reply's
  `replyTo` names — and, once the step is recorded, hands it to the delivery
  provider, which **carries bytes**: it makes no wallet call on the send path.
  (It still uses the instance wallet for its BRC-103/104 messagebox session —
  the instance authenticating its own session — and to decrypt inbound
  content.) Queueing and retries are the provider's; what became of each emit
  comes back as one host-signed **outcome** entry (below), never as an error
  to the step. A reply, if any, is just another admitted entry; a thread
  whose reply never comes, though its envelope was delivered, sits `waiting`
  at no cost.
- **Outcomes** (#10, "delivery closes the loop"). After it sends — or gives
  up on — an emit, the delivery provider admits an entry like a wake, stamped
  and signed with the host wallet, naming the emit record:

  ```
  { kind: "log", prev, n, time, outcome: { emit: <emit cid>, status: "delivered" | "failed", reason? }, sig }
  ```

  `delivered` means the messagebox took it (nothing about whether anyone will
  answer); `failed` carries the reason. At most one outcome per emit: the
  runtime refuses a second ("duplicate-outcome") and an outcome naming a
  record that is not an emit in its store. The provider reports `failed` at
  once for a **permanent** refusal — an HTTP 4xx other than 408/425/429 (the
  local messagebox's `403 ERR_ACCOUNT_REQUIRED`: the recipient has no
  account), or a request the client cannot make — and retries a
  **transient** one (no answer, 5xx, 429) at its polls with a doubling
  backoff, `SKEIN_SEND_ATTEMPTS` sends in all (default 8, over about two
  minutes: `SKEIN_SEND_BACKOFF_MS` 1000, capped at 60 s), then reports
  `failed` "… (gave up after n attempts)". Nothing is sent again after a
  `failed` entry. (The queue is in memory: an emit still queued when the
  process stops gets no outcome; nothing re-sends it on start.)

  The scheduler: a `delivered` outcome is a record and runs nothing. A
  `failed` one resumes the thread whose tip emitted that emit and awaits a
  reply to it, driven by the outcome entry, with `deliveryFailed: {emit,
  envelope, to, box, reason}` as the step's input in place of a `reply`; if
  nothing awaits it, it is recorded and nothing runs. So no thread waits on
  an envelope that will not arrive. A program opts in by listing `outcomes`
  among its record's `services` (the loop does); one that does not — a loop
  pinned by a genesis from before outcomes, which would read such a step as
  its first — is not resumed and keeps waiting, as it did. Outcomes are entries: replay reads them
  back like any other.
- **Wallet**: BRC-100, however wired.

## Inside the instance

- **Admission.** A delivery provider collects the box (list-and-acknowledge,
  or an equivalent queue), verifies each envelope's signature, decrypts its
  content through the instance wallet and checks it against `contentHash`,
  and admits it as a log entry in arrival order: the envelope's signed part
  and the plaintext body (both records; the body's CID is dag-cbor over the
  sender's bytes, so its sha2-256 digest *is* `contentHash`), with the box
  name and the time it observed. The ciphertext is not kept. The runtime
  checks the entry's signature, the body against `contentHash`, and that the
  envelope is new, before it appends. Arrival is non-deterministic only until
  admission; the admitted order is the order of record.
- **Every log entry is signed by the host**, admissions, wakes and outcomes
  alike: an entry is the host's statement — "message *n* arrived at *t*",
  "wake at *t*", "emit *e* was delivered (or failed) at *t*" — so the provider
  that delivers it (the delivery for admissions and outcomes, the tick for
  wakes; different parties may run them) signs it with the host wallet (`createSignature`, protocol `[2, "skein
  log"]`, key `1`, counterparty `anyone`), not the instance's. The genesis
  records the host's identity (`host`, beside `owner`), and every stamp and
  every kick traces to a signature a third party can check against it. Where
  a provider hosts instances for users, this is the provider's word, and what
  a checkpoint later binds to chain time. The signature is recorded, never
  recomputed. The instance wallet signs nothing per message; it signs only
  what the instance itself sends. (One wallet may be host, instance and
  owner at once, e.g. a whole VM in a browser window: the roles collapse and
  nothing breaks.)
- **Routing** is by **subscription** on `(sender.identityKey, box)`, first
  match wins, over the rules as they stand when the entry is processed: the
  instance's subscriptions chain (docs/VM.md, "Subscriptions"), seeded by the
  genesis and changed only by `subscribe` messages from whoever is subscribed
  to that box (the owner, and whomever the owner delegates to). The handler
  is the **box's handler program**, not a tool: `(sender: david, box: run) →
  run-handler`.
- **The handler** knows the box's message shape. Its arguments name the
  envelope and the plaintext body records; it reads the body and launches the
  next thread with arguments pointing at the body or a record derived from it
  — for `run`, the shell over the named tree. No decryption inside, no
  recorded call, no wallet.
- **A handler that errors** ends its thread `errored`, and that is all: no
  reply, no bounce. The sender learns nothing, as with any asynchronous
  message.
- **Replay protection** is at admission: an envelope whose record CID is
  already in the log is rejected, by the runtime, whoever delivers it; where
  the messagebox reports the authenticated submitter, it must equal
  `envelope.sender.identityKey`. The messagebox server should enforce the
  last of these too, and dedupe by message id. **Freshness** is not judged at
  the edge: the provider supplies only the arrival stamp. The sender's
  `created` (in the signed part) and the attested stamp are both in the
  entry, so the instance can decide from `(created, stamp)` deterministically
  if it decides at all; it mostly cares about the order received.
- **Replies** correlate to their request through the waiting thread's own
  state: a thread that sent a request rests `waiting` with a reference to
  it; an admitted message naming that request is delivered to that thread.
- **Results** leave as envelopes to the sender of the request that started
  the thread, sealed — signed and encrypted — by the step that emits them
  ("Outbound" above), so the id is known and recorded before the step ends.
- **Nothing is a message that isn't one.** Genesis is starting state. A
  sleeper's wake is a signed, stamped log entry with no message and no
  sender, one per wake; an outcome is the host's report on an emit, not a
  message either. `hello` and `tick` are gone.

## Chat between instances

An instance talks to another the way David talks to it: a `chat`. There is
one chat envelope, the same in both directions, whoever the parties are: a
new conversation has no `replyTo`; everything after it is a `chat` **reply**
(`replyTo` = the envelope it answers). The answer is never a `say` (that is
an optional tool; "The turn stream", below). A conversation is
pairwise — one sender, one recipient, `replyTo` one parent — and a thread is
one party's participation in one conversation.

The loop (`programs/loop`) gives the model a `message` tool beside `bash`:

```
message {to: "@handle@domain", text}
```

- **Addressing.** The loop resolves the handle to an identity key through the
  host (`skein.Resolve`, the `resolve` import): an recorded call — the host's
  `Resolver` answers, the **whole answer** is recorded, replay serves it. A
  handle that does not resolve is recorded as `{identityKey: "", error}` and
  becomes an error result. The emit is sealed to that key with the handle in
  the envelope's `recipient`; which messagebox it goes to is the delivery
  provider's business (on localhost, the one configured).
- **Resolution** (`hostResolver`, `src/host/host.ts`), in order:
  1. the host's own rows (host.db): `{identityKey, via: "host"}`;
  2. BRC-169 (§5.1–5.2): the domain's `/manifest.json`; if it publishes
     `metanet.handles`, `GET <resolve>?handle=<handle>` answers, final either
     way. The answer is the endpoint's whole response — `identityKey`,
     `certificate`, `messagebox`, `ttl`, … — plus `via: "brc169"`, `checked`
     and `unchecked`. The BRC-52 handle certificate is checked (§4.1) against
     the manifest's certifier key (`metanet.trust.publicKey`) when there is
     one: its type, certifier, subject = `identityKey`, signature, and
     `fields.handle`/`fields.domain` when they are plaintext (encrypted fields
     need a keyring we are not given: `unchecked`). Any failure refuses the
     handle; the refused response is recorded beside the error. **Revocation
     (§4.2) is not implemented anywhere**: it is always in `unchecked`, which
     means unknown, not revoked;
  3. last, for a domain whose manifest has no `metanet.handles` (§5.1: then
     no probing the well-known path), the paymail PKI,
     `<origin>/bsvalias/id/<handle>@<domain>`: `{…its response, identityKey,
     via: "paymail"}`.

  A domain's origin is the messagebox host's when one is configured (dev: one
  host serves every domain it is asked about), else `https://<domain>`. The
  local `1sat serve` publishes a manifest with `metanet.trust` only and
  answers paymail, so on localhost handles resolve by row or by paymail.
- **Who the loop sends to, and what it replies to.** Every chat the loop sends
  replies to the recipient's latest envelope in this thread, if it has one —
  the chats of the party that opened the thread (its user turns), or a party's
  replies to our messages — and rests `waiting` on the answer, as on an
  `infer`:

  | situation | box | to | replyTo |
  |---|---|---|---|
  | the turn's answer (plain text, or an inference error) | `chat` | the opener | the opener's latest envelope here (the chat that opened the turn, or their reply to a message) |
  | `message` to the opener, or to a party that replied to one of our messages | `chat` | that party | their latest envelope here |
  | `message` to anyone else | `chat` | that party | none: a new conversation there |

  The answer carries `{text, tree, thread, replyTo}` (the working tree and the
  thread, for David's client); a `message` carries `{text, replyTo?}` — no
  tree: trees do not cross instances.
- **The other side.** A chat with `replyTo` is a reply: the scheduler matches
  it against the thread whose tip `awaits` that envelope (and the sender
  against the key it was sealed to) before any subscription, in any box — so
  a reply in `chat` resumes the waiting thread and never opens a new one
  through the `chat` subscription (a reply nothing awaits is recorded and
  nothing runs). A resumed thread that rests on a `message` takes the reply
  as that call's result, kept as `{of: <their chat>, role: "tool", call, to,
  sent: <our chat>, text}`; one that rests on its answer takes it as the next
  user turn.
- **Undeliverable.** A `failed` outcome for what the loop rests on resumes it
  (above): a `message` becomes an error result for the model, `{of: <outcome
  entry>, role: "tool", call, to, error: "could not deliver to @h@d:
  <reason>"}` — as an unresolvable handle already is — and the loop goes on;
  its `infer`, an `error` turn answered to the opener as an inference error;
  its answer to the opener, an `error` turn ("could not deliver the answer:
  …") and the thread **finishes**, since the reply it awaited cannot come. Replies to `infer` arrive in `completions`, which the genesis
  `collect`s (default `["completions"]`); `chat` is collected because it is
  subscribed.
- **Two agents alternate on one thread each.** Martha's `message` to Kurt
  opens a conversation on Kurt's side (one thread there); inside Martha's
  thread it is one step: emit, wait, resume. If Kurt calls `message` back to
  Martha, that is a reply to her chat and resumes her waiting step with it as
  the result; her next `message` to Kurt replies to his and resumes his; his
  plain answer at the end of his turn replies to her latest too. Martha's own
  answer goes to whoever opened her thread (the user), as a reply to their
  chat, and the user's next chat, replying to it, continues her thread.
- **One at a time.** A step waits on threads or on replies, not both: several
  tool calls in one completion run in order, each `bash` a shell thread and
  each `message` a reply-await.
- **Inbound.** The receiving instance routes a new `chat` (no `replyTo`) by
  subscription; to accept agents, not only its owner, its genesis seeds
  `{box: "chat"}` with no sender (or the owner subscribes it later). A chat
  that cannot be delivered comes back as a `failed` outcome; one that was
  delivered and never answered leaves the thread waiting.

## The infer protocol

Between the loop (`programs/loop`) and the inference peer (`src/peers/infer.ts`,
`bin/skein-infer`), as decided in issue #12. The peer is **stateful**: it
holds each sender's conversation graph; the engine behind it (an
OpenAI-compatible endpoint) is not. Requests go in the peer's `infer` box,
replies come back in the instance's `completions` box with `replyTo` = the
request's id, as for any reply. Both bodies are dag-cbor records.

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
  The loop sends the turns from its latest assistant turn on (the peer held
  everything up to that turn's parent: the newest node of the request it
  answered) and names that parent. The first request of a conversation has
  no `parent` and carries the whole conversation, root first.
- `model` and `thinking` are per request. The loop takes them from the
  latest user turn — a `chat` may carry `model` and `thinking` beside `text`,
  kept on the user turn — else from the genesis defaults (`defaults.model`,
  else `ripper/qwen38`; `defaults.thinking`). The peer maps `model` to its
  provider table (`<provider>/<model>`: the provider's `baseUrl` and
  `apiKey`, the engine's model name after the slash) and `thinking` to the
  engine's `chat_template_kwargs.enable_thinking` and `reasoning_effort`;
  absent, the engine's default.

**The peer.** It checks that the nodes chain, stores them, and walks from the
newest node back through `parent` to the root. The path becomes the engine's
whole chat: system → `system`, user → `user` (`text`, then its
`annotations`, if any), assistant →
`assistant` (`content`, `tool_calls`), tool → `tool` (`tool_call_id` = `call`;
a shell's `exit N`, stdout and `[stderr]`, or a message's answer, or
`error: …`); other roles (the loop's `error` turns) are not the model's and are
left out. Nodes are held per sender identity — one sender's CIDs never reach
another's chat — in memory (the most recently used `SKEIN_INFER_NODES`,
default 50000) and on disk under its own state directory
(`SKEIN_INFER_CACHE`, default `$SKEIN_HOME/infer-cache`, one file per node at
`<sender>/<cid>`, its dag-cbor bytes, checked against the CID when read back;
`""` for memory only). Nothing prunes the directory.

**Reply** (`completions`), one of:

```
{ replyTo, message: {role: "assistant", content?, reasoning?, tool_calls?}, usage?, model, ms }
{ replyTo, missing: [<node cid>] }
{ replyTo, error }
```

- **`missing`** is the peer's 404: it does not hold a node the request needs
  — the named `parent`, or an ancestor on the way to the root (a restarted
  peer with no cache, an evicted node) — and names the first it could not
  find. No engine call is made.
- **The loop on `missing`** keeps a note beside its turns (not a turn, not a
  node), `{kind: "missing", of: <completions envelope>, missing}`, and sends
  the whole conversation again — an ordinary `infer` with no `parent`,
  emitted, recorded and replayed like any other — and awaits that. It
  retries once: `missing` again right after the resend, or for a request
  that already carried the whole conversation (the first), is an inference
  error — an `error` turn, answered to the opener as "inference failed: …".
  Everything the loop decides is from its own kept records, so replay is
  exact; the peer's reply is an admitted entry like any other.
- A request with `messages` and no `nodes` (a loop from before this
  protocol) is passed to the engine as it is.

## The turn stream

As decided in issue #19. The answer to the opener is still the `chat` reply
with `replyTo` (above), and it still closes the turn. Beside it, the loop can
send the opener — the sender of the chat that opened the thread, David or
another agent — ordinary messages in its **`turn`** box: one per event, a
dag-cbor record with a `kind`, emitted in the step where it happens, in
order, and never awaited (a `failed` outcome for one is recorded and nothing
runs). The front end (easel, #16) subscribes to it; what it speaks or renders
is its business.

**Config** (genesis `defaults`, strings; both off by default, so an instance
that does not set them behaves as before):

- `defaults.tools`: the optional tools to offer the model, a comma-separated
  list of `say`, `present`, `annotate`. A tool not named is not offered, and a
  call to it is an unknown tool.
- `defaults.stream`: `"on"` sends the non-model kinds as well (`thinking`,
  `log`, `error`, and the opener's own annotations).

**Tools.** `say`, `present` and `annotate` are ordinary tools, called when the
conversation's rules call for them (a spoken line where a voice channel is
established; a page and its annotations when something is being discussed),
not by default and not once per turn:

```
say      {text}
present  {page: <markdown or HTML>, blocks?: [{id, …}]}     (ids unique; other fields are kept as given)
annotate {present: <cid>, block?, note}                      (a page presented in this thread; block one of its ids)
```

Each call puts its record, keeps it in the thread (listed in the step's
`kept`, beside the turns), sends it to the opener in `turn`, and answers the
model with a `tool` turn `{of: <the record>, role: "tool", call, text}`
whose text is JSON: `{"say": "<cid>"}`, `{"present": "<cid>", "blocks":
[<ids>]}`, `{"annotation": "<cid>"}`. Bad arguments are an error result
(`{role: "tool", call, error}`) and nothing is sent. The call (with the page
in its arguments) and its result are turns, so a presented page lives on in
every later prompt by its CID and need not be presented again.

**The opener's annotations.** A `chat` may carry `annotations: [{present:
<cid>, block?, note}]` beside `text`. The loop keeps them on the user turn —
the inference peer renders them after the text, `[annotations]` then `- on
<cid> block <id>: <note>` per line — and puts each as an annotation record of
that turn, kept, and (with `stream`) sent back in `turn` with its CID.

**Records** (`of` is always a CID; the kept ones are exactly the bodies
sent, so a message's body CID is the kept record's):

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
facts. Every tool call logs `started` when the loop takes it up and
`finished` when its result turn is kept — a `bash` call across two steps
(launch, then the shell at rest), a `message` across the wait for the reply.

## Why the plaintext

With the content hash in the sender's signature, the plaintext needs no one
else's word: a replayer checks the body against `contentHash` and the
signature against `sender.identityKey`, from the log alone. So the log keeps
the plaintext, and an inbound message's ciphertext is not part of state;
nothing depends on it. What the instance sends is different only in that the
program produced it: its emit record carries the envelope complete,
ciphertext and all, and the wallet's answers to the sign and encrypt calls
are recorded like any recorded call (the encryption's IV is the wallet's, so
two live runs of one input differ there, and nowhere else; replay serves the
recorded answer). Replay needs the log and nothing else — no keys, no wallet
on the message path. Sharing state is sharing the log. (An
earlier version kept the ciphertext and a per-message key, and had handlers
decrypt and sign "reveals" into state; the state is plaintext anyway — trees,
output, completions — so selectively handing out keys bought nothing.)

## Bodies

Inside `content`, our payload is **dag-cbor**: the same encoding as every
record, so a body is a record with a CID. One base64 at the messagebox
layer is the only expansion. A binary envelope replacing the JSON one would
be a later extension BRC.
