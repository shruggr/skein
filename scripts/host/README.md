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
| messagebox host `1sat serve` | 127.0.0.1:8100, messagebox at `/messagebox` | `~/.skein/host-home` | `~/.skein/host.env` | `~/.skein/logs/messagebox.log` |

Files the scripts write for the client and the runtime:

- `~/.skein/instance.identity`, `~/.skein/owner.identity`, `~/.skein/infer.identity`, `~/.skein/host.identity` — public keys, one line each
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
- `replyTo` is matched against the **envelope CID**: CIDv1, dag-cbor codec,
  sha2-256 of `dagCbor.encode(envelope)` where `envelope` is the JSON object
  exactly as sent (`envelopeCid` in `src/client/client.ts`). Sent envelopes are
  logged in `~/.skein/client/sent.jsonl`.

## Checking by hand

```
node --experimental-strip-types --no-warnings --test src/client/client.test.ts   # includes a live messagebox round trip
sqlite3 ~/.skein/host-home/.1sat/cli/data/messagebox-main.db 'select messageBoxId, count(*) from messages group by 1'
```
