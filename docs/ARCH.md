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

Everything else that looks like an input — the time, a random seed, a model
completion, a tree of files, a person's line — is a message. Even the clock
and randomness: under the covers a program's request for "now" or for random
bytes is a message to a receiver outside, and the answer comes back signed,
bound to the state it applied to (`{ time | seed, state, sig }`), and is
recorded. That is what makes replay exact.

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
- **clock and random** — the simplest peers: they answer requests with
  attestations.
- **messagebox** — the BRC-33/BRC-169 relay to people and other instances.
- **other instances** — peers like any other.

A peer may be a thin proxy that receives messages and runs things on a real
host; what makes that acceptable is that its result is signed by the peer's
identity and enters the log as a message. The runtime's record of the world
is exactly the set of messages peers sent it.

## How a file gets in and out

In: a peer (the client) hashes a directory into git blob and tree objects,
sends them, and sends a message naming the root CID. The runtime stores the
objects and the message; a thread's working tree is that CID.

Out: a thread's result names a tree CID. A peer that wants bytes on a disk
fetches the objects and materializes them, or pushes them as a git commit
through gib. The runtime never writes to a disk.

## Processes on David's machines, today

- `skein` — the runtime: one process, one instance, one store file. Talks to
  the wallet, and to peers over a local socket or a messagebox.
- `1sat serve wallet-api` — the wallet.
- a **client** — David's terminal or easel: scans, prompts, renders, signs as
  David.
- **peers** — inference (ripper), clock/random, a machine runner for
  commands that cannot run inside, each with its own derived identity.

The v1 daemon glued a runtime and a local client into one process and let
the "skein" CLI read the disk. That is the thing this note corrects.
