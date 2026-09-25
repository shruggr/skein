# skein

A deterministic WASI machine over a content-addressed graph. Its only inputs
are an ordered log of signed messages; its only outputs are messages. Programs
(for now: a bash-compatible wasm shell over git-shaped trees) run inside it;
anything that needs the world — the time, a random seed, a model, a real
machine — is a **peer** that answers a signed request with a signed reply,
which the log records. Replaying the log reproduces the graph.

Read `docs/ARCH.md` first (the architecture; "The kernel, in one paragraph" is
the spec), then `docs/VM.md`. Open questions are in `docs/OPEN.md`.

## Layout

```
src/runtime/     the machine — one process, no disk/network/clock/randomness
  main.ts          `skein`: store + wallet + socket + scheduler
  scheduler.ts     the log consumer: route by subscription, step threads, attested syscalls
  log.ts           the input log as a hash chain (tip = state hash); genesis
  syscalls.ts      the binding table (pure vs attested → which peer); the seed stream
  transport.ts     unix socket, length-prefixed dag-cbor frames, hello, held messages
  programs.ts      the `shell` program record; wasm modules loaded from the store by CID
  shell.ts wasi/   the wasm shell (brush + uutils coreutils) and the WASI host
  store.ts sqlite.ts memory.ts cid.ts records.ts types.ts tree.ts identity.ts
src/peers/       things outside that talk to the runtime by messages
  clock.ts         `skein-clock`: answers time and random requests
  connection.ts    a peer's side of the socket
src/dev/         developer tools, OUTSIDE the machine (read the disk, open the store file)
  cli.ts           `skein-dev`: scan, install, run, sh, log, ls, show, refs, tree ls, rebuild
  scan.ts          directory <-> tree objects (the client's job)
  admin.ts         sign and send messages as admin/david
src/wallet.ts    connecting a BRC-100 wallet (the runtime's other edge)
wasm/            brush.wasm, coreutils.wasm (see wasm/README.md)
```

`src/runtime/isolation.test.ts` fails if anything under `src/runtime` imports
`node:fs`, `child_process`, `http(s)`, `dns`, `net` (except `transport.ts`),
or uses `fetch`, `Date.now`, `Math.random`, `randomBytes`, timers or
`process.env` (except `main.ts`).

## Running it

Needs Node 26 (JSPI, `node:sqlite`, type stripping) and a wallet:
`1sat serve wallet-api` on 127.0.0.1:3321 with origin `skein` granted protocol
`skein` and identity-key retrieval (or `SKEIN_WALLET=ephemeral` for a
throwaway key).

```
npm install
bin/skein                                   # the runtime; writes a genesis into an empty store
bin/skein-clock                             # the clock peer, in another terminal
bin/skein-dev scan ~/Work/easel             # tree objects into the store file; prints the tree CID
bin/skein-dev run --tree <cid> -- 'date; ls | head -3'
bin/skein-dev log                           # the input log and the state hash
bin/skein-dev ls; bin/skein-dev show <cid-suffix>
npm test
```

State lives in `$SKEIN_HOME` (default `~/.skein`): `runtime.db` (`$SKEIN_DB`)
and `runtime.sock` (`$SKEIN_SOCKET`).

## Messages

All are signed records `{kind: "message", from, to?, seq, at, body, refs, sig}`.

| body | from → to | |
|---|---|---|
| `{kind: "hello", identity}` | peer → runtime | first frame; verified, not logged |
| `{kind: "run", cmd, tree, cwd?, env?}` | admin/david → runtime | routed to `shell` by subscription |
| `{kind: "time", state}` | runtime → clock | per CLOCK_REALTIME read; `state` = the log entry asking |
| `{kind: "time", time, state}` + `replies-to` | clock → runtime | ms since epoch |
| `{kind: "random", state}` | runtime → clock | once per thread |
| `{kind: "random", seed, state}` + `replies-to` | clock → runtime | 32 bytes seeding a SHA-256 stream |
| `{kind: "result", exitCode, stdout, stderr, tree}` + `replies-to` | runtime → launcher | when a thread ends |
| genesis, subscription, `{kind: "bind", syscall, to}` | admin → runtime | configuration, in the log |
