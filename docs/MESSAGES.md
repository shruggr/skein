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
transport, handled at the host edge. It is not in the VM and not in the log.

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
  protocol `message encryption`, a random 256-bit key id per message carried
  in the serialization, counterparty the recipient. The encryption is
  **wire-level only**: it keeps the messagebox operator out and nothing more.
  The recipient decrypts it and checks the plaintext against `contentHash`.
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

## Inside the instance

- **Admission.** The instance collects its box (list-and-acknowledge, or an
  equivalent queue), verifies each envelope's signature, decrypts its content
  through the instance wallet and checks it against `contentHash`, and admits
  it as a log entry in arrival order: the envelope's signed part and the
  plaintext body (both records; the body's CID is dag-cbor over the sender's
  bytes, so its sha2-256 digest *is* `contentHash`), with the box name and the
  time it observed. The ciphertext is not kept. Arrival is non-deterministic
  only until admission; the admitted order is the order of record.
- **Every log entry is signed by the host**, admissions and wakes alike: an
  entry is the host's statement — "message *n* arrived at *t*", "wake at *t*"
  — so the host wallet signs it (`createSignature`, protocol `[2, "skein
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
- **Replay protection** is at admission: an envelope whose record CID was
  already admitted is rejected; `created` must fall within a freshness
  window; where the messagebox reports the authenticated submitter, it must
  equal `envelope.sender.identityKey`. The messagebox server should enforce
  the last of these too, and dedupe by message id.
- **Replies** correlate to their request through the waiting thread's own
  state: a thread that sent a request rests `waiting` with a reference to
  it; an admitted message naming that request is delivered to that thread.
- **Results** leave as envelopes to the sender of the request that started
  the thread. The step that emits signs the signed part through the instance
  wallet (an attested call; `created` is the step's stamp), so its id is known
  and recorded; the edge encrypts the body to the recipient when it sends.
- **Nothing is a message that isn't one.** Genesis is starting state. A
  sleeper's wake is a signed, stamped log entry with no message and no
  sender, one per wake. `hello` and `tick` are gone.

## Why the plaintext

With the content hash in the sender's signature, the plaintext needs no one
else's word: a replayer checks the body against `contentHash` and the
signature against `sender.identityKey`, from the log alone. So the log keeps
the plaintext, and neither the ciphertext nor the message key is part of
state; nothing depends on them. Replay needs the log and nothing else — no
keys, no wallet on the message path. Sharing state is sharing the log. (An
earlier version kept the ciphertext and a per-message key, and had handlers
decrypt and sign "reveals" into state; the state is plaintext anyway — trees,
output, completions — so selectively handing out keys bought nothing.)

## Bodies

Inside `content`, our payload is **dag-cbor**: the same encoding as every
record, so a body is a record with a CID. One base64 at the messagebox
layer is the only expansion. A binary envelope replacing the JSON one would
be a later extension BRC.
