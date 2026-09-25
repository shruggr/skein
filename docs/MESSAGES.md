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
  created, quoteId?, payment?, content, signature }
```

- `sender.identityKey` and `signature` are plaintext: provenance a third party
  can verify from the envelope alone.
- `content` is a BRC-78 portable encrypted message: security level 2,
  protocol `message encryption`, a random 256-bit key id per message carried
  in the serialization, counterparty the recipient. Only the recipient can
  decrypt; decrypting successfully is the content's authenticity check and
  names the same identity the signature names.
- `payment`, when present, is a BRC-29 payment as Atomic BEEF, unbroadcast,
  to keys derived from the recipient's identity key, internalized by the
  recipient's wallet with `internalizeAction`.
- The box name is not in the envelope; it is the BRC-33 parameter beside it.
  BRC-169 leaves the choice of box to the sender.

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
`signature` removed. A verifier derives the signing key from
`sender.identityKey` with those constants. Reusing one derived key across
envelopes is safe (RFC 6979 nonces); the identity key is already plaintext,
so a fresh key id would add no unlinkability. This is a proposed revision
to BRC-169 §7.2, to be raised upstream.

## Inside the instance

- **Admission.** The instance collects its box (list-and-acknowledge, or an
  equivalent queue) and admits each envelope as a log entry in arrival order,
  with the box name and the time it observed. Arrival is non-deterministic
  only until admission; the admitted order is the order of record.
- **Every log entry is signed** by the instance's identity (`createSignature`
  through its wallet, counterparty `anyone`), admissions and wakes alike, so
  every stamp and every kick traces to a signature a third party can check.
  The signature is an attested syscall result: recorded, never recomputed.
- **Routing** is by **subscription** on `(sender.identityKey, box)`, in log
  order, first match wins. The handler is the **box's handler program**, not
  a tool: `(sender: david, box: run) → run-handler`.
- **The host delivers the decryption key with the envelope.** The host, where
  the wallets live, derives the BRC-78 message key for each incoming envelope
  (a per-message key: BRC-78 picks a random key id per message, so it exposes
  nothing else) and routes envelope and key to the instance together. Both
  are records; the admission entry references them.
- **The handler** knows the box's message shape. It decrypts the content
  purely (AES-256-GCM with the recorded key — a replayer recomputes the
  plaintext and checks the tag; no wallet, no attested call), **reveals** into
  state what it chooses as a record, **signs the reveal** with the instance
  identity (attested, `anyone`), and launches the next thread from the
  revealed records — for `run`, the shell over the named tree. State can
  only build on revealed records. Keys in the state are as sensitive as the
  plaintext: if you don't want it exposed, don't share your state.
- **Replay protection** is at admission: an envelope whose record CID was
  already admitted is rejected; `created` must fall within a freshness
  window; where the messagebox reports the authenticated submitter, it must
  equal `envelope.sender.identityKey`. The messagebox server should enforce
  the last of these too, and dedupe by message id.
- **Replies** correlate to their request through the waiting thread's own
  state: a thread that sent a request rests `waiting` with a reference to
  it; an admitted message naming that request is delivered to that thread.
- **Results** leave as envelopes to the sender of the request that started
  the thread, built and encrypted through the wallet the same way.
- **Nothing is a message that isn't one.** Genesis is starting state. A
  sleeper's wake is a signed, stamped log entry with no message and no
  sender, one per wake. `hello` and `tick` are gone.

## Why the key, not the plaintext

Recording the plaintext as an attested `decrypt` result would be
deterministic too, but a replayer would have to take the runtime's word for
it. Recording the message key makes decryption a pure computation anyone can
verify against the ciphertext, keeps ciphertext as the canonical stored
content (share the log without the keys and it is confidential; hand out one
key and exactly one message is readable), and needs no wallet to replay or
to fork under a new identity. It needs one wallet operation BRC-100 lacks:
returning the message key rather than the plaintext — a method for the
host's wallet, not the standard interface.

## Bodies

Inside `content`, our payload is **dag-cbor**: the same encoding as every
record, so a body is a record with a CID. One base64 at the messagebox
layer is the only expansion. A binary envelope replacing the JSON one would
be a later extension BRC.
