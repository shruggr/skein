# skein

A deterministic WASI machine over a content-addressed graph. Its only inputs
are an ordered log of entries — BRC-169 messages (the sender's signed
metadata and the plaintext) admitted by the router, which is the host's
messagebox, mail for the identities an instance keeps a mailbox for, wakes
for sleepers, and the router's report on each envelope it sent (delivered, or
failed); its only outputs are envelopes. Entries are unsigned (issue #33):
messages are signed by their senders, `prev` fixes the order.
Programs run inside it: handler programs (Go, `wasip1`; Zig) per box, and a
bash-compatible wasm shell over git-shaped trees. Time and randomness are not
inputs: the router stamps each log entry with its clock at admission, and
programs see that stamp (+1 ns per read) as "now" and a stream keyed by the
entry's CID as random bytes. Replaying the log reproduces the graph, with no
wallet.

Read `docs/ARCH.md` first (the architecture; "The kernel, in one paragraph" is
the spec), then `docs/MESSAGES.md` (how messages enter and leave) and
`docs/VM.md`. Open questions are in `docs/OPEN.md`.

## Layout

```
src/runtime/     the machine — no disk, network, clock, randomness, messagebox or private key
  scheduler.ts     the log consumer: admit, route by subscription, step programs and the shell, recorded calls, replay
  log.ts           the input log: host-signed entries (genesis | envelope | wake | outcome), verified at admission
  program.ts       one step of a handler program; wasi/skein-imports.ts is its `skein` import namespace
  programs.ts      the program records (shell, run-handler, objects-handler, head-handler, subscribe-handler, loop) and pinned module CIDs
  heads.ts         named heads: a chain per name; `main` is where `run`/`chat` start
  subscriptions.ts the routing table: one chain per instance, seeded by the genesis, changed by `subscribe`
  shell.ts wasi/   the wasm shell (brush + uutils coreutils) and the WASI host
  syscalls.ts      pure time (entry stamp + 1 ns per read), sleep, random (keyed by entry CID)
  store.ts sqlite.ts memory.ts cid.ts records.ts types.ts tree.ts identity.ts
src/host/        the host, outside the machine
  router.ts        `skein-host run` (#33): the BRC-33 messagebox (auth.ts: BRC-104), hydrate/idle-stop kernels, the waker, delivery and outcomes
  kernel.ts        one `skein-kernel serve` process: frames on stdin/stdout; answers its wallet (the oracle) and resolve calls
  oracle.ts        the master secret; per-instance ProtoWallets (BRC-42 child, key ID = the handle)
  genesis.ts       format 2: the genesis (keys as bytes) and unsigned admissions
  vmmail.ts mail.ts  mail for hosted identities, kept by an instance's messagebox program
  brc231.ts        a BRC-231 (dag-cbor) messagebox client
  cli.ts           `skein-host`: the management database (instances.ts, host.db), the router, deploy, roster
  host.ts          the resolver (rows, BRC-169, paymail); startInstance (the frozen TS runtime)
  supervisor.ts    the explorers' supervisor
  messagebox.ts tick.ts entry.ts main.ts   the frozen TS runtime's providers (format 1: host-signed entries)
kernel-zig/      the kernel (Zig): store, log, scheduler, WASI, programs through wasmtime; `skein-kernel serve|replay|shell|dump|fuel`
src/envelope.ts  BRC-169 §7.2 (JSON) envelopes: sign/seal/open through a wallet (shared with the client); the pure part (canonical form, contentHash, BRC-78 framing, verify) is src/runtime/envelope.ts
src/envelope-cbor.ts  BRC-169 §7.3 (dag-cbor) envelopes: seal, verify, open; either form from a BRC-33 body
programs/        the handler programs (Go, wasip1): skein (the imports), envelope (sealing through the wallet import), wallet, the handlers
src/client/      David's client (`bin/skein`): import, run, chat, inbox
src/peers/       peers, each its own process and identity: infer.ts (`bin/skein-infer`, the inference peer)
src/dev/         developer tools, OUTSIDE the machine: `skein-dev install|log|ls|show|refs|rebuild`
  explore/         `bin/skein-explore [port]`: a read-only graph explorer over the store file (http://localhost:4500)
src/wallet.ts    connecting a BRC-100 wallet
programs/        handler programs in Go: run-handler, objects-handler, head-handler, subscribe-handler, loop (the chat turn loop); skein/ (the ABI); messagebox/ (Zig)
scripts/         build-wasm.sh (brush, coreutils), build-programs.sh + pin-programs.sh (handlers), host/ (dev host)
wasm/            the committed modules; pinned in kernel-zig/src/programs.zig (and src/runtime/programs.ts, whose handler builds are wasm/v1/)
```

`src/runtime/isolation.test.ts` fails if anything under `src/runtime` imports
`node:fs`, `child_process`, `http(s)`, `net`…, `@bsv/message-box-client` or
anything outside `src/runtime`, or uses `fetch`, `Date.now`, `Math.random`,
`randomBytes`, timers, `process.env` or a private key — with no exceptions.

## Running it

Needs Node 26 (`node:sqlite`, type stripping), Zig 0.16.0 (`mise`) for the
kernel, and the dev host (`scripts/host/README.md`).

The instances run on the Zig kernel (`kernel-zig/`) behind the **router**
(issue #33): `skein-host run` is the host. It serves the BRC-33 messagebox
(BRC-104 mutual auth, the same API and URL as the `1sat serve` messagebox
it replaces: http://127.0.0.1:8100/messagebox), looks up which instance
serves a recipient (host.db), starts that instance's kernel on demand
(`skein-kernel serve` over its store, frames on stdin/stdout) and stops it
when idle, admits the message as a log entry, and keeps each instance's
earliest sleeper deadline to wake it. It is also every instance's signing
oracle: a ProtoWallet over a key derived from one master secret
(`~/.skein/master.key`; `src/host/oracle.ts`). No wallet-api per instance, no
host key: log entries are unsigned (format 2).

```
npm install
(cd kernel-zig && mise exec -- zig build --release)
bin/skein-host add martha                   # a row: identity derived from the master secret, store ~/.skein/instances/martha/runtime.db
scripts/host/up.sh                          # the client wallets (owner 3322, infer 3323), their grants, the router on :8100, accounts
bin/skein-host deploy martha <dir>          # SOUL.md, IDENTITY.md, skills/ into it through `objects`, as the owner
bin/skein import ~/Work/easel               # the client: tree objects into `objects`; prints the tree CID
bin/skein run --tree <cid> -- 'ls | head -3'   # no --tree: the `main` head (the first import sets it)
bin/skein inbox --wait                      # the result envelope, opened by the owner
bin/skein-infer                             # the inference peer (its own wallet on 3323; providers in ~/.skein/infer.json)
bin/skein chat --new --tree <cid> --wait 'what is here?'   # the loop answers with a `chat` reply in David's `chat` box
bin/skein-dev log; bin/skein-dev ls; bin/skein-dev show <cid-suffix>
npm test
```

`bin/skein-runtime` (`src/host/main.ts`) is the frozen TypeScript runtime as a
standalone process (format 1: host-signed entries, its own handler builds in
`wasm/v1/`); nothing in the dev stack runs it any more.

### The host: `skein-host`

`$SKEIN_HOME/host.db` (#23) is the identity → instance map: one row per
instance (handle, domain, identity, store, deployed tree), and the
**mailboxes** it keeps for other identities (the owner's wallet, the
inference peer, …: `POST /account/register`, as the front end's Register
does), each kept by an instance. `skein-host run` is the router
(`src/host/router.ts`):

- `sendMessage` to an instance: the envelope is screened (signed by the
  authenticated sender, addressed to this instance, new), decrypted through
  its oracle and admitted; to a kept mailbox: admitted into the keeping
  instance as a `mail` entry, which its messagebox program (`programs/messagebox`,
  Zig) keeps in log order; `listMessages` reads those records, `acknowledgeMessage`
  admits an `ack`. An unknown recipient: `403 ERR_ACCOUNT_REQUIRED`.
- an instance's emits are delivered the same way in process; each one's
  outcome goes back into it as an `outcome` entry.
- JSON requests get JSON (the standard `@bsv/message-box-client`: the front
  end, the owner's client); `application/cbor` requests get BRC-231 dag-cbor.
- `GET /bsvalias/id/<handle>@<domain>`: the paymail PKI for rows and
  mailboxes (the resolvers' and the front end's lookup).
- the host page and roster on :4600, a read-only explorer per row on :4610+.

A new instance's genesis (written by the router at its first hydration) is
the owner's boxes, `chat` from anyone, and `:mail` → messagebox.

```
bin/skein-host list                         # handle, kind, status, identity, front-door key, wallet (legacy) | owner, store, tree
bin/skein-host identity [handle]            # the router's BRC-104 identity, or an instance's
bin/skein-host mailboxes                    # handle, owner, front-door key, status, store
bin/skein-host run                          # the router; SKEIN_ROUTER_PORT, SKEIN_IDLE_MS (default 0: never stop), SKEIN_MAILBOX_HOST, SKEIN_MASTER_KEY
bin/skein-host subscribe martha add --sender <key> run run-handler   # a `subscribe` message as the owner; no new genesis
bin/skein-host disable kurt                 # also: add <handle> [--domain --derive --store --tree], enable, remove
```

Handler programs change → `scripts/build-programs.sh && scripts/pin-programs.sh`
(the build is reproducible; the pins are the modules' raw CIDs, in
`kernel-zig/src/programs.zig`).

## Records

| record | shape |
|---|---|
| log entry | `{kind: "log", prev, n, time: [sec, nsec], genesis \| envelope+box+body \| wake \| outcome: {emit, status: delivered \| failed, reason?}, sig}` — `sig` by the host identity (the genesis's `host`) over the entry without `sig` (`[2, "skein log"]`, key `1`, anyone) |
| genesis | `{kind: "genesis", identity, handle, domain, owner, host, programs: {name: cid}, subscriptions: [{match: {sender?, box}, handler}], peers?: {infer}, defaults?: {model, thinking}, names?: {<identity>: {handle, domain}}, collect?: [box]}` — `subscriptions` is only the seed of the subscriptions chain; `names`: what outbound envelopes call the owner and the peers |
| envelope | the BRC-169 envelope's signed part: its JSON object without `content`, as dag-cbor (its CID is the message id, the client's `replyTo`) |
| body | the plaintext content: the sender's dag-cbor bytes, CIDv1 dag-cbor/sha2-256 — the digest is the envelope's signed `contentHash` |
| thread origin | `{kind: "thread", program, args, launchedBy, input: <entry>, at, nonce?}`; handler args `{envelope, body, box, sender}` |
| program step | update `{state, step, input, at, calls?, launched?, waitingOn?, awaits?, kept?, emits?, heads?, subscriptions?, result: {exitCode, stdout, stderr}}` — `awaits`: envelopes it emitted and rests on; `kept`: records the step keeps in the thread's state |
| step input | `{kind: "step", thread, step, entry, at, self: {handle, domain}, args, programs, resolved?, tip?, reply?: {envelope, body, box, sender, replyTo}, peers?, defaults?, names?}` |
| attested | `{kind: "attested", thread, step, i, op: "wallet" \| "resolve", request, result}` — a wire frame and its answer (among them each envelope's signature and encryption), or a handle `handle@domain` and the host resolver's whole answer as dag-cbor (`{identityKey, …the resolve endpoint's response, via, checked?, unchecked?}`; `identityKey: ""` and `error`: none) |
| head | origin `{kind: "head", name}`; update `{tree, thread, input, at}` — written when a step that called `advance` ends without error; the step's update lists it in `heads` |
| subscriptions | origin `{kind: "subscriptions"}`, one per instance; update `{op: "add" \| "remove", sender?, box, handler, thread?, input, at}` — the genesis entry writes the seed (no `thread`), later ones are written when a step that called `subscribe` ends without error, listed in its `subscriptions`; the scheduler routes by the fold of them (docs/VM.md, "Subscriptions") |
| emit | `{kind: "emit", to, box, body: <cid>, envelope}` — `envelope` is complete: the program signed it and encrypted `body` to `to` through the wallet import in the step (`programs/envelope`; `created` is the step's stamp); the runtime checks it, `emit` returns its signed part's CID (the message id), and the delivery provider sends it as it is after the step |

Boxes: `objects` (`{records: [{cid, bytes}], root?}` ≤ 1 MiB, blobs first,
`root` on the last) → objects-handler, which sets `main` to `root` if there is
no `main`; `run` (`{cmd, tree?, cwd?, env?}`; no tree: `main`'s, else the empty
tree) → run-handler, which replies in the sender's `results` box with
`{exitCode, stdout, stderr, tree, replyTo}`; `head` (`{name, tree}`) →
head-handler, which moves the head (no reply); `subscribe` (`{op: "add" |
"remove", sender?, box, handler}`) → subscribe-handler, which adds or removes
that subscription (no reply; the handler must be a program record in the
store — registering a program is subscribing a box to its CID).

Chat: `chat` (`{text, tree?, model?, replyTo?}`) with no `replyTo` → a new loop
thread, over `tree` or else `main`'s; the loop sends `infer` (`{model, messages, tools?, thinking?}`) to
`peers.infer`, which answers in `completions` (`{replyTo, message: {role,
content?, reasoning?, tool_calls?}, usage?, model, ms}` or `{replyTo, error}`),
and answers David with a `chat` reply `{text, tree, thread, replyTo: <his chat>}`
(the same box, both directions; the answer is never a `say`). David's next `chat` carries
`replyTo: <that reply>` and continues the thread. The system prompt is the
starting tree's `/SOUL.md` (else a fixed one), then `/IDENTITY.md`. Besides
`bash`, the model has `message` (`{to: "@handle@domain", text}`): the loop
sends `chat` to another party and rests on their `chat` reply, which is the
tool result. A chat to a party the thread already talks with (its opener, or
one that answered its messages) is a reply to that party's latest envelope,
so their waiting thread resumes; two agents alternate on one thread each
(docs/MESSAGES.md, "Chat between instances"). With `defaults.tools` naming them, the
model also has `say`, `present` and `annotate`, whose records the loop keeps
and sends the opener in its `turn` box; `defaults.stream: "on"` adds
thinking, tool-call logs and errors there (docs/MESSAGES.md, "The turn
stream").

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
