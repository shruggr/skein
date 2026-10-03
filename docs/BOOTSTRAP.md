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
instance** (#40, `skein-host add <h> --mailbox --owner <key>`) is code genesis
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
  bin/static.wasm                         shruggr/skein-static v0.2.0's module
  bin/*.json                              the program records' inputs and descriptions
  etc/dispatch.json                       the claim row; the messagebox's `:ack` box and BRC-33 http rows; static at `/` (root www)
  etc/routes.json, etc/reads.json         empty: no explorer route (there is no owner to give it to at genesis)
  etc/config.json                         {collect: []}
  www/index.html                          the management site (#92); a placeholder page until it exists
```

It has the four tables and the apps needed to be reachable and to install
more: the front door, the messagebox and the static app serving the
management site. Nothing else — no wallet, no chain app, no shell, no chat:
the owner installs those afterwards. The front door, the messagebox and
static are wired by the genesis (no app records), as any system tree wires
its programs.

The image's genesis is written by `skein-host add <h> --image <spec>`:

- `default` (the repo's `images/default`), a directory, or a tree CID with
  `--from <store.db>`;
- an outpoint (`<txid>_<vout>`) is refused for now: an image on chain is read
  through the ORDFS app, which is not built yet.

The host brings only its own facts to an image's genesis: the instance's
identity, handle and domain, its providers in the address book, where its
domain resolves, its defaults. There is no `owner`, no owner's mailbox, no
inference peer and no names. A tree whose genesis would name no owner must
carry a claim row (the loader refuses it otherwise), and `$owner` anywhere
in it is refused. The heads' owner column is unaffected: it is the app a
head's name belongs to, not a key.

### The claim

The claim row is

```json
{ "transport": "mailbox", "address": "claim", "sender": "*", "program": "kernel", "fn": "claim" }
```

A message in box `claim` whose body is `{owner: <key>, messagebox?: <url>,
handle?, domain?}` is the kernel's `claim` operation (docs/VM.md). In one
step, under the message's entry, the kernel:

1. adds the owner's four admin rows (`objects`, `head`, `dispatch`, `peers`,
   each from `owner` to the kernel);
2. removes the claim row;
3. points the head `claim` at the body (what was claimed: how the kernel and
   the host know the owner of an instance whose genesis names none);
4. with a `messagebox`, writes the owner's address-book entry (source
   `claim`), so that what the instance sends its owner can be delivered.

A second claim finds no row: recorded, nothing runs. A claim into an
instance whose genesis names an owner, or whose table has an admin row
already, is refused and nothing is written.

The host delivers the claim with `skein-host claim <h> <owner-key>
[--messagebox url] [--handle h@d]` (Router.claim). It is a signed message
from the host's instance-manager provider (`manager`), appended as a `local`
request: the body is what was asked. Without `--messagebox`, the owner's
mailbox instance on this host is used if there is one. While `skein-host
run` is up the claim goes through its control socket; otherwise the command
runs a router of its own. The row admits anyone, so the race is closed by
order: the instance manager's `create` (#90: `skein-host init` for the host
skein, the onboarding app's request for anyone else) adds the row disabled,
boots it from the image, delivers the claim and waits for the kernel to
take it, and only then enables the row, which publishes its hostname. The
claim is the instance's first entry after its genesis (docs/ARCH.md, "The
host skein").

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
                                   scopes: frontdoor/, mailbox + outbound, wallet/, and chain/ for a
                                   program named chain (#78: the chain module); a genesis-wired
                                   overlay engine and its lookup service programs need overlay/
                                   (#79: an overlay writes only under its name; kernel-zig/equiv/overlay.ts)
etc/dispatch.json        the dispatch rows (#77): [{transport?: mailbox | http | libp2p, address, prefix?: true,
                         sender?: "*" | "session" | key, program, fn?, …settings}] — a box, an HTTP path or a libp2p
                         topic / "/<protocol>"; the sender a key (hex, $owner, $infer, or a host provider's $<name> —
                         $status, $cron; one naming a provider the host has not is left out) or "*" (anyone, the
                         default); the program a bin/ name, a CID, or "kernel" with fn the operation. One of this
                         file or etc/subscriptions.json is required.
etc/subscriptions.json   the form before #77, still read: [{sender?: key, box?, handler}], each a mailbox row
etc/routes.json          the form before #77, still read (#40): [{path | prefix, program, fn, auth?: "none", read?: op, root?, index?}],
                         each an http row (auth none → sender "*", else "session") or, for a `libp2p:` path, a
                         libp2p row; default: the default http rows (root, index: the static handler's, #52)
etc/reads.json           optional (#40): who may call a route marked `read: op`, [{caller?: key, op}]; default: the default reads
…                        anything else: the instance's own files (SOUL.md, skills/, …)
```

- A **key** is an identity key in hex, or `$owner` / `$infer`. Those are the
  host's (`SKEIN_OWNER`, `SKEIN_INFER`), so one published tree serves any
  owner. A row with no `sender` (or `"*"`) takes anyone.
- A row's **program** is a `bin/` name or a program record's CID. A row to a
  program the system lacks is dropped. A row whose key is an admin row's
  (the owner's `objects`, `head`, `dispatch`, `peers`) is left out: those are
  the kernel's.
- **Rows and reads** (#40, #77) are the kernel's dispatch table and the
  front door's reads (docs/MESSAGES.md): an `http` row is an exact address
  or a prefix (exact first, then the longest prefix), the program and
  function the front door calls with the request, sender `"*"` for an open
  route (an overlay's, docs/OVERLAY.md), `"session"` for BRC-104, and
  `read` an op the reads table must allow the caller. The default http rows
  are the BRC-33 messagebox — `sendMessage`, `listMessages`,
  `acknowledgeMessage` at the root and under `/messagebox` (program
  `messagebox`) — and the explorer, prefix `/explore` (program `frontdoor`,
  fn `explore`, `read: "explore"`). The default reads are
  `[{caller: "$owner", op: "explore"}]`: the owner may explore. A tree that
  writes `etc/routes.json` replaces the default http rows whole (include them
  to keep the messagebox); likewise `etc/reads.json`.
- **Static files** (#52): an app, shruggr/skein-static (#71), not pinned:
  a tree that serves files wires it — `bin/static.wasm` (copied from that
  repo's tree; `bin/static.cid` if the instance already holds the module),
  optionally `bin/static.json`
  (`{"inputs": {}, "description": …}`), and a row to it in
  `etc/dispatch.json`, e.g. `{"transport": "http", "address": "/site",
  "prefix": true, "sender": "*", "program": "static", "fn": "get", "root":
  "www"}` (and, for the site's root, `{"address": "/", …, "root":
  "www"}`). `root` and `index` are the row's settings, passed to the
  handler as the row that matched
  (docs/MESSAGES.md, "Static files"). The files are the tree's own
  (`www/…`), served from the `main` head's tree as it stands.
- **`owner.messagebox`** becomes the genesis's `defaults.ownerMessagebox`:
  where the instance delivers what it sends its owner. Unset, the host's
  (`SKEIN_OWNER_MESSAGEBOX`, else the owner's mailbox instance on this host)
  fills it. It is the only peer a genesis names: the address book
  (head `peers`, one of the kernel's tables) is written by the kernel's
  `peers` operation on the owner's messages (`skein-host peers`) only — no
  program writes it. The resolve program keeps what it finds under its own
  name (`resolve/peers`), which the messagebox's delivery reads for a key
  the address book does not name.
- **`libp2p`** (#51) becomes the genesis's `libp2p: {topics, protocols,
  listen?}`: the host's libp2p node runs for the instance (its own peer key,
  derived from the master secret, key ID `libp2p:<handle>`), subscribes
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
(`config.json` with the default `scopes`, `dispatch.json`, `reads.json`).
Booting from it unchanged gives the same programs and rows as code genesis,
plus the tree.

The default `etc/dispatch.json` has no `register` box (#40): registration —
a sender making itself reachable — is **application wiring**, not
core. An application that wants it adds its own row, with its own rules on
who may call it: e.g. `{"address": "register", "program": "resolve"}` (anyone;
the resolve program's claim handler records `{handle, domain}` under
`resolve/peers` — never the address book, #87 — only if the
handle resolves to the sender), or `{"sender": "<key>", "address":
"register", "program": "<its own program>"}`. Without one, the admin
configures the address book (`skein-host peers <handle> add <key>
<mailbox-url> [--handle h@d]`: the kernel's `peers` operation), and a sender
in it is answered; any other sender on an open box is still admitted, and
an answer to it fails with "no route".

## Installing an app

Apps live in their own repos (#71). Each repo is the app's tree: `bin/`,
`etc/app.json` (the manifest, docs/APPS.md §2), and whatever the app serves.

| repo | what | in a tree |
|---|---|---|
| shruggr/skein-shell | the shell app (#83): `run` (a command over a tree, row `run` from the owner) and the shell itself — brush, coreutils, the toolset, python's stdlib, each a file of its tree, declared as a shell program in its manifest (docs/APPS.md §6b) | `skein-host install https://github.com/shruggr/skein-shell --instance <h>`. A genesis has no shell: an instance runs commands only once this is installed |
| shruggr/skein-chat | the chat app (#83): the turn loop, rows `chat` from the owner and from anyone; its `bash` calls run the shell app's shell when the instance has the shell app | `skein-host install https://github.com/shruggr/skein-chat --instance <h>` |
| shruggr/skein-static | the static file handler (#52; 0.2.0: the #77 rows) | `skein-host install https://github.com/shruggr/skein-static --instance <h>`: its rows under `/static/`; or at boot, `bin/static.wasm` and a row (above, "Static files") |
| shruggr/skein-chain | the chain module (#78; 0.2.0, #79): the one writer of the instance's chain state under `chain/state`; ingest a BEEF, broadcast, answers on each state change | `skein-host install https://github.com/shruggr/skein-chain --instance <h>`: rows `chain` from `event`, `$self` and `$owner`, `status` from `$status` (optional); or at boot, `bin/chain.wasm` and those rows in `etc/dispatch.json` (the default scope `chain: ["chain/"]` covers its writes). The wallet and the overlay apps need it |
| shruggr/skein-overlay | the overlay services engine (#36; 0.3.0, #79: its state under its name, over the chain app) and its demo topic manager and lookup service; the topic/lookup contract as Zig modules | `skein-host install https://github.com/shruggr/skein-overlay --instance <h>` (after the chain app: `requires chain/1`): its wiring derived from `config.overlay` (docs/APPS.md §6), its topics subscribed by the instance's libp2p node; or at boot, a system tree (docs/OVERLAY.md in that repo) |

The SDK they build against is shruggr/skein-sdk, a sibling repo: a Zig
package dependency by URL+hash (#75), not a path in this tree. Developing
both at once: `scripts/sdk-local.sh` (README.md).

There are two ways to install an app.

- **At boot**, an app is part of a system tree. Copy the repo's `bin/`
  entries the tree needs into its `bin/`, its rows into `etc/dispatch.json`
  and, since a genesis-wired program has no app record, the heads it writes
  (its name's prefix, `<name>/`) as `scopes` in `etc/config.json`. Then `skein-host add <h> --boot <dir>` (above).
- **Into a running instance** (#72, #76, built): `skein-host install`.

  ```
  skein-host install <repo-url[#rev] | dir> --instance <h> [--approve-all | --dry-run]
  skein-host uninstall <app> --instance <h> [--approve-all]
  ```

  `install` clones the repo (or reads the directory), checks `etc/app.json`
  (docs/APPS.md §2; src/host/manifest.ts), checks the instance (every
  `requires` interface provided by an installed app's `*/app` head; the
  name free; no row with a key the genesis or another app has; every
  `$<provider>` sender in the address book), and prints the permission
  prompt: the head `<app>/app`, each row (`row <transport>
  <address> from <who> → <role>.<fn>`: an http address under `/<app>/`, a
  libp2p topic or protocol as it is), `start`/`stop`, `requires`/`provides`,
  what an overlay publishes, and the messages it will send. An overlay
  app's wiring (docs/APPS.md §6) is derived from its `config.overlay` and
  marked "(derived: config.overlay)". Approved (`--approve-all`, or "y" at
  a terminal; `--dry-run` only prints), it sends them as the owner
  (SKEIN_OWNER_WALLET, as `deploy` does), in order — each a kernel
  operation on an admin box (docs/APPS.md §3, src/host/install.ts):

  1. `objects`: the tree's git objects, its `bin/*.wasm` modules, a program
     record per program (with `app: <name>`), and the **app record**, ≤ 1 MiB per message, no root named
     (an app never becomes `main`);
  2. `head` `{name: "<app>/app", tree: <the app record>}` (#79: no alias head;
     a manifest in the form before #77 is refused);
  3. `dispatch` `{op: "add", row}` per row, the sender resolved, an http
     address under `/<app>/`, `app: <name>` on the row. The host's libp2p
     node follows the dispatch table: an installed libp2p topic is
     subscribed, a protocol served, live — the node started if the instance
     had none;
  4. the manifest's `start` body into the app's box.

  Installing an app that is installed already is the upgrade: its `state`
  is kept, what the old version asked for and the new one does not is
  removed, and `start` is sent again. `uninstall` sends `stop`, then removes
  the app's rows (its libp2p topics unsubscribed); the heads are left.

  By hand, the same messages: `bin/skein import <checkout>` (objects),
  `skein head`, `skein dispatch add [--sender <key>] <box> <handler>` /
  `skein-host dispatch <h> add …` (a mailbox row; http and libp2p rows
  through `install`).

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
same master key and handle (the host checks the oracle against the genesis).

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
skein-host system <dir>                                   the default system tree
skein-host add <h> --boot <dir>                           Source A
skein-host add <h> --boot <tree-cid> [--from store.db]    a tree already in a store
skein-host add <h> --packet <file> [--scope cid] [--proofs roots.json]   Source B (tree or checkpoint)
skein-host add <h> --image <default | dir | tree-cid [--from store.db]>  an image: no owner, the claim row (#89)
skein-host claim <h> <owner-key> [--messagebox url] [--handle h@d]      the owner's claim into an image
skein-host pack <h|dir|tree-cid> <out> [--from store.db] [--tree cid] [--checkpoint] [--form ordfs|git] [--no-index] [--mined roots.json]
```

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
  (in `run.sh`): `skein-host install` of shruggr/skein-static and
  programs/test/app-demo into a running instance, driven, uninstalled,
  replayed.
- `src/host/packet.test.ts`: both forms, with and without an index; the
  scope-mismatch, hash-mismatch, incomplete, unproven and malformed refusals; a
  patched file resolved through its base, and incomplete without it.
- `src/host/boot.test.ts`: the tree read and resolved (including a component
  in `bin/`, the order of defaults, the owner's admin rows first); its
  refusals.
- `src/host/vcdiff.test.ts`: the vcdiff decoder.
- `src/host/boot.test.ts` also resolves the default image: no owner, no
  admin rows, the claim row its one kernel row, no explorer route;
  `$owner` in an image refused.
- `kernel-zig/equiv/claim.ts` (in `run.sh`): an instance from the default
  image serves the placeholder and refuses the owner's admin messages;
  `skein-host claim` over the control socket writes the owner's admin rows,
  removes the claim row, sets the head `claim` and the owner's address-book
  entry; a second claim and a stranger's are refused; the owner installs
  app-demo and calls it; an owned instance refuses a claim; `add --image
  default` and the refused outpoint form; both stores replayed.
- `src/host/manager.test.ts`: the instance manager (#90) on signed
  messages: the host skein with the manager in its address book; `create`
  claims the child before it is published (the claim its first entry), the
  child's book has no manager; refusals as answers; another instance's
  message not acted on; `stop`/`start`.
- `kernel-zig/equiv/host.ts` (in `run.sh`, #90): `skein-host init`, the
  onboarding app installed in the host skein, a client's session creates
  alice through it, alice claimed for the client and answering at her url,
  the client installs app-demo in her; a second create refused; both stores
  replayed.
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
