# Architecture

The one-page picture, as settled with David on 2026-09-25. Where `VM.md`
talks about a "host" with services beside the runtime, this note supersedes
it: there is no such layer.

## The runtime is the whole system

The skein runtime is the only thing that communicates into or out of an
instance. Its edges are:

1. **Messages** — signed records, in and out. This is the only channel.
2. **The wallet** — the connected BRC-100 wallet, for signing, verifying,
   encrypting, decrypting and deriving. Keys never enter the runtime.

Everything else that looks like an input — a model completion, a tree of
files, a person's line — is a message from another identity, signed by it.

Each edge is an interface, satisfied by a **provider** outside `src/runtime`
(`MESSAGES.md`, "Providers"): message delivery (`src/host/messagebox.ts`),
ticks (`src/host/tick.ts`), the wallet. Which provider serves which interface
is kernel configuration (`src/host/main.ts`), so a test wires mocks and one
host can serve all of them or different parties each. The runtime only
`admit`s the finished, host-signed entries they deliver and hands its emits
to the delivery provider.

Time and randomness are different: they are not another party's statement
inside a message. When the host admits an input it reads its clock and writes
the time into that log entry ("this arrived at *t*"; `MESSAGES.md`; since
#33 the entry is not signed: the stamp is the environment's word, and the
sequence is the order).
Inside the machine, "now" is the entry's time plus the fuel the step has
burnt so far at one nanosecond per unit, and never the same value twice
(so time always moves forward and never backwards; issue #38, Zig kernel —
the frozen TS runtime still advances one nanosecond per read),
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
  the virtual filesystem, the store by CID, the wallet, and message
  emission;
- the **virtual filesystem**: trees from the store, seen through WASI; the
  wasm shell and its tools run over it. It is the only filesystem the runtime
  has.

The runtime has no access to a disk, a network, a clock or a process table.
Nothing in its code imports `node:fs`, `node:child_process` or `fetch`. The
"WASI host" — the code that satisfies a module's imports — is *inside* the
runtime; it is not a host in any other sense.

## Everything outside is a peer

Anything that acts on the world is a **peer**: an identity that exchanges
signed messages with the runtime. The runtime cannot tell, and does not care,
whether a peer is a process on the same machine or a service across the
network. Peers include:

- **David's client** — runs as David on his desktop. It scans a directory
  into tree objects and *sends* the tree; sends his prompts; receives pages
  and spoken lines; signs with his wallet. It is a peer, not part of skein.
- **inference** — a peer that turns a prompt message into a completion
  message (ripper's vLLM behind it).
- **a machine** — a peer that receives "run this on the host" and answers
  with the signed result. This is the sysadmin path and the toolchain path
  (`go build`, `npm test`): the command runs outside, the result is a
  recorded input.
- **messagebox** — the host's BRC-33/BRC-169 messagebox; every message in
  or out passes through it as a BRC-169 envelope (see `MESSAGES.md`).
- **other instances** — peers like any other.

A peer may be a thin proxy that receives messages and runs things on a real
host; what makes that acceptable is that its result is signed by the peer's
identity and enters the log as a message. The runtime's record of the world
is exactly the set of messages peers sent it.

## How a file gets in and out

In: a peer (the client) hashes a directory into git blob and tree objects,
sends them, and sends a message naming the root CID. The runtime stores the
objects and the message; a thread's working tree is that CID. A message that
names no tree starts from the instance's `main` head, which only an explicit
act moves (`VM.md`, "Heads").

Out: a thread's result names a tree CID. A peer that wants bytes on a disk
fetches the objects and materializes them, or pushes them as a git commit
through gib. The runtime never writes to a disk.

## The router (issue #33)

The host is a **router**, and the instance is the messagebox host. The kernel's
surface is its table: three things leave the VM — `wallet` (the signing
oracle), `emit` (these bytes to that identity), `resolve` (handle → identity
key) — and one call comes in: **admit an entry and run the step**. A
`sendMessage` from the web, a wake, an outcome, a mailbox change and a deploy
are all that one call.

- **Transport and auth** end at the router (`src/host/router.ts`, `auth.ts`):
  the BRC-33 API of the TypeScript messagebox (`/sendMessage`,
  `/listMessages`, `/acknowledgeMessage` under BRC-103/104 mutual auth, plus
  `/account/register` and the paymail PKI), JSON or BRC-231 dag-cbor, so the
  stock `@bsv/message-box-client` works against it unchanged. The router's
  BRC-104 identity is its own (one URL, one handshake for every instance), a
  child of the master secret.
- **Routing**: host.db maps an identity to the instance that serves it — its
  own identity, or a mailbox it keeps for another identity (the owner's
  wallet, the inference peer, a roster). A message to an instance is screened
  (signed by the authenticated sender, addressed to it, new), decrypted
  through its oracle and admitted as an envelope entry; mail for a hosted
  identity is admitted into the keeping instance as a `mail` entry, and the
  **messagebox program** (`programs/messagebox`, Zig, run by the `:mail`
  subscription) keeps it under the head `mailbox`, in log order;
  `listMessages` is a read of those records, `acknowledgeMessage` an `ack`
  entry. Down means down; nothing waits for a receipt.
- **Hydration**: an instance is a kernel the router can load
  (`src/host/kernel.ts`: `skein-kernel serve` over the instance's store,
  length-prefixed dag-cbor frames on stdin/stdout). The router starts it on
  demand and stops it when it has been idle `SKEIN_IDLE_MS`; recovery after an
  environment failure happens at hydrate time from the log (a thread whose
  step was cut off — the router gone mid-call — runs again; a deterministic
  error is recorded and never retried).
- **The waker** is the router's timer: the kernel reports its sleepers; the
  router keeps each instance's earliest deadline, and when it comes it
  hydrates the instance and admits the wake.
- **The oracle** (#18): one master secret (`$SKEIN_HOME/master.key`), a
  per-instance root key derived from it with BRC-42/43 (`[2, "skein
  instance"]`, key ID = the handle, self), a ProtoWallet each
  (`src/host/oracle.ts`) answering the kernel's `wallet` import in process.
  Provisioning an instance is picking a handle (`skein-host add`).
- **No host key** (#9): entries are unsigned — the sender signed the message,
  `prev` fixes its place, the stamp is the environment's word. Time (#10): the
  router stamps each entry at admission; the sequence is the order.
- **Format 2** (#21): identity keys, hashes and signatures are byte strings in
  every record; envelopes are kept in the encoding they were made in — §7.2
  JSON from JSON clients (the front end), §7.3 dag-cbor from instances and
  BRC-231 clients — and an instance answers a party in the form it wrote in.
  `kernel-zig/src/log.zig` has the shapes.

## Processes on David's machines, today

- `skein-host run` — the router: the messagebox on `127.0.0.1:8100`
  (`/messagebox`), a `skein-kernel serve` child per instance while it has
  work, the host page and roster on `:4600`, one read-only `skein-explore` per
  instance on `:4610+`. Log in `~/.skein/logs/host.log` when `up.sh` starts it.
- `1sat serve wallet-api` — the clients' wallets only: the dev owner (3322)
  and the inference peer (3323). No wallet per instance, no host wallet, no
  `1sat serve` messagebox (their scripts are kept, marked legacy).
- a **client** — David's terminal (`bin/skein`) or the bopen-skein front end
  (Yours wallet): scans, prompts, renders, signs as David, over the standard
  messagebox client.
- **peers** — inference (`bin/skein-infer`, ripper behind it), each with its
  own identity and a mailbox kept here.

The v1 daemon glued a runtime and a local client into one process and let
the "skein" CLI read the disk. That is the thing this note corrects.

## The kernel, in one paragraph (added later on 2026-09-25)

Skein is a WASI machine: the runtime's import table is its kernel, and the
userland is anything compiled to plain WASI (Rust `wasm32-wasip1`, wasi-sdk
C/C++, Go `wasip1`, interpreters as modules). Programs target WASI, never
skein. Syscalls are of two kinds. **Pure** ones — files, pipes, spawn, stdio
— are answered inside, deterministically, and never recorded. **Attested**
ones — anything that leaves the runtime: a message to a peer (inference,
fetch, clone, run-on-machine) — are one message out and one signed message
back, recorded and replayed. Time and random are pure: they derive from the
stamp the runtime wrote on the current log entry.
Request/response *is* attestation; peers all look the same from inside. A
program waiting on an recorded call is an ordinary thread at rest: the
suspended instance is its transient handle, the scheduler wakes it when the
reply arrives, and a restart re-executes it from the log. Pipeline stages are
threads too; their records are recomputable cache. Which syscall is bound to
what — inside, or routed out — is instance configuration in the log, so a
mock is just a binding to a bundle, and replay uses the binding the original
run used.
