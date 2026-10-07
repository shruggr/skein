# skein-site

The management site of a [skein](https://github.com/shruggr/skein), as an
app (shruggr/skein#125): installed in a skein, it serves the page at
`/site/`, and at `/` by root's own route (the default image has it; below). The files are
the same everywhere; what makes the page yours is the wallet in your
browser. A skein from the default image serves nothing until something is
installed: the host's own skein carries this app, installed by the host's
operator (root), and you manage your skeins from there, the page talking to
each one directly. Version **0.9.0** (shruggr/skein#92; the Inbox, #99;
handles, #103; profiles and search, #104; the wallet's grouped request, #97;
an app, #125; the signed claim, shruggr/skein#127; routes, filters and
roles, shruggr/skein#143).

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
  installed): your wallet signs the new skein's claim (skein's `signClaim`:
  a message naming no recipient; the kernel grants root to its sender, #127, #143), and
  `POST /onboard/call {fn: "onboard.create", args: {handle, claim}}` (as
  DAG-JSON) on your session; the answer `{handle, identity, url}`; the page writes a
  locator and opens the new skein's view here (a new skein serves no page:
  it is managed from this one).
- **A skein's page.** Its apps (the heads `<app>/app`), read from its
  explorer (`/explore`, root's). **Install** (root's: the page says so when
  your key does not hold root): the catalog (`catalog.json`: our apps as a
  repository URL and a commit id) or any URL and commit id. The git app
  comes first, from the tree a skein of the default image carries
  (`apps/git`); then each install is one message to the git app's box,
  `{fn: "git.clone", args: {url, hash}}` (its function gated by root), its
  answer `{tree, app}` read from the thread that message launched; the
  manifest is read out of the stored tree, the app record rebuilt in the
  page (skein's own install plan, `src/host/plan.ts` `planInstall`) and
  checked against the git app's, and its routes (each resolved by skein's
  `wiring`: transport, address as served, filters, handler), its filters
  and its roles are shown. On your approval the page sends the objects, the
  head, the routes and the start, signed by you. The install grants
  nothing: you are root (shruggr/skein#143). **Uninstall**: the stop, then
  its routes removed; its data and its roles' grants stay. **An app's
  page**: its routes as the table holds them (the ones its manifest asks
  for that are missing marked; installing it again restores them) and its
  **roles** — `root`, `user` and the app's own (`<app>.<role>`), each with
  the functions it gates (the app record's `roles`) and its holders (the
  kernel's head `grants`, `{kind: "grants", roles: {<role>: [<key>…]}}`).
  Root grants a role to a key (yours, a contact's, or one typed) and
  revokes it, each one `grant` message `{op: "add" | "remove", role,
  principal}` you approve; `user` is any signed-in key and is never
  granted; the last root holder cannot be revoked here. **From a
  repository**: a github.com URL lists its tags and its default branch's
  head (GitHub's public API, unsigned), else the commit id is typed.
  **Contacts** (the address book): a handle resolved at its domain and
  added (`handle` and `domain` apart, as the address book keeps them), or a
  key and mailbox URL; removed, each by a `peers` message you approve.
- **Explorer**: the log, threads, a thread, any record (git trees
  browsable), what points at a record (edges), the routes (transport,
  address, filters, handler, whose).
- **On a host skein**: the skeins created there (`onboard/instances/…`),
  each openable through a locator.
- **Your handles; register one** (on a skein a skein host runs). The page
  finds the host's router through `/.well-known/skein-host` (the router
  answers it at every skein's origin: `{origin, domain}`) and reads its
  BRC-169 manifest there (`metanet.trust.publicKey`, the certifier key;
  `metanet.handles.resolve`). **Register a handle**: your wallet signs
  `register <name>@<domain>` (the domain lower case; protocol
  `[2, "skein register"]`, key id the name,
  counterparty anyone); `POST <router>/account/register`, over your wallet's
  BRC-104 session with the router's origin (shruggr/skein#135), creates your
  mailbox instance, `<name>@<domain>`, and answers with the BRC-52 handle
  certificate issued for your key (encrypted fields and a keyring for you);
  the wallet keeps it: `acquireCertificate` with `acquisitionProtocol:
  "direct"`, `keyringRevealer: "certifier"` (skipped when the wallet holds
  that serial number already). **Your handles**: `listCertificates` for that
  certifier and the BRC-169 handle type; each certificate checked (your key,
  its signature, the certifier the domain's manifest names), its fields
  decrypted with the keyring the wallet keeps (`@bsv/sdk`'s
  `MasterCertificate.decryptFields`), and resolved to its messagebox.
- **Your profile** (shruggr/skein#104). Each of your handles has a Profile
  form: a name and an avatar, an image inscription's outpoint (`txid_vout`
  or `txid.vout`). The page builds the OpNS profile record (`@1sat/utils`'
  `encodeProfile`: DAG-CBOR `{domain, name?, avatar?}`, the avatar as its 36
  bytes), your wallet signs it (`createSignature`, protocol
  `[1, "metanet handles profile"]`, key id `1`, counterparty anyone), and
  the page posts `{handle, record: <base64 of the bytes>, signature: <hex
  DER>}` to `POST <router>/account/profile`; the host's onboarding app keeps
  it and serves it in the handle's resolve answer (`profile`, with
  `displayName` and `avatarURL` derived for other clients).
- **Handles shown** (BRC-169 §2.4): the avatar, or an identicon drawn from
  the identity key, then `handle@domain`. A profile whose signature the page
  verifies against the handle's identity key (and whose domain is the
  handle's) is shown as signed by its key; the host's `displayName` and
  `avatarURL` are shown only without one, marked unattested.
- **Find a handle** (BRC-169 §5.6): the search endpoint the host's
  manifest names (`metanet.handles.search`), asked on an explicit Search
  (nothing is sent as you type; one query at a time), this page's host
  only. Results are hints; each result's profile is verified as above.
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
  lists the box again. The URL: the one you typed last (kept in this
  browser, `localStorage`, per identity key), else the messagebox your first
  handle resolves to (Your handles).

## The wallet's grouped request (`manifest.json`)

A BRC-100 wallet that seeks grouped permission (wallet-toolbox's
`WalletPermissionsManager`, `seekGroupedPermission`) reads
`<origin>/manifest.json` of the page's origin (shruggr/skein#97). The app
serves it at `/site/manifest.json`; at the origin's `/manifest.json` only
with root's route at `/` (below), and a host's router may answer that path
itself. It asks once, under `metanet`, for:

- `groupPermissions`, granted together on the first call: the protocols
  `[1, "identity key retrieval"]`, `[2, "server hmac"]` (self), `[1, "skein
  locator"]`, `[2, "skein register"]` (anyone), `[1, "certificate
  acquisition <the BRC-169 handle type>"]`, `[1, "certificate list"]`,
  `[1, "metanet handles profile"]`; and the basket `skein-locators`. No
  spending allowance: a locator's spend (1 sat and its fee) is asked for
  when it happens.
  `[2, "auth message signature"]` is listed without a counterparty, which
  the toolbox leaves out of the first group: for a wallet without a
  counterparty prompt it is asked per skein instead.
- `counterpartyPermissions`, asked once per new counterparty (the first
  level-2 call to a key the wallet has no grant for): `auth message
  signature` (a BRC-104 session with that skein) and `certificate field
  encryption` (reading the handle certificates a host's certifier issued
  you). No counterparty keys are named: every skein and every certifier
  costs one first-contact prompt.

Not in it: the Inbox's calls. Sync decrypts each envelope under
`[2, "message encryption"]` with its sender as counterparty (any key) and
internalizes the payment with the label `metanet payment` (`[1, "action
label metanet payment"]`); a BRC-232 delivery brings its sender's labels
and baskets. The wallet asks for those as they come.

## The app

```
etc/app.json      the manifest (skein docs/APPS.md §2)
bin/site.wasm     the one program: a read route's filter (Zig, WASI preview1; src/main.zig), built by `zig build bin`
bin/site.json     its program record's description
www/              the page, served as it is in the tree
src/, build.zig, build.zig.zon, lib/, build.mjs, package.json   how bin/site.wasm and www/'s bundles are made
```

The program serves **the app's own tree**: on each request it reads the
head `site/app` (the app record the install wrote), takes its `tree`, and
answers with skein-sdk's `files.serve` (`lib/files.zig`: the file under the
route's `root`, a directory's `index.html`, a 301 for a directory named
without its `/`, the blob's CID as the ETag and 304 on `If-None-Match`, 404,
405), as a filter's answer `{answer: {status, type, headers, body}}`. Its
route is a read route (shruggr/skein#143: no handler; its one filter, the
manifest's `get`, answers): the kernel's door calls it over the current
state — anyone, signed or not, any method, no entry in the log — and it
puts nothing and moves no head.

The manifest (description left out):

```json
{
  "kind": "app",
  "name": "site",
  "version": "0.9.0",
  "programs": { "site": "bin/site.wasm" },
  "provides": [{ "interface": "site/1", "functions": { "get": { "writes": false,
    "args": { "method?": "string", "route?": "string", "path?": "string", "query?": "string", "headers?": "map", "match?": "map" },
    "answer": { "status": "int", "type": "string", "headers": "map", "body": "bytes" } } } }],
  "requires": [],
  "filters": { "get": "site.get" },
  "routes": [
    { "transport": "http", "address": "/", "prefix": true, "filters": ["get"], "root": "www" }
  ]
}
```

The app takes no messages: its one route is a read route. Its address is
relative to `/site/` (APPS.md §2: an app's paths are under its name), so the
install asks for `route http /site/ prefix [site.get] → (a read: its filters
answer, nothing logged) (root www)`. The page's links are relative (`app.js`, `style.css`,
`catalog.json`), so it works under `/site/` and at `/`; the skein it was
served by is its URL less a trailing `/site`.

## Install

From the management page of a skein where you hold root (Install, by URL
and commit id), or with skein's reference client as root:

```
skein plan install https://github.com/shruggr/skein-site#<the v0.9.0 commit> --origin <the skein's URL> --out plan
skein send <the skein's URL> plan
```

**The site at the root.** An app's paths are under its name; the root is
root's. The default image carries root's own route putting the page at
`/` (shruggr/skein#143: a route with no `app`, so an upgrade of the site
keeps it and an uninstall leaves it):

```
{transport: "http", address: "/", prefix: true, filters: ["site.get"], root: "www"}
```

Elsewhere, root adds it with one `dispatch` message (skein's
`planRootRoute`, `skein dispatch`). A prefix route at `/` is the instance's
catch-all: exact paths and longer prefixes (the messagebox, the explorer,
every app's `/<name>/…`) match first; any other path is the site's (a 404
when the tree has no such file), and `/manifest.json` is the page's grouped
request.

## Files

| file | what |
|---|---|
| `www/index.html`, `www/app.js`, `www/style.css` | the page: plain HTML and JavaScript, no framework |
| `www/catalog.json` | the apps the page offers |
| `www/manifest.json` | the wallet's grouped permission request (above) |
| `www/lib.js`, `www/chunk-*.js` | the libraries, one esbuild bundle (`lib/entry.ts`): skein's BRC-104 client (`src/client/raw.ts`), install plan and block encoder (`src/runtime/cid.ts`), `@1sat/connect`, `@bsv/sdk` (with its `Certificate`, `MasterCertificate` and `ProtoWallet`), `@bsv/message-box-client`, `@1sat/actions`' `syncMetanetInbox` (its module only), `@1sat/utils`' profile codec, `@1sat/templates`' outpoint bytes and `@1sat/types`' outpoint form (their modules only), `@ipld/dag-cbor`, `@ipld/dag-json` |
| `www/webwallet.js` | `@1sat/wallet-browser`'s `createWebWallet`, loaded only in test mode |
| `lib/entry.ts`, `lib/webwallet.ts`, `build.mjs`, `lib/SKEIN_REV` | how the bundles are made, and the skein commit they are made from |

Test mode: `?key=<private key hex>` runs a wallet in the tab over that key
instead of connecting one, and `&services=<url>` points it at a 1sat
services endpoint (skein's `kernel-zig/equiv/site.ts` drives the page this way).

## Build and test

The page's bundles (Node; the output is committed, the app serves `www/`
as it is in the tree):

```
npm ci
SKEIN_DIR=../skein node build.mjs     # a skein checkout at lib/SKEIN_REV, with its web/shims → www/lib.js, www/webwallet.js, www/chunk-*.js
```

The chunks' names hash the modules' paths, so the same bytes come out only
with the skein checkout at `../skein` as above.

The filter (Zig 0.16.0, `mise.toml`):

```
zig build          # zig-out/bin/site.wasm
zig build bin      # the same, into bin/site.wasm (committed; the build is reproducible)
zig build test     # the filter's checks (natively)
```

skein runs the app end to end: `kernel-zig/equiv/site.ts` (the page in
headless Chrome, installed in a host skein), `files.ts` (the filter's
answers) and `install.ts` (the install and uninstall), at a commit of this
repository pinned in skein's `src/testapps.ts`.

## Versions

| | |
|---|---|
| this app | 0.9.0 (tag `v0.9.0`): routes, filters and roles (shruggr/skein#143) — the manifest's read route with its filter `get` (the program answers `{answer: …}`); the bundles from skein's routes-roles (`planInstall` resolves routes, the install sends no key); an app's Permissions page becomes its Routes (read only) and Roles (root, user and the app's own, the holders from the head `grants`, granted and revoked by root with the kernel's `grant` message); the automatic setup of owner rows and its card are gone (root needs no rows); the review shows routes, filters and roles; the explorer's dispatch table is the Routes view (transport, address, filters, handler); Overview shows root's holders; the catalog pins onboard 0.4.0. 0.8.1: setup is automatic — on the owner's first visit the page sends the rows from you the image's apps lack (a status card while it runs, then what was added, dismissible; Try again on a failure); a contact added by handle keeps `handle` and `domain` apart (docs/MESSAGES.md, the address book), an older entry's full handle still shown. 0.8.0: a skein's pages redesigned — tabs Apps (the default: Finish setup, the installed apps as cards with Upgrade and Uninstall, Add an app, From a repository with GitHub's versions resolved to a commit, the review read from the plan, the skeins created there), Contacts (add by handle) and Overview; an app's page with its rows (remove one, add one, as skein's `wiring` builds it); the heads under the explorer; every key, CID and commit expandable and copyable; no window.confirm. 0.7.7: the page is a read (`reads[]`, shruggr/skein#135: served by a call, anyone, nothing logged), the owner's root a read (`skein plan reads add`); Save profile posts over your wallet's session (a write: signed); the bundles from skein's two-door plan (an app's reads into the reads head); the catalog pins onboard 0.3.4 and git 0.1.3. 0.7.6: Register posts over your wallet's BRC-104 session with the host's origin — a registration is a write, so a signed request (shruggr/skein#135); the catalog pins onboard 0.3.3. 0.7.5: the catalog pins skein-chain v0.4.0. 0.7.4: the page in the skein brand (0.7.0: header + wallet chip, skein cards, handle/Register card, self-hosted fonts, the mark), the logged-out landing page (0.7.1), quiet without a wallet (0.7.2); manifest and package versions aligned (0.7.3); Create shows the wait (the mark turning, the seconds counting) while the new skein loads the chain. 0.6.3: the catalog pins the current releases (git 0.1.2, shell 0.1.1, chain 0.3.2, overlay 0.7.7, onboard 0.3.2). 0.6.2: the bundles rebuilt on a skein whose address book has no roles (shruggr/skein#126); the address book page has no role column |
| skein-sdk | v0.6.0, by tag tarball and hash in `build.zig.zon` (`cbor`, `sk`, `files`; no wallet) |
| skein | the bundles from `lib/SKEIN_REV` (shruggr/skein routes-roles); the app installs into a skein with the #143 manifest shape (log format 9) |
