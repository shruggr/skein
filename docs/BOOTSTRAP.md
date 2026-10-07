# Bootstrap: one loader, two sources (issue #4)

An instance boots from a **system tree**. The loader (`src/host/boot.ts`)
**pre-fills the store** with the tree's objects and writes the genesis from the
tree's config and dispatch rows, naming the tree. When the kernel processes
that genesis it sets the head `main` to the tree. The result is the state an
authorised `objects` + `head` pair would have produced, written directly. It is
also a function of the log: a replay copies the tree (`replay.zig` copyLog) and
reproduces the store exactly.

The objects come from one of two sources. Both go through the same code:

- **A: a git tree on disk.** A directory is scanned into git objects in memory
  (`scan.ts`): `skein-host add <h> --boot <dir>`. A tree already in a store
  works too: `--boot <tree-cid> [--from <store.db>]`.
- **B: a chain packet.** A BEEF bag of the transactions that carry the objects,
  plus a scope, verified offline (`src/host/packet.ts`):
  `skein-host add <h> --packet <file> [--scope <cid>] [--proofs roots.json]`.

An instance with no tree (a plain `skein-host add`, and so the live agents)
gets the **default system in code** through the same writer
(`genesis.ts codeSystem`). That is the kernel's pinned programs,
`STOCK_DISPATCH`, `STOCK_HTTP` and `STOCK_READS` (#77). The host's
hydration of an empty store calls `boot` with this source. A **mailbox
instance** (#40: the dev agents' mailbox, `skein-host add <h> --mailbox --owner <key>`; never a handle's — #131: a handle is registered from a skein, its messagebox that skein's origin) is code genesis
too, with only the kernel's `frontdoor` and `messagebox` programs,
`MAILBOX_DISPATCH` (`:ack` → messagebox, every message from anyone in any
box (`*`) → messagebox), the default http rows and reads, and no peers or
names. **Every genesis that names an owner carries the owner's four admin
rows** first (the kernel's `objects`, `head`, `dispatch`, `peers`
operations): a bare genesis is the four tables and those rows; a bundle adds
what its apps ask for. An **image** names no owner: it carries the claim row
instead, and the owner's rows come with the claim (below, "The default
image").

## The default image

The default image (#89) is the system tree in `images/default/`: one genesis
for everyone, with no owner in it, so that it can be published as one
outpoint later. A new skein starts from it and is then claimed.

```
images/default/
  bin/frontdoor.cid, bin/messagebox.cid   the kernel's pinned modules, by CID (scripts/pin-programs.sh keeps them current)
  bin/wallet.cid, bin/*.json              the wallet (#116, #130) and the program records' inputs and descriptions
  etc/dispatch.json                       the claim row; the messagebox's `:ack` box and BRC-33 http rows (no route to the wallet);
                                          no explorer row (#121: the claim writes it with the owner's key)
  etc/apps.json                           the apps installed at birth (#141) and the owner's read at `/`
  etc/routes.json                         empty
  etc/config.json                         {collect: []}
  apps/chain/, apps/git/, apps/site/      shruggr/skein-chain v0.4.0, skein-git v0.1.3, skein-site v0.7.7: each the tag's git tree
  chain/headers/<first>, chain/tip        the chain part (#132): not in the repo — the host adds it (below)
```

It has the four tables, the programs needed to be reachable (the front
door, the messagebox) and to pay its host (the wallet), wired by the
genesis with no app records; and **three apps installed at birth** (#141):

- **chain** — the chain app, so the chain data the image carries and the
  app that reads it arrive together: its first step loads `chain/headers`
  into `chain/state`, and the host's headers feed is attached from the
  skein's creation (below, "The image's chain part").
- **git** — the app every other app is installed through (by hash, docs/APPS.md §3).
- **site** — the management page, under `/site/` (its own read) and at `/`
  (the owner's read, `{address: "/", prefix: true, program: <site's
  program>, fn: "get", root: "www"}`): a new skein answers its page at its root.

They are installed **as apps**: each has its app record under `<app>/app`,
its rows (each with `app`) and its reads in the `reads` head, exactly what
installing it by messages writes — so the owner upgrades or uninstalls
them like any other app, and an app's state stays its own. `etc/apps.json`
names them:

```json
{ "install": ["apps/chain", "apps/git", "apps/site"],
  "reads": [{ "address": "/", "prefix": true, "program": "site.site", "fn": "get", "root": "www" }] }
```

The loader (`boot`, src/host/boot.ts `installAtBirth`) plans each with
src/host/plan.ts — `readStoredApp` over the app's tree in the image,
`planInstall` against the instance as its genesis will stand,
`planRootRoute` for root's route at `/` — puts the records into the store,
appends the routes to the genesis's `dispatch`, and names the heads in the
genesis's `heads` (`{"chain/app": <record>, "git/app": …, "site/app": …}`),
which the kernel advances when it processes the genesis, after the routes
(as `tree` sets `main`). The CIDs are an install's, with no difference
(#143: no route names a sender, and the install grants no key — what was
"from `$owner`" is a function gated by root in the app's `roles`, git's
`call`; the claim grants root).

- **The explorer** is a route of every genesis (`/explore` and below,
  behind `kernel.brc104`, the front door's `explore` gated by root). Before
  the claim nobody holds root: 403.
### The host image and the host skein (#142)

The host skein is made from the **host image**: `images/host` merged over
`images/default`. Images are starting trees that merge: `images/host` holds
only what it adds — `apps/onboard/` (shruggr/skein-onboard v0.3.4, the
tag's git tree) and `etc/apps.json` `{"install": ["apps/onboard"]}`.
The merge (src/host/boot.ts `mergeImages`) adds every path of the host part
to the default image's tree: a directory in both is merged, a file in both
must be the same blob, and `etc/apps.json` lists are joined (an app in
both is refused); any other path in both is refused, by its path. The
installer's own checks (no route with a key another app has, the heads)
run when the merged image's four apps — chain, git,
site, onboard — are installed at birth. The chain part is added to the
merged tree as to the default one.

The host skein's genesis **names its root** (#143: `root: [<key>]`): the
operator's key (`$SKEIN_HOME/operator.key`, below "Commands"). Booted with
root named, the image's claim route is left out: the genesis's `root` is
what a claim would have granted. The onboarding app's config is written at
birth from the host's settings (`config.onboard`: `domain` from
`SKEIN_HANDLE_DOMAIN`, default the domain of `SKEIN_ROUTER_ORIGIN`;
`origin` from `SKEIN_ROUTER_ORIGIN`; `name` from `SKEIN_HOST_NAME`; `note`
from `SKEIN_HOST_NOTE`), merged over the manifest's as an install's
`--config` is: that app record is this host skein's own. No claim route, no
claim entry: the skein is published at once. A user skein is unchanged: it
boots from the default image and is claimed (below).

The settings shape the host skein once, at its birth. A later change to
host.env does not reach into it; to change the onboarding app's config, the
operator installs the same tree again with `--config` (`skein install
images/host/apps/onboard --instance host --config <file.json>`).

### The image's chain part (#132)

**The image carries the whole header chain**, and grows with every header
the host receives. Headers are network facts, not host facts, so they may
be in the image; a skein holds the chain from genesis (every proof is
verifiable, no checkpoint) and never asks for a header: headers are pushed.
The default image is therefore a **host-maintained tree**: the static part
(the repo's `images/default`, above) with `chain/` added at its root:

```
chain/headers/<first>   the raw 80-byte headers, concatenated in height order, 2016 per block; <first> the
                        first one's height in 8 digits (00000000, 00002016, …); every block but the last
                        is full, the last holds the rest
chain/tip               {"height":<n>,"hash":"<the last header's hash, display hex>"} and a newline
```

The format is skein-sdk's (`chain/src/image.zig`); the host writes the same
bytes (`src/host/image-chain.ts`):

- **Grown per header.** Every header the host's headers feed brings
  (`SKEIN_HEADERS_URL`, feeds.ts: the host listens to it itself, besides
  the instances it subscribes) is appended: a new tree per header — the
  last block (at most 2016 × 80 bytes), the tip, the two trees above them
  and the root are rewritten; every full block stays as it is. A header
  that links a little below the tip replaces from there (a reorg).
- **Filled from history.** At start, the host fills the chain from the
  feed's chaintracks service — its history by height, `…/headers?height=&count=`
  beside `…/tip/stream` (80 bytes a header) — from genesis the first time,
  afterwards from a little below its tip (a restart, a gap, a deeper reorg).
  A header the feed brings that links to none near the tip goes the same
  way; with no history service (a feed that is not chaintracks') it is
  dropped and logged.
- **Checked as the chain app checks**: each header links to the one
  before, its target is usable, its hash meets it. The host does not judge
  the network: the chain app refuses an image whose first header is not its
  configured network's genesis.
- **Kept in host.db**: the chain part's git objects in `image_blocks` (only
  the current ones: what a write replaces it deletes), the current root and
  `chain` tree in `host_settings` (`image`, `image_chain`). The static part
  is scanned from the repo as before.

**A skein is born with the chain up to the current tip, and the chain app
to read it** (#141): the instance manager's `create` (and `skein-host
init`, `skein-host add <h> --image default`) boots from the image as it
stands — after the first fill at start — so its tree, and its store, carry
`chain/headers`, and its table the chain app's event row. The chain app
(shruggr/skein-chain 0.4.0) loads them into its empty `chain/state` at its
first step (it reads `main`, the genesis's tree; its docs/CHAIN.md, "Born
with the chain"). Replay: the image tree is the genesis's, so the chain app
loads the same; nothing new is in the log.

**The feed from the first second** (#141). The host subscribes a skein to
its headers feed while its table has a row taking events in box `chain`
(#102) — with the chain app in the image, from its creation (`create`
subscribes it as it enables it; an instance added offline, at its first
load). On subscribing (and on every resubscription: a host restart, a skein
enabled again) the host first pushes the headers the skein lacks — from its
tip (its `chain/state`'s last header, else its tree's `chain/tip`) to the
host's, read from the image's chain part in turn with its writes, in runs of
2016 (`{kind: "header", raws}`) — and the live stream after them: a live
header that arrives meanwhile waits behind them, and one they carry is not
pushed twice (feeds.ts `host`, image-chain.ts `after`, `skeinTip`). A tip
the image does not hold at its height (a fork) is pushed from six below it.
Still push-only: the skein asks for nothing. An instance made before #132
has no `chain/` in its tree and no chain state: nothing is pushed before the
live stream.

Costs on mainnet (about 970 000 headers, 2026-10): the chain part is
78 MB of header blocks in host.db; filling it from a local chaintracks
takes about 10 s; each new skein's store starts with those 78 MB, and the
chain app's first step takes about 15 s and adds about 330 MB (each header
as its own block, and the `headers` and `heights` maps). A host store
shared by the skeins (backlog) would hold the blocks once.

A host with no headers feed has no chain part: the image is the static part
alone, as before.

The image's genesis is written by `skein-host add <h> --image <spec>`:

- `default` (the default image as this host holds it: `images/default` with
  its chain part, #132), a directory, or a tree CID with `--from <store.db>`;
- an outpoint (`<txid>_<vout>`) is refused for now: an image on chain is read
  through the ORDFS app, which is not built yet.

The host brings only its own facts to an image's genesis: the instance's
identity, handle and domain, its providers in the address book, where its
domain resolves, its defaults. There is no `root`, no root holder's
mailbox, no inference peer and no names. A tree whose genesis would name no
root must carry a claim route (the loader refuses it otherwise), and
`$owner` anywhere in it is refused (#143). The host skein is the one image
booted with root named (above). The heads' owner column is unaffected: it
is the app a head's name belongs to, not a key.

### The claim

The claim route is

```json
{ "transport": "mailbox", "address": "claim", "program": "kernel", "fn": "claim" }
```

A message in box `claim` whose body is `{messagebox?: <url>, handle?,
domain?}` is the kernel's `claim` operation (docs/VM.md). **Its sender is
granted root** (#127, #143): the key that signed it, never a key in the
body. In one step, under the message's entry, the kernel:

1. grants root to the sender (the head `grants`);
2. removes the claim route;
3. points the head `claim` at `{claimant: <the sender>, messagebox?,
   handle?, domain?}` (what was claimed);
4. with a `messagebox`, writes the claimant's address-book entry (source
   `claim`), so that what the instance sends it can be delivered.

A second claim finds no route: recorded, nothing runs. A claim into an
instance where root is held already is refused and nothing is written.

The host holds no owner's key and signs no claim. The claim comes one of
two ways:

- **A bare image** (`skein-host add --image`): the route takes anyone, and
  whoever sends the claim first is root. It is not meant to be
  secure: the operator claims a self-hosted instance the first thing once it
  runs — `skein claim [--messagebox url] [--handle h@d] (--instance <handle>
  | <its origin>)`, signed with the operator's key.
- **A hosted registration** (the onboarding app's `onboard.create`): the
  registrant's wallet signs the claim **before the instance exists** — a
  message in box `claim` that names no recipient (the one message that may
  name none; one of the few a sender signs itself, #126 step 4 — counterparty
  anyone, so the sender's key alone checks it) — and sends it in the request. The
  instance manager's `create` (#90) adds the row disabled, boots it from
  the image, **forwards that signed message** as a `local` request — the
  instance's first entry after its genesis — and waits for the kernel to
  take it; the door checks the signature, the kernel grants root to the
  signer. Only then is the row enabled, which publishes its hostname, so
  nothing reaches the claim route first. A claim
  whose sender is not the registrant, or whose signature does not hold, is
  refused and the instance is left unpublished (docs/ARCH.md, "The host
  skein").

## The system tree

```
bin/<name>.wasm          a handler program: a WASI preview 1 core module or a WASI 0.2 component (#34), stored as a raw block, or
bin/<name>.cid           the CID (raw, bafkrei…) of a module the source or the kernel holds
bin/<name>.json          optional: the program record's {inputs, services, description}
                         (default: the handler inputs {envelope, body, box, sender}, no services)
etc/config.json          optional: {defaults: {k: string}, peers: {role: key}, names: [{identityKey, handle, domain}], collect: [box],
                                   feeds: [{kind: "headers", url, box?}]  (the host holds them; proofs and statuses come from its broadcaster),
                                   owner: {messagebox: url},  (#40: the owner's messagebox, the one peer a genesis names)
                                   libp2p: {topics?: [topic], protocols?: {protocol: program | {program, fn?}}, listen?: [multiaddr]},
                                   (#51: the host's libp2p node runs for the instance)
                                   scopes: {<program name>: [<head name | prefix/>]}}
                                   (#77: the heads a genesis-wired program may advance, over the default
                                   scopes: frontdoor/, mailbox, wallet/, and chain/ for a
                                   program named chain (#78: the chain module); a genesis-wired
                                   overlay engine and its lookup service programs need overlay/
                                   (#79: an overlay writes only under its name; kernel-zig/equiv/overlay.ts)
etc/dispatch.json        the routes (#77, #143): [{transport?: mailbox | event | http | libp2p, address, prefix?: true,
                         filters?: [filter], program?, fn?, …settings}] — a box, an event's box, an HTTP path or a
                         libp2p topic / "/<protocol>"; the program a bin/ name, a CID, or "kernel" with fn the
                         operation; no program: an http read route (its filters answer). No sender (#143). Required.
                         A tree that names no http route gets the default ones (each dropped when its program is lacking).
etc/apps.json            optional (#141): {install: [<an app's tree>], routes?: [<root's own route>]}
…                        anything else: the instance's own files (SOUL.md, skills/, …)
```

(`etc/subscriptions.json`, `etc/routes.json` and `etc/reads.json`, the
forms before #77 and #115, are refused: they spoke of senders, #143.)

- A **key** in `etc/config.json` (`peers`, `names`) is an identity key in
  hex, `$self`, `$infer` or a host provider's `$<name>`. `$owner` is gone
  (#143): root is the genesis's `root` (the host's), or a claim's.
- A route's **program** is a `bin/` name or a program record's CID. A route
  to a program the system lacks is dropped. A route whose key is an admin
  route's (`objects`, `head`, `dispatch`, `peers`, `grant`) is left out:
  those are the kernel's.
- **Routes** (#40, #77, #143) are the kernel's route table
  (docs/MESSAGES.md): an `http` route is an exact address or a prefix
  (exact first, then the longest prefix), its filters and the program and
  function the front door calls with the request. The default http routes
  are the handshake (`/.well-known/auth` → the front door's `handshake`),
  the BRC-33 messagebox — `sendMessage`, `listMessages`,
  `acknowledgeMessage` at the root and under `/messagebox` (program
  `messagebox`, behind `kernel.brc104`) — and the explorer, prefix
  `/explore` (program `frontdoor`, fn `explore`, behind `kernel.brc104`,
  gated by root: `etc/config.json`'s `roles` add to the stock
  `{root: ["frontdoor.explore"]}`).
- **Files** (#52, #125): serving files is a function, skein-sdk's `files`
  module (`files.serve(a, req, tree, files.rowOptions(req))`), which any
  http handler calls with the tree it picks — its own app's
  (shruggr/skein-site serves its tree's `www`), a head's, any CID. A row to
  such a handler carries its settings, e.g. `{"transport": "http",
  "address": "/site", "prefix": true, "filters": ["site.get"], "root":
  "www"}` (a read route: the site's filter answers); `root` and `index` are passed to
  the handler as the row that matched (docs/MESSAGES.md, "Files"). The
  static app (shruggr/skein-static) is archived.
- **`owner.messagebox`** becomes the genesis's `defaults.ownerMessagebox`:
  where the instance delivers what it sends its owner. Unset, the host's
  (`SKEIN_OWNER_MESSAGEBOX`, else the owner's dev mailbox on this host, `add --mailbox`)
  fills it. It is the only peer a genesis names: the address book
  (head `peers`, one of the kernel's tables) is written by the kernel's
  `peers` operation on the owner's messages (`skein peers`, or the owner's wallet) only — no
  program writes it. The resolve program keeps what it finds under its own
  name (`resolve/peers`), which the messagebox's delivery reads for a key
  the address book does not name.
- **`libp2p`** (#51) becomes the genesis's `libp2p: {topics, protocols,
  listen?}`: the host's libp2p node runs for the instance (its own peer key,
  derived from the instance's root key, key ID `libp2p:<handle>`, #129), subscribes
  `topics` and serves `protocols`. Each topic message and stream frame is a
  front-door step routed by the dispatch table's `libp2p` row for the topic
  or protocol (docs/MESSAGES.md, "libp2p"): a topic's row comes from
  `etc/dispatch.json` (`{transport: "libp2p", address: "<topic>", program,
  fn}`, or the older `etc/routes.json`'s `libp2p:<topic>` path); a protocol
  names its handler here — a program (fn `libp2p`) or `{program, fn}` —
  which becomes its row unless the tree has one. `listen` is this node's
  addresses over the host's `SKEIN_LIBP2P_LISTEN` (a fixed port belongs to
  one node). No `libp2p` and no libp2p row: no node. The host-wide settings
  (listen, bootstrap, DHT, relays, mDNS) are the host's, not the tree's
  (scripts/host/README.md).
- **Programs.** The genesis `programs` are one record per `bin/` module
  (`{kind: "program", name, code: {wasm}, inputs, services, description}`),
  plus the kernel's front door when the tree brings none. There is no shell
  (#83): the shell is the shell app, installed on top. Handler modules no
  longer enter through the pinned table: their CIDs come from the tree.
- A `.wasm` is accepted by its preamble: a core module (version 1) or a
  component (version 0x0d, layer 1). Either is stored as a raw block, and the
  kernel's runner tells them apart when it runs one (`runner.zig`). Anything
  else is refused.
- **Defaults** come from the tree. They stack in this order, later over
  earlier: `DEFAULTS`, the host's defaults (`genesis.defaults`),
  which only fill what the tree leaves unset, then the tree's `defaults`. An
  instance's behaviour comes from its tree. The one exception is an explicit
  dev override, `SKEIN_FUEL_PER_STEP`: it wins over the tree, and the host
  logs a warning when it replaces a value the tree set.
- `peers` and `names`, when the tree omits them, are the host's (as in code
  genesis). `collect` defaults to `["completions"]`.
- The genesis gains `tree: <root>`. It is a git-raw CID, checked by
  `log.zig isGenesis`. The head `main` moves at the genesis with no thread
  (`thread` is absent from that head update).

`skein-host system <dir>` writes the default system as such a tree:
`bin/*.cid` + `bin/*.json` taken from the kernel's own records, plus `etc/`
(`config.json` with the default `scopes` and `roles`, `dispatch.json`).
Booting from it unchanged gives the same programs and rows as code genesis,
plus the tree.

The default `etc/dispatch.json` has no `register` box (#40): registration —
a sender making itself reachable — is **application wiring**, not
core. An application that wants it adds its own row, with its own rules on
who may call it: e.g. `{"address": "register", "program": "resolve"}` (anyone;
the resolve program's claim handler records `{handle, domain}` under
`resolve/peers` — never the address book, #87 — only if the
handle resolves to the sender), or a route to a function of its own
gated by a role it grants (#143). Without one, the admin
configures the address book (`skein peers add <key> <mailbox-url>
[--handle h@d] <origin>`: the kernel's `peers`
operation), and a sender
in it is answered; any other sender on an open box is still admitted, and
an answer to it fails with "no route".

## Installing an app

Apps live in their own repos (#71). Each repo is the app's tree: `bin/`,
`etc/app.json` (the manifest, docs/APPS.md §2), and whatever the app serves.

| repo | what | in a tree |
|---|---|---|
| shruggr/skein-shell | the shell app (#83): `run` (a command over a tree, row `run` from the owner: the box `shell/run`, #128) and the shell itself — brush, coreutils, the toolset, python's stdlib, each a file of its tree, declared as a shell program in its manifest (docs/APPS.md §6b) | `skein install https://github.com/shruggr/skein-shell#<commit> <origin>` (below). A genesis has no shell: an instance runs commands only once this is installed |
| shruggr/skein-chat | the chat app (#83): the turn loop, rows `chat` from the owner and from anyone; its `bash` calls run the shell app's shell when the instance has the shell app | `skein install https://github.com/shruggr/skein-chat#<commit> <origin>` |
| shruggr/skein-site | the management site (#92; an app since #125): its filter `get` serving its own tree's `www` (skein-sdk `files`) | `skein install https://github.com/shruggr/skein-site#<commit> <origin>`: its read route under `/site/`; then, if root wants the page at `/`, root's own read route (#143): `skein routes add --prefix --filters site.get --settings '{"root":"www"}' / <origin>` (docs/APPS.md §3, "The management page") |
| shruggr/skein-chain | the chain module (#78; 0.2.0, #79): the one writer of the instance's chain state under `chain/state`; ingest a BEEF, broadcast, answers on each state change | `skein install https://github.com/shruggr/skein-chain#<commit> <origin>`: its routes (#143) — an event route `chain`, a mailbox route `chain` behind `kernel.beef`, `status` (the box `chain/status`, #128); or at boot, `bin/chain.wasm` and those routes in `etc/dispatch.json` (there written `chain/status`: a genesis route is as written) (the default scope `chain: ["chain/"]` covers its writes). The wallet and the overlay apps need it |
| shruggr/skein-overlay | the overlay services engine (#36; 0.3.0, #79: its state under its name, over the chain app) and its demo topic manager and lookup service; the topic/lookup contract as Zig modules | `skein install https://github.com/shruggr/skein-overlay#<commit> <origin>` (after the chain app: `requires chain/1`): its wiring derived from `config.overlay` (docs/APPS.md §6), its topics subscribed by the instance's libp2p node; or at boot, a system tree (docs/OVERLAY.md in that repo) |
| shruggr/skein-git | the git app (#91): `git.clone {url, hash}` from the owner, box `git` — one commit fetched through the fetch provider, checked against the hash, kept in the store, its app record built and answered (deploy by hash, below) | `skein install https://github.com/shruggr/skein-git#<commit> <origin>` |

The SDK they build against is shruggr/skein-sdk, a sibling repo: a Zig
package dependency by URL+hash (#75), not a path in this tree. Developing
both at once: `scripts/sdk-local.sh` (README.md).

There are three ways to install an app.

- **At boot**, an app is part of a system tree. Copy the repo's `bin/`
  entries the tree needs into its `bin/`, its rows into `etc/dispatch.json`
  and, since a genesis-wired program has no app record, the heads it writes
  (its name's prefix, `<name>/`) as `scopes` in `etc/config.json`. Then `skein-host add <h> --boot <dir>` (above).
- **Into a running instance** (#72, #76, #124, #142, built): the owner's
  messages. The client `skein` builds them, signs them in its own process
  with the operator's key (`SKEIN_OPERATOR_KEY`, default
  `$SKEIN_HOME/operator.key`) and delivers them; the management page builds
  the same messages and sends them from the owner's wallet.

  ```
  skein install <catalog-name | url#commit | dir> (--instance <handle> | <origin>) [--config <file.json>] [--dry-run]
  skein uninstall <app> (--instance <handle> | <origin>) [--dry-run]
  ```

  Where they go: `--instance <handle>` is an instance on this host machine —
  its row in `$SKEIN_HOME/host.db`, its store read read-only, each message
  handed to the running host over its control socket (`host.sock`, op
  `message`: appended as a signed `local` request, the path a forwarded claim
  takes; the front door checks the signature). An origin is an instance
  anywhere: one BRC-104 session carries the messages (dag-cbor bodies) and
  the explorer's reads. No other process is started. `--store <runtime.db>`
  plans from a store file and prints; `--dry-run` prints the prompt and the
  messages (their `/sendMessage` JSON) and sends nothing.

  A catalog name or `<url>#<commit>` is installed **by hash** (below): one
  message to the instance's git app, `git.clone {url, hash}`; the client
  reads the answer from the thread it launched, plans from the stored tree,
  and sends `head`, the rows and `start` — nothing of the app's tree or
  modules crosses from the client. A catalog name is looked up in the
  instance's own site tree (`www/catalog.json` of its `site/app`). An
  instance with no route at box `git` is refused before anything is sent;
  git's `call` is root's (#143), so a key without root gets nothing back. A directory is read on the client's machine and the objects the
  instance lacks are sent (`objects`, ≤ 1 MiB per message, a larger record
  alone in its own); a tree the instance holds already (an image's app,
  `images/default/apps/<app>`) sends only the head and what changes.

  The checks (docs/APPS.md §2, §3; src/host/manifest.ts, plan.ts): every
  `requires` interface provided by an installed app's `*/app` head; the
  name free; no route with a key the genesis, root or another app has;
  another app's filter declared by that app. The prompt: the head
  `<app>/app`, each route (`route <transport> <address> [<filters>] →
  <role>.<fn> | (a read)`: an http address under `/<app>/`, a libp2p topic
  or protocol as it is), its filters and roles, `start`/`stop`, `requires`/`provides`,
  what an overlay publishes, and the messages. An overlay app's wiring
  (docs/APPS.md §6) is derived from its `config.overlay` and marked
  "(derived: config.overlay)". The messages, in order, each a kernel
  operation on an admin box (src/client/admin.ts):

  1. `objects`: what the instance lacks of the tree's git objects, its
     `bin/*.wasm` modules, a program record per program (with `app:
     <name>`), and the **app record**, no root named (an app never becomes
     `main`);
  2. `head` `{name: "<app>/app", tree: <the app record>}` (#79: no alias head;
     a manifest in the form before #77 is refused);
  3. `dispatch` `{op: "add", row}` per route (#143: no sender, no key
     granted), an http address under `/<app>/`, `app: <name>` on the route. The host's libp2p
     node follows the dispatch table: an installed libp2p topic is
     subscribed, a protocol served, live — the node started if the instance
     had none;
  4. the manifest's `start` body into the app's box.

  The client waits until the head names the record, then says so.
  Installing an app that is installed already is the upgrade: its `state`
  is kept, what the old version asked for and the new one does not is
  removed, and `start` is sent again. `uninstall` sends `stop`, then removes
  the app's rows (its libp2p topics unsubscribed); the heads are left.

  One at a time, the same way: `skein deploy <dir>` (objects and `head
  main`), `skein routes add|remove [--transport t] [--prefix] [--filters
  f,g] [--fn f] [--settings <json>] <address> [<handler>]` (#143: root's
  own route — a box, an http path, the site's read route at `/`; the
  handler a program record CID, a genesis program or `<app>.<role>`, an
  installed app's; an app's own routes come through `install`), `skein
  grant add|remove <key> [--role root|<app>.<role>]`, `skein peers …`,
  `skein host …` (#130), `skein claim`.
- **By hash, from a page** (#91, built): the clone happens in the VM. With
  the git app installed, two owner-signed steps:

  1. `{fn: "git.clone", args: {url, hash}}` to box `git`. The git app
     fetches that one commit through the fetch provider (git smart HTTP,
     protocol version 2: the advertisement, then one shallow pack), checks
     every object against the hash, puts the commit, its trees and blobs as
     git-raw blocks, builds the app record (and its program records and
     modules) from `etc/app.json` exactly as `install` would, and answers
     `{tree, app}`. It moves no head.
  2. The install as above, without `objects`: the client reads the manifest
     out of the stored tree by CID (reads are open), checks it and the
     instance, rebuilds the app record (src/host/install.ts `readStoredApp`
     + `planInstall`: its CID must be the answer's `app`), shows the prompt,
     and the owner sends `head`, the `dispatch` rows and `start`.

  The management page (shruggr/skein-site, #92) does this: it sends the
  clone as a message to box `git` and reads the answer from the thread that
  message launched (the explorer's `/explore/edges/<message>?rel=launched-by`,
  then `/explore/thread/<origin>` until it rests), plans in the browser with
  the same code (src/host/plan.ts), and shows the prompt.
  kernel-zig/equiv/git-clone.ts drives both steps against a repository served
  by `git http-backend`; kernel-zig/equiv/site.ts does it from the page.

## Packets

```
packet   dag-cbor {kind: "skein-packet", version: 1, scope: CID, beef: bytes,
                   index?: [{tx: CID (bitcoin-tx), vout: int, cid: CID}]}
scope    a git tree   → a system tree: boot a new instance from it
         a skein-state record (#30) → a checkpoint: restore the instance
beef     BRC-62 BEEF (V1/V2) of the carrier transactions
carrier  output script OP_FALSE OP_RETURN <content-type> <payload>
           ordfs/dir     a gib directory manifest (gib-cli ordfs-formats): resolves to the git tree of its entries
           ordfs/patch   [0x00][36-byte base outpoint][vcdiff]: resolves to apply(delta, resolve(base))
           other         the payload as it is
index    where each object is; without it, every carrier output is resolved and keyed by every CID its bytes hash to
```

A resolved payload is the object for a CID if it hashes to it. For a git blob
that means either the whole object (`blob <n>\0…`) or the file's bare content
framed as a blob, which is how ORDFS and gib carry files. A bitcoin-tx CID is
served by the bag's own transaction with that txid. So a gib commit (a git tree
on chain) and a clone of it yield the same store.

### What verifies what

| check | how | refusal |
|---|---|---|
| scope | the packet's scope must be the root the caller names (`--scope`); a boot takes the scope as its tree | `scope-mismatch` |
| content addressing | every object is hashed against its CID: git sha1 for blobs and trees, sha2-256 for raw and dag-cbor, dbl-sha2-256 for bitcoin-tx/-block. Each BEEF txid is checked against its body. The kernel's `putblock` checks each hash again as it stores the block | `hash-mismatch` |
| completeness | **system tree:** every tree and blob reachable from the root, patched files walked to their bases, and the module every `bin/<name>.cid` names. **checkpoint:** every link (dag-cbor links, tree entries) from the state record down, plus every extra the index lists. A bitcoin block is walked by its typed links (#42, docs/VM.md "What is stored"): a header to its previous header and its merkle root, a merkle node (a 64-byte bitcoin-tx) to its two children, a transaction to what its inputs spend. Those are optional: the tree and the ancestry are sparse, so a target the instance never held is not missing | `incomplete` |
| chain inclusion | only when asked (`--proofs roots.json`, `chainTracker`): every transaction an object came from (and each patch base) must carry a merkle path in the bag that verifies against the headers. Offline, the headers are a `{height: root}` file | `unproven` |
| shape | dag-cbor with the kind and version; a dag-cbor scope must be a `skein-state` record; ordfs/dir canonical form (sorted names, reserved bits zero); the vcdiff profile (below) | `malformed` |

vcdiff (`src/host/vcdiff.ts`) is RFC 3284 with the default code table and no
secondary compression, which is the profile gib emits. It also accepts
xdelta3's application header and Adler-32 checksum. It is tested against deltas
from go-deltasync/vcdiff, the library 1sat-stack's gateway uses.

### Checkpoints

A checkpoint packet's scope is the instance's state record (#30). Its closure
covers the log, every index map node, every record and tree, and every module
a program names. Records a step wrote that no link reaches go in as **extras**.
An example is a run's args. Extras are listed in the index,
and each is verified and kept. Restoring (`boot` with a checkpoint →
`putblock` for each block, then the kernel's `restore` frame) moves the state
pointer onto the record. The index is **read, not rebuilt**. `restore` only
works on an empty store, and only for this kernel's format. Old spine nodes and
state records (the index history) are left behind. `pack <handle> --checkpoint`
writes one. The restored instance keeps its identity: it must be served by the
same master key and handle (the host checks the signer against the genesis).

### Writing packets

A checkpoint is every block the state record reaches. An instance with the
shell app installed is large: the app record reaches the shell's program
record, and so its modules and python's standard library, and the log
reaches the install's messages that carried them — hundreds of MB, more than
`pack --checkpoint` holds in memory today (it fails with "Invalid array
length"; kernel-zig/equiv/boot.ts checkpoints an instance with the chat app
only).

`skein-host pack <handle|dir|tree-cid> <out>` writes a packet with these options:

- `--form ordfs` (the default) writes trees as ordfs/dir manifests and files as
  bare content, as gib publishes. `--form git` writes every object as it is.
- `--no-index` leaves out the index.
- `--mined roots.json` gives every transaction a merkle path and writes the
  headers' roots.

The transactions are **synthetic**: each has a made-up, unfunded input and
zero-satoshi OP_RETURN outputs. They are **never broadcast**. The writer is a
file format and a test fixture, not a publisher. A real publisher (gib, 1sat
inscriptions or B outputs, funded and broadcast) is out of scope. Its outputs
are read the same way once their carrier shape is mapped onto
(content-type, payload).

## Commands

```
skein-host run                                            the host; on its first run the host skein (#142)
skein-host init [--handle host]                           the first run's part alone: the host skein, once
skein-host grant <key> [--role r] [--remove] [--instance <h>]   a grant in the host skein (#143; root by default)
skein-host system <dir>                                   the default system tree
skein-host add <h> --boot <dir>                           Source A
skein-host add <h> --boot <tree-cid> [--from store.db]    a tree already in a store
skein-host add <h> --packet <file> [--scope cid] [--proofs roots.json]   Source B (tree or checkpoint)
skein-host add <h> --image <default | dir | tree-cid [--from store.db]>  an image: no root, the claim route (#89)
skein-host pack <h|dir|tree-cid> <out> [--from store.db] [--tree cid] [--checkpoint] [--form ordfs|git] [--no-index] [--mined roots.json]
```

**The host's settings** are `$SKEIN_HOME/host.env`: every `SKEIN_*` line
(`KEY=value`, `export` and quotes allowed); the environment wins
(src/host/hostenv.ts). **The operator's key** is the file
`SKEIN_OPERATOR_KEY` names, default `$SKEIN_HOME/operator.key`: one line,
hex or WIF, mode 0600 — used if present, made by `skein-host run` if not.
It is the host skein's root (#143), and the client `skein` signs with it.

`skein-host run` on its first run (no host skein in host.db) makes the
master secret and host.db as before, the operator's key if absent, and the
host skein from the host image (above), published at once, and prints its
identity, its URL, the operator's key and the grant line; then it serves.
Later runs start what exists. `init` is the first run's part alone (no
router left running). `grant <key> [--role root|<app>.<role>] [--remove]`
sends the kernel's `grant` operation — root by default — into the host
skein (or `--instance <h>`): the operator's message, signed with its key,
handed to the running host over its control socket; nothing is sent when
the grants say so already. A browser wallet that should manage the host
skein is granted root this way.

`add --boot/--packet` runs the loader when the row is added, on its new, empty
store (`Router.bootRow` → `bootStore`: a kernel started, `boot`, stopped). The
host then hydrates the instance like any other store, and the kernel
processes the genesis at that first start. The owner is `SKEIN_OWNER` (`bin/skein-host` fills it from `$SKEIN_HOME/owner.identity`). The
command is a one-shot (#61): the host it boots through is closed
(`Router.close()`: its timers, clients, libp2p nodes and kernels) once the
boot is written, and the process exits 0.

## Kernel surface (kernel-zig)

- genesis `tree?`: `log.zig`. Processing sets `main`: `scheduler.zig`.
  `heads.By.thread` is optional (null: the genesis, or a kernel operation, #77).
- `serve` frames: `has` (any codec), `putblock {cid, bytes}` (hash-checked),
  and `restore <state>` (`SqliteStore.restore`).
- `replay.zig` copyLog copies the genesis tree.

## Tests

- `src/host/manifest.test.ts`: the manifest's checks (the rows, the http
  address escapes, the senders, the form before #77 refused, shapes,
  `requires`); `kernel-zig/equiv/install.ts`
  (in `run.sh`): the owner's messages for shruggr/skein-site (and the
  root's read route at `/`, `skein routes` over the control socket,
  which its uninstall leaves) and
  programs/test/app-demo into a running instance, driven, uninstalled,
  replayed. `kernel-zig/equiv/files.ts` (in `run.sh`): skein-sdk's `files`
  through the site's handler (#125), its row and the owner's.
- `src/host/packet.test.ts`: both forms, with and without an index; the
  scope-mismatch, hash-mismatch, incomplete, unproven and malformed refusals; a
  patched file resolved through its base, and incomplete without it.
- `src/host/boot.test.ts`: the tree read and resolved (including a component
  in `bin/`, the order of defaults, the admin routes first, `root`); its
  refusals.
- `src/host/vcdiff.test.ts`: the vcdiff decoder.
- `src/host/image-chain.test.ts` (#132): the image's chain part filled from
  a fake chaintracks history from genesis, grown per header (the full
  blocks kept, the last block and the tip rewritten, the replaced objects
  deleted), a reorg near the tip, a gap filled from the history (dropped
  with none), a restart from host.db, refusals; the boot source the static
  part with `chain/` beside it. `kernel-zig/equiv/image-chain.ts` (in
  `run.sh`): on regtest, N headers in a fake chaintracks' history and M on
  its tip stream, all before any skein exists; a skein created from the
  image holds `chain/headers` and `chain/tip`; the chain app installed, the
  next header is the first header event it takes, and its chain state then
  holds every header from genesis (no feed replay); `add --image default`
  boots from the same image; replayed.
- `src/host/boot.test.ts` also resolves the default image: no root, the
  admin routes and the claim route, the explorer behind `kernel.brc104`
  (root's), no http route at `/`, `/site` or `/manifest.json`; a sender or
  `$owner` refused (#143); and (#141) its apps at birth: the records of
  chain, git and site in the store, their routes with `app`, root's read
  route at `/`, the heads `chain/app`, `git/app`, `site/app`, chain's app
  record and routes the same CIDs as an install by messages over the same
  tree.
- `src/host/image-chain.test.ts` and `src/host/feeds.test.ts` (#141): the
  backfill — a skein whose tip lags the image's gets the headers it lacks,
  in order; one at the tip, past it or with no tip none; a forked tip from
  six below it; a header the image takes before the read is in it; on
  subscribing, live headers wait behind the backfill (pushed as runs), one
  it carries not pushed twice.
- `kernel-zig/equiv/claim.ts` (in `run.sh`): an instance from the default
  image serves the site at `/`, `/site/` and `/manifest.json` and its
  genesis names the heads of its apps (#141), answers nobody's explorer read and
  refuses the owner's admin messages; the owner's own claim (sent on its
  session; a key in its body not read) writes the
  sender's admin rows, removes the claim row, sets the head `claim` and the
  owner's address-book entry, and the owner reads the explorer (another key
  does not); a stranger's claim after it is refused; `skein install
  images/default/apps/git --instance` adds git's owner row (#142: the head
  again and that row); the owner installs app-demo and calls it; an owned instance refuses a claim; `add --image
  default` and the refused outpoint form; a claim signed before the
  instance existed (no recipient), forwarded, makes its signer the owner,
  and a recipient-less message in another box is not admitted; the stores
  replayed.
- `src/host/manager.test.ts`: the instance manager (#90) on signed
  messages: the host skein (#142: from the host image, the operator's admin
  rows, explorer row and git's owner row at birth, no claim row, a claim
  refused) with the manager in its address book; `create`
  forwards the owner's own signed claim into the child before it is
  published (#127: the claim its first entry; no claim, another key's or a
  forged one refused, the child left unpublished), the
  child's book has no manager; refusals as answers; another instance's
  message not acted on; `stop`/`start`.
- `kernel-zig/equiv/host.ts` (in `run.sh`, #90, #142): `skein-host init` —
  the host skein's root the operator's key at birth (#143: no claim route:
  a claim is refused), the onboarding app installed at birth with the
  settings' config; `skein-host grant <key>` (root: the key reads the
  explorer after it; a second grant sends nothing); a client's session creates alice through it
  with its own signed claim (none or another key's refused), alice claimed
  by the client and answering at her url,
  the client installs app-demo in her; a second create refused; both stores
  replayed.
- `kernel-zig/equiv/git-clone.ts` (in `run.sh`, #91): deploy by hash — the
  git app clones a commit of a repository served by `git http-backend`, the
  install client rebuilds the same app record from the stored tree, `head`
  + `dispatch` + `start` install it and it runs; a hash not held, another
  commit's pack, a bad URL, no repository and no manifest refused; the
  client's `skein install <url>#<hash> --instance` (#142): one `git.clone`
  message, then head and row, signed in the client and handed over the
  control socket; a key with no row in box `git` refused before anything is
  sent; replayed.
- `kernel-zig/equiv/site.ts` (in `run.sh`, #92): the management site in
  headless Chrome on a host skein (#142: owned by the operator's key at
  birth, the site and the onboarding app installed at birth, host.env naming
  the host; the onboarding app's tree installed again with `--config`) —
  create from the page, the locator in the
  wallet's basket, the new skein managed from the host's page (chain, git and site there from birth, #141; git's
  owner row added by installing git again as the owner),
  app-demo deployed by hash from the page, the explorer, the host skein's
  children; replayed.
- `src/host/http.test.ts`: the fetch provider's network (`fetchHttp`): a
  request, its `timeoutMs`, its `maxBytes` (#91).
- `kernel-zig/equiv/boot.ts` (in `run.sh`): two instances, one booted from a
  directory and one from a packet of it (mined, proofs checked). Each is
  chatted with over `main` and runs over it. Then a checkpoint is restored on a
  second host: `dump` is identical and it keeps answering. Finally the booted
  stores are replayed Zig against Zig. When the wallet's component build is
  there (`run.sh` builds it), the tree also carries it as `bin/wallet.wasm`,
  and each instance, the restored one included, answers an owner's `list`
  through that component handler.

## Not done yet

- **Extras.** A checkpoint's records that no link reaches travel as index
  extras. A follow-up for the kernel is to make them reachable, for example by
  linking a step's args from its update. Then
  completeness could require them.
- **Real carriers.** Real inscription (1sat `ord`) and B-protocol carriers are
  not mapped yet. Only the OP_RETURN `(content-type, payload)` form is read.
