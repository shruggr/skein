# Backlog

The prioritised list as of 2026-09-26, grouped. We go through it one item at a
time with David; each settled item becomes a GitHub issue
(https://github.com/shruggr/skein/issues). Raw notes behind these are in
`OPEN.md`.

## Machine core
1. **Named heads, `main` default** — #1 (settled: heads are record chains;
   advancing is explicit; `chat`/`run` start from `main`).
2. **git over skein state** — #2 (direction settled; verbs proposed, not
   confirmed).
3. **Admin messages and mutable subscriptions**: add/remove routes, register
   programs, install trees, set owner/peers/defaults. Today all fixed at
   genesis.
4. **Bootstrap from a node**: genesis from a git tree or gib commit; the
   platform supplies the objects; modules stop entering via `skein-dev
   install`. Claim ("first caller is admin") only for single-user local;
   commercial hosting registers via a host API route behind payment
   middleware.
5. **Metering**: fuel for infinite loops; caps on steps and tool calls.
6. **Reachability gating** of `get`; per-program wallet grants.

## Messages and edge
7. **Edge out of the runtime process** (message-key derivation, messagebox
   client); later a multi-wallet BRC-100 server, one channel per instance.
8. **Delivery robustness**: durable outbox; a failing handler still replies;
   freshness judged at arrival, not admission.
9. **Scheduler shouldn't decrypt to route**: `replyTo` in plaintext metadata
   or a dedicated box.

## Inference
10. **Priced inference**: prepaid balance per identity; "exhausted + quote"
    reply (BRC-169 §8.3 shapes); the loop tops up under an instance-side
    spend policy per peer identity (the wallet's per-origin monthly cap is a
    backstop only).
11. **Graph-delta inference**: the peer holds the conversation and receives
    only new nodes; native fork and revert.
12. **Per-message `thinking`/model**; stop resending the whole chat each step.

## Shell and programs
13. **Streaming pipelines**; `env`/`chmod`/`stat`/grep/sed/awk/find in the
    toolset; file modes.
14. **HTTP as a kernel binding** (`wasi:http`, or a `skein.fetch` import
    first) to an HTTP provider peer.
15. **Runtime choice**: V8/JSPI vs wasmtime; core modules vs components.

## Interface
16. **Easel as the lens** over the messagebox (the browser page is the
    stand-in); client signing with the Yours wallet.
17. **Specs upstream**: binary BRC-169/33 extensions; BRC-169 §7.2 signature
    derivation.

## Where to track
Issues on GitHub; this file is the ordered index; `OPEN.md` the raw notes.
