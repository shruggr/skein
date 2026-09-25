# skein

A deterministic WASI machine over a content-addressed graph. Its only inputs
are an ordered log of signed entries — BRC-169 envelopes admitted from the
host's messagebox, and wakes for sleepers; its only outputs are envelopes.
Programs run inside it: handler programs (Go, `wasip1`) per box, and a
bash-compatible wasm shell over git-shaped trees. Time and randomness are not
inputs: the runtime stamps each log entry with its own clock and signs it, and
programs see that stamp (+1 ns per read) as "now" and a stream keyed by the
entry's CID as random bytes. Replaying the log reproduces the graph, with no
wallet.

Read `docs/ARCH.md` first (the architecture; "The kernel, in one paragraph" is
the spec), then `docs/MESSAGES.md` (how messages enter and leave) and
`docs/VM.md`. Open questions are in `docs/OPEN.md`.

## Layout

```
src/runtime/     the machine — one process; no disk, network or randomness; one clock read, in log.ts
  main.ts          `skein-runtime`: store + wallet + edge + scheduler
  inbox.ts         the edge to the host's messagebox: screen, derive the message key, admit; seal and send emits
  scheduler.ts     the log consumer: route by subscription, step programs and the shell, attested calls, replay
  log.ts           the input log: signed entries (genesis | envelope | wake), stamped at admission
  program.ts       one step of a handler program; wasi/skein-imports.ts is its `skein` import namespace
  programs.ts      the program records (shell, run-handler, objects-handler) and pinned module CIDs
  shell.ts wasi/   the wasm shell (brush + uutils coreutils) and the WASI host
  syscalls.ts      pure time (entry stamp + 1 ns per read), sleep, random (keyed by entry CID)
  store.ts sqlite.ts memory.ts cid.ts records.ts types.ts tree.ts identity.ts
src/envelope.ts  BRC-169 envelopes: RFC 8785 canonical form, BRC-78 content, seal/verify/open (shared with the client)
src/client/      David's client (`bin/skein`): import, run, inbox
src/dev/         developer tools, OUTSIDE the machine: `skein-dev install|log|ls|show|refs|rebuild`
src/wallet.ts    connecting a BRC-100 wallet
programs/        handler programs in Go: run-handler, objects-handler; skein/ (the ABI), brc78/ (pure decryption)
scripts/         build-wasm.sh (brush, coreutils), build-programs.sh + pin-programs.sh (handlers), host/ (dev host)
wasm/            the committed modules; their CIDs are pinned in src/runtime/programs.ts
```

`src/runtime/isolation.test.ts` fails if anything under `src/runtime` imports
`node:fs`, `child_process`, `http(s)`, `net`…, or uses `fetch`, `Date.now`
(except `log.ts`, which stamps entries), `Math.random`, `randomBytes`, timers
or `process.env` — with named exceptions: `inbox.ts` (the network edge: the
messagebox client, `../envelope.ts`, a poll timer) and `main.ts` (env, the
wallet, wake timers).

## Running it

Needs Node 26 (JSPI, `node:sqlite`, type stripping) and the dev host
(`scripts/host/README.md`: instance and owner wallets, the messagebox at
http://127.0.0.1:8100/messagebox, grants).

```
npm install
scripts/host/up.sh                          # wallets, messagebox, grants, accounts (idempotent)
bin/skein-runtime                           # the instance: installs modules, writes a genesis into an empty store
bin/skein import ~/Work/easel               # the client: tree objects into `objects`; prints the tree CID
bin/skein run --tree <cid> -- 'ls | head -3'
bin/skein inbox --wait                      # the result envelope, opened by the owner
bin/skein-dev log; bin/skein-dev ls; bin/skein-dev show <cid-suffix>
npm test                                    # includes `go test ./brc78` when go is on PATH
```

`bin/skein-runtime` fills the environment from `~/.skein`: `SKEIN_INSTANCE_WIF`
(from `dev-wallet.env`: the key the instance wallet runs with; the edge derives
each envelope's BRC-78 message key from it — BRC-100 has no call that returns
one), `SKEIN_OWNER` (`owner.identity`), `SKEIN_MESSAGEBOX` (`messagebox.url`).
Also: `SKEIN_DB` (`~/.skein/runtime.db`), `SKEIN_HANDLE` (`skein@localhost`),
`SKEIN_OWNER_HANDLE` (`david@localhost`), `SKEIN_FRESHNESS_MS` (600000),
`SKEIN_POLL_MS` (1000), `SKEIN_WALLET=ephemeral` (a throwaway key).

The instance wallet (`1sat serve wallet-api`, origin `skein`) needs, besides
the transport grants in `scripts/host/grants.sh`:

```
1sat permissions grant skein --protocol "skein log" --level 2 --counterparty anyone      # every log entry's signature
1sat permissions grant skein --protocol "skein reveal" --level 2 --counterparty anyone   # every reveal's signature
1sat permissions grant skein --protocol "metanet handles envelope" --level 2 --counterparty anyone  # outbound envelopes
1sat permissions grant skein --protocol "message encryption" --level 2 --counterparty <owner>      # outbound content
```

Handler programs change → `scripts/build-programs.sh && scripts/pin-programs.sh`
(the build is reproducible; the pins are the modules' raw CIDs).

## Records

| record | shape |
|---|---|
| log entry | `{kind: "log", prev, n, time: [sec, nsec], genesis \| envelope+box+key \| wake, sig}` — `sig` by the instance identity over the entry without `sig` (`[2, "skein log"]`, key `1`, anyone) |
| genesis | `{kind: "genesis", identity, handle, domain, owner, programs: {name: cid}, subscriptions: [{match: {sender?, box?}, handler}]}` |
| envelope | the BRC-169 envelope's JSON object as received, as dag-cbor (its CID is the client's `replyTo`) |
| message key | `{kind: "message-key", envelope, key}` — the 32-byte AES-256-GCM key its content decrypts under |
| thread origin | `{kind: "thread", program, args, launchedBy, input: <entry>, at, nonce?}`; handler args `{envelope, key, box, sender}` |
| program step | update `{state, step, input, at, calls?, launched?, waitingOn?, reveals?, emits?, result: {exitCode, stdout, stderr}}` |
| attested | `{kind: "attested", thread, step, i, op: "wallet" \| "reveal", request, result}` — a wire frame and its answer, or a reveal's signature |
| reveal | `{kind: "reveal", of: <envelope>, …}` — run: `cmd, tree, cwd?, env?`; objects: `root?, count` |
| emit | `{kind: "emit", to, handle?, domain?, box, body: <cid>}` — the edge seals `body` to `to` in `box` |

Boxes: `objects` (`{records: [{cid, bytes}]}` ≤ 1 MiB, blobs first) →
objects-handler; `run` (`{cmd, tree, cwd?, env?}`) → run-handler, which replies
in the sender's `results` box with `{exitCode, stdout, stderr, tree, replyTo}`.
