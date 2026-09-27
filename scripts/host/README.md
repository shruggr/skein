# Host setup on David's machine

What runs where so the client (`bin/skein`) can reach an instance through a
messagebox (docs/MESSAGES.md). Everything here is dev-only: the keys are
throwaway, generated on this machine, and hold no funds.

```
scripts/host/up.sh      # all of it, idempotent: wallets, messagebox, grants, accounts
```

| process | address | HOME | key | log |
|---|---|---|---|---|
| instance wallet `1sat serve wallet-api` | 127.0.0.1:3321 | `$HOME` (`~/.1sat/cli`) | `~/.skein/dev-wallet.env` | `~/.skein/logs/wallet-instance.log` |
| owner (David) wallet `1sat serve wallet-api` | 127.0.0.1:3322 | `~/.skein/owner-home` | `~/.skein/owner-wallet.env` | `~/.skein/logs/wallet-owner.log` |
| infer peer wallet `1sat serve wallet-api` | 127.0.0.1:3323 | `~/.skein/infer-home` | `~/.skein/infer-wallet.env` | `~/.skein/logs/wallet-infer.log` |
| host wallet `1sat serve wallet-api` (signs log entries) | 127.0.0.1:3324 | `~/.skein/host-wallet-home` | `~/.skein/host-wallet.env` | `~/.skein/logs/wallet-host.log` |
| messagebox host `1sat serve` | 127.0.0.1:8100, messagebox at `/messagebox` | `~/.skein/host-home` | `~/.skein/host.env` | `~/.skein/logs/messagebox.log` |

Files the scripts write for the client and the runtime:

- `~/.skein/instance.identity`, `~/.skein/owner.identity`, `~/.skein/owner-dev.identity`, `~/.skein/infer.identity`, `~/.skein/host-wallet.identity`, `~/.skein/host.identity` (the messagebox's) — public keys, one line each. `owner.identity` is the *configured* owner (a genesis's `owner`) and is written once, kept after; `owner-dev.identity` is always the owner wallet's (3322) own key, so `up.sh` can tell whether they're the same wallet.
- `~/.skein/infer.json` — the inference peer's providers, `{"ripper": {"baseUrl": "http://100.100.177.87:8001/v1", "apiKey": "vllm"}}` (written if absent)
- `~/.skein/messagebox.url` — `http://127.0.0.1:8100/messagebox`
- `~/.skein/*.env` — `PRIVATE_KEY_WIF=…`, mode 0600, created by `genkey.ts` only if absent. Never printed, never committed.

## The messagebox

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

`up.sh` sets up the one instance `skein-runtime` runs. For many instances in
one process (`bin/skein-host run`, src/host/host.ts), each is a row in the
host's management database, `~/.skein/host.db` (src/host/instances.ts):

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
bin/skein-host run                    # every enabled row, and the roster server
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

`skein-host run` reads the environment as `skein-runtime` does
(`SKEIN_OWNER`, `SKEIN_INFER`, `SKEIN_MESSAGEBOX`, `SKEIN_HOST_WALLET_URL`,
`SKEIN_POLL_MS`, `SKEIN_WALLET=ephemeral`; `bin/skein-host` fills the first
three from `~/.skein`). For each enabled row it installs the modules into the
store, writes a genesis if the store is empty (`handle`/`domain` from the row;
the seed subscriptions: the owner's `run`, `objects`, `head`, `chat`,
`subscribe`, then `chat` from any sender → loop; `collect`: `completions`; `names`: the owner as
`SKEIN_OWNER_HANDLE`, the infer peer as `SKEIN_INFER_HANDLE`), connects the
row's wallet, and wires its own messagebox delivery (its own BRC-104 session)
and tick. The host wallet signs every entry of every instance. A row that
fails (wallet down, identity or host mismatch) is logged and skipped.

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
instance runs in this host process, else `idle` (so `skein-host roster`,
its own process, says `idle` for every row).

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

Two limits of the dev wallets and messagebox, not of skein:

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
bin/skein run --tree <cid> -- 'ls | head -3'         # prints the run envelope's CID
bin/skein inbox --wait                               # until a result with replyTo = that CID
```

- Wallet: `HTTPWalletJSON('skein-client', http://127.0.0.1:3322)`. Override
  with `SKEIN_OWNER_WALLET`, `SKEIN_MESSAGEBOX`, `SKEIN_INSTANCE_IDENTITY`,
  `SKEIN_INSTANCE_HANDLE` (default `skein@localhost`), `SKEIN_HOME`.
- Boxes: `objects` (bundles `{records: [{cid, bytes}]}`, dag-cbor, ≤ 1 MiB;
  blobs first, the root tree last), `run` (`{cmd, tree: CID, cwd?, env?}`),
  and David's own `results` (`{replyTo, exitCode, stdout, stderr, tree}`).
  All sent with `skipEncryption: true`: the envelope's BRC-78 `content` is the
  encryption.
- `replyTo` is matched against the **envelope CID** (the message id): CIDv1,
  dag-cbor codec, sha2-256 of `dagCbor.encode(signed)` where `signed` is the
  JSON object as sent without `content` (`envelopeCid` in
  `src/client/client.ts`). Sent envelopes are logged in
  `~/.skein/client/sent.jsonl`.

## Checking by hand

```
node --experimental-strip-types --no-warnings --test src/client/client.test.ts   # includes a live messagebox round trip
sqlite3 ~/.skein/host-home/.1sat/cli/data/messagebox-main.db 'select messageBoxId, count(*) from messages group by 1'
```
