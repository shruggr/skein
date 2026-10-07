# The dev host

What runs where so the clients (`bin/skein`, the bopen-skein front end, the
inference peer) reach the instances (docs/ARCH.md, "The host"). Everything
here is dev-only: the keys are throwaway, generated on this machine, and hold
no funds.

```
bin/skein-host run                          # the host; on its first run operator.key, master.key, host.db and the host skein
bin/skein-host add martha                   # a row: identity derived from ~/.skein/master.key (made on first use), no wallet process
scripts/host/up.sh                          # wallets, mailbox instances, the host on :8100, grants, address books, in that order (idempotent)
```

**Settings.** Every command reads `$SKEIN_HOME/host.env` (default
`~/.skein/host.env`): every `SKEIN_*` line (`KEY=value`, `export` and quotes
allowed); the environment wins (src/host/hostenv.ts). The operator's key is
the file `SKEIN_OPERATOR_KEY` names (default `$SKEIN_HOME/operator.key`, one
line, hex or WIF, mode 0600): `skein-host run` makes it if it is absent and
uses it if it is there. It owns the host skein, and the client `bin/skein`
signs the owner's messages with it.

### Bring-up order

An agent's genesis is written at its first hydration and names the owner's
messagebox (`defaults.ownerMessagebox`) — fixed for the store's life. If the
owner has no mailbox instance then, nothing the agent sends him (its
answers) can ever be delivered, and only a new store (re-genesis) fixes it.
So `up.sh` goes:

1. **The client wallets** (`wallets.sh owner infer`): `owner.identity`,
   `infer.identity`.
2. **The mailbox instances** of the owner (`david`) and of the inference peer
   (`infer`): `skein-host add <h> --mailbox --owner <key>`, unless the key has
   one already (whatever its handle). `~/.skein/mailbox.url` names the
   owner's. No registration (`POST /account/register`) is needed for keys this machine
   knows: the rows are what a registration would make.
2b. **The host skein** (#90, #142): `skein-host init` (the first run's
   part of `run`), once — the operator's own instance (`host`), from the
   host image (the default image with the onboarding app), its genesis
   naming the operator's key: its admin rows and its apps' owner rows are
   there at birth, no claim. The onboarding app's config comes from the
   settings (`SKEIN_HANDLE_DOMAIN`, default the domain of
   `SKEIN_ROUTER_ORIGIN`, i.e. `localhost`; the router's origin;
   `SKEIN_HOST_NAME`, `SKEIN_HOST_NOTE`). The instance manager is in its
   address book (no other instance's book names it). Run again, it only says
   which instance it is. `skein-host list` shows it as kind `host`, so the
   steps below that walk the agents leave it out. up.sh points
   `SKEIN_OPERATOR_KEY` at the dev owner's key (`~/.skein/owner-dev.key`,
   written from `owner-wallet.env`), so the dev owner owns the host skein.
3. **The host** (`skein-host run`, if nothing listens on :8100). It
   hydrates every enabled row, so the agents' geneses happen here, naming the
   owner's mailbox instance (the host's default for
   `SKEIN_OWNER_MESSAGEBOX`; `run` prints which at start, and a WARNING if
   there is none).
4. **The grants** (`grants.sh`), toward every row's front-door key from
   `skein-host list`, now that every row exists.
5. **The address books** (#40). Into every enabled agent, through its
   `peers` box as the owner (`skein peers add <key> <origin> … --instance
   <agent>`; see "The owner's messages" below): the owner's key and mailbox instance
   origin (`http://david.localhost:8100`, handle `SKEIN_OWNER_HANDLE`), the
   inference peer's (`http://infer.localhost:8100`, `SKEIN_INFER_HANDLE`)
   and every other agent's. The inference peer's own address book, every
   agent's key → origin, is written to `~/.skein/infer-peers.json`
   (bin/skein-infer reads it, again whenever it changes). Run `up.sh` again
   after adding an agent.
6. **The apps** (#83). A genesis has no shell and no chat loop: every
   enabled agent gets the shell app (`run`) and the chat app (`chat`) by
   the owner's messages (`skein install <dir> --instance <agent>`), from
   `SKEIN_SHELL_APP` / `SKEIN_CHAT_APP` (default the two repos at
   `#v0.1.0`). Installing what an instance already has sends only the head
   again. The shell app's first install is the slow step: its modules are
   ~50 MB of messages.
7. **The mailboxes adopted** (#113): step 2's mailboxes, which the host
   skein's onboarding app (installed at its birth) did not make, are
   recorded and certified so they resolve: `skein-host import-handles`
   prints the owner's `onboard.adopt` request for each, and the dev owner's
   wallet sends it. Any wallet with a session then creates a skein of its
   own with `POST http://host.localhost:8100/onboard/call {"fn":
   "onboard.create", "args": {"handle": "…", "claim": …}}` (docs/ARCH.md,
   "The host skein"), and registers a handle and its mailbox at the
   router's `POST /account/register`.

Steps 5–6 are the owner's messages, signed by `bin/skein` with the dev
owner's key (`SKEIN_OPERATOR_KEY=~/.skein/owner-dev.key`) and handed to the
running host over its control socket (`--instance <agent>`). An instance
whose owner is another key (an `owner.identity` that is not
`owner-dev.identity`) refuses them; that owner sends from its own wallet.

An agent whose genesis names no owner messagebox is logged at every
hydration (`[<handle>] WARNING: its genesis names no owner messagebox …` in
`host.log`).

| process | address | what | log |
|---|---|---|---|
| host `bin/skein-host run` | 127.0.0.1:8100 (and ::1), host page 127.0.0.1:4600 | the HTTP transport: each instance is an HTTP server, its front door, at `http://<handle>.localhost:8100` (or `http://127.0.0.1:8100/@<handle>`); each instance's kernel started on demand (`skein-kernel serve`; not stopped when idle unless `SKEIN_IDLE_MS` is set), the signer (instance keys from `~/.skein/master.key`), the providers (#70, #69, #65, #90: `fetch`, `waker`, `cron`, `libp2p`, `status`, the instance manager `manager` (the host skein's only), each with a key of its own from the same master), the fuel ledger, the instances' feeds (SSE headers), the broadcaster (#58, #65: the broadcast events' queue to the host's Arcade, one status subscription), the libp2p nodes (#51: one per instance that has libp2p rows or declares `libp2p`, below) | `~/.skein/logs/host.log` |
| owner (David) wallet `1sat serve wallet-api` | 127.0.0.1:3322 | the dev owner's wallet (HOME `~/.skein/owner-home`, key `~/.skein/owner-wallet.env`): a client | `~/.skein/logs/wallet-owner.log` |
| infer peer wallet `1sat serve wallet-api` | 127.0.0.1:3323 | the inference peer's wallet (HOME `~/.skein/infer-home`, key `~/.skein/infer-wallet.env`): a client | `~/.skein/logs/wallet-infer.log` |
| inference peer `bin/skein-infer` | — | polls its own mailbox instance (`SKEIN_MAILBOX_URL`, e.g. `http://127.0.0.1:8100/@infer`) and answers `completions` into the sender's messagebox as its address book names it (`~/.skein/infer-peers.json`, `SKEIN_INFER_PEERS`), raw BRC-33 on BRC-104 sessions | as run |

Instances need no wallet and no grants: the host's signer signs for them.
The scripts of the layout before #33 (an instance wallet on 3321, a host
wallet on 3324, the `1sat serve` messagebox) are gone; `register.ts` is a
client of `POST /account/register`.

## The HTTP transport

The host picks the instance a request is for and appends it; it holds no
mail and no sessions, and verifies nothing. The URL picks the instance,
because a BRC-104 handshake does not name its recipient.

- **By host name**: `http://<handle>.localhost:8100/…` (the `Host` header;
  `SKEIN_INSTANCE_ORIGIN` sets another template, default
  `http://{handle}.localhost:{port}`). The standard `AuthFetch` keeps one
  session per origin and shakes hands at `<origin>/.well-known/auth`, so
  this is the form `@bsv/message-box-client` uses. `*.localhost` resolves
  to ::1: the host listens on 127.0.0.1 and ::1.
- **By path prefix**: `http://127.0.0.1:8100/@<handle>/…` (a dev form). The
  host strips the prefix for the routes; the client signs the path it sent,
  and its handshake goes under the prefix (`src/client/raw.ts`, `RawBox`).

A request for an instance is appended as received (#68: a `request` entry)
and its front door (`programs/frontdoor`) is stepped on it: BRC-103/104
against the instance's session records, the dispatch table's http rows, the
handler, the signed answer. The host holds the client until that thread comes to rest
(#66) — past `SKEIN_ANSWER_WAIT_MS` (default 120000) or at shutdown, 503 +
Retry-After. Every request is an entry (a poll too: an access log); a read
moves nothing. A request's fuel is on its thread's updates; the kernel
calls the host makes (the explorer's reads) are charged to the **fuel
ledger** (host.db `fuel_ledger`, by instance, caller and route; `skein-host
ledger [handle]`).

The host's own endpoints. The BRC-169 rows are the host skein's onboarding
app's (#113): the router maps these paths at its own origin onto the host
skein's `/onboard/…` routes, each request an entry there; with no host
skein they are 404 (docs/MESSAGES.md, "Mailbox instances", "BRC-169 is
discovery").

| | |
|---|---|
| `GET /manifest.json` | BRC-169 §5.1: `metanet.trust` (`name`, `note`, `icon` from the app's config when set; `publicKey`, the certifier key), `metanet.handles` (`version`, `resolve`, `search` under the app's configured origin) |
| `GET /.well-known/metanet-handles/resolve?handle=<h>[@<d>]` | BRC-169 §5.2 `{metanetHandles, handle, domain, identityKey, certificate, messagebox, ttl, revoked}` from the app's record of the handle: a mailbox instance's owner's key and the instance's origin, an onboarded skein's own identity; `certificate` as the certifier signed it (revocation not implemented: the host has no wallet); with the holder's signed profile (#104, kept by the app) also `profile {record, signature, protocolID, keyID}`, `displayName`, `avatarURL` |
| `GET /.well-known/metanet-handles/search?q=<text>&limit=<n>` | BRC-169 §5.6 (#104) `{metanetHandles, results: [{handle, identityKey, displayName?, avatarURL?, profile?}], truncated}`: the app's handles whose handle or profile name contains `q` (any case), at most `limit` (default 20, at most 100) |
| `GET /bsvalias/id/<handle>[@<domain>]` | paymail PKI (identity keys by handle, from the app's records) |
| `POST /account/register {username, identityKey, signature}` | over the identity's BRC-104 session with the host's origin (#135: a signed request; `identityKey` the session's): a mailbox instance for that identity at the handle domain (the app's `config.onboard.domain`): the signature by its own wallet, protocol `[2, "skein register"]`, key ID the username (a host name label), counterparty anyone, over `register <username>@<domain>` → `{handle, domain, identityKey, messagebox, certificate, keyringForSubject}`, the handle certificate for the wallet's `acquireCertificate` (#103); the same key and name again, a new certificate (a new serial) for the same mailbox; 409 if the name is taken, reserved (`id`, `host`) or the key has another |
| `POST /account/profile {handle, record, signature}` | the handle holder's signed profile (#104), kept by the app and served with resolve and search |
| `GET /.well-known/skein-host` | at every host name, an instance's origin too: `{origin, domain}` — the router's origin and the handle domain, where the management page finds the manifest and the register route (#103) |
| `POST /arc/callback` | Arcade's webhook (`Authorization: Bearer <SKEIN_ARC_TOKEN>`) |

The instances' outbound HTTP (a messagebox delivery thread, a resolve) is a
message to the host's `fetch` provider (#70; docs/MESSAGES.md,
"Outbound"): a URL of this host's is answered in process (the same path, no
socket), any other goes out (`SKEIN_HTTP=fetch`). Every delivery
(a `POST …/sendMessage`) is one line in `host.log`, so a lost reply shows
where it went and what came back:

```
[martha] deliver chat for 8f98ef7c → http://david.localhost:8100/sendMessage (local): 200 delivered
[martha] deliver chat for 79d35eb2 → https://other.host/sendMessage (remote): HTTP 503 down for a moment
[martha] deliver chat for 79d35eb2 → https://other.host/sendMessage (remote): failed: fetch failed
```

### The address book: `skein peers`

Where an agent delivers to a key — its answers, its `message` tool — is its
address book (head `peers`: key → transport and address, role and handle
optional; docs/MESSAGES.md, "Outbound: emit, the address book and the
providers"). Every new genesis seeds it with the host's providers and the
owner's mailbox (source `genesis`); the rest is configuration: the owner
writes it through the agent's `peers` box, like `dispatch` — the owner's
messages (#124; "The owner's messages", below).

```
bin/skein peers add <key> <address> [--transport mailbox|libp2p|local] [--handle bob@example.com] --instance martha
bin/skein peers remove <key> --instance martha
bin/skein-host peers martha list        # key, transport, address, role, handle@domain, source (genesis | admin | resolve)
```

`--transport` defaults to `mailbox` (the address a messagebox URL); `libp2p`
takes a peer ID or `topic:<name>`, `local` a provider's name on this host.

Nothing registers itself: the core sends no claims and the default genesis
takes none. A key outside the host — a person using the bopen page, say —
gets answers from an agent only once the admin adds its key and mailbox URL
here (or an application wires its own `register` box: docs/BOOTSTRAP.md).
Until then its chats are still admitted (the key authenticates, the
dispatch table decides), and the agent's answer fails once, logged on the
step's line in host.log: `stderr: loop: could not deliver the answer: … no
route to <key>: not in the address book`. `up.sh` writes the owner, the
inference peer and every other agent.

**Mailbox instances.** A person or peer outside the host gets a mailbox: an
instance of its own with only the front door and the messagebox, keeping
every message sent to it (docs/BOOTSTRAP.md). `skein-host add <handle>
--mailbox --owner <key>` makes one; so does a signed registration
(`POST /account/register`: the front end's Register, for a key this machine does not
know; #113: the host skein's onboarding app takes it and asks the instance
manager, whose `create` with image `mailbox` is the one creation path —
`add --mailbox` calls it too). `up.sh` makes `david`'s and `infer`'s with `add`, then
adopts them into the app (`skein-host import-handles` prints the owner's
`onboard.adopt` request for each; the owner's wallet sends it). `skein-host mailboxes` lists them (whose, the key their front door signs
sessions with, and where); `skein-host list` prints that key for every row
(its fifth column), which is what `grants.sh` grants toward. The
owner's is where every instance delivers what it sends him: a new genesis
names it (`defaults.ownerMessagebox`: `SKEIN_OWNER_MESSAGEBOX`, else the
owner's mailbox instance here), the one peer a genesis names.

Files:

- `~/.skein/master.key` — the host's master secret (hex, 0600, made once; `SKEIN_MASTER_KEY` overrides). Every instance key derives from it; losing it loses the instances' identities. `skein-host identity <handle>` prints one.
- `~/.skein/owner.identity`, `~/.skein/owner-dev.identity`, `~/.skein/infer.identity` — public keys, one line each. `owner.identity` is the *configured* owner (a genesis's `owner`) and is written once; `owner-dev.identity` is the owner wallet's (3322). `bin/skein-host` reads `owner.identity` into `SKEIN_OWNER` and `infer.identity` into `SKEIN_INFER`, unless they are set, for `run`, `add` (so `add --boot`/`--packet` needs no `SKEIN_OWNER` by hand), `event` and `init`.
- `~/.skein/host.sock` — the running host's control socket (0600; there only while `run` is up): `skein-host event` sends through it.
- `~/.skein/infer.json` — the inference peer's providers (written if absent).
- `~/.skein/mailbox.url` — the owner's mailbox instance, `http://127.0.0.1:8100/@david` (`up.sh`): where `bin/skein` reads.
- `~/.skein/host.db` — the instances (identity → store; `kind` agent or mailbox, a mailbox's `owner`) and the fuel ledger (`skein-host list`, `skein-host mailboxes`, `skein-host ledger`).

Sessions are state (#68): a handshake is a request like any other, and
the front door's step on it writes the session under the instance's head
`frontdoor/sessions`; every later request is verified against it. Sessions expire by
the instance's `defaults.sessionTtlMs` (a day) from the handshake entry's
time; an unknown or expired one is a plain 401, and the standard client shakes
hands again by itself. A restarted host or kernel keeps them: clients go
on without a new handshake. Instances are not stopped when idle
(`SKEIN_IDLE_MS` default 0: never); `SKEIN_IDLE_MS=<ms>` turns the idle
stop on. **Switching a live stack**: stores
in a log format before 8 are refused; they need a new genesis (move
`runtime.db` aside and start the host again).

Feeds: an instance's `etc/config.json` may declare `feeds: [{kind:
"headers", url, box?}]` (the genesis carries them): the host holds one SSE
connection per URL (reconnecting with backoff, at most 1000 items queued per
instance), admitting each header as an event into the box (default `chain`,
the chain app's). Transaction proofs and statuses come from the
broadcaster.

The host's own headers feed (#102): `SKEIN_HEADERS_URL` (the environment)
names one SSE stream of block headers — e.g. Arcade's chaintracks,
`http://127.0.0.1:8083/chaintracks/v2/tip/stream`. Every enabled instance
whose dispatch table has a row taking events in box `chain` (the chain
app's `event` row) is subscribed to it, in box `chain`; an instance without
one gets nothing. The router re-reads the table whenever it moves, so an
install of the chain app subscribes the instance live and an uninstall
unsubscribes it; `host.log` has one line each (`[router] <handle>:
subscribed to the host's headers feed <url>`). A header arrives as hex,
`{header|raw|hex}`, or chaintracks' JSON (`{version, previousHash,
merkleRoot, time, bits, nonce, height, hash}`, hashes in display order):
the 80 bytes are serialized from the fields and checked against `hash`;
a mismatch is logged and dropped. A genesis's `feeds` are in addition.

Scheduling (#69, `src/host/cron.ts`; docs/MESSAGES.md "Scheduling"): a program
asks the host's **cron provider** — its address book's role `cron`, seeded
by every new genesis — with a message (`{fn: "tick", every | at, box, body?,
name}` in box `cron`; `{fn: "stop", name}`), and each tick comes back as a
signed message from the provider into the named box, `{kind: "cron", name,
due, …body}` (the body's own `kind` wins), which the instance's dispatch row
for that box handles. The schedules live in host.db (`cron_schedule`): an
`every` one ticks once when `run` starts (a restart is a late tick, never a
burst), an `at` one once. An idle-stopped instance is hydrated for a tick
only if a dispatch row in it takes the box; otherwise the tick is logged
(`cron: … not woken`) and skipped. A step's `deadline` and a shell's `sleep`
are wake-me messages to the **waker** provider, likewise. By hand:

```
bin/skein-host event <handle> <box> ['{"kind":"amm-p2p-timer","job":"heartbeat"}']   # {kind: "cron" unless named, due: now}
```

sends one tick now, a message from the cron provider. While `run` is up it
goes over the host's control socket, `$SKEIN_HOME/host.sock` (a Unix
socket, mode 0600, made when `run` starts and removed when it stops; no
HTTP route leads to it), and the running host sends it with the kernel it
already holds. With the host down it goes through a host of its own, which
runs the steps it starts and closes. It refuses when a host answers at
`SKEIN_HOST_URL` / `SKEIN_ROUTER_PORT` but no control socket answers under
this `SKEIN_HOME` (another home): that host's kernel holds the instance's
store.

The broadcaster (#58, #65, `src/host/arc.ts`, docs/MESSAGES.md): one Arcade
for the whole host. An instance's broadcast is an event (`{kind:
"broadcast", tx, beef?}`), not a message: the host queues it durably in
host.db (`broadcast_queue`), posts it to Arcade under the host's callback
token, and retries with backoff while Arcade does not take it (a 503, no
answer), until a day after it was queued. The host holds one SSE
subscription to Arcade's events for the token (resumed with `Last-Event-ID`
from host.db `stream_cursor`) and takes Arcade's webhooks at `POST
/arc/callback` (`Authorization: Bearer <token>`). What Arcade says of a
transaction goes to every instance whose state holds it (host.db
`status_seen`: each txid + status + block hash once): a merkle path as a
proof event in box `chain`; anything else — its answer to the post included
— as a signed message from the host's **status provider** (box `status`;
role `status` in a new genesis's address book), which an instance takes
only through a dispatch row from `$status` (the chain app's optional
`{address: "status", sender: "$status", program: "chain"}`).
Configured from the environment or `~/.skein/host.env`:

| variable | default | |
|---|---|---|
| `SKEIN_ARC_URL` | unset: no broadcaster (a broadcast event is dropped, with a line), and a new genesis has no status provider in its address book | Arcade's API (its `POST /tx`), e.g. `https://arcade.example.com` |
| `SKEIN_ARC_TOKEN` | required with the URL | the host's one callback token: `X-CallbackToken` on every submission, the scope of the SSE stream, the webhook's bearer. Arcade has no client auth: this token is what ties the host's transactions together |
| `SKEIN_ARC_EVENTS_URL` | `<SKEIN_ARC_URL>/events` | Arcade's SSE service, which listens on a port of its own (Arcade's default 8082), e.g. `https://arcade.example.com:8082/events` |
| `SKEIN_ARC_CALLBACK_URL` | unset: SSE only | where Arcade posts webhooks: this host's `/arc/callback` as Arcade reaches it (Arcade wants a public HTTPS URL) |

`skein-host run` prints the broadcaster's line at start (`broadcaster:
broadcast events → Arcade …; proofs and statuses (the status provider) from
…`, or `no Arcade`), and `host.log` has one line per post (`[<handle>]
broadcast <txid> → Arcade: HTTP 202 RECEIVED`) and per status routed
(`arcade stream: <txid> MINED (a proof event) → <handles>`).

libp2p (#51): an instance whose `etc/config.json` declares `libp2p:
{topics?, protocols?, listen?}`, or whose installed apps added libp2p rows,
gets a libp2p node in the host process,
with its own peer key (#129: a child of the instance's root key — itself a
child of `~/.skein/master.key` — protocol [2, "skein instance"], key ID
`libp2p:<handle>`, counterparty self; what the instance's signer answers for
that derivation). `skein-host list` prints every row's peer ID (last
column) and `skein-host identity <handle> --peer` prints one; it is the
identity multihash of the compressed secp256k1 key, so the key reads out of
it. Topic messages and stream frames reach the instance through its front
door (docs/MESSAGES.md, "libp2p"); the validator and stream calls' fuel is in
`skein-host ledger` (caller: the peer ID, op: `libp2p:<topic | protocol>`).
The host-wide settings, from the environment or `~/.skein/host.env`:

| variable | default | |
|---|---|---|
| `SKEIN_LIBP2P_LISTEN` | `/ip4/127.0.0.1/tcp/0,/ip4/127.0.0.1/tcp/0/ws` | multiaddrs every node listens on (comma-separated). A fixed port can serve one node only: give per-instance ports in its config's `libp2p.listen`. Plain WS on loopback is for dev; browsers need WSS (below) |
| `SKEIN_LIBP2P_TLS_CERT`, `SKEIN_LIBP2P_TLS_KEY` | unset | PEM files: the WebSocket listener serves TLS (listen on `/ip4/0.0.0.0/tcp/<port>/tls/ws`), so browsers can dial it |
| `SKEIN_LIBP2P_BOOTSTRAP` | none | multiaddrs with `/p2p/<peer ID>`: dialled at start and redialled every 30 s while not connected |
| `SKEIN_LIBP2P_DHT` | `off` | `off`, `client` or `server` (Kademlia, `/ipfs/kad/1.0.0`). On: each topic name is a rendezvous — the node provides the CID v1 raw sha2-256 of the name and dials the providers it finds, every 30 s (go-p2p-message-bus's scheme). Private and loopback addresses are kept in the DHT only when every listen and bootstrap address is private (dev) |
| `SKEIN_LIBP2P_RELAYS` | none | circuit relays (multiaddrs with `/p2p/<id>`): each node also listens at `<relay>/p2p-circuit` |
| `SKEIN_LIBP2P_MDNS` | `off` | `on`: mDNS discovery on the LAN; discovered peers are dialled |

## The client wallets

The owner's and the inference peer's wallets are `1sat serve wallet-api`
processes (any BRC-100 wallet over HTTP works). The 1sat CLI has no flag or
env var for its config dir (`CONFIG_DIR` is `join(homedir(), ".1sat",
"cli")`), so each runs with its own `HOME`; the port is
`ONESAT_DAPP_PORT`. `wallets.sh owner infer` starts whichever is not
listening and writes the `.identity` files.

```
set -a; . ~/.skein/owner-wallet.env; set +a; HOME=~/.skein/owner-home ONESAT_DAPP_PORT=3322 1sat serve wallet-api
set -a; . ~/.skein/infer-wallet.env; set +a; HOME=~/.skein/infer-home ONESAT_DAPP_PORT=3323 1sat serve wallet-api
```

wallet-api denies by default and names the grant that would allow a
refused call. `grants.sh` writes the owner's (origin `skein-client`) and
the inference peer's (origin `skein-infer`): identity key retrieval, `skein
register`, `messagebox`, `server hmac` toward self, and `auth message
signature` and `message encryption` toward every enabled instance's
front-door key. Run it again after `skein-host add`. A level-2 grant
without `--counterparty` means `self`.

## Instances

Every instance is a row in the host's management database, `~/.skein/host.db`
(src/host/instances.ts), and runs on the Zig kernel under the host:

| column | |
|---|---|
| `handle` | primary key; the genesis's `handle` and the front door's host name, e.g. `martha` |
| `domain` | default `localhost` |
| `kind` | `agent`, or `mailbox` (a mailbox instance, #40: the front door and the messagebox, keeping mail for `owner`) |
| `owner` | a mailbox instance's: the identity (hex) whose mailbox it is |
| `identity` | the instance's identity key: derived from `~/.skein/master.key` by `add` (the signer's, BRC-42 child, key ID the handle) |
| `wallet_url`, `wallet_originator` | only in files made before #33: nothing reads them, and new files lack them |
| `store` | its store file (default `~/.skein/instances/<handle>/runtime.db`) |
| `tree` | a deployed tree's root CID (`add --tree`; unset: the roster reads the store's `main`) |
| `source` | a directory the roster reads IDENTITY.md from when the store has neither (set before #124 by `deploy`) |
| `knows` | JSON array of the handles its `ROSTER.md` lists (`skein-host knows`); `["*"]`: every other enabled row; NULL: none, no `ROSTER.md` |
| `status` | `enabled` / `disabled` |
| `created_at` | ISO time |

```
bin/skein-host add <handle> [--domain d] [--identity hex] [--store path] [--tree cid] [--knows a,b|*] [--disabled]
bin/skein-host add <handle> --mailbox --owner <hex>   # a mailbox instance for an identity outside the host
bin/skein-host knows <handle> [a,b | --all | --none]   # who its ROSTER.md lists; no list: print it
bin/skein-host list | mailboxes | enable <handle> | disable <handle> | remove <handle>   # remove leaves the store
bin/skein-host run                    # the host, the host page and roster
bin/skein-host roster                 # the roster JSON, printed
bin/skein-host roster --for <handle>  # that agent's ROSTER.md, printed
bin/skein-host peers <handle> list    # its address book, from its store
bin/skein-host import-handles         # the mailboxes the onboarding app has no record of, each with the owner's adopt request
```

### Running them: `skein-host run`

`skein-host run` is the host (above, and docs/ARCH.md "The host"): it
hydrates every enabled row once at start — a row's genesis is written at its
first hydration — then starts each kernel (`skein-kernel serve` over the
row's store) on demand and, with `SKEIN_IDLE_MS`, stops it when idle.
SIGINT/SIGTERM closes the host (`Router.close()`, #61: its timers, feeds,
broadcaster, libp2p nodes and kernels). There is no host-side explorer any
more (#92): a skein's explorer is its own route (`/explore`, its owner's),
and the management page a skein from the default image serves at its origin
renders it.

**Ports** (127.0.0.1):

| | |
|---|---|
| `SKEIN_ROUTER_PORT` (default 8100) | the host's HTTP transport |
| `SKEIN_HOST_PORT` (default 4600) | `/`: the host page; `/roster.json`: the roster |

**The host page** (`http://127.0.0.1:4600/`, read-only, #23): one line per
enabled instance — handle, identity, status (`live` while its kernel runs,
else `idle`), pid, store path, deployed tree — and a link to its origin.
This is the host operator's view; the user's is the management page (#92).

### The owner's messages: `skein install`, `skein dispatch`, … (#124, #142)

Nothing on the host writes into an instance as its owner on its own.
Installing an app, a dispatch row, an address-book entry, a directory into
`main` are messages from the owner to the kernel's admin boxes
(docs/MESSAGES.md, "The dispatch table and the kernel's operations":
`objects`, `head`, `dispatch`, `peers`) and the app's own box (start, stop).
`bin/skein` builds them (src/client/admin.ts, over the install plan
src/host/plan.ts that the management page uses too), signs each in its own
process with the operator's key, and delivers it (src/client/target.ts):

```
bin/skein install <catalog-name | url#commit | dir> <where> [--config <file.json>] [--dry-run]
bin/skein uninstall <app> <where> [--dry-run]
bin/skein dispatch add|remove [--sender <key>] <box> <handler> <where> [--dry-run]
bin/skein dispatch add|remove --http [--prefix] --fn f [--settings json] [--sender <key>|session] <path> <handler> <where> [--dry-run]
bin/skein reads add|remove [--prefix] --fn f [--settings json] <path> <handler> <where> [--dry-run]   # #135: the owner's own read (a call, anyone)
bin/skein peers add <key> <address> [--transport …] [--handle h@d] <where> [--dry-run]
bin/skein peers remove <key> <where> [--dry-run]
bin/skein host add|remove (<host-key> --x sats [--rates json] | --from <host origin>) <where> [--dry-run]
bin/skein claim [--messagebox url] [--handle h@d] <where> [--dry-run]
bin/skein deploy <dir> [--only glob,glob | --all] <where> [--dry-run]
bin/skein-host grant <key> [--apps] [--instance <handle>]                # a key's admin rows in the host skein
```

`<where>` is the instance. `--instance <handle>`: on this host machine —
its row in host.db, its store read read-only for the plan, each message
handed to the running host over its control socket (`host.sock`, op
`message`: a signed `local` request, checked by the front door like any
signed message). `<origin>`: anywhere — one BRC-104 session carries the
messages (dag-cbor bodies) and the explorer's reads (the owner's).
`--store <runtime.db>`: the plan from a store file, printed, nothing sent.
`--dry-run` prints the prompt (what the management page shows) and the
messages, each a `/sendMessage` JSON body, one a line:

```
{"message": {"recipient": "<the instance's key, hex>", "messageBox": "<box>", "body": <the body as DAG-JSON>}}
```

and sends nothing. No other process is started.

- **install** of a catalog name (the instance's own `www/catalog.json` in
  its site app's tree) or `<url>#<commit>` sends one message to the
  instance's git app, `git.clone {url, hash}` (the commit fetched by hash in
  the VM, through the host's fetch provider: the host runs with
  `SKEIN_HTTP=fetch`), reads the answer from the thread it launched, and
  plans from the stored tree; a directory is read here (leaving out `.git`,
  `node_modules`, `zig-out`, `.zig-cache`, `zig-pkg`). Then it checks the manifest (src/host/manifest.ts) and the instance
  (`requires` provided by an installed app, the name free, no row whose key
  another app or the genesis has, `$<provider>` senders in the address book,
  `optional` rows left out when the provider is missing), and plans
  `objects` (the tree, modules, program records, the app record; only what
  the instance lacks), `head {name: "<app>/app", tree: <app record>}`, a
  `dispatch` per row that changes, then `start`. `--config` is merged over
  the manifest's config (per program, one level deep). Installing it again
  is the upgrade (state kept, rows it no longer asks for removed, start sent
  again). The client waits until the head names the record. A key with no
  row in box `git` is refused before anything is sent. **uninstall** plans
  `stop`, then the app's rows removed; the heads are left.
- **dispatch** is one message to `dispatch`: `{op, row}`, the row
  `{transport: "mailbox", address: <box>, sender: "*" | <key bytes>,
  program: <handler>}`; `add` replaces the row with the same (transport,
  address, prefix, sender) or appends it, `remove` deletes it. `<handler>`
  is a program the instance's genesis names (`resolve`, `messagebox`, …:
  resolved from the view) or a program record's CID.
- **peers** is one message to `peers` per change ("The address book",
  above).
- **deploy** hashes `<dir>` into git objects (the filter below), plans them
  in ≤ 1 MiB bundles to `objects` (blobs, then trees, the root on the last
  bundle; only what the store lacks), then `head {name: "main", tree:
  root}` when `main` is another tree. The first deploy needs no head (the
  kernel's `objects` operation makes the root `main` when there is none); a
  changed directory moves `main`, so the next *new* conversation starts
  from the new tree; an unchanged one plans nothing.

**The filter.** Only what the loop uses goes in, not the code around it
(b-open-io/prompts' `.agents/<name>/` also holds `src/`, `package.json`,
`bun.lock`, `data/`, …). Default `--only SOUL.md,IDENTITY.md,skills`.
Patterns are paths from the directory's root, comma-separated, `*`/`?`
within one segment; a pattern naming a directory takes all of it;
`.git` and `node_modules` are never sent. `--all` sends everything else.

```
bin/skein install https://github.com/shruggr/skein-site#<commit> --instance martha
bin/skein reads add --prefix --fn get --settings '{"root":"www"}' / site.site --instance martha   # the owner's own read (#135): the site at /
bin/skein dispatch add --sender <key> register resolve --instance martha
bin/skein deploy ~/Work/prompts/.agents/martha --instance martha
```

The operator's key must be the instance's owner (or hold the rows it
uses): the explorer refuses another key's reads (403), the session refuses
its messages (403 `ERR_NOT_SUBSCRIBED`), and on the control socket a
message no row admits does nothing. A single record larger than a bundle
travels alone, so a module's size is a message's size: the client and the
host take it (the control socket's line is 64 MiB; the session has no SDK
cap); a module is better cloned in the VM.

**Stores before format 8** are not read by this kernel. Move the
runtime.db aside, restart `skein-host run` on this build, and deploy again;
host.db is untouched.

### The roster: `/roster.json`

`skein-host run` serves `http://127.0.0.1:$SKEIN_HOST_PORT/roster.json`
(default 4600; CORS `*`, for a static front end on another origin), and
`skein-host roster` prints the same JSON: one entry per enabled row,

```
[{"handle": "martha", "domain": "localhost", "identity": "02…", "displayName": "Martha",
  "description": "Organization front desk …", "emoji": ":woman_office_worker:", "status": "live"}]
```

`displayName`, `description`, `emoji`, `avatar` are IDENTITY.md's `- Name:`,
`- Description:`, `- Emoji:`, `- Avatar:` lines, read from the instance's
store by the row's `tree` (`add --tree`), else its `main` (read-only);
empty (or absent) when nothing is deployed or the deploy has not been
admitted yet. `status` is `live` if the
instance's process, supervised by this `skein-host run`, is up, else `idle`
(so `skein-host roster`, its own process, says `idle` for every row).

### Each agent's colleagues: `ROSTER.md`

Agents know each other only from their trees (#27): each row's `knows` names
the agents its `ROSTER.md` lists, and the loop appends `/ROSTER.md` to a new
conversation's system prompt after `IDENTITY.md`. The file, generated by the
host (`skein-host roster --for <handle>`), goes at the root of the deployed
tree with the agent's directory (`skein deploy <dir> --only
SOUL.md,IDENTITY.md,skills,ROSTER.md`):

```
## Colleagues

- @kurt@localhost — Kurt: Public-facing account manager for bOpen.io website visitors.
```

One line per known enabled row (in `list` order, never the agent itself;
handles with no row are skipped until one exists): `- @<handle>@<domain> —
<Name>: <Description>` from that row's IDENTITY.md — the directory being
deployed tree in its store (its `tree`, else `main`), else its `source`
directory's; no name: the handle; no description: no `: …`. `knows` empty:
no `ROSTER.md`.

Relations for the live POC (#22's who-references-whom: Martha lists
everyone, Kurt hands off to Martha), then each roster into its directory
and deployed by the owner:

```
bin/skein-host knows martha --all
bin/skein-host knows kurt martha
bin/skein-host roster --for martha > ~/Work/prompts/.agents/martha/ROSTER.md
bin/skein deploy ~/Work/prompts/.agents/martha --only SOUL.md,IDENTITY.md,skills,ROSTER.md --instance martha
```

The loop reads `ROSTER.md` at the next *new* conversation.

## The client

```
bin/skein whoami
bin/skein import ~/Work/easel                        # prints the root tree CID
bin/skein run --tree <cid> -- 'ls | head -3'         # prints the run message's id
bin/skein inbox --wait                               # until a result with replyTo = that id
bin/skein install|dispatch|… <where>               # the owner's admin messages (above), signed with the operator's key
```

- Wallet: `HTTPWalletJSON('skein-client', http://127.0.0.1:3322)`. Override
  with `SKEIN_OWNER_WALLET`, `SKEIN_ORIGINATOR`, `SKEIN_INSTANCE_IDENTITY`,
  `SKEIN_INSTANCE_HANDLE` (default `skein@localhost`), `SKEIN_HOME`.
- Where: raw BRC-33 on a BRC-104 session (#40). It sends to the instance's
  front door, `SKEIN_INSTANCE_URL` (default `$SKEIN_HOST_URL/@<handle>`,
  `SKEIN_HOST_URL` default `http://127.0.0.1:8100`), and reads David's
  mailbox instance, `SKEIN_MAILBOX_URL`, else `~/.skein/mailbox.url`, else
  `$SKEIN_HOST_URL/@david`.
- Boxes: `objects` (bundles `{records: [{cid, bytes}]}`, dag-cbor, ≤ 1 MiB;
  blobs first, the root tree last), `run` (`{cmd, tree: CID, cwd?, env?}`;
  the shell app's box, #83),
  and David's own `results` (`{replyTo, exitCode, stdout, stderr, tree}`).
  Bodies are dag-cbor, sent as `application/cbor` (BRC-231). No envelope and
  no encryption layer: the session proves the sender.
- `replyTo` is matched against the **message id**: the CID of the mail record
  the instance admitted, which the send's answer returns (`id`) and the
  mailbox lists as `messageId`. Sent messages are logged in
  `~/.skein/client/sent.jsonl`.

## Billing (#130)

A hosted skein pays for its own hosting from its own wallet (docs/VM.md
"Billing": the kernel's side). The host's side, `src/host/billing.ts` and
`Router` ("billing"):

**The terms.** The host bills by its **billing key** (a child of the master
secret, the provider key `billing`: it takes no messages and is in no
address book) and what it supports — X, the rates, the free allowance per
skein, the tick interval, the grace — `SKEIN_BILLING_*` over small dev
defaults (`billing.ts DEV_BILLING`; `SKEIN_BILLING=off`: it bills no one).
It publishes them:

```
GET /.well-known/skein-host  → {origin, domain, billing: {key, x, rates: {fuel, storage, served, fetch, authfetch, publish},
                                 allowance, tickMs, graceMs}}
```

The owner grants them as the skein's **host row** (a kernel row of its
dispatch table, the owner's own admin message):

```
bin/skein host add --from <the host's origin> <the skein's origin>                         # the published terms
bin/skein host add <host key> --x 1000 --rates '{"fuel":1,"storage":1}' <the skein's origin>
bin/skein host remove <host key> <the skein's origin>                                       # nothing billed after it
```

A skein with no host row is not billed and is served as before (the host
skein among them). One whose host row names another key, or X or a rate
below this host's, is not served (the gate, below).

**The meter.** What never reaches the skein's log is the host's to count: the
fuel of the read calls it makes for it (the explorer's reads, frontdoor.ts)
and the bytes of every response it serves for it. Each is a line of its log
for the period since its last tick (in memory; the fuel ledger, host.db
`fuel_ledger`, keeps the read calls per caller as before).

**The tick.** Every `SKEIN_BILLING_TICK_MS`, to every billed skein it runs
(and at once to one whose host row it has not ticked yet: the first tick
starts its billing, its allowance the allocation; and early, when what it
holds unreported would take the tally to the allocation): a message signed
by the billing key, in the host row's box, appended as a `local` request —

```
{kind: "tick", at: <ms>, allowance: <sats>, fuel: <read calls' fuel>, served: <bytes served>, log: <cid>}
```

— `log` the CID of the period's record, `{kind: "host-log", instance:
<its identity>, from, to, lines: [{at, op, caller?, fuel, bytes}]}`, which
the host keeps (host.db `billing_ticks`): what it charged, provable.

**The host reads the tally** after each settle, as it reads the dispatch
table: the kernel's `head billing` and its record (`Router.syncBilling`),
into host.db `billing` (tally, allocation, asleep since).

**Payments.** The skein's pay step emits each payment as the event
`payment` (its Atomic BEEF, the output index and amount, the BRC-29
remittance, the checkpoint CID): the host keeps it (host.db
`billing_payments`, with whether its output pays the key the remittance
derives from the billing key) and broadcasts it (its Arcade, once). What
else it does with it is its own.

**Funding.** Root funds a skein by the wallet's `internalize` message on
a route of its own to the wallet (docs/WALLET.md); the host has no funding
endpoint. A BRC-169 delivery message to the skein's own mailbox is the
coming path.

**The gate.** Asleep (consumed ≥ allocation, nothing paid) or with terms this
host does not serve, a skein gets nothing from the host but its own
messages to itself (the loopback: its
wallet's ingest at the chain app, the chain app's answers): a request is
`402 {code: "ERR_PAYMENT_REQUIRED"}` (its owner's too), a libp2p message is
ignored, a provider's answer, a cron tick, a feed's header, a status is not
carried in (a log line), and no tick is sent. Nothing wakes it today.

**Grace and reclaim.** host.db `billing.asleep_since` is when the host first
saw it asleep. Past `SKEIN_BILLING_GRACE_MS` the host may reclaim it;
nothing does it on its own:

```
bin/skein-host billing [handle]            # each billed skein: tally, allocation, asleep since, terms not served; its ticks and payments
bin/skein-host reclaim [--grace ms]        # the skeins asleep past the grace
bin/skein-host reclaim [--grace ms] --yes  # reclaim them: kernel stopped, row disabled and removed, store deleted (through the running router)
```

## Checking by hand

```
node --experimental-strip-types --no-warnings --test src/client/client.test.ts src/client/chat.test.ts   # on a scratch host, real kernel
bin/skein-host ledger david          # what the polls of david's mailbox cost
```

## Environment: every `SKEIN_*` variable

Every variable the code reads, one line each; the sections above say more
where they use one. Unset means the default.

**The host** (`skein-host`, `src/host/`):

| variable | what |
|---|---|
| `SKEIN_HOME` | the host's directory (default `~/.skein`): host.db, master.key, operator.key, instances/, host.env (every other setting here may be a line of it; the environment wins), the `.identity` files |
| `SKEIN_OPERATOR_KEY` | the operator's key file (default `$SKEIN_HOME/operator.key`: hex or WIF, 0600; `run` makes it if absent): the host skein's owner, and the key `bin/skein` signs with |
| `SKEIN_HANDLE_DOMAIN`, `SKEIN_HOST_NAME`, `SKEIN_HOST_NOTE` | the onboarding app's config at the host skein's birth: the handle domain (default the domain of `SKEIN_ROUTER_ORIGIN`), the host's name and note |
| `SKEIN_MASTER_KEY` | the master secret (hex) every instance, provider and certifier key derives from |
| `SKEIN_MASTER_KEY_FILE` | the master secret's file instead (default `$SKEIN_HOME/master.key`, made if absent) |
| `SKEIN_ROUTER_PORT` | the HTTP transport's port (default 8100) |
| `SKEIN_ROUTER_ORIGIN` | the router's public origin (default `http://127.0.0.1:{port}`): the geneses' `resolveOrigin`, where the host's own origin's BRC-169 requests are answered (by the host skein's onboarding app), and the host's domain (its host name) when the onboarding app names none |
| `SKEIN_INSTANCE_ORIGIN` | an instance's origin template (default `http://{handle}.localhost:{port}`) |
| `SKEIN_HOST_PORT` | the host page and `/roster.json` (default 4600) |
| `SKEIN_IDLE_MS` | stop a kernel this long after its last work (default 0: never) |
| `SKEIN_ANSWER_WAIT_MS` | how long a client waits on its request's thread before 503 + Retry-After (default two minutes) |
| `SKEIN_HTTP` | `fetch`: the HTTP proxy (the `fetch` provider) performs URLs that are not this host's; unset: refused |
| `SKEIN_KERNEL_BIN` | the kernel binary (default `kernel-zig/zig-out/bin/skein-kernel`) |
| `SKEIN_FUEL_PER_STEP` | a new genesis's `fuelPerStep` |
| `SKEIN_OWNER`, `SKEIN_OWNER_HANDLE` | a new code genesis's owner key and its handle (default `david@localhost`); bin/skein-host fills the key from `owner.identity` |
| `SKEIN_OWNER_MESSAGEBOX` | the owner's messagebox URL for new geneses (default: the owner's mailbox instance here) |
| `SKEIN_INFER`, `SKEIN_INFER_HANDLE` | a new code genesis's inference peer key and handle (default `infer@localhost`); bin/skein-host fills the key from `infer.identity` |
| `SKEIN_HOST_URL` | where `event` and `import-handles` find the running host (default `http://127.0.0.1:8100`) |
| `SKEIN_ARC_URL`, `SKEIN_ARC_TOKEN`, `SKEIN_ARC_EVENTS_URL`, `SKEIN_ARC_CALLBACK_URL` | the host's Arcade ("The broadcaster" above) |
| `SKEIN_HEADERS_URL` | the host's headers feed (#102) |
| `SKEIN_BILLING` | `off`: the host bills no one (#130, "Billing" above); else it bills a skein whose host row names its billing key |
| `SKEIN_BILLING_X`, `SKEIN_BILLING_RATES`, `SKEIN_BILLING_ALLOWANCE` | what it supports: X (sats a skein prepays at a time), the rates (JSON `{fuel, storage, served, fetch, authfetch, publish}`, whole sats), the free allowance per skein (sats); dev defaults in `src/host/billing.ts` |
| `SKEIN_BILLING_TICK_MS`, `SKEIN_BILLING_GRACE_MS` | how often it ticks a billed skein; how long after one went asleep `skein-host reclaim` lists it |
| `SKEIN_LIBP2P_LISTEN`, `_TLS_CERT`, `_TLS_KEY`, `_BOOTSTRAP`, `_DHT`, `_RELAYS`, `_MDNS` | the libp2p nodes ("libp2p" above) |
| `SKEIN_LIBP2P_VERBOSE` | set: log every libp2p verdict, accepted ones too (default: only reject and ignore) |
| `SKEIN_SHELL_APP`, `SKEIN_CHAT_APP`, `SKEIN_ONBOARD_APP` | up.sh: the shell, chat and onboarding apps it installs (repo URL with a tag) |

**The kernel process** (`skein-kernel`, set by the host or by hand):

| variable | what |
|---|---|
| `SKEIN_DB`, `SKEIN_HANDLE` | `serve`'s store file and `handle@domain` (the host sets both); `skein-dev`'s store (default `$SKEIN_HOME/runtime.db`) |
| `SKEIN_WASM_DIR` | where the pinned modules are read from (default the repo's `wasm/`) |
| `SKEIN_EXTRA_MODULES` | `file:file…`: modules that are not pinned, installed into the store too (tests) |
| `SKEIN_REPLAY_MODULE` | `<cid>=<file>`: replay runs `<file>` wherever the log runs that module (another build of a program) |
| `SKEIN_REPLAY_ECHO` | set: replay echoes the steps' log lines |
| `SKEIN_FUEL_MODE` | `instrument`: count fuel by instrumenting the modules, as the browser build does |
| `SKEIN_WASMTIME_CACHE` | `0`: no wasmtime compilation cache |
| `SKEIN_SHELL_COMPONENTS` | `kernel shell`: run the tools found in that directory as components (#34) |
| `SKEIN_COMPONENT_TRACE` | `1`: every component call on stderr (debugging) |

**Clients** (`bin/skein`, `bin/skein-infer`, `web/`):

| variable | what |
|---|---|
| `SKEIN_INSTANCE_IDENTITY`, `SKEIN_INSTANCE_HANDLE`, `SKEIN_INSTANCE_URL` | the client's instance: its key (default `$SKEIN_HOME/instance.identity`), `handle@domain`, its URL |
| `SKEIN_MAILBOX_URL`, `SKEIN_MAILBOX_HANDLE` | the client's (or the inference peer's) mailbox instance; the handle when no URL is set (default `david`) |
| `SKEIN_INFER_WALLET_URL` | the inference peer's wallet (default `http://127.0.0.1:3323`) |
| `SKEIN_INFER_PEERS`, `SKEIN_INFER_PROVIDERS` | its address book and provider map files |
| `SKEIN_INFER_CACHE`, `SKEIN_INFER_NODES` | its conversation graph on disk, and how many nodes it keeps in memory |
| `SKEIN_POLL_MS` | its poll interval (default 1000) |
| `SKEIN_WEB_PORT`, `SKEIN_WEB_HOST` | the web page's port (web.sh) and listen address (default 127.0.0.1) |
| `SKEIN_YOURS_IDENTITY` | `web:build`: the owner key the page expects |

**Tests and builds**:

| variable | what |
|---|---|
| `SKEIN_SHELL_DIR`, `SKEIN_SHELL_REV`, `SKEIN_CHAT_DIR`, `SKEIN_CHAT_REV`, `SKEIN_ONBOARD_DIR`, `SKEIN_ONBOARD_REV`, `SKEIN_GIT_DIR`, `SKEIN_GIT_REV` | the apps the tests install: a checkout, or another commit than src/testapps.ts pins |
| `SKEIN_CHAIN_DIR`, `SKEIN_CHAIN_REV`, `SKEIN_OVERLAY_DIR`, `SKEIN_OVERLAY_REV`, `SKEIN_SITE_DIR`, `SKEIN_SITE_REV` | the same for the equiv drivers' apps (the site, #125) |
| `SKEIN_KERNEL` | the equiv drivers' kernel binary (default `kernel-zig/zig-out/bin/skein-kernel`) |
| `SKEIN_EQUIV_BROWSER` | `0`: skip the browser parts of equiv/run.sh |
| `SKEIN_CHROMIUM`, `SKEIN_PLAYWRIGHT` | the Chromium and the Playwright package the browser parts use |
| `SKEIN_BROWSER_MAX_MB` | the largest store the browser replay takes (default 256) |
| `SKEIN_EQUIV_SHOW`, `SKEIN_EQUIV_KEEP`, `SKEIN_EQUIV_NO_COMPONENTS` | equiv/shell.ts: print the cases, keep the work dir, skip the component runs |
| `SKEIN_WALLET_ABI`, `SKEIN_WALLET_COMPONENT`, `SKEIN_WALLET_REPORT` | equiv/wallet.ts: run the wallet as a component, which build, and where to write its report |
| `SKEIN_FETCH_COMPONENT` | equiv/fetch.ts: the fetch component's build |
| `SKEIN_WASI_ADAPTER` | the preview1 adapter for component builds (programs/*/build.zig, equiv/shell.ts) |
| `SKEIN_P2P_KEEP` | p2p-router.test.ts: keep its stores |
| `SKEIN_POLLS` | router.test.ts: how many polls the poll test makes (default 100) |
| `SKEIN_TEST_MESSAGEBOX_HOST` | web/envelope.test.ts: the live messagebox it tries (default `http://127.0.0.1:8100`) |
| `SKEIN_SDK_DIR` | scripts/sdk-local.sh: the sibling skein-sdk checkout |
| `SKEIN_DIR` | shruggr/skein-site's build.mjs (the page's bundles): the skein checkout it builds against |
| `SKEIN_NO_NODE` | host-go's tests: skip the comparison with Node |
