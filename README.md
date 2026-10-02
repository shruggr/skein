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
| **hosts** | whatever drives a kernel from outside: transports, providers, a store and the signer (the oracle). The host judges nothing and routes nothing | `src/host/` (the node host, `skein-host`); `web/kernel/` (the browser host) |

The kernel's four tables:

| table | holds | written by |
|---|---|---|
| objects | blocks by CID (dag-cbor, git-raw, bitcoin, raw) | the kernel's `objects` operation; programs `put`/`keep` |
| heads | name → root, each with an owner (the app the name is under) | the kernel's `head` operation; programs `advance`, only under their own app's name |
| dispatch | rows `(transport, address, sender, program)`: boxes, HTTP paths, libp2p topics. A row is the permission | the kernel's `dispatch` operation |
| address book | key → transport and address; providers are `local` rows | the kernel's `peers` operation |

The four admin operations are the kernel's own, taken on admin messages from
the owner (or a key the owner delegated with another row). No program writes
a kernel table. An app writes only heads under its own name; reads are
global by CID; a call to another app hands back CIDs, not data.

## Run a skein locally

Needs Node 26, Zig 0.16.0 through `mise`, and, for anything sent as the
owner, a BRC-100 wallet reachable over HTTP (default
`http://127.0.0.1:3322`; the dev setup runs `1sat serve wallet-api`,
`scripts/host/wallets.sh`).

```
git clone https://github.com/shruggr/skein && cd skein
npm install
(cd kernel-zig && mise exec -- zig build --release)   # kernel-zig/zig-out/bin/skein-kernel; fetches skein-sdk by URL+hash
bin/skein-host add martha                             # an instance: identity derived from ~/.skein/master.key
SKEIN_OWNER=<owner key hex> bin/skein-host run        # the host on :8100; martha at http://martha.localhost:8100 or /@martha
```

A genesis needs an owner: `SKEIN_OWNER`, else `~/.skein/owner.identity`
(the owner wallet's identity key, one line of hex).

- State lives in `$SKEIN_HOME` (default `~/.skein`): `master.key` (the one
  secret every instance key derives from), `host.db` (instances, queues, the
  fuel ledger), `instances/<handle>/runtime.db` (each instance's store),
  `logs/host.log`.
- An instance's genesis is written at its first start: the owner, the
  owner's admin rows, the default programs and rows, and the host's
  providers in its address book. `skein-host add <h> --boot <dir>` boots
  from a system tree instead (docs/BOOTSTRAP.md). A new log format means a
  new store: move `runtime.db` aside and start again.
- The full dev stack (owner and inference wallets, mailbox instances, address
  books, the inference peer) is `scripts/host/up.sh`; see
  `scripts/host/README.md`.
- The host page is http://127.0.0.1:4600, a read-only explorer per instance
  on :4610 and up. `bin/skein-dev log | ls | show <cid>` and
  `kernel-zig/zig-out/bin/skein-kernel dump | replay | fuel <store>` read a
  store from the command line.

## Talk to it

An instance is an HTTP server at its own origin. Every request is appended
as received and the instance's front door (a program) runs BRC-103/104 on it
inside the VM; the host holds the connection until the request's thread
comes to rest, and the answer is signed on the session.

```
bin/skein whoami
bin/skein import ~/some/dir                      # tree objects into the kernel's objects operation; prints the tree CID
bin/skein run --tree <cid> -- 'ls | head -3'     # box run (the shell over a tree)
bin/skein inbox --wait                           # the answer, from your mailbox instance
bin/skein chat --new --wait 'what is here?'      # box chat (needs the inference peer, bin/skein-infer)
```

- Messages are BRC-33 (`/sendMessage`, `/listMessages`,
  `/acknowledgeMessage`) on a BRC-104 session, bodies dag-cbor
  (`application/cbor`, BRC-231) or JSON. A message's id is the CID of its
  record; an answer names it in `replyTo`.
- What an instance sends you goes to your mailbox instance (an instance with
  only the front door and the messagebox: `skein-host add <h> --mailbox
  --owner <key>`).
- libp2p: an instance with libp2p rows gets a node in the host; topic
  messages and stream frames go through the same front door.
- App routes live under `/<app>/` (an overlay's `/<app>/submit`,
  `/<app>/lookup`); `{fn, args}` to an app's box calls a function.

The wire contract is docs/MESSAGES.md.

## Install an app

```
bin/skein-host install https://github.com/shruggr/skein-chain --instance martha            # prints the rows it asks for, asks y/n
bin/skein-host install https://github.com/shruggr/skein-static#<rev> --instance martha --approve-all
bin/skein-host uninstall static --instance martha
```

Install reads the manifest aloud (its dispatch rows), then sends, as the
owner: `objects` (the tree and program records), `head` (`<app>/app` → the
app record), one `dispatch` per row, and the app's `start` message.
Installing again is the upgrade. docs/APPS.md §3.

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
    { "address": "app-demo-tick", "sender": "$cron", "program": "demo" },
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
  zig fetch --save=skein_sdk https://github.com/shruggr/skein-sdk/archive/refs/tags/v0.4.0.tar.gz
  ```

  and dispatch `{fn, args}` with the SDK's `app.serve`
  (`programs/test/app-demo/main.zig`). Build with `zig build` for
  `wasm32-wasi` and commit the module under `bin/`.

docs/APPS.md is the specification (the manifest fields, install, calling an
app, the security model, worked examples for an overlay and the chain app).

## Write an overlay

An overlay is an app built on shruggr/skein-overlay: the engine program plus
your topic managers and lookup services, wired from `config.overlay` in its
manifest, serving BRC-22/24 at `/<handle>/<app>/submit` and `/lookup`. It
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
- `equiv/run.sh` clones the pinned sibling apps (skein-chain, skein-overlay,
  skein-static); `SKEIN_CHAIN_DIR`, `SKEIN_OVERLAY_DIR`, `SKEIN_STATIC_DIR`
  point it at local checkouts. The browser cases need Playwright and
  Chromium, else they are skipped with a note.
- The programs here: `scripts/build-programs.sh && scripts/pin-programs.sh`.
  Developing against a local skein-sdk: clone it next to this checkout and
  prefix a build with `scripts/sdk-local.sh`.

## Repositories

| repo | what | version |
|---|---|---|
| [shruggr/skein](https://github.com/shruggr/skein) | kernel, boundary programs (front door, messagebox, resolve), the wallet program, the node host, the client | log format 8 |
| [shruggr/skein-sdk](https://github.com/shruggr/skein-sdk) | the Zig package every program is written against: the `skein` imports, codecs, `app`, `chain`, wallet library, WIT | v0.4.0 |
| [shruggr/skein-chain](https://github.com/shruggr/skein-chain) | the chain app: the one writer of `chain/state`, ingest a BEEF, the only broadcaster | v0.2.0 |
| [shruggr/skein-overlay](https://github.com/shruggr/skein-overlay) | the overlay engine app: BRC-22/24 over topic managers and lookup services | v0.3.0 |
| [shruggr/skein-static](https://github.com/shruggr/skein-static) | static files from the `main` head's tree, at the http rows pointed at it | v0.2.0 |
| [shruggr/skein-workbench](https://github.com/shruggr/skein-workbench) | the shell and chat loop (run-handler, loop, the shell's toolset), to be split into the shell app and the chat app by #83 | v0.2.0 |
| [shruggr/skein-nexus](https://github.com/shruggr/skein-nexus) | the source of https://skein.nexus | |

This repository's layout:

```
kernel-zig/      the kernel: skein-kernel serve | replay | shell | dump | fuel; equiv/ (the equivalence suite)
programs/        frontdoor, messagebox, resolve, wallet (Zig over skein-sdk); test/ (fixtures, app-demo)
wasm/            the committed modules the kernel pins (kernel-zig/src/programs.zig), see wasm/README.md
src/host/        the node host: skein-host (cli.ts), the HTTP transport, providers, feeds, broadcaster, libp2p node, oracle, install
src/runtime/     the formats and a store reader in TypeScript (no machine)
src/client/      bin/skein: import, run, chat, inbox, dispatch
src/peers/       bin/skein-infer (the inference peer), a remote cron provider
src/dev/         bin/skein-dev, bin/skein-explore (a read-only explorer)
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

Vocabulary: the **host** is transports + providers + store + oracle (there
is no "router"; the dispatch table routes); the **kernel** is the machine,
the four tables and the oracle import; **admin operations** are kernel
operations, not programs; every other thing is an **app** under its own
name; a **box** is a mailbox address in the dispatch table; **emit** is the
one way out (a signed message to a key in the address book, or a broadcast
event).

## Contributing

The tracker is issue [#31](https://github.com/shruggr/skein/issues/31):
decisions, conventions and what is ready to build. Where a doc and an issue
disagree, the issue is right.
