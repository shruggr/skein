# skein-site

The management site of a [skein](https://github.com/shruggr/skein): the page
every skein from the default image serves at `/` (its files at `/site/`).
The files are the same on every skein; what makes the page yours is the
wallet in your browser. Version **0.2.1** (shruggr/skein#92; the Inbox, #99).

## What it does

- **Connect a wallet.** Any BRC-100 wallet the browser reaches (Yours, or
  another, through `@1sat/connect` over `@bsv/sdk`'s `WalletClient`). Every
  request the page makes to a skein is signed by it on a BRC-104 session.
- **Your skeins (locators).** A locator is an output in your own wallet, in
  basket `skein-locators`: a PushDrop token (`@bsv/sdk`'s template, protocol
  `[1, "skein locator"]`, key id `1`, counterparty `self`) whose fields are
  the skein's identity key (33 bytes), its URL and a handle. The page lists
  the basket, and for each skein talks to that skein directly: the skein that
  served the page is never in the path. Anyone may keep a locator for any
  skein (a bookmark); what it resolves to is what your key may do there.
  Add one by URL (the identity is taken from the skein's signed answer);
  remove one (the wallet relinquishes the output).
- **Create a skein** (on a host skein, where the onboarding app is
  installed): `POST /onboard/call {fn: "onboard.create", args: {handle}}` on
  your session; the answer `{handle, identity, url}`; the page writes a
  locator and opens the new skein.
- **A skein's page.** Its apps (the heads `<app>/app`), read from its
  explorer (`/explore`, a read the owner may make). **Install**: the
  catalog (`catalog.json`: our apps as a repository URL and a commit id) or
  any URL and commit id. The git app comes first, from the tree a skein of
  the default image carries (`apps/git`); then each install is one message
  to the git app's box, `{fn: "git.clone", args: {url, hash}}`, its answer
  `{tree, app}` read from the thread that message launched; the manifest is
  read out of the stored tree, the app record rebuilt in the page (skein's
  own install plan, `src/host/plan.ts`) and checked against the git app's,
  and the rows it asks for are shown resolved against this skein. On your
  approval the page sends the head, the dispatch rows and the start, signed
  by you. **Uninstall**: the stop, then its rows removed. **Address book**:
  entries added or removed by a `peers` message you approve.
- **Explorer**: the log, threads, a thread, any record (git trees
  browsable), what points at a record (edges), the dispatch table.
- **On a host skein**: the skeins created there (`onboard/instances/…`),
  each openable through a locator.
- **The Inbox** (`#/inbox`): a mailbox's box for your key — any BRC-33
  messagebox, such as your mailbox instance on a skein host. Give it the
  mailbox's URL and a box (default `metanet_inbox`); the page lists what is
  waiting there (`@bsv/message-box-client`'s `listMessagesLite`, on a
  BRC-104 session signed by your wallet). **Sync** runs `@1sat/actions`'
  `syncMetanetInbox` with the same wallet against that URL. It always reads
  `metanet_inbox` (the box field is for List only): each BRC-169 envelope
  there is opened (signature, decryption, content hash), its payment
  internalized into your wallet, then acknowledged. The page shows a row per
  message received (txid, sats, memo, sender) and a row per message left in
  the box with the SDK's reason, the SDK's `error` if it set one, and then
  lists the box again. There is no lookup from a key to its mailbox (a
  BRC-169 resolver answers a handle), so the URL is typed once and kept in
  this browser (`localStorage`, per identity key).

## Files

| file | what |
|---|---|
| `index.html`, `app.js`, `style.css` | the page: plain HTML and JavaScript, no framework |
| `catalog.json` | the apps the page offers |
| `lib.js`, `chunk-*.js` | the libraries, one esbuild bundle (`lib/entry.ts`): skein's BRC-104 client (`src/client/raw.ts`) and install plan, `@1sat/connect`, `@bsv/sdk`, `@bsv/message-box-client`, `@1sat/actions`' `syncMetanetInbox` (its module only), `@ipld/dag-cbor`, `@ipld/dag-json` |
| `webwallet.js` | `@1sat/wallet-browser`'s `createWebWallet`, loaded only in test mode |
| `lib/entry.ts`, `lib/webwallet.ts`, `build.mjs`, `lib/SKEIN_REV` | how the bundles are made, and the skein commit they are made from |

Test mode: `?key=<private key hex>` runs a wallet in the tab over that key
instead of connecting one, and `&services=<url>` points it at a 1sat
services endpoint (skein's `kernel-zig/equiv/site.ts` drives the page this way).

## Build

```
npm ci
SKEIN_DIR=../skein node build.mjs     # a skein checkout at lib/SKEIN_REV, with its web/shims
```

The chunks' names hash the modules' paths, so the same bytes come out only
with the skein checkout at `../skein` as above. The bundles are committed:
the site is served as the tree is. A skein's
default image carries a copy of this tree under `images/default/www`, the
same git tree as this repository's tag.
