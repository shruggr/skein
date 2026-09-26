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

Time and randomness are different: they are the runtime's own observations,
not another party's statement. When the runtime admits an input it reads its
clock and writes the time into that log entry, unsigned and immutable.
Inside the machine, "now" is the entry's time plus a counter that advances
one nanosecond per read (so time always moves forward and never backwards),
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
  subscription, steps programs;
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

## Processes on David's machines, today

- `skein` — the runtime: one process, one instance, one store file. Talks to
  the wallet, and to peers over a local socket or a messagebox.
- `1sat serve wallet-api` — the wallet.
- a **client** — David's terminal or easel: scans, prompts, renders, signs as
  David.
- **peers** — inference (ripper), a machine runner for commands that cannot
  run inside, each with its own derived identity.

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
program waiting on an attested call is an ordinary thread at rest: the
suspended instance is its transient handle, the scheduler wakes it when the
reply arrives, and a restart re-executes it from the log. Pipeline stages are
threads too; their records are recomputable cache. Which syscall is bound to
what — inside, or routed out — is instance configuration in the log, so a
mock is just a binding to a bundle, and replay uses the binding the original
run used.
