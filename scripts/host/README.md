# Host setup on David's machine

What runs where so the clients (`bin/skein`, the bopen-skein front end, the
inference peer) reach the instances (docs/ARCH.md, "The router"). Everything
here is dev-only: the keys are throwaway, generated on this machine, and hold
no funds.

```
bin/skein-host add martha                   # a row: identity derived from ~/.skein/master.key (made on first use), no wallet process
scripts/host/up.sh                          # wallets, mailbox instances, the router on :8100, grants — in that order (idempotent)
```

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
   owner's. No registration (`register.ts`) is needed for keys this machine
   knows: the rows are what a registration would make.
3. **The router** (`skein-host run`, if nothing listens on :8100). It
   hydrates every enabled row, so the agents' geneses happen here, naming the
   owner's mailbox instance (the router's default for
   `SKEIN_OWNER_MESSAGEBOX`; `run` prints which at start, and a WARNING if
   there is none).
4. **The grants** (`grants.sh`), toward every row's front-door key from
   `skein-host list`, now that every row exists.
5. **The address books** (#40). Into every enabled agent, through its
   `peers` box as the owner (`skein-host peers <agent> add …`): the owner's
   key and mailbox instance origin (`http://david.localhost:8100`, handle
   `SKEIN_OWNER_HANDLE`) and the inference peer's (`http://infer.localhost:8100`,
   `SKEIN_INFER_HANDLE`). Then the roster step, `skein-host roster --deploy`,
   writes the other agents' keys and origins into each (and redeploys any
   changed ROSTER.md). The inference peer's own address book, every agent's
   key → origin, is written to `~/.skein/infer-peers.json` (bin/skein-infer
   reads it, again whenever it changes). An add identical to what the store
   has is not sent, so this is idempotent. Run `up.sh` again after adding an
   agent.

An agent whose genesis names no owner messagebox is logged at every
hydration (`[<handle>] WARNING: its genesis names no owner messagebox …` in
`host.log`) and `skein-host deploy` says the same.

| process | address | what | log |
|---|---|---|---|
| router `bin/skein-host run` | 127.0.0.1:8100 (and ::1), host page 127.0.0.1:4600, explorers 4610+ | the reverse proxy (#40): each instance is an HTTP server, its front door, at `http://<handle>.localhost:8100` (or `http://127.0.0.1:8100/@<handle>`); each instance's kernel started on demand (`skein-kernel serve`; not stopped when idle unless `SKEIN_IDLE_MS` is set), the oracle (instance keys from `~/.skein/master.key`), the providers (#70, #69, #65: `fetch`, `waker`, `cron`, `libp2p`, `status`, each with a key of its own from the same master), the fuel ledger, the instances' feeds (SSE headers), the broadcaster (#58, #65: the broadcast events' queue to the host's Arcade, one status subscription), the libp2p host (#51: a node per instance whose config declares `libp2p`, below) | `~/.skein/logs/host.log` |
| owner (David) wallet `1sat serve wallet-api` | 127.0.0.1:3322 | the dev owner's wallet (HOME `~/.skein/owner-home`, key `~/.skein/owner-wallet.env`): a client | `~/.skein/logs/wallet-owner.log` |
| infer peer wallet `1sat serve wallet-api` | 127.0.0.1:3323 | the inference peer's wallet (HOME `~/.skein/infer-home`, key `~/.skein/infer-wallet.env`): a client | `~/.skein/logs/wallet-infer.log` |
| inference peer `bin/skein-infer` | — | polls its own mailbox instance (`SKEIN_MAILBOX_URL`, e.g. `http://127.0.0.1:8100/@infer`) and answers `completions` into the sender's messagebox as its address book names it (`~/.skein/infer-peers.json`, `SKEIN_INFER_PEERS`), raw BRC-33 on BRC-104 sessions | as run |

Gone since the router (#33), scripts kept and marked legacy: the `1sat serve`
messagebox (`messagebox.sh`, `messagebox-migrate.mjs`), the instance wallet
3321 and the host wallet 3324 (`wallets.sh` with no arguments starts them all),
one wallet-api per instance on 3401+ (`instance.sh`), their grants
(`grants-legacy.sh`). Gone since #40: the router's shared `/messagebox`, its
mailbox keeping and its BRC-104 server. Instances need no grants: the
router's oracle signs for them.

## The router: a reverse proxy (#40)

The router picks the instance a request is for and forwards it; it holds no
mail, and of auth only each running kernel's in-memory session table, which
it never reads. Routing comes before authentication, because a BRC-104
handshake does not name its recipient: the URL is the recipient.

- **By host name**: `http://<handle>.localhost:8100/…` (the `Host` header;
  `SKEIN_INSTANCE_ORIGIN` sets another template, default
  `http://{handle}.localhost:{port}`). The stock `AuthFetch` keeps one session
  per origin and shakes hands at `<origin>/.well-known/auth`, so this is the
  form the stock `@bsv/message-box-client` and the SDK's overlay clients use.
  `*.localhost` resolves to ::1: the router listens on 127.0.0.1 and ::1.
- **By path prefix**: `http://127.0.0.1:8100/@<handle>/…` (a dev form). The
  router strips the prefix for the routes; the client signs the path it sent,
  and its handshake goes under the prefix (`src/client/raw.ts`, `RawBox`).

A request for an instance is appended as received (#68: a `request` entry)
and its front door (`programs/frontdoor`) is stepped on it: BRC-103/104
against the instance's session records, the routes table, the handler, the
signed answer. The router holds the client until that thread comes to rest
(#66) — past `SKEIN_ANSWER_WAIT_MS` (default 120000) or at shutdown, 503 +
Retry-After. Every request is an entry (a poll too: an access log); a read
moves nothing. A request's fuel is on its thread's updates; the kernel
calls the router makes (the explorer's reads) are charged to the **fuel
ledger** (host.db `fuel_ledger`, by instance, caller and route; `skein-host
ledger [handle]`).

The router's own endpoints:

| | |
|---|---|
| `GET /manifest.json` | BRC-169: `metanet.handles.resolve` |
| `GET /.well-known/metanet-handles/resolve?handle=<h>@<d>` | `{handle, domain, identityKey, messagebox}`: an agent's own identity and origin; for a mailbox instance, its owner's key and the instance's origin |
| `GET /bsvalias/id/<handle>@<domain>` | paymail PKI (identity keys by handle) |
| `POST /account/register {username, identityKey, signature}` | a mailbox instance for that identity: the signature by its own wallet, protocol `[2, "skein register"]`, key ID the username, counterparty anyone, over `register <username>` → `{identityKey, username, handle, messagebox}` (409 if the name is taken) |
| `POST /arc/callback` | Arcade's webhook (`Authorization: Bearer <SKEIN_ARC_TOKEN>`) |

The instances' outbound HTTP (a messagebox delivery thread, a resolve) is a
message to the router's `fetch` provider (#70; docs/MESSAGES.md,
"Outbound"): a URL of this host's is answered in process (the same path, no
socket), any other goes out (`SKEIN_HTTP=fetch`). Every delivery
(a `POST …/sendMessage`) is one line in `host.log`, so a lost reply shows
where it went and what came back:

```
[martha] deliver chat for 8f98ef7c → http://david.localhost:8100/sendMessage (local): 200 delivered
[martha] deliver chat for 79d35eb2 → https://other.host/sendMessage (remote): HTTP 503 down for a moment
[martha] deliver chat for 79d35eb2 → https://other.host/sendMessage (remote): failed: fetch failed
```

### The address book: `skein-host peers`

Where an agent delivers to a key — its answers, its `message` tool — is its
address book (head `peers`: key → transport and address, role and handle
optional; docs/MESSAGES.md, "Outbound: emit, the address book and the
providers"). Every new genesis seeds it with the host's providers and the
owner's mailbox (source `genesis`); the rest is configuration: the admin
writes it through the agent's `peers` box as the owner, like `dispatch`.

```
bin/skein-host peers martha add <key> <address> [--transport mailbox|libp2p|local] [--role r] [--handle bob@example.com]
bin/skein-host peers martha remove <key>
bin/skein-host peers martha list        # key, transport, address, role, handle@domain, source (genesis | admin | resolve)
```

`--transport` defaults to `mailbox` (the address a messagebox URL); `libp2p`
takes a peer ID or `topic:<name>`, `local` a provider's name on this host.

Nothing registers itself: the core sends no claims and the stock genesis
takes none. A key outside the host — a person using the bopen page, say —
gets answers from an agent only once the admin adds its key and mailbox URL
here (or an application wires its own `register` box: docs/BOOTSTRAP.md).
Until then its chats are still admitted (the key authenticates, the
subscription decides), and the agent's answer fails once, logged on the
step's line in host.log: `stderr: loop: could not deliver the answer: … no
route to <key>: not in the address book`. `up.sh` writes the owner, the
inference peer and every other agent; `deploy` and `roster --deploy` write
the other agents.

**Mailbox instances.** A person or peer outside the host gets a mailbox: an
instance of its own with only the front door and the messagebox, keeping
every message sent to it (docs/BOOTSTRAP.md). `skein-host add <handle>
--mailbox --owner <key>` makes one; so does a signed registration
(`register.ts`: the front end's Register, for a key this machine does not
know). `up.sh` makes `david`'s and `infer`'s with `add`. `skein-host mailboxes` lists them (whose, the key their front door signs
sessions with, and where); `skein-host list` prints that key for every row
(its fifth column), which is what `grants.sh` grants toward. The
owner's is where every instance delivers what it sends him: a new genesis
names it (`defaults.ownerMessagebox`: `SKEIN_OWNER_MESSAGEBOX`, else the
owner's mailbox instance here), the one peer a genesis names.

Files:

- `~/.skein/master.key` — the router's master secret (hex, 0600, made once; `SKEIN_MASTER_KEY` overrides). Every instance key derives from it; losing it loses the instances' identities. `skein-host identity <handle>` prints one.
- `~/.skein/owner.identity`, `~/.skein/owner-dev.identity`, `~/.skein/infer.identity` — public keys, one line each. `owner.identity` is the *configured* owner (a genesis's `owner`) and is written once; `owner-dev.identity` is the owner wallet's (3322). `bin/skein-host` reads `owner.identity` into `SKEIN_OWNER` and `infer.identity` into `SKEIN_INFER`, unless they are set, for `run`, `deploy`, `roster`, `peers`, `add` (so `add --boot`/`--packet` needs no `SKEIN_OWNER` by hand) and `event`.
- `~/.skein/host.sock` — the running router's control socket (0600; there only while `run` is up): `skein-host event` sends through it.
- `~/.skein/infer.json` — the inference peer's providers (written if absent).
- `~/.skein/mailbox.url` — the owner's mailbox instance, `http://127.0.0.1:8100/@david` (`up.sh`): where `bin/skein` reads.
- `~/.skein/host.db` — the instances (identity → store; `kind` agent or mailbox, a mailbox's `owner`) and the fuel ledger (`skein-host list`, `skein-host mailboxes`, `skein-host ledger`).

Sessions are state (#68): a handshake is a request like any other, and
the front door's step on it writes the session under the instance's head
`sessions`; every later request is verified against it. Sessions expire by
the instance's `defaults.sessionTtlMs` (a day) from the handshake entry's
time; an unknown or expired one is a plain 401, and the stock client shakes
hands again by itself. A restarted router or kernel keeps them: clients go
on without a new handshake. Instances are not stopped when idle
(`SKEIN_IDLE_MS` default 0: never); `SKEIN_IDLE_MS=<ms>` turns the idle
stop on. **Switching a live stack**: stores
from before #40 (log format 2) are refused; they need a new genesis
(`skein-host add <h> --derive` with a new `--store`).

Feeds: an instance's `etc/config.json` may declare `feeds: [{kind:
"headers", url, box?}]` (the genesis carries them): the router holds one SSE
connection per URL (reconnecting with backoff, at most 1000 items queued per
instance), admitting `header` entries into the box (default `chain`). The
per-instance `arc-callback` feed is gone (#58; a config that declares one is
refused): transaction proofs and statuses come from the broadcaster.

Scheduling (#69, `src/host/cron.ts`; docs/MESSAGES.md "Scheduling"): there
are no genesis jobs (a config that declares `jobs` is refused). A program
asks the host's **cron provider** — its address book's role `cron`, seeded
by every new genesis — with a message (`{fn: "tick", every | at, box, body?,
name}` in box `cron`; `{fn: "stop", name}`), and each tick comes back as a
signed message from the provider into the named box, `{kind: "cron", name,
due, …body}` (the body's own `kind` wins), which the instance's subscription
on that box handles. The schedules live in host.db (`cron_schedule`): an
`every` one ticks once when `run` starts (a restart is a late tick, never a
burst), an `at` one once. An idle-stopped instance is hydrated for a tick
only if something in it subscribes the box; otherwise the tick is logged
(`cron: … not woken`) and skipped. A step's `deadline` and a shell's `sleep`
are wake-me messages to the **waker** provider, likewise. By hand:

```
bin/skein-host event <handle> <box> ['{"kind":"amm-p2p-timer","job":"heartbeat"}']   # {kind: "cron" unless named, due: now}
```

sends one tick now, a message from the cron provider. While `run` is upadmits one such event now. While `run` is up it goes over the router's
control socket, `$SKEIN_HOME/host.sock` (a Unix socket, mode 0600, made when
`run` starts and removed when it stops; no HTTP route leads to it), and the
running router sends it with the kernel it already holds. With the host
down it goes through a router of its own, which runs the steps it starts and
closes. It refuses when a router answers at `SKEIN_HOST_URL` /
`SKEIN_ROUTER_PORT` but no control socket answers under this `SKEIN_HOME`
(another home, or a router from before the socket): that router's kernel
holds the instance's store.

The broadcaster (#58, #65, `src/host/arc.ts`, docs/WALLET.md): one Arcade
for the whole host. An instance's broadcast is an event (`{kind:
"broadcast", tx, beef?}`), not a message: the router queues it durably in
host.db (`broadcast_queue`), posts it to Arcade under the host's callback
token, and retries with backoff while Arcade does not take it (a 503, no
answer), until a day after it was queued. The router holds one SSE
subscription to Arcade's events for the token (resumed with `Last-Event-ID`
from host.db `stream_cursor`) and takes Arcade's webhooks at `POST
/arc/callback` (`Authorization: Bearer <token>`). What Arcade says of a
transaction goes to every instance whose state holds it (host.db
`status_seen`: each txid + status + block hash once): a merkle path as a
proof event in box `chain`; anything else — its answer to the post included
— as a signed message from the host's **status provider** (box `status`;
role `status` in a new genesis's address book), which an instance takes
only if it subscribes to it (`{"sender": "$status", "box": "status",
"handler": …}`). There is no `/arc/v1/tx` route any more.
Configured from the environment or
`~/.skein/host.env` (only the `SKEIN_ARC_*` lines are read from it):

| variable | default | |
|---|---|---|
| `SKEIN_ARC_URL` | unset: no broadcaster (a broadcast event is dropped, with a line), and a new genesis has no status provider in its address book | Arcade's API (its `POST /tx`), e.g. `https://arcade.example.com` |
| `SKEIN_ARC_TOKEN` | required with the URL | the host's one callback token: `X-CallbackToken` on every submission, the scope of the SSE stream, the webhook's bearer. Arcade has no client auth: this token is what ties the host's transactions together |
| `SKEIN_ARC_EVENTS_URL` | `<SKEIN_ARC_URL>/events` | Arcade's SSE service, which listens on a port of its own (Arcade's default 8082), e.g. `https://arcade.example.com:8082/events` |
| `SKEIN_ARC_CALLBACK_URL` | unset: SSE only | where Arcade posts webhooks: this router's `/arc/callback` as Arcade reaches it (Arcade wants a public HTTPS URL) |

`skein-host run` prints the broadcaster's line at start (`broadcaster:
broadcast events → Arcade …; proofs and statuses (the status provider) from
…`, or `no Arcade`), and `host.log` has one line per post (`[<handle>]
broadcast <txid> → Arcade: HTTP 202 RECEIVED`) and per status routed
(`arcade stream: <txid> MINED (a proof event) → <handles>`).

libp2p (#51): an instance whose `etc/config.json` declares `libp2p:
{topics?, protocols?, listen?}` gets a libp2p node in the router process,
with its own peer key (a child of `~/.skein/master.key`, key ID
`libp2p:<handle>`). `skein-host list` prints every row's peer ID (last
column) and `skein-host identity <handle> --peer` prints one; it is the
identity multihash of the compressed secp256k1 key, so the key reads out of
it. Topic messages and stream frames reach the instance through its front
door (docs/MESSAGES.md, "libp2p"); the validator and stream calls' fuel is in
`skein-host ledger` (caller: the peer ID, op: `libp2p:<topic | protocol>`).
The host-wide settings, from the environment or `~/.skein/host.env` (only the
`SKEIN_LIBP2P_*` lines are read from it):

| variable | default | |
|---|---|---|
| `SKEIN_LIBP2P_LISTEN` | `/ip4/127.0.0.1/tcp/0,/ip4/127.0.0.1/tcp/0/ws` | multiaddrs every node listens on (comma-separated). A fixed port can serve one node only: give per-instance ports in its config's `libp2p.listen`. Plain WS on loopback is for dev; browsers need WSS (below) |
| `SKEIN_LIBP2P_TLS_CERT`, `SKEIN_LIBP2P_TLS_KEY` | unset | PEM files: the WebSocket listener serves TLS (listen on `/ip4/0.0.0.0/tcp/<port>/tls/ws`), so browsers can dial it |
| `SKEIN_LIBP2P_BOOTSTRAP` | none | multiaddrs with `/p2p/<peer ID>`: dialled at start and redialled every 30 s while not connected |
| `SKEIN_LIBP2P_DHT` | `off` | `off`, `client` or `server` (Kademlia, `/ipfs/kad/1.0.0`). On: each topic name is a rendezvous — the node provides the CID v1 raw sha2-256 of the name and dials the providers it finds, every 30 s (go-p2p-message-bus's scheme). Private and loopback addresses are kept in the DHT only when every listen and bootstrap address is private (dev) |
| `SKEIN_LIBP2P_RELAYS` | none | circuit relays (multiaddrs with `/p2p/<id>`): each node also listens at `<relay>/p2p-circuit` |
| `SKEIN_LIBP2P_MDNS` | `off` | `on`: mDNS discovery on the LAN; discovered peers are dialled |

The sections below describe the pre-router layout (the `1sat serve`
messagebox, a wallet-api per instance, host-signed entries, BRC-169
envelopes) where they talk about those processes; `skein-host deploy`,
`dispatch` and the roster work the same against the router, speaking raw
BRC-33 to the row's front door (`SKEIN_HOST_URL`/@<handle>) as the owner.

## The messagebox (legacy: `1sat serve`)

`1sat serve` (1sat CLI 0.0.121) is the unified host: wallet storage RPC,
accounts, paymail and `@bopen-io/messagebox-server` behind one BRC-103/104
`authMiddleware` (one `/.well-known/auth` handshake covers every route). The
stock `@bsv/message-box-client` (2.5.4) works against it unchanged:
`sendMessage` / `listMessages(Lite)` / `acknowledgeMessage` with the host
`http://127.0.0.1:8100/messagebox`, verified with two ephemeral ProtoWallets
and in `src/client/client.test.ts`. The reference TS and Go servers were not
needed.

Two things `1sat serve` needs that it does not do by itself:

1. **Migrations.** It mounts the messagebox routes but never runs their knex
   migrations; the first `sendMessage` fails `500 SQLITE_ERROR`.
   `messagebox-migrate.mjs` applies them to
   `~/.skein/host-home/.1sat/cli/data/messagebox-main.db` with the knex and
   migration files inside the installed CLI. `messagebox.sh` runs it on every
   start (idempotent).
2. **Accounts.** It stores messages only for recipients with an account on the
   host (`403 ERR_ACCOUNT_REQUIRED`). `register.ts` does `POST /account/register`
   over AuthFetch through each identity's wallet: `david` (owner) and `skein`
   (instance), `infer` (the inference peer). The host also issues a BRC-52 handle certificate
   (`certifier` = host identity), so `skein@localhost` is a real handle here.
   `up.sh` can only register the owner through the dev owner wallet (3322); if
   `owner.identity` names some other key (e.g. the Yours wallet), it prints a
   one-line notice instead and that key must register itself from `web/` (Register).

Host config, written once by `messagebox.sh` under `HOME=~/.skein/host-home`:

```
1sat config set server.host 127.0.0.1
1sat config set server.port 8100
1sat config set server.paymail.baseUrl http://localhost:8100   # paymail accepts https, or http only for "localhost"
1sat config set server.paymail.userDomain localhost
1sat config set server.monitor.enabled false                   # plus ONESAT_MONITOR=false in the env
```

Client code must always pass the host explicitly (`sendMessage(msg, host)`,
`listMessagesLite({host})`); otherwise the message-box-client looks recipients
up on the mainnet overlay.

## The two wallets

The 1sat CLI has no flag or env var for its config dir: `CONFIG_DIR` is
`join(homedir(), ".1sat", "cli")`. The owner wallet therefore runs with its own
`HOME`. The port is `ONESAT_DAPP_PORT`.

```
# instance (already the runtime's wallet; see ~/.skein/README-wallet.md)
set -a; . ~/.skein/dev-wallet.env; set +a; 1sat serve wallet-api
# owner
set -a; . ~/.skein/owner-wallet.env; set +a; HOME=~/.skein/owner-home ONESAT_DAPP_PORT=3322 1sat serve wallet-api
```

`wallets.sh` starts whichever is not listening (in the background) and writes
both `.identity` files.

## Grants

wallet-api denies by default and names the grant that would allow a refused
call. Each grant below answers one refusal. `grants.sh` writes them all
(`$HOST`, `$INST`, `$OWNER` = the three identity files):

```
# owner wallet, origin skein-client (HOME=~/.skein/owner-home)
1sat permissions grant skein-client --protocol "identity key retrieval" --level 1
1sat permissions grant skein-client --protocol "metanet handles envelope" --level 2 --counterparty anyone  # envelope signature
1sat permissions grant skein-client --protocol "message encryption" --level 2 --counterparty $INST        # BRC-78 content
1sat permissions grant skein-client --protocol "messagebox" --level 1                                      # messageId HMAC
1sat permissions grant skein-client --protocol "server hmac" --level 2 --counterparty self                 # BRC-104 nonces
1sat permissions grant skein-client --protocol "auth message signature" --level 2 --counterparty $HOST     # BRC-104 with the host

# instance wallet, origin skein (default HOME): the same transport set, envelope ones toward the owner
1sat permissions grant skein --protocol "identity key retrieval" --level 1
1sat permissions grant skein --protocol "server hmac" --level 2 --counterparty self
1sat permissions grant skein --protocol "auth message signature" --level 2 --counterparty $HOST
1sat permissions grant skein --protocol "messagebox" --level 1
1sat permissions grant skein --protocol "metanet handles envelope" --level 2 --counterparty anyone
1sat permissions grant skein --protocol "message encryption" --level 2 --counterparty $OWNER
1sat permissions grant skein --protocol "message encryption" --level 2 --counterparty $INFER

# host wallet, origin skein-host (HOME=~/.skein/host-wallet-home): it signs every log entry
1sat permissions grant skein-host --protocol "identity key retrieval" --level 1
1sat permissions grant skein-host --protocol "skein log" --level 2 --counterparty anyone

# infer peer wallet, origin skein-infer (HOME=~/.skein/infer-home): transport, and envelopes to/from the instance
1sat permissions grant skein-infer --protocol "identity key retrieval" --level 1
1sat permissions grant skein-infer --protocol "server hmac" --level 2 --counterparty self
1sat permissions grant skein-infer --protocol "auth message signature" --level 2 --counterparty $HOST
1sat permissions grant skein-infer --protocol "messagebox" --level 1
1sat permissions grant skein-infer --protocol "metanet handles envelope" --level 2 --counterparty anyone
1sat permissions grant skein-infer --protocol "message encryption" --level 2 --counterparty $INST
```

A level-2 grant without `--counterparty` means `self`, which is never what an
envelope needs.

## Instances

Every instance is a row in the host's management database, `~/.skein/host.db`
(src/host/instances.ts), and runs on the Zig kernel behind the router:

| column | |
|---|---|
| `handle` | primary key; the genesis's `handle` and the front door's host name, e.g. `martha` |
| `domain` | default `localhost` |
| `kind` | `agent`, or `mailbox` (a mailbox instance, #40: the front door and the messagebox, keeping mail for `owner`) |
| `owner` | a mailbox instance's: the identity (hex) whose mailbox it is |
| `identity` | the instance's identity key: derived from `~/.skein/master.key` by `add` (the oracle's, BRC-42 child, key ID the handle) |
| `wallet_url`, `wallet_originator` | legacy (a wallet-api per instance, `instance.sh`); unused by the router |
| `store` | its store file (default `~/.skein/instances/<handle>/runtime.db`) |
| `tree` | the root CID of the directory last deployed into it (`skein-host deploy`) |
| `source` | that directory, which `deploy --all` sends again |
| `knows` | JSON array of the handles its `ROSTER.md` lists (`skein-host knows`); `["*"]`: every other enabled row; NULL: none, no `ROSTER.md` |
| `status` | `enabled` / `disabled` |
| `created_at` | ISO time |

```
bin/skein-host add <handle> [--domain d] [--identity hex] [--store path] [--tree cid] [--knows a,b|*] [--disabled]
bin/skein-host add <handle> --mailbox --owner <hex>   # a mailbox instance for an identity outside the host
bin/skein-host knows <handle> [a,b | --all | --none]   # who its ROSTER.md lists; no list: print it
bin/skein-host list | mailboxes | enable <handle> | disable <handle> | remove <handle>   # remove leaves the store
bin/skein-host run                    # the router, the host page and roster, an explorer each
bin/skein-host deploy <handle> <dir> [--only glob,glob]
bin/skein-host deploy --all [--only glob,glob]   # every enabled row, from its `source`
bin/skein-host roster                 # the roster JSON, printed
bin/skein-host roster --for <handle>  # that agent's ROSTER.md, printed
bin/skein-host roster --deploy        # redeploy every enabled row whose ROSTER.md changed
```

### Running them: `skein-host run`

`skein-host run` is the router (above, and docs/ARCH.md "The router"): it
hydrates every enabled row once at start — a row's genesis is written at its
first hydration — then starts each kernel (`skein-kernel serve` over the
row's store) on demand and, with `SKEIN_IDLE_MS`, stops it when idle. Beside
it runs a supervisor (src/host/supervisor.ts) for one read-only
`bin/skein-explore <port>` per enabled row:

- **Lines**: every line an explorer writes is the host's, prefixed
  `[handle explore]`.
- **Restarts**: an explorer that exits is started again after 1 s, doubling
  to at most 60 s; one that ran 30 s or more starts again at 1 s.
- **Stopping**: SIGINT/SIGTERM closes the router (`Router.close()`, #61:
  its timers, feeds, broadcaster, libp2p nodes and kernels) and sends every
  explorer SIGTERM (SIGKILL after 10 s). An explorer whose supervisor is killed stops
  by itself (its IPC channel closes).

**Ports** (127.0.0.1):

| | |
|---|---|
| `SKEIN_ROUTER_PORT` (default 8100) | the router |
| `SKEIN_HOST_PORT` (default 4600) | `/`: the host page; `/roster.json`: the roster |
| `SKEIN_EXPLORE_BASE_PORT` (default 4610; `off`: none) | row *i*'s explorer on base + *i*, *i* its place among the enabled rows (`list` order) |

**The host page** (`http://127.0.0.1:4600/`, read-only, #23 "Host
explorer"): one line per enabled instance — handle, identity, status
(`live` while its kernel runs, else `idle`), pid, store path, deployed tree —
and a link to its explorer (src/dev/explore) over the row's store. This is
the host operator's view, not the end-user UI.

### Changing an instance's dispatch table: `skein-host dispatch`

The genesis carries only the seed of an instance's dispatch table (#77,
docs/MESSAGES.md "The dispatch table"); the table is a chain in the
instance's store, so a change is a message, not a new genesis.
`skein-host dispatch <handle> add|remove [--sender <key>] <box> <handler>`
sends one message to the instance's `dispatch` box as the owner, through the
owner's wallet to its front door exactly as `deploy` does (same checks). The
kernel performs it (an admin operation, not a program): the body is
`{op, row}`, the row `{transport: "mailbox", address: <box>, sender: "*" |
<key bytes>, program: <handler>}`; `add` replaces the row with the same
(transport, address, prefix, sender) or appends it, `remove` deletes it.
`<handler>` is a program the instance's genesis names (`loop`,
`run-handler`, …: resolved to its record's CID from the row's store) or a
program record's CID (its record and module go in through `objects` first).
No reply; the change shows on the explorer's `/s`. Nothing in host.db maps
to rows yet (`knows` is only ROSTER.md), so nothing sends these
automatically.

```
bin/skein-host dispatch martha add --sender <key> run run-handler
bin/skein-host dispatch martha remove --sender <key> run run-handler
```

**Stores from before the dispatch table** (a genesis with `subscriptions`
or `routes`, before format 8) are not read by this kernel. Move the
runtime.db aside, restart `skein-host run` on this build, and `deploy`
again; host.db is untouched.

### Installing an app: `skein-host install` / `uninstall`

```
skein-host install <repo-url[#rev] | dir> --instance <handle> [--approve-all | --dry-run]
skein-host uninstall <app> --instance <handle> [--approve-all]
```

An app (docs/APPS.md, #72/#76) is a tree with `etc/app.json`. `install`
clones the repo (a `#<rev>` checks that commit out) or reads the
directory (leaving out `.git`, `node_modules`, `zig-out`, `.zig-cache`,
`zig-pkg`), checks the manifest (src/host/manifest.ts) and the instance
(its store, read only: `requires` provided by an installed app, routes and
heads nobody else has, `$<provider>` senders in the address book), prints
what the app asks for — heads, each box with its handler and senders, each
route under `/<app>/`, start/stop, requires/provides, the messages — and,
approved (`--approve-all`, or "y" at a terminal; `--dry-run` stops at the
prompt), sends as the owner through the owner's wallet to the row's front
door (as `deploy` does): `objects` (the tree, modules, program records,
the app record), `head` `{name: <app>, tree: <app record>}`, `subscribe`
per (box, sender), `routes` per route, then `start`. Installing it again is
the upgrade (state kept, what it no longer asks for removed, start sent
again). `uninstall` sends `stop`, then removes the app's subscriptions and
routes; the head is left. Exit 0 sent, 1 refused or failed, 2 usage.

```
skein-host install https://github.com/shruggr/skein-static --instance martha --approve-all   # /static/… from main's www/
skein-host install programs/test/app-demo --instance martha --dry-run
```

### Deploying an agent: `skein-host deploy`

Genesis is only the core image; the agent's personality arrives as a
message (#23, "Deployment via `objects`"). `skein-host deploy <handle> <dir>`
does what `bin/skein import` does, for the row's instance: it hashes `<dir>`
into git objects, sends them in ≤ 1 MiB bundles to the instance's `objects`
box (blobs, then trees, the root tree on the last bundle), and records the
root CID as the row's `tree` and `<dir>` as its `source`. Each message is
sent as the **owner** — the identity the genesis's dispatch rows take `objects` and
`head` from — on the owner's BRC-104 session with the front door, as `bin/skein` does
(`SKEIN_OWNER_WALLET`, default http://127.0.0.1:3322, origin
`SKEIN_ORIGINATOR`, default `skein-client`); it refuses if that wallet is not
`SKEIN_OWNER` or not the store's genesis owner. Each bundle is one message
to the instance's front door (the router starts its kernel if it is not
running), admitted as one `mail` entry.

- **First deploy**: the kernel's `objects` operation makes the root `main` (there is none yet).
- **Redeploy of a changed directory**: only the records the instance's store
  lacks (read-only look at the store, if it exists), then `head` `{name:
  "main", tree: root}`, so the next *new* conversation starts from the new
  tree (a SOUL.md edit takes effect there; running conversations keep their
  prompt).
- **Unchanged directory** (root = the row's `tree`, and the instance's store,
  if it has one, holds it): nothing is sent. A store without it (reset to a
  new genesis, or not admitted yet) gets it sent again.
- `deploy --all`: every enabled row that has a `source`.
- The row's generated `ROSTER.md` (below) is added at the tree's root, in
  memory — never written into `<dir>` — so it is part of the root: a roster
  change alone is a changed tree (objects + `head`).

**The filter.** Only what the loop uses goes in, not the code around it
(b-open-io/prompts' `.agents/<name>/` also holds `src/`, `package.json`,
`bun.lock`, `data/`, …). Default `--only SOUL.md,IDENTITY.md,skills`.
Patterns are paths from the directory's root, comma-separated, `*`/`?`
within one segment; a pattern naming a directory takes all of it;
`.git` and `node_modules` are never sent. `--only '*'` sends everything else.

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
store by the row's `tree` (read-only); empty (or absent) when nothing is
deployed or the deploy has not been admitted yet. `status` is `live` if the
instance's process, supervised by this `skein-host run`, is up, else `idle`
(so `skein-host roster`, its own process, says `idle` for every row).

### Each agent's colleagues: `ROSTER.md`

Agents know each other only from their trees (#27): each row's `knows` names
the agents its `ROSTER.md` lists, and the loop appends `/ROSTER.md` to a new
conversation's system prompt after `IDENTITY.md`. The file, generated by the
host and put at the root of the deployed tree:

```
## Colleagues

- @kurt@localhost — Kurt: Public-facing account manager for bOpen.io website visitors.
```

One line per known enabled row (in `list` order, never the agent itself;
handles with no row are skipped until one exists): `- @<handle>@<domain> —
<Name>: <Description>` from that row's IDENTITY.md — the directory being
deployed in the same command, else the row's deployed tree in its store,
else (not admitted yet) its `source` directory's; no name: the handle; no
description: no `: …`. `knows` empty: no `ROSTER.md` (a deploy removes one).

- `deploy <handle> <dir>` / `deploy --all` include it.
- `roster --deploy` refreshes rosters without the source directories: for
  every enabled deployed row it takes the row's `tree` from the instance's
  store, sets `ROSTER.md` in its root, and sends only what is new (the file
  and the root) plus `head` if the root changed; otherwise `unchanged`. Run it
  after `knows` changes, or after deploying an agent whose IDENTITY.md
  changed (its colleagues' rosters show the old name until then). A row
  whose store does not have its `tree` yet (deploy not admitted) is an
  error for that row: wait, or `deploy` its directory.

Relations for the live POC (#22's who-references-whom: Martha lists
everyone, Kurt hands off to Martha), then push the rosters:

```
bin/skein-host knows martha --all
bin/skein-host knows kurt martha
bin/skein-host roster --for martha     # check
bin/skein-host roster --for kurt
bin/skein-host roster --deploy
```

The loop reads `ROSTER.md` at the next *new* conversation — but only the
loop built with #27 does: the loop wasm was re-pinned, and a genesis names
its handlers by CID, fixed for the store's life (docs/OPEN.md items 30, 41).
An instance whose genesis predates it keeps the old loop, which ignores
`ROSTER.md`; it needs a new genesis (move its runtime.db aside, restart
`skein-host run` on this build, `deploy` again — `knows` survives in
host.db).

Two limits of the legacy layout (the `1sat serve` messagebox and per-instance wallets; neither applies to the router), not of skein:

- **The open subscription needs a grant per sender.** wallet-api has no
  any-counterparty grant, so a `chat` from an identity the instance's wallet
  has no "message encryption" grant for is refused at decryption ("permission
  denied … run `1sat permissions grant skein --protocol "message encryption"
  --level 2 --counterparty <sender>`"), logged as rejected and acknowledged.
  Provisioned instances, the owner and the infer peer are granted.
- **A reply needs the recipient's account.** The messagebox stores messages
  only for registered identities (`403 ERR_ACCOUNT_REQUIRED`). That refusal is
  permanent: the delivery reports it into the instance as a `failed` outcome
  entry and never sends it again (docs/MESSAGES.md, "Outcomes"); a `message`
  to such an agent becomes an error result for the model, an answer to such
  a sender ends the thread.

## The client

```
bin/skein whoami
bin/skein import ~/Work/easel                        # prints the root tree CID
bin/skein run --tree <cid> -- 'ls | head -3'         # prints the run message's id
bin/skein inbox --wait                               # until a result with replyTo = that id
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
  blobs first, the root tree last), `run` (`{cmd, tree: CID, cwd?, env?}`),
  and David's own `results` (`{replyTo, exitCode, stdout, stderr, tree}`).
  Bodies are dag-cbor, sent as `application/cbor` (BRC-231). No envelope and
  no encryption layer: the session proves the sender.
- `replyTo` is matched against the **message id**: the CID of the mail record
  the instance admitted, which the send's answer returns (`id`) and the
  mailbox lists as `messageId`. Sent messages are logged in
  `~/.skein/client/sent.jsonl`.

## Checking by hand

```
node --experimental-strip-types --no-warnings --test src/client/client.test.ts src/client/chat.test.ts   # on a scratch host, real kernel
bin/skein-host ledger david          # what the polls of david's mailbox cost
```
