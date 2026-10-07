# skein

A skein is a deterministic WASI machine over a content-addressed graph. Every
package that reaches it is appended to its log as received, every step a
program takes is recorded, and replaying the log rebuilds the same graph,
byte for byte. What a skein does depends on the apps installed in it, and
the same history runs under any host: a server, a laptop, a browser tab.

This repository is the kernel, the boundary programs, the node host and the
client. Apps live in their own repositories (below). The public explainer is
https://skein.nexus; these docs are the reference.

## What it is

Three layers:

| layer | what | where |
|---|---|---|
| **kernel** | the machine (store, log, scheduler, WASI, fuel) and its four tables, plus the signer import (`wallet`). One implementation, Zig over wasmtime; it also builds for the browser | `kernel-zig/` |
| **apps** | everything else, each a tree of WASI programs installed under its own name: the front door, messagebox, resolve, wallet, chain, static sites, overlays, the shell, chat, your own | `programs/` here (the boundary programs and the wallet); the rest in sibling repos |
| **hosts** | whatever drives a kernel from outside: transports, providers, a store and the signer. The host judges nothing and routes nothing | `src/host/` (the node host, `skein-host`); `web/kernel/` (the browser host) |

The kernel's four tables:

| table | holds | written by |
|---|---|---|
| objects | blocks by CID (dag-cbor, git-raw, bitcoin, raw) | the kernel's `objects` operation; programs `put`/`keep` |
| heads | name → root, each with an owner (the app the name is under) | the kernel's `head` operation; programs `advance`, only under their own app's name |
| dispatch | rows `(transport, address, sender, program)`: boxes, HTTP paths, libp2p topics. A row is the permission | the kernel's `dispatch` operation |
| address book | key → transport and address; providers are `local` rows | the kernel's `peers` operation |

The four admin operations are the kernel's own, taken on admin messages from
the owner (or a key the owner delegated with another row). So is the
claim: a skein started from the default image has no owner until a message
reaches its claim row, and then the kernel writes the sender's admin rows
(#127: the owner is the claim's sender, never a key in its body) and removes
the claim row. No program writes a kernel table. An app writes only heads under its own name; reads are
global by CID; a call to another app hands back CIDs, not data.

## Run a skein locally

Needs Node 26 and Zig 0.16.0 through `mise`. The owner's admin messages
(installing an app, a dispatch row, the address book, a directory into
`main`) are `bin/skein install|uninstall|routes|grant|peers|host|claim|deploy`:
the client signs them in its own process with the operator's key
(`SKEIN_OPERATOR_KEY`, default `~/.skein/operator.key`, which `skein-host
run` makes) and sends them — over the host's control socket on the host
machine (`--instance <handle>`), else on one BRC-104 session with the
instance's origin (#142). A browser wallet sends the same messages from the
management page. The `bin/skein` client's other commands
use a wallet reachable over HTTP (default `http://127.0.0.1:3322`; the dev
setup runs `1sat serve wallet-api`, `scripts/host/wallets.sh`).

That HTTP wallet is deny-by-default. The client (origin `skein-client`,
`SKEIN_ORIGINATOR`) needs these grants
from the owner's wallet (`scripts/host/grants.sh` grants them for the dev
stack):

| protocol | level | counterparty |
|---|---|---|
| `identity key retrieval` | 1 | |
| `server hmac` | 2 | `self` |
| `messagebox` | 1 | |
| `auth message signature` | 2 | the instance's front-door key |
| `message encryption` | 2 | the instance's front-door key |

The front-door key is column 5 of `skein-host list`; a new instance is a
new counterparty. A missing grant fails the command with the wallet's
refusal, which names the `1sat permissions grant …` command for it.

```
git clone https://github.com/shruggr/skein && cd skein
npm install
(cd kernel-zig && mise exec -- zig build --release)   # kernel-zig/zig-out/bin/skein-kernel; fetches skein-sdk by URL+hash
bin/skein-host add martha --image default            # an instance from the default image: identity derived from ~/.skein/master.key, no owner yet
bin/skein-host run                                    # the host on :8100; martha at http://martha.localhost:8100 or /@martha
bin/skein claim --instance martha                     # the claim, signed with ~/.skein/operator.key: you, its sender, own martha; the claim row goes
```

The default image (`images/default`, docs/BOOTSTRAP.md) is the same for
every user skein: the front door, the messagebox, the wallet, the chain, git
and site apps installed at birth (#141), and one row to the kernel,
`claim`, from anyone: the first claim's sender owns it (#127), so claim it
first thing. The host signs no user's claim; `skein claim --messagebox
<url>` names where the instance reaches its owner. A second claim is
refused. After the claim, the owner's rows into the apps installed at
birth: `bin/skein install images/default/apps/git --instance martha` (the
same for `apps/chain`), or the page.

A plain `skein-host add martha` (no `--image`) is code genesis, with the
owner in it: `SKEIN_OWNER`, else `~/.skein/owner.identity` (the owner
wallet's identity key, one line of hex). The tests and the dev stack use it.

- State lives in `$SKEIN_HOME` (default `~/.skein`): `master.key` (the one
  secret every instance key derives from), `host.db` (instances, queues, the
  fuel ledger), `instances/<handle>/runtime.db` (each instance's store),
  `logs/host.log`.
- BRC-169 on the host's own origin (`SKEIN_ROUTER_ORIGIN`) is the host
  skein's onboarding app (shruggr/skein-onboard, #113): the router carries
  `/manifest.json`, `/.well-known/metanet-handles/resolve` and `/search`,
  `/bsvalias/id/…`, `POST /account/register` and `POST /account/profile`
  into the host skein. The app registers handles from a skein (#131: signed
  over `register <name>@<domain>`, naming the hosting skein, whose root the
  key must hold; no instance is made, the messagebox is that skein), has the
  host's certifier (a child of `master.key`, never in an instance) sign each
  handle certificate under a serial of its own, records every issue, and
  answers resolve, search and the manifest from those records. The handle
  domain, the host's name and note are the app's config, written at the
  host skein's birth from the host's settings (below).
  Revocation is not implemented (the host has no wallet): the certificate's
  revocation outpoint is BRC-52's disabled sentinel.
- Code genesis (no `--image`) is written at its first start: the owner, the
  owner's admin rows, the boundary programs (front door, messagebox,
  resolve) and their rows, and the host's providers in its address book.
  It has no shell and no chat loop: those are apps, installed next. `skein-host add <h> --boot <dir>` boots
  from a system tree instead (docs/BOOTSTRAP.md). A new log format means a
  new store: move `runtime.db` aside and start again.
- The full dev stack (owner and inference wallets, mailbox instances, address
  books, the inference peer) is `scripts/host/up.sh`; see
  `scripts/host/README.md`.
- The host page is http://127.0.0.1:4600 (every instance, a link to its
  origin). A skein from the default image serves its management page, the
  explorer included, at its origin. `bin/skein-dev log | ls | show <cid>` and
  `kernel-zig/zig-out/bin/skein-kernel dump | replay | fuel <store>` read a
  store from the command line.

## Run a host

A host runs skeins for others too. It has one of its own, the **host
skein**: the operator's instance, where the host keeps what is state or
conversation (docs/ARCH.md, "The host skein").

```
# ~/.skein/host.env — the host's settings: every SKEIN_* line; the environment wins
SKEIN_ROUTER_ORIGIN=https://id.example.com
SKEIN_INSTANCE_ORIGIN=https://{handle}.example.com
SKEIN_HANDLE_DOMAIN=example.com
SKEIN_HOST_NAME="Example host"
SKEIN_HTTP=fetch
```

```
bin/skein-host run        # the first run: operator.key, master.key, host.db and the host skein; then the host
```

- `run` reads `$SKEIN_HOME/host.env` (every `SKEIN_*` line; the environment
  wins). On its first run it makes the operator's key
  (`SKEIN_OPERATOR_KEY`, default `$SKEIN_HOME/operator.key`; a file you put
  there is used instead: hex or WIF, mode 0600) and the **host skein**
  (handle `host`) from the host image — the default image with the
  onboarding app (shruggr/skein-onboard) — its genesis naming the
  operator's key as its owner: its admin rows, its explorer row and its
  apps' owner rows are there at birth, with no claim. The onboarding app's
  config comes from the settings (`domain` from `SKEIN_HANDLE_DOMAIN`, else
  the domain of `SKEIN_ROUTER_ORIGIN`; `origin`; `name` from
  `SKEIN_HOST_NAME`; `note` from `SKEIN_HOST_NOTE`). It prints the host
  skein's identity and URL, then serves. Later runs start what exists; a
  changed host.env does not reach into the host skein (`skein install
  images/host/apps/onboard --instance host --config <file.json>` changes the
  app's config). `skein-host init` is the first run's part alone. Its
  address book alone names the **instance manager**, the host's provider
  that creates, starts and stops instances; the manager acts for no one
  else.
- `skein-host grant <your wallet's identity key> --apps` gives a browser
  wallet the host skein's admin rows and its apps' owner rows (signed with
  the operator's key), so the management page manages the host skein too.
- With the onboarding app installed, anyone with a wallet gets a skein: a
  BRC-104 session to the host skein and `POST /onboard/call {"fn":
  "onboard.create", "args": {"handle": "alice", "claim": …}}`, `claim` the
  wallet's own signed claim naming no recipient (#127; skein-onboard's
  README has its shape). The answer, on the same connection, is `{handle,
  identity, url}`: a new instance from the default image, its claim
  forwarded by the instance manager as its first entry — owned by the
  signer, already claimed when its URL first answers. Its owner installs apps into it from there (next sections). A
  handle that is taken is refused (409).
- **The management page.** Open the host skein's origin
  (`http://host.localhost:8100/`) with a BRC-100 wallet in the browser: it
  creates a skein for your key through that route, writes a **locator** (an
  output in your wallet, basket `skein-locators`: the skein's identity, URL
  and handle) and opens the new skein's own copy of the page. There it reads
  the skein through its explorer and installs apps: the git app from the
  image, then any app by repository URL and commit id — you see the rows each
  asks for before your wallet signs. Deploy by hash needs the host to carry
  requests beyond itself: run it with `SKEIN_HTTP=fetch`. Every skein from
  the default image serves the same page (shruggr/skein-site); one page
  manages skeins on many hosts, each through its locator.
- **A handle from your skein** (#103, #131). On a skein's Overview, when
  your key holds root there, "Register a handle for this skein" asks the
  host for `<name>@<domain>` for your key (the domain is the onboarding
  app's `config.onboard.domain`; the page finds the router through
  `/.well-known/skein-host`, which the router answers at every skein's
  origin): your wallet signs the request, the host checks your key holds
  root on that skein and answers with the BRC-52 handle certificate — its
  messagebox that skein — and your wallet keeps it (`acquireCertificate`).
  "Your handles" lists those certificates (`listCertificates`) and the
  mailbox each resolves to. The labels `id` and `host` and every
  instance's handle are refused.
- **Your profile** (#104). Each of your handles has a Profile form: a name
  and an avatar (an image inscription, by outpoint). Your wallet signs the
  profile record (the OpNS one: DAG-CBOR `{domain, name?, avatar?}`), and
  the page posts it to the host (`/account/profile`). The host serves
  it with the handle when it is resolved or found; the page shows it as
  signed by the handle's key. "Find a handle" searches the host by handle
  or name.
- `scripts/host/up.sh` brings up the dev stack.
- Block headers for the chain app: run the host with
  `SKEIN_HEADERS_URL=http://127.0.0.1:8083/chaintracks/v2/tip/stream`
  (Arcade's chaintracks); every instance with the chain app installed is
  subscribed to it (scripts/host/README.md, the feeds). The host fills the
  default image with the whole header chain from that chaintracks' history
  at start and appends every header the feed brings, so a new skein is born
  with the chain (#132, docs/BOOTSTRAP.md, "The image's chain part").

## Talk to it

An instance is an HTTP server at its own origin. Every request is appended
as received and the instance's front door (a program) runs BRC-103/104 on it
inside the VM; the host holds the connection until the request's thread
comes to rest, and the answer is signed on the session.

```
bin/skein install shell --instance martha       # the shell app (from martha's catalog, cloned by her git app): box shell/run
bin/skein install chat --instance martha        # the chat app: box chat
bin/skein whoami
bin/skein import ~/some/dir                      # tree objects into the kernel's objects operation; prints the tree CID
bin/skein run --tree <cid> -- 'ls | head -3'     # box shell/run (the shell app: the shell over a tree)
bin/skein inbox --wait                           # the answer, from your mailbox instance
bin/skein chat --new --wait 'what is here?'      # box chat (the chat app; needs the inference peer, bin/skein-infer)
```

- In a browser: a skein from the default image serves the management page
  at its origin (`/`). It talks to that skein, and to every skein your
  wallet keeps a locator for, with the same requests as the commands below,
  signed by your wallet. Its Inbox lists a box of any mailbox you give it
  (by default the mailbox your handle certificate resolves to) and syncs its
  `metanet_inbox` into that wallet with `@1sat/actions`' `syncMetanetInbox`.
- Messages are BRC-33 (`/sendMessage`, `/listMessages`,
  `/acknowledgeMessage`) on a BRC-104 session, bodies dag-cbor
  (`application/cbor`, BRC-231) or JSON. A message's id is the CID of its
  record; an answer names it in `replyTo`.
- Mail to your handle goes to the skein you registered it from (#131).
  On a dev host, what the code-genesis agents send the owner goes to the
  owner's dev mailbox (`skein-host add <h> --mailbox --owner <key>`, #40:
  an instance with only the front door and the messagebox, never a
  handle's).
- libp2p: an instance with libp2p rows gets a node in the host; topic
  messages and stream frames go through the same front door.
- App routes live under `/<app>/` (an overlay's `/<app>/submit`,
  `/<app>/lookup`); `{fn, args}` to an app's box calls a function.

The wire contract is docs/MESSAGES.md.

## Install an app

```
bin/skein install <name> --instance martha                         # a name from martha's catalog (her site's www/catalog.json)
bin/skein install https://github.com/<owner>/<repo>#<commit> http://martha.localhost:8100   # any repository and commit, at an origin
bin/skein install <name> --instance martha --dry-run               # the prompt and the messages, nothing sent
bin/skein uninstall <app> --instance martha
```

`install` prints the prompt — what the app asks for (its head, its rows,
its reads, its start) — and sends the owner's messages. A repository is
installed **by hash**: one message to the skein's git app, `{fn:
"git.clone", args: {url, hash}}`; the app fetches that one commit through
the host's fetch provider (the host runs with `SKEIN_HTTP=fetch`), checks it
against the hash, keeps its tree in the store and answers `{tree, app}`
(the app record, built in the VM). The client plans from the stored tree and
sends `head` (`<app>/app` → the app record), one `dispatch` per row, and the
app's `start` — no `objects`: the blocks are already there. Installing
again is the upgrade. A directory (`skein install <dir>`) is read on your
machine and the objects the skein lacks are sent. The management page does
the same from your wallet. docs/APPS.md §3.

## Build an app

An app is a tree with `etc/app.json`. A complete minimal one is
`programs/test/app-demo/`: a counter with one interface, a box, a cron tick
and an HTTP route. Its manifest, with the `peek` function and the
description left out:

```json
{
  "kind": "app",
  "name": "app-demo",
  "version": "0.1.0",
  "programs": { "demo": "bin/app-demo.wasm" },
  "provides": [{ "interface": "demo.counter/1", "functions": {
    "get": { "writes": false, "args": {}, "answer": { "count": "int" } },
    "add": { "writes": true, "args": { "by": "int", "note?": "string" }, "answer": { "count": "int" } } } }],
  "requires": [],
  "dispatch": [
    { "address": "app-demo", "sender": "*", "program": "demo" },
    { "address": "tick", "sender": "$cron", "program": "demo" },
    { "transport": "http", "address": "/call", "sender": "session", "program": "demo", "fn": "call" }
  ],
  "start": { "body": { "kind": "app-demo-start" } },
  "stop": { "body": { "kind": "app-demo-stop" } }
}
```

- **The name rule.** The app's programs advance only heads under
  `app-demo/…`; its record is `app-demo/app`, its own state the record's
  `state` link.
- **Rows.** `transport` defaults to `mailbox` (a box). An `http` address is
  relative to `/<app>/`. Senders: `*`, `event`, `session` (http), `$owner`,
  `$self`, `$<provider>` (`$cron`, `$status`), or a key in hex.
- **Programs** are WASI preview1 modules or WASI 0.2 components. In Zig,
  depend on skein-sdk by tag:

  ```
  zig fetch --save=skein_sdk https://github.com/shruggr/skein-sdk/archive/refs/tags/v0.7.2.tar.gz
  ```

  and dispatch `{fn, args}` with the SDK's `app.serve`
  (`programs/test/app-demo/main.zig`). Build with `zig build` for
  `wasm32-wasi` and commit the module under `bin/`.

docs/APPS.md is the specification (the manifest fields, install, calling an
app, the security model, worked examples for an overlay and the chain app).

## Write an overlay

An overlay is an app built on shruggr/skein-overlay: the engine program plus
your topic managers and lookup services, wired from `config.overlay` in its
manifest, serving BRC-22/24 at `<base>/submit` and `<base>/lookup`, its
BRC-23 base URL `https://<handle>.<host>/<app>` (`/@<handle>/<app>` on the
host's origin without wildcard DNS). It
needs the chain app installed (`requires: ["chain/1"]`). The engine exports
the `topic`, `lookup` and `sk` Zig modules to build against; its README and
docs/OVERLAY.md there have the walkthrough.

## Build and test

```
cd kernel-zig && mise exec -- zig build          # first: the host tests run kernel-zig/zig-out/bin/skein-kernel
cd kernel-zig && mise exec -- zig build test     # the kernel's unit tests
npm test                                         # the host, client, formats (node --test src/**/*.test.ts)
TMPDIR=/tmp/sk kernel-zig/equiv/run.sh           # equivalence: shell, git, replay exactness, apps, browser
```

- Gotcha: after a kernel change, a stale `zig-out/bin/skein-kernel` makes
  `npm test` fail with "kernel probe: exited (1)" and can hang the host
  suite. Run `zig build` first.
- CI (`.github/workflows/test.yml`) runs all four on Ubuntu for every push
  and pull request, with the browser and component parts of the equivalence
  suite skipped (no Playwright, Chromium, wasm-tools or adapter there).
- `equiv/run.sh` clones the pinned sibling apps (skein-chain, skein-overlay,
  skein-site, skein-shell, skein-chat, skein-onboard, skein-git);
  `SKEIN_CHAIN_DIR`, `SKEIN_OVERLAY_DIR`, `SKEIN_SITE_DIR`,
  `SKEIN_SHELL_DIR`, `SKEIN_CHAT_DIR`, `SKEIN_ONBOARD_DIR`, `SKEIN_GIT_DIR`
  point it at local checkouts. The git app's case (`git-clone.ts`) serves a
  local repository with `git http-backend`. `npm test` installs the
  shell app and the chat app where a test runs them (src/testapps.ts: the
  same pins, fetched once into `$TMPDIR/skein-apps`). The browser cases need Playwright and
  Chromium, else they are skipped with a note.
- The programs here: `scripts/build-programs.sh && scripts/pin-programs.sh`.
  Developing against a local skein-sdk: clone it next to this checkout and
  prefix a build with `scripts/sdk-local.sh`.

## Repositories

| repo | what | version |
|---|---|---|
| [shruggr/skein](https://github.com/shruggr/skein) | kernel, boundary programs (front door, messagebox, resolve), the wallet program, the node host, the client | log format 8 |
| [shruggr/skein-sdk](https://github.com/shruggr/skein-sdk) | the Zig package every program is written against: the `skein` imports, codecs, `app`, `files`, `chain`, wallet library, WIT | v0.6.0 |
| [shruggr/skein-chain](https://github.com/shruggr/skein-chain) | the chain app: the one writer of `chain/state`, ingest a BEEF, the only broadcaster; born with the image's header chain (#132) | v0.4.0 |
| [shruggr/skein-overlay](https://github.com/shruggr/skein-overlay) | the overlay engine app: BRC-22/24 over topic managers and lookup services | v0.9.2 |
| [shruggr/skein-shell](https://github.com/shruggr/skein-shell) | the shell app: `run`, and the shell itself (brush, coreutils, the toolset, python's stdlib) | v0.1.1 |
| [shruggr/skein-chat](https://github.com/shruggr/skein-chat) | the chat app: the turn loop (`chat`), its `bash` calls in the shell app's shell | v0.1.0 |
| [shruggr/skein-onboard](https://github.com/shruggr/skein-onboard) | the onboarding app, installed in the host skein: creates a skein for a wallet through the instance manager (the wallet's signed claim forwarded, #127); registration over the registrant's session (#135) | v0.3.3 |
| [shruggr/skein-git](https://github.com/shruggr/skein-git) | the git app: clones one commit by hash into the store, in the VM, and builds its app record (deploy by hash) | v0.1.2 |
| [shruggr/skein-site](https://github.com/shruggr/skein-site) | the management site, an app (#125: its page at `/site/`, served from its own tree by skein-sdk's `files`; the owner may add a row for `/`): locators in your wallet, create a skein, install apps, the explorer, the Inbox, handles and their profiles | v0.7.6 |
| [shruggr/skein-nexus](https://github.com/shruggr/skein-nexus) | the source of https://skein.nexus | |

This repository's layout:

```
kernel-zig/      the kernel: skein-kernel serve | replay | shell | dump | fuel; equiv/ (the equivalence suite)
images/default/  the default image (#89): a system tree with no owner and the claim row; the git app's tree in apps/git (#92); no site (#125)
programs/        frontdoor, messagebox, resolve, wallet (Zig over skein-sdk); test/ (fixtures, app-demo)
wasm/            the committed modules the kernel pins (kernel-zig/src/programs.zig), see wasm/README.md
src/host/        the node host: skein-host (cli.ts), the HTTP transport, providers, feeds, broadcaster, libp2p node, signer, install
src/runtime/     the formats and a store reader in TypeScript (no machine)
src/client/      bin/skein: import, run, chat, inbox, dispatch
src/peers/       bin/skein-infer (the inference peer), a remote cron provider
src/dev/         bin/skein-dev (log, ls, show over a store file)
web/             the browser host (web/kernel/) and a front-end demo
scripts/         program builds and pins, sdk-local.sh; host/ (the dev stack)
```

## Docs

| doc | for |
|---|---|
| [docs/ARCH.md](docs/ARCH.md) | the architecture: the kernel, the host, the browser host, the apps |
| [docs/VM.md](docs/VM.md) | the machine: records, heads, the four tables, imports, `emit`, calls, requests, fuel, time, the index |
| [docs/MESSAGES.md](docs/MESSAGES.md) | the wire: the front door, sessions, routes, the log format, the messagebox, outbound, providers, broadcast, scheduling, libp2p |
| [docs/APPS.md](docs/APPS.md) | apps: the manifest, install, calling an app, security, worked examples |
| [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md) | genesis: the system tree, packets, checkpoints, installing |
| [docs/WALLET.md](docs/WALLET.md) | the wallet program, the chain state it reads, proofs, SPV |
| [docs/OVERLAY.md](docs/OVERLAY.md) | pointer to skein-overlay's docs |
| [docs/SKILLS.md](docs/SKILLS.md) | which skill scripts run in the VM |
| [kernel-zig/README.md](kernel-zig/README.md) | building and running the kernel, components, the browser build, equivalence |
| [scripts/host/README.md](scripts/host/README.md) | the dev host: commands, ports, environment, Arcade, libp2p settings |
| [src/client/README.md](src/client/README.md) | the client |
| [docs/OPEN.md](docs/OPEN.md) | open questions still live from building |

Vocabulary: the **host** is transports + providers + store + signer (there
is no "router"; the dispatch table routes); the **kernel** is the machine,
the four tables and the signer import; **admin operations** are kernel
operations, not programs; every other thing is an **app** under its own
name; a **box** is a mailbox address in the dispatch table; **emit** is the
one way out (a message to a key in the address book — unsigned: a skein
receives mail only on a BRC-104 session to its own front door or over
libp2p, #126 step 4 — or an event).

## Contributing

The tracker is issue [#31](https://github.com/shruggr/skein/issues/31):
decisions, conventions and what is ready to build. Where a doc and an issue
disagree, the issue is right.
