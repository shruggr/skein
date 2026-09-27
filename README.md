# skein

A deterministic WASI machine over a content-addressed graph. Its only inputs
are an ordered log of host-signed entries — BRC-169 messages (the sender's
signed metadata and the plaintext) delivered from the host's messagebox, and
wakes for sleepers; its only outputs are envelopes.
Programs run inside it: handler programs (Go, `wasip1`) per box, and a
bash-compatible wasm shell over git-shaped trees. Time and randomness are not
inputs: the host stamps each log entry with its clock and signs it, and
programs see that stamp (+1 ns per read) as "now" and a stream keyed by the
entry's CID as random bytes. Replaying the log reproduces the graph, with no
wallet.

Read `docs/ARCH.md` first (the architecture; "The kernel, in one paragraph" is
the spec), then `docs/MESSAGES.md` (how messages enter and leave) and
`docs/VM.md`. Open questions are in `docs/OPEN.md`.

## Layout

```
src/runtime/     the machine — no disk, network, clock, randomness, messagebox or private key
  scheduler.ts     the log consumer: admit, route by subscription, step programs and the shell, attested calls, replay
  log.ts           the input log: host-signed entries (genesis | envelope | wake), verified at admission
  program.ts       one step of a handler program; wasi/skein-imports.ts is its `skein` import namespace
  programs.ts      the program records (shell, run-handler, objects-handler, head-handler, loop) and pinned module CIDs
  heads.ts         named heads: a chain per name; `main` is where `run`/`chat` start
  shell.ts wasi/   the wasm shell (brush + uutils coreutils) and the WASI host
  syscalls.ts      pure time (entry stamp + 1 ns per read), sleep, random (keyed by entry CID)
  store.ts sqlite.ts memory.ts cid.ts records.ts types.ts tree.ts identity.ts
src/host/        the providers and the kernel configuration, outside the machine
  main.ts          `skein-runtime`: store + wallets + runtime, wired to its providers
  cli.ts host.ts   `skein-host`: the management database (instances.ts, host.db) and `run`, every enabled instance in one process
  messagebox.ts    message delivery: screen, decrypt, stamp, host-sign and admit; sign, encrypt and send emits
  tick.ts          wakes: the next deadline → one host-signed wake entry
  entry.ts         the host's clock and entry signing; genesis
src/envelope.ts  BRC-169 envelopes: RFC 8785 canonical form, signed contentHash, BRC-78 content, sign/seal/verify/open (shared with the client)
src/client/      David's client (`bin/skein`): import, run, chat, inbox
src/peers/       peers, each its own process and identity: infer.ts (`bin/skein-infer`, the inference peer)
src/dev/         developer tools, OUTSIDE the machine: `skein-dev install|log|ls|show|refs|rebuild`
  explore/         `bin/skein-explore [port]`: a read-only graph explorer over the store file (http://localhost:4500)
src/wallet.ts    connecting a BRC-100 wallet
programs/        handler programs in Go: run-handler, objects-handler, head-handler, loop (the chat turn loop); skein/ (the ABI)
scripts/         build-wasm.sh (brush, coreutils), build-programs.sh + pin-programs.sh (handlers), host/ (dev host)
wasm/            the committed modules; their CIDs are pinned in src/runtime/programs.ts
```

`src/runtime/isolation.test.ts` fails if anything under `src/runtime` imports
`node:fs`, `child_process`, `http(s)`, `net`…, `@bsv/message-box-client` or
anything outside `src/runtime`, or uses `fetch`, `Date.now`, `Math.random`,
`randomBytes`, timers, `process.env` or a private key — with no exceptions.

## Running it

Needs Node 26 (JSPI, `node:sqlite`, type stripping) and the dev host
(`scripts/host/README.md`: the instance, owner, infer and host wallets, the messagebox at
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
bin/skein chat --new --tree <cid> --wait 'what is here?'   # the loop answers with a `chat` reply in David's `chat` box
bin/skein-dev log; bin/skein-dev ls; bin/skein-dev show <cid-suffix>
bin/skein-dev replay [--db <path>]          re-derive the store from the log alone, no wallet, and compare
npm test
```

`bin/skein-runtime` fills the environment from `~/.skein`: `SKEIN_OWNER`
(`owner.identity`), `SKEIN_MESSAGEBOX` (`messagebox.url`).
Also: `SKEIN_DB` (`~/.skein/runtime.db`), `SKEIN_HANDLE` (`skein@localhost`),
`SKEIN_OWNER_HANDLE` (`david@localhost`), `SKEIN_HOST_WALLET_URL`
(`http://127.0.0.1:3324`), `SKEIN_POLL_MS` (1000), `SKEIN_WALLET=ephemeral`
(throwaway keys).

### Many instances: `skein-host`

One host process runs every enabled row of its management database,
`$SKEIN_HOME/host.db` (#23): each row its own store, runtime, wallet,
messagebox session and tick; the host wallet (3324), which signs every entry,
is all they share. A new instance's genesis is `skein-runtime`'s plus `chat`
from anyone (an open subscription), and the host resolves `handle@domain` for
its programs (host.db, then the messagebox's paymail PKI).

```
scripts/host/up.sh                          # as above: the messagebox, the host and owner wallets
scripts/host/instance.sh martha             # a wallet-api on the next free port from 3401, grants, account, host.db row (idempotent)
scripts/host/instance.sh kurt
bin/skein-host list                         # handle, status, identity, wallet, store, tree
bin/skein-host run                          # every enabled row; lines prefixed [handle]; roster at :4600/roster.json
bin/skein-host deploy martha <dir>          # SOUL.md, IDENTITY.md, skills/ into it through `objects`, as the owner; sets/moves main
bin/skein-host disable kurt                 # also: add <handle> [--wallet-url --store --tree --domain --identity], enable, remove
```

`scripts/host/README.md`, "Instances", has the details.

The instance wallet (`1sat serve wallet-api`, origin `skein`) needs, besides
the transport grants in `scripts/host/grants.sh`:

```
1sat permissions grant skein --protocol "metanet handles envelope" --level 2 --counterparty anyone  # outbound envelopes
1sat permissions grant skein --protocol "message encryption" --level 2 --counterparty <owner>      # inbound and outbound content
```

The host wallet (127.0.0.1:3324, origin `skein-host`, `SKEIN_HOST_WALLET_URL`)
signs every log entry: `"identity key retrieval"` and
`"skein log" --level 2 --counterparty anyone`.

Handler programs change → `scripts/build-programs.sh && scripts/pin-programs.sh`
(the build is reproducible; the pins are the modules' raw CIDs).

## Records

| record | shape |
|---|---|
| log entry | `{kind: "log", prev, n, time: [sec, nsec], genesis \| envelope+box+body \| wake, sig}` — `sig` by the host identity (the genesis's `host`) over the entry without `sig` (`[2, "skein log"]`, key `1`, anyone) |
| genesis | `{kind: "genesis", identity, handle, domain, owner, host, programs: {name: cid}, subscriptions: [{match: {sender?, box?}, handler}], peers?: {infer}, defaults?: {model, thinking}, collect?: [box]}` |
| envelope | the BRC-169 envelope's signed part: its JSON object without `content`, as dag-cbor (its CID is the message id, the client's `replyTo`) |
| body | the plaintext content: the sender's dag-cbor bytes, CIDv1 dag-cbor/sha2-256 — the digest is the envelope's signed `contentHash` |
| thread origin | `{kind: "thread", program, args, launchedBy, input: <entry>, at, nonce?}`; handler args `{envelope, body, box, sender}` |
| program step | update `{state, step, input, at, calls?, launched?, waitingOn?, awaits?, kept?, emits?, heads?, result: {exitCode, stdout, stderr}}` — `awaits`: envelopes it emitted and rests on; `kept`: records the step keeps in the thread's state |
| step input | `{kind: "step", thread, step, entry, args, programs, resolved?, tip?, reply?: {envelope, body, box, sender, replyTo}, peers?, defaults?}` |
| attested | `{kind: "attested", thread, step, i, op: "wallet" \| "seal" \| "resolve", request, result}` — a wire frame and its answer, an emit record and its signed envelope (the signed part), or a handle `handle@domain` and the identity key the host resolved it to (`""`: none) |
| head | origin `{kind: "head", name}`; update `{tree, thread, input, at}` — written when a step that called `advance` ends without error; the step's update lists it in `heads` |
| emit | `{kind: "emit", to, handle?, domain?, box, body: <cid>}` — the delivery provider signs the envelope for `body` to `to` in `box` during the step (`emit` returns the envelope CID; `created` is the step's stamp) and encrypts and sends it after |

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
and answers David with a `chat` reply `{text, tree, thread, replyTo: <his chat>}`
(the same box, both directions; there is no `say`). David's next `chat` carries
`replyTo: <that reply>` and continues the thread. The system prompt is the
starting tree's `/SOUL.md` (else a fixed one), then `/IDENTITY.md`. Besides
`bash`, the model has `message` (`{to: "@handle@domain", text}`): the loop
sends `chat` to another party and rests on their `chat` reply, which is the
tool result. A chat to a party the thread already talks with (its opener, or
one that answered its messages) is a reply to that party's latest envelope,
so their waiting thread resumes; two agents alternate on one thread each
(docs/MESSAGES.md, "Chat between instances").

**Replies.** An admitted envelope whose plaintext body has `replyTo` goes
only to the thread whose tip `awaits` that envelope,
and only if its sender is the identity it was sealed to; it becomes that step's
`reply` input. Otherwise it is recorded and nothing runs. It is never routed by
subscription.

Loop turns (`{kind: "turn", of, role, …}`), one per turn, kept in its chain (the conversation is rebuilt from them each step):
`{of: <tree>, role: "system", content}` (first: the conversation's prompt),
`{of: <chat>, role: "user", text, tree?, model?}`,
`{of: <completions>, role: "assistant", content?, reasoning?, tool_calls?, model, ms?, usage?}`,
`{of: <shell thread>, role: "tool", call, exitCode, stdout, stderr, tree}` (16 KiB caps),
`{of: <their chat reply>, role: "tool", call, to, sent: <our chat>, text}` (a `message` answered; `{of: <entry>, role: "tool", call, to?, error}` if it could not be sent),
`{of: <completions>, role: "error", error}`.
