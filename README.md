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
  inbox.ts         the edge to the host's messagebox: screen, decrypt, admit the plaintext; sign, encrypt and send emits
  scheduler.ts     the log consumer: route by subscription, step programs and the shell, attested calls, replay
  log.ts           the input log: signed entries (genesis | envelope | wake), stamped at admission
  program.ts       one step of a handler program; wasi/skein-imports.ts is its `skein` import namespace
  programs.ts      the program records (shell, run-handler, objects-handler, head-handler, loop) and pinned module CIDs
  heads.ts         named heads: a chain per name; `main` is where `run`/`chat` start
  shell.ts wasi/   the wasm shell (brush + uutils coreutils) and the WASI host
  syscalls.ts      pure time (entry stamp + 1 ns per read), sleep, random (keyed by entry CID)
  store.ts sqlite.ts memory.ts cid.ts records.ts types.ts tree.ts identity.ts
src/envelope.ts  BRC-169 envelopes: RFC 8785 canonical form, signed contentHash, BRC-78 content, sign/seal/verify/open (shared with the client)
src/client/      David's client (`bin/skein`): import, run, chat, inbox
src/peers/       peers, each its own process and identity: infer.ts (`bin/skein-infer`, the inference peer)
src/dev/         developer tools, OUTSIDE the machine: `skein-dev install|log|ls|show|refs|rebuild`
src/wallet.ts    connecting a BRC-100 wallet
programs/        handler programs in Go: run-handler, objects-handler, head-handler, loop (the chat turn loop); skein/ (the ABI)
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
bin/skein run --tree <cid> -- 'ls | head -3'   # no --tree: the `main` head (the first import sets it)
bin/skein head main <cid>                   # move `main` to a tree the instance holds
bin/skein inbox --wait                      # the result envelope, opened by the owner
bin/skein-infer                             # the inference peer (its own wallet on 3323; providers in ~/.skein/infer.json)
bin/skein chat --new --tree <cid> --wait 'what is here?'   # the loop answers in David's `say` box
bin/skein-dev log; bin/skein-dev ls; bin/skein-dev show <cid-suffix>
npm test
```

`bin/skein-runtime` fills the environment from `~/.skein`: `SKEIN_OWNER`
(`owner.identity`), `SKEIN_MESSAGEBOX` (`messagebox.url`).
Also: `SKEIN_DB` (`~/.skein/runtime.db`), `SKEIN_HANDLE` (`skein@localhost`),
`SKEIN_OWNER_HANDLE` (`david@localhost`), `SKEIN_FRESHNESS_MS` (600000),
`SKEIN_POLL_MS` (1000), `SKEIN_WALLET=ephemeral` (a throwaway key).

The instance wallet (`1sat serve wallet-api`, origin `skein`) needs, besides
the transport grants in `scripts/host/grants.sh`:

```
1sat permissions grant skein --protocol "skein log" --level 2 --counterparty anyone      # every log entry's signature
1sat permissions grant skein --protocol "metanet handles envelope" --level 2 --counterparty anyone  # outbound envelopes
1sat permissions grant skein --protocol "message encryption" --level 2 --counterparty <owner>      # inbound and outbound content
```

Handler programs change → `scripts/build-programs.sh && scripts/pin-programs.sh`
(the build is reproducible; the pins are the modules' raw CIDs).

## Records

| record | shape |
|---|---|
| log entry | `{kind: "log", prev, n, time: [sec, nsec], genesis \| envelope+box+body \| wake, sig}` — `sig` by the instance identity over the entry without `sig` (`[2, "skein log"]`, key `1`, anyone) |
| genesis | `{kind: "genesis", identity, handle, domain, owner, programs: {name: cid}, subscriptions: [{match: {sender?, box?}, handler}], peers?: {infer}, defaults?: {model, thinking}, collect?: [box]}` |
| envelope | the BRC-169 envelope's signed part: its JSON object without `content`, as dag-cbor (its CID is the message id, the client's `replyTo`) |
| body | the plaintext content: the sender's dag-cbor bytes, CIDv1 dag-cbor/sha2-256 — the digest is the envelope's signed `contentHash` |
| thread origin | `{kind: "thread", program, args, launchedBy, input: <entry>, at, nonce?}`; handler args `{envelope, body, box, sender}` |
| program step | update `{state, step, input, at, calls?, launched?, waitingOn?, awaits?, kept?, emits?, heads?, result: {exitCode, stdout, stderr}}` — `awaits`: envelopes it emitted and rests on; `kept`: records the step keeps in the thread's state |
| step input | `{kind: "step", thread, step, entry, args, programs, resolved?, tip?, reply?: {envelope, body, box, sender, replyTo}, peers?, defaults?}` |
| attested | `{kind: "attested", thread, step, i, op: "wallet" \| "seal", request, result}` — a wire frame and its answer, or an emit record and its signed envelope (the signed part) |
| head | origin `{kind: "head", name}`; update `{tree, thread, input, at}` — written when a step that called `advance` ends without error; the step's update lists it in `heads` |
| emit | `{kind: "emit", to, handle?, domain?, box, body: <cid>}` — the edge signs the envelope for `body` to `to` in `box` during the step (`emit` returns the envelope CID; `created` is the step's stamp) and encrypts and sends it after |

Boxes: `objects` (`{records: [{cid, bytes}], root?}` ≤ 1 MiB, blobs first,
`root` on the last) → objects-handler, which sets `main` to `root` if there is
no `main`; `run` (`{cmd, tree?, cwd?, env?}`; no tree: `main`'s, else the empty
tree) → run-handler, which replies in the sender's `results` box with
`{exitCode, stdout, stderr, tree, replyTo}`; `head` (`{name, tree}`) →
head-handler, which moves the head (no reply).

Chat: `chat` (`{text, tree?, model?, replyTo?}`) with no `replyTo` → a new loop
thread, over `tree` or else `main`'s; the loop sends `infer` (`{model, messages, tools?, thinking?}`) to
`peers.infer`, which answers in `completions` (`{replyTo, message: {role,
content?, reasoning?, tool_calls?}, usage?, model, ms}` or `{replyTo, error}`),
and says `{text, page?, tree?, thread, replyTo: <chat>}` to David in `say`.
David's next `chat` carries `replyTo: <say>`.

**Replies.** An admitted envelope whose plaintext body has `replyTo` goes
only to the thread whose tip `awaits` that envelope,
and only if its sender is the identity it was sealed to; it becomes that step's
`reply` input. Otherwise it is recorded and nothing runs. It is never routed by
subscription.

Loop turns (`{kind: "turn", of, role, …}`), one per turn, kept in its chain (the conversation is rebuilt from them each step):
`{of: <chat>, role: "user", text, tree?, model?}`,
`{of: <completions>, role: "assistant", content?, reasoning?, tool_calls?, model, ms?, usage?}`,
`{of: <shell thread>, role: "tool", call, exitCode, stdout, stderr, tree}` (16 KiB caps),
`{of: <completions>, role: "error", error}`.
