# The browser client (`web/`)

The CLI client (`bin/skein`, src/client) as one page, signing with David's own
wallet — the Yours browser extension — instead of the dev owner wallet-api.
Same boxes, same envelopes, same bodies (src/client/README.md, docs/MESSAGES.md).

```
scripts/host/web.sh --bg        # build web/dist, serve http://localhost:4400 (log ~/.skein/logs/web.log)
npm run web:build               # just the bundle + web/dist/config.json
npm run web:test                # tree hashing, bundling, envelope round trips (the live one needs the messagebox)
```

**Origin: `http://localhost:4400`.** Always open exactly this (not 127.0.0.1,
not another port): Yours keeps its grants per origin.

## How it gets the wallet

`@1sat/connect`'s `connectWallet` with its BRC-100 auto-detect —
`new WalletClient('auto')` from `@bsv/sdk`, which prefers `window.CWI` (the
extension) over the localhost substrates — wrapped as a provider so the reason
for a failure is shown instead of a bare "no wallet". The identity key it
reports is checked against David's Yours key
(`033212a7…cd59e`, `SKEIN_YOURS_IDENTITY` overrides at build time); anything
else is flagged in red. Note that without the extension `'auto'` also tries
`http://localhost:3321`, the instance's own wallet-api: the page would then
show the instance key and the mismatch warning.

`web/dist/config.json` is written at build from the same sources as the CLI's
`loadConfig` (`~/.skein/instance.identity`, `~/.skein/messagebox.url`,
`SKEIN_*` env): the instance `skein@localhost`, messagebox
`http://127.0.0.1:8100/messagebox`, host `http://127.0.0.1:8100`.

## What the wallet will be asked for

These are the BRC-100 calls the page makes; how Yours groups them into prompts
is up to Yours (untested here — approve and note what it actually shows):

| when | call | protocol / key |
|---|---|---|
| Connect | `getPublicKey({identityKey})`, `waitForAuthentication` | identity key retrieval; the connection itself |
| every send (seal) | `encrypt` | `[2, "message encryption"]`, keyID random, counterparty = the instance |
| every send (seal) | `createSignature` | `[2, "metanet handles envelope"]`, keyID `1`, counterparty `anyone` |
| every reply read (open) | `decrypt` | `[2, "message encryption"]`, counterparty = the instance |
| Register, and every messagebox call (BRC-104 via AuthFetch) | `createHmac`/`verifyHmac`, `createSignature`/`verifySignature` | `[2, "server hmac"]` counterparty self; `[2, "auth message signature"]` counterparty = the host |
| every send | `createHmac` | `[1, "messagebox"]` (the message id) |

The same set `scripts/host/grants.sh` grants the dev owner wallet (origin
`skein-client`). Approving them "for this site" / "always" avoids a prompt per
message; the inbox polls every 2 s, so a denied permission stops polling (tick
"poll" to resume) instead of prompting forever. Every error is shown verbatim.

## A first chat

1. `scripts/host/up.sh` (host, wallets), the runtime running, then
   `scripts/host/web.sh --bg`.
2. Open `http://localhost:4400` in the browser that has Yours. Click
   **Connect wallet**; approve the connection in Yours. The identity line must
   read `033212a7…cd59e` (no red warning).
3. **Register** (username defaults to `u-<first 8 hex of the identity key>`,
   so it doesn't collide with someone else's name; any free name — `david` is
   the dev owner's). Approve the auth prompts. `HTTP 200` or `409 … already
   registered` are both fine; `409 … taken` means pick another name.
4. Optional: **Choose Files** → pick a directory → **Import**. The root CID
   lands in the chat and run tree fields.
5. Type in **Chat**, **Send** (approve encrypt + signature). The say arrives in
   **Inbox** within a couple of seconds of the instance answering (approve
   decrypt). The next chat replies to it (`replyTo` = that say, tree defaults to
   its tree); tick **new conversation** to start over.
6. **Run**: a tree CID and a command; the result shows in the inbox.

## Before the instance will answer this identity

The running instance was created with the dev owner key (`SKEIN_OWNER` =
`~/.skein/owner.identity`) in its genesis, and its wallet may only encrypt to
that key (and infer). For it to accept and answer the Yours identity, the host
side needs (not done by this page): the instance wallet granted
`message encryption` level 2 with counterparty `033212a7…cd59e`, and the
Yours key as the instance's owner (a new genesis with
`SKEIN_OWNER=033212a7…cd59e`, or however ownership gets added).

## Differences from the CLI

- File modes: the picker cannot see them, so every file imports as `100644`
  (the CLI writes `100755` for executables) and symlinks are followed (the CLI
  stores them as `120000`). A tree with either hashes differently from
  `skein import` of the same directory. `.git` and `node_modules` are skipped as
  in the CLI; empty directories vanish in both.
- State lives in localStorage (conversation, last sent chat/run, the last 100
  inbox messages) instead of `~/.skein/client`.
- The shared modules (src/envelope.ts, src/runtime/identity.ts,
  src/client/{bundle,conversation}.ts) are bundled unchanged; node-only imports
  are mapped to `web/shims` (node:crypto → @bsv/sdk hashes + getRandomValues,
  node:fs/path → stubs never reached, `Buffer` → the `buffer` package with
  node's Uint8Array-accepting `equals`/`compare`). `web/envelope.test.ts` runs
  the bundled code against the node code.
