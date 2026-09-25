# Messages

How messages enter and leave a skein instance, as settled with David on
2026-09-25 (evening). This replaces the local-socket transport and the
`hello`/`tick` messages of the first runtime build.

## The messagebox is the transport

"Message" means a BRC-33 message: sent to a named **box** on an identity,
carried by a messagebox, listed and acknowledged; wrapped in the BRC-169
§7.2 envelope. The implementation is `@bsv/message-box-client` and the
message-box server in ts-stack (BRC-103/104 authenticated), with the drift
from BRC-169 that exists today (encryption per BRC-2/42/43 rather than
BRC-78; host discovery by on-chain advertisement rather than handle-domain
resolution; no per-message signature yet).

The instance **owns its messagebox**. The outside server is a proxy into the
VM: the BRC-103/104 handshake, the session, and the acknowledgement are done
by the runtime itself, with every cryptographic operation (counterparty-
derived signatures, verification, HMACs, nonces, encryption, decryption) a
call to the connected wallet. What remains in our code is the protocol state
machine, small enough to write in any language the kernel is written in.
Receiving need not be an explicit poll-and-acknowledge: a queue of received
messages is the same interface.

Because the handshake happens inside, its messages are inputs and outputs
like any other, so who-said-what is in the log and replays with everything
else. Done outside, the VM would still be deterministic over its inputs, but
the provenance of those inputs would be unrecorded.

## What the envelope supplies

From the envelope and the authenticated session, not repeated in the body:
`sender` (identity key, established by the server's authentication),
`recipient`, `messageBox`, `messageId` (an HMAC of the body), `created_at`,
and any attached payment.

## The body

The body is encrypted content, opaque to the transport. Ours is **dag-cbor**:
the same encoding as every record in the store, so a body is a record with
a CID. Hashes and payloads stay raw inside; the only expansion is the one
base64 the envelope applies to the encrypted bytes. A binary envelope
replacing the JSON one is a possible later extension BRC.

The body carries only what the envelope does not: the payload itself, and
references to records it builds on (the request it replies to, a tree, a
thread), named by hash. Dependencies between a sender's messages are that
sender's protocol, checked by the receiving program; the transport gives no
per-sender ordering.

## Kind is the box

A message's type is the box it was sent to. Each box has one dag-cbor body
schema. Boxes today:

- `run` — `{ cmd, tree, cwd?, env? }`: run a command over a tree.
- `subscriptions` — `{ match: { sender?, box? }, handler }`: configuration
  from the admin identity.
- replies to requests the runtime sent — box named by the request's
  protocol; body names the request it answers.

## Order

The runtime admits messages in arrival order and writes the time it observed
on each log entry. That admission order is the order of record; replay uses
it, not whatever the network did. Arrival is non-deterministic only until
admission.

## Routing

- **Replies** correlate to their request through the waiting thread's own
  state: a thread that sent a request rests `waiting` with a reference to
  that request; a message naming the request is delivered to that thread.
  No table, no subscription.
- **Unsolicited** messages are routed by **subscriptions**, matched on
  `(sender, box)`, tried in log order, first match wins; the handler is a
  program CID, and the thread it opens gets the body as its arguments and
  the message as `launchedBy`. No match: recorded, nothing runs.
- **Results** go out to the sender of the request that started the thread,
  naming that request.

## What is not a message

- **Genesis** is starting state: the instance's identity and first moment,
  written by the runtime to itself. It is the first record, not a message.
- **Time** is the runtime's stamp on each log entry. A thread that sleeps
  rests until its deadline; when the runtime wakes it, that wake is a
  stamped log entry with no message and no sender — one per wake.
- **`hello`** and **`tick`** from the first build are gone.
