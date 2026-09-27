# Messages

How messages enter and leave a skein instance, as settled with David on
2026-09-25/26. This replaces the local-socket transport, the `hello` and
`tick` messages, and the auth-stage idea of the first runtime build.

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
transport, handled by the host's delivery provider. It is not in the VM and
not in the log.

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
  content.) Queueing, retries and delivery errors are the provider's; nothing
  about delivery comes back as an error. A reply, if any, is just another
  admitted entry; a thread whose reply never comes sits `waiting` at no cost.
  (A delivery receipt entry, "sent", signed by the provider, would be optional
  state the VM may consult; it is not built.)
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
- **Every log entry is signed by the host**, admissions and wakes alike: an
  entry is the host's statement — "message *n* arrived at *t*", "wake at *t*"
  — so the provider that delivers it (the delivery for admissions, the tick
  for wakes; different parties may run them) signs it with the host wallet (`createSignature`, protocol `[2, "skein
  log"]`, key `1`, counterparty `anyone`), not the instance's. The genesis
  records the host's identity (`host`, beside `owner`), and every stamp and
  every kick traces to a signature a third party can check against it. Where
  a provider hosts instances for users, this is the provider's word, and what
  a checkpoint later binds to chain time. The signature is recorded, never
  recomputed. The instance wallet signs nothing per message; it signs only
  what the instance itself sends. (One wallet may be host, instance and
  owner at once, e.g. a whole VM in a browser window: the roles collapse and
  nothing breaks.)
- **Routing** is by **subscription** on `(sender.identityKey, box)`, in log
  order, first match wins. The handler is the **box's handler program**, not
  a tool: `(sender: david, box: run) → run-handler`.
- **The handler** knows the box's message shape. Its arguments name the
  envelope and the plaintext body records; it reads the body and launches the
  next thread with arguments pointing at the body or a record derived from it
  — for `run`, the shell over the named tree. No decryption inside, no
  attested call, no wallet.
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
  sender, one per wake. `hello` and `tick` are gone.

## Chat between instances

An instance talks to another the way David talks to it: a `chat`. There is
one chat envelope, the same in both directions, whoever the parties are: a
new conversation has no `replyTo`; everything after it is a `chat` **reply**
(`replyTo` = the envelope it answers). There is no `say`. A conversation is
pairwise — one sender, one recipient, `replyTo` one parent — and a thread is
one party's participation in one conversation.

The loop (`programs/loop`) gives the model a `message` tool beside `bash`:

```
message {to: "@handle@domain", text}
```

- **Addressing.** The loop resolves the handle to an identity key through the
  host (`skein.Resolve`, the `resolve` import): an attested call — the host's
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
  user turn. Replies to `infer` arrive in `completions`, which the genesis
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
  subscription; to accept agents, not only its owner, its genesis subscribes
  `{box: "chat"}` with no sender. A stalled reply is a delivery failure — the
  thread just waits.

## Why the plaintext

With the content hash in the sender's signature, the plaintext needs no one
else's word: a replayer checks the body against `contentHash` and the
signature against `sender.identityKey`, from the log alone. So the log keeps
the plaintext, and an inbound message's ciphertext is not part of state;
nothing depends on it. What the instance sends is different only in that the
program produced it: its emit record carries the envelope complete,
ciphertext and all, and the wallet's answers to the sign and encrypt calls
are recorded like any attested call (the encryption's IV is the wallet's, so
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
