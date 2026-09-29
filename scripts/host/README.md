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
| router `bin/skein-host run` | 127.0.0.1:8100 (and ::1), host page 127.0.0.1:4600, explorers 4610+ | the reverse proxy (#40): each instance is an HTTP server, its front door, at `http://<handle>.localhost:8100` (or `http://127.0.0.1:8100/@<handle>`); each instance's kernel started on demand (`skein-kernel serve`; not stopped when idle unless `SKEIN_IDLE_MS` is set), the waker, the oracle (instance keys from `~/.skein/master.key`), the fuel ledger, the instances' feeds (SSE headers, ARC callbacks at `/callback/<handle>`), the libp2p host (#51: a node per instance whose config declares `libp2p`, below) | `~/.skein/logs/host.log` |
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

A request for an instance is one kernel `call` of its front door
(`programs/frontdoor`): BRC-103/104 against the instance's in-memory session
table, the routes table, the handler, the signed answer. The entries it
returns (a message, an acknowledgement) are admitted; a handshake and a read
— a poll, a lookup, the explorer — write nothing. Its
fuel is charged to the **fuel ledger** (host.db `fuel_ledger`, by instance,
caller and route; `skein-host ledger [handle]`).

The router's own endpoints:

| | |
|---|---|
| `GET /manifest.json` | BRC-169: `metanet.handles.resolve` |
| `GET /.well-known/metanet-handles/resolve?handle=<h>@<d>` | `{handle, domain, identityKey, messagebox}`: an agent's own identity and origin; for a mailbox instance, its owner's key and the instance's origin |
| `GET /bsvalias/id/<handle>@<domain>` | paymail PKI (identity keys by handle) |
| `POST /account/register {username, identityKey, signature}` | a mailbox instance for that identity: the signature by its own wallet, protocol `[2, "skein register"]`, key ID the username, counterparty anyone, over `register <username>` → `{identityKey, username, handle, messagebox}` (409 if the name is taken) |
| `POST /callback/<handle>` | ARC's status callback (an `arc-callback` feed) |

The instances' outbound http (a messagebox delivering, a resolve) comes back
through the router: a URL of this host's is answered in process (the same
path, no socket), any other goes out (`SKEIN_HTTP=fetch`). Every delivery
(a `POST …/sendMessage`) is one line in `host.log`, so a lost reply shows
where it went and what came back:

```
[martha] deliver chat for 8f98ef7c → http://david.localhost:8100/sendMessage (local): 200 delivered
[martha] deliver chat for 79d35eb2 → https://other.host/sendMessage (remote): HTTP 503 down for a moment
[martha] deliver chat for 79d35eb2 → https://other.host/sendMessage (remote): failed: fetch failed
```

### The address book: `skein-host peers`

Where an agent delivers to a key — its answers, its `message` tool — is its
address book (head `peers`: key → mailbox URL, handle optional;
docs/MESSAGES.md, "The address book"). It is configuration: the admin writes
it through the agent's `peers` box as the owner, like `subscribe`.

```
bin/skein-host peers martha add <key> <mailbox-url> [--handle bob@example.com]
bin/skein-host peers martha remove <key>
bin/skein-host peers martha list        # key, mailbox URL, handle@domain, source (admin | resolve)
```

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
- `~/.skein/owner.identity`, `~/.skein/owner-dev.identity`, `~/.skein/infer.identity` — public keys, one line each. `owner.identity` is the *configured* owner (a genesis's `owner`) and is written once; `owner-dev.identity` is the owner wallet's (3322).
- `~/.skein/infer.json` — the inference peer's providers (written if absent).
- `~/.skein/mailbox.url` — the owner's mailbox instance, `http://127.0.0.1:8100/@david` (`up.sh`): where `bin/skein` reads.
- `~/.skein/host.db` — the instances (identity → store; `kind` agent or mailbox, a mailbox's `owner`) and the fuel ledger (`skein-host list`, `skein-host mailboxes`, `skein-host ledger`).

Sessions are not state (#40): a handshake writes nothing. The session lives
in memory with the instance's kernel process (the router holds the table
beside the process and passes it to the front door, which alone reads it);
every later request is verified against it, and writes nothing. Sessions
expire by the instance's `defaults.sessionTtlMs` (a day) from the in-memory
record's stamp; an unknown or expired one is a plain 401, and the stock
client shakes hands again by itself. A restarted router or kernel starts
with no sessions: each client's next request costs one extra round trip.
Instances are not stopped when idle (`SKEIN_IDLE_MS` default 0: never);
they will be once resource contention appears, and the session table would
be cached out then. `SKEIN_IDLE_MS=<ms>` turns the idle stop on (a stopped
instance's clients re-handshake). **Switching a live stack**: stores
from before #40 (log format 2) are refused; they need a new genesis
(`skein-host add <h> --derive` with a new `--store`).

Feeds: an instance's `etc/config.json` may declare `feeds: [{kind:
"headers", url, box?}, {kind: "arc-callback", box?, token?}]` (the genesis
carries them): the router holds the SSE connection (reconnecting with
backoff, at most 1000 items queued per instance) and takes ARC's callbacks
at `POST http://127.0.0.1:8100/callback/<handle>` (with `Authorization:
Bearer <token>` when a token is set), admitting `header` / `status` entries
into the box (default `chain`).

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
`subscribe` and the roster work the same against the router, speaking raw
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

`up.sh` sets up the one instance `skein-runtime` runs. For many instances
(`bin/skein-host run`, a supervisor running one `skein-runtime` process per
instance: src/host/supervisor.ts), each is a row in the host's management
database, `~/.skein/host.db` (src/host/instances.ts):

| column | |
|---|---|
| `handle` | primary key; the messagebox account and the genesis's `handle`, e.g. `martha` |
| `domain` | default `localhost` |
| `identity` | the instance wallet's identity key; written by `instance.sh`, or by `run` the first time it starts the row |
| `wallet_url`, `wallet_originator` | its BRC-100 endpoint, origin (default `skein`) |
| `store` | its runtime.db (default `~/.skein/instances/<handle>/runtime.db`) |
| `tree` | the root CID of the directory last deployed into it (`skein-host deploy`) |
| `source` | that directory, which `deploy --all` sends again |
| `knows` | JSON array of the handles its `ROSTER.md` lists (`skein-host knows`); `["*"]`: every other enabled row; NULL: none, no `ROSTER.md` |
| `status` | `enabled` / `disabled` |
| `created_at` | ISO time |

```
scripts/host/instance.sh <handle>     # provision one: idempotent
bin/skein-host add <handle> [--domain d] [--identity hex] [--wallet-url url] [--originator o] [--store path] [--tree cid] [--knows a,b|*] [--disabled]
bin/skein-host knows <handle> [a,b | --all | --none]   # who its ROSTER.md lists; no list: print it
bin/skein-host list | enable <handle> | disable <handle> | remove <handle>   # remove leaves the store and wallet
bin/skein-host run [--only a,b]       # one process per enabled row (or those), the host page and roster, an explorer each
bin/skein-host deploy <handle> <dir> [--only glob,glob]
bin/skein-host deploy --all [--only glob,glob]   # every enabled row, from its `source`
bin/skein-host roster                 # the roster JSON, printed
bin/skein-host roster --for <handle>  # that agent's ROSTER.md, printed
bin/skein-host roster --deploy        # redeploy every enabled row whose ROSTER.md changed
```

`instance.sh <handle>` does for one instance what `up.sh` does for the single
one: a key (`~/.skein/instances/<handle>/wallet.env`), a `1sat serve
wallet-api` under `HOME=~/.skein/instances/<handle>/home` on the next free
port from `SKEIN_INSTANCE_PORT` (default 3401; kept in `wallet.port`, reused
on the next run; log `~/.skein/logs/wallet-<handle>.log`), the grants below,
its account on the messagebox (`register.ts`) and its row (`skein-host add`).
It needs the messagebox and `host.identity`/`owner.identity` from `up.sh`.

Grants, origin `skein`, in the instance's wallet: `grants.sh`'s instance set
(identity key retrieval, server hmac, auth message signature with the
messagebox host, messagebox, metanet handles envelope to anyone, message
encryption with the owner and the infer peer), plus message encryption with
every other provisioned instance and, in each of theirs, with this one, so
the roster can message itself. The infer peer's and the dev owner's wallets
get message encryption with the new instance, as `grants.sh` does.

### Running them: `skein-host run`

`skein-host run` is a **supervisor**: for each enabled row (`--only a,b`:
just those; a disabled or unknown handle is said and skipped) it spawns one
`bin/skein-runtime` — the same entry point and kernel configuration
(src/host/main.ts) as a single instance — with the row in its environment:

| variable | from the row |
|---|---|
| `SKEIN_DB` | `store` |
| `SKEIN_HANDLE` | `handle@domain` |
| `SKEIN_WALLET_URL`, `SKEIN_WALLET_ORIGINATOR` | `wallet_url`, `wallet_originator` |
| `SKEIN_IDENTITY` | `identity` (the child refuses a wallet that is not it) |
| `SKEIN_HOST_DB` | `~/.skein/host.db`, which the child opens read-only for its resolver |

and everything else from its own environment, which it reads as
`skein-runtime` does (`SKEIN_OWNER`, `SKEIN_INFER`, `SKEIN_MESSAGEBOX`,
`SKEIN_HOST_WALLET_URL`, `SKEIN_POLL_MS`, `SKEIN_SEND_ATTEMPTS`,
`SKEIN_SEND_BACKOFF_MS`, `SKEIN_WALLET=ephemeral`; `bin/skein-host` fills the
first three from `~/.skein`). A row with no `wallet_url` is not started
(unless ephemeral).

Each child installs the modules into its store, writes a genesis if the
store is empty (`handle`/`domain` from the row; the seed subscriptions: the
owner's `run`, `objects`, `head`, `chat`, `subscribe`, then `chat` from any
sender → loop; `collect`: `completions`; `names`: the owner as
`SKEIN_OWNER_HANDLE`, the infer peer as `SKEIN_INFER_HANDLE`), connects the
row's wallet, and wires its own messagebox delivery (its own BRC-104
session), tick and resolver. It prints `skein runtime <identity> (<handle>@<domain>) …`
when it is up: the supervisor then calls it `live`, records the identity in
the row if the row had none (not for ephemeral wallets), and starts its
explorer. The host wallet signs every entry of every instance; host.db, the
host wallet and the messagebox are all the instances share — nothing of one
runs in another's process, or in the supervisor's.

- **Lines**: every line a child writes, stdout or stderr, is the
  supervisor's, prefixed `[handle]` (`[handle explore]` for its explorer).
- **Restarts**: a child that exits (a crash, a wallet that is down, an
  identity or host mismatch — the child logs why) is started again after 1 s,
  doubling to at most 60 s; one that ran 30 s or more starts again at 1 s.
- **Stopping**: SIGINT/SIGTERM stops restarting and sends every child
  SIGTERM (SIGKILL after 10 s); each stops its runtime cleanly. A child
  whose supervisor is killed stops by itself (its IPC channel closes).
- **Ephemeral** (`SKEIN_WALLET=ephemeral`): every child makes its own
  throwaway keys, host key included, each time it starts; a restarted child
  cannot continue its store ("not this instance's host"). For tests and
  trials only.

**Ports** (127.0.0.1):

| | |
|---|---|
| `SKEIN_HOST_PORT` (default 4600) | `/`: the host page; `/roster.json`: the roster |
| `SKEIN_EXPLORE_BASE_PORT` (default 4610; `off`: none) | row *i*'s explorer on base + *i*, *i* its place among the enabled rows (`list` order), so a row keeps its port whatever `--only` says |

**The host page** (`http://127.0.0.1:4600/`, read-only, #23 "Host
explorer"): one line per enabled instance — handle, identity, status
(`live`, `idle`, or `not run` under `--only`), pid and restarts, store path,
deployed tree — and a link to its explorer: `bin/skein-explore <port>` over
the row's store, read-only (src/dev/explore, unchanged), started by the
supervisor once the row is live and supervised like it. This is the host
operator's view, not the end-user UI.

The instances' programs seal what they send themselves — sign and encrypt
through the instance wallet, inside the step — so the delivery sends bytes;
it uses the instance wallet only for its messagebox session and to decrypt
what arrives. Handles the programs `resolve` are looked up in host.db, then
by BRC-169 at the domain (`<origin>/manifest.json`; if it publishes
`metanet.handles`, its resolve endpoint, the handle certificate checked
against `metanet.trust.publicKey`), then, last, at the paymail PKI
(`/bsvalias/id/<handle>@<domain>`). The origin is the messagebox's
(`SKEIN_MESSAGEBOX`). The local `1sat serve` publishes `metanet.trust` but no
`metanet.handles` (and its `/.well-known/metanet-handles/*` answers 401), so
here a handle that is not a row resolves by paymail. The recorded answer is
the whole response (`docs/MESSAGES.md`, "Resolution").

### Changing an instance's subscriptions: `skein-host subscribe`

The genesis carries only the seed of an instance's subscriptions; the
routing table is a chain in the instance (docs/VM.md, "Subscriptions"), so a
change is a message, not a new genesis. `skein-host subscribe <handle>
add|remove [--sender <key>] <box> <handler>` sends one `subscribe` envelope
`{op, sender?, box, handler}` to the row's instance as the owner, through the
owner's wallet and messagebox exactly as `deploy` does (same checks, same
queueing). `<handler>` is a built-in program's name (`loop`, `run-handler`,
…) or a program record's CID (registering a program: its record and module
go in through `objects` first). No reply; the change shows on the
explorer's `/s` and in the log (`[handle] … subscribe-handler step 1 →
finished · 1 subscription change`). Nothing in host.db maps to rules yet
(`knows` is only ROSTER.md), so nothing sends these automatically.

```
bin/skein-host subscribe martha add --sender <key> run run-handler
bin/skein-host subscribe martha remove --sender <key> run run-handler
```

**Stores from before the chain** (genesis written before #3) have no
subscriptions chain: the runtime refuses to start them ("predates the
subscriptions chain … it needs a new genesis"). Move the runtime.db aside,
restart `skein-host run` on this build, and `deploy` again; host.db is
untouched.

### Deploying an agent: `skein-host deploy`

Genesis is only the core image; the agent's personality arrives as a
message (#23, "Deployment via `objects`"). `skein-host deploy <handle> <dir>`
does what `bin/skein import` does, for the row's instance: it hashes `<dir>`
into git objects, sends them in ≤ 1 MiB bundles to the instance's `objects`
box (blobs, then trees, the root tree on the last bundle), and records the
root CID as the row's `tree` and `<dir>` as its `source`. Each envelope is
signed and encrypted by the **owner** — the identity the genesis subscribes
to `objects` and `head` — through the owner's wallet as `bin/skein` does
(`SKEIN_OWNER_WALLET`, default http://127.0.0.1:3322, origin
`SKEIN_ORIGINATOR`, default `skein-client`); it refuses if that wallet is not
`SKEIN_OWNER` or not the store's genesis owner. The messagebox queues the
envelopes; the instance admits them as host-signed entries when its delivery
polls, so the instance need not be running.

- **First deploy**: objects-handler makes the root `main` (there is none yet).
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
