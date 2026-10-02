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
gets the **stock system in code** through the same writer
(`genesis.ts codeSystem`). That is the kernel's pinned programs,
`STOCK_DISPATCH`, `STOCK_HTTP` and `STOCK_READS` (#77). The host's
hydration of an empty store calls `boot` with this source. A **mailbox
instance** (#40, `skein-host add <h> --mailbox --owner <key>`) is code genesis
too, with only the kernel's `frontdoor` and `messagebox` programs,
`MAILBOX_DISPATCH` (`:ack` → messagebox, every message from anyone in any
box (`*`) → messagebox), the stock http rows and reads, and no peers or
names. **Every genesis carries the owner's four admin rows** first (the
kernel's `objects`, `head`, `dispatch`, `peers` operations): a bare genesis
is the four tables and those rows; a bundle adds what its apps ask for.

## The system tree

```
bin/<name>.wasm          a handler program: a WASI preview 1 core module or a WASI 0.2 component (#34), stored as a raw block, or
bin/<name>.cid           the CID (raw, bafkrei…) of a module the source or the kernel holds
bin/<name>.json          optional: the program record's {inputs, services, description}
                         (default: the handler inputs {envelope, body, box, sender}, no services)
etc/config.json          optional: {defaults: {k: string}, peers: {role: key}, names: [{identityKey, handle, domain}], collect: [box],
                                   feeds: [{kind: "headers", url, box?}]  (the host holds them, #33; statuses: the host's broadcaster, #58),
                                   owner: {messagebox: url},  (#40: the owner's messagebox, the one peer a genesis names)
                                   libp2p: {topics?: [topic], protocols?: {protocol: program | {program, fn?}}, listen?: [multiaddr]},
                                   (#51: the host's libp2p node runs for the instance)
                                   scopes: {<program name>: [<head name | prefix/>]}}
                                   (#77: the heads a genesis-wired program may advance, over the stock
                                   scopes — frontdoor/, mailbox + outbound, peers, wallet, and chain/ for a
                                   program named chain (#78: the chain module); a genesis-wired
                                   overlay engine needs wallet, overlay:gossip, and each lookup service
                                   program its own ls:<service>: kernel-zig/equiv/overlay.ts)
                                   (no `jobs`, #69: a schedule is a program's message to the cron provider,
                                   docs/MESSAGES.md "Scheduling"; a config naming them is refused)
etc/dispatch.json        the dispatch rows (#77): [{transport?: mailbox | http | libp2p, address, prefix?: true,
                         sender?: "*" | "session" | key, program, fn?, …settings}] — a box, an HTTP path or a libp2p
                         topic / "/<protocol>"; the sender a key (hex, $owner, $infer, or a host provider's $<name> —
                         $status, $cron; one naming a provider the host has not is left out) or "*" (anyone, the
                         default); the program a bin/ name, a CID, or "kernel" with fn the operation. One of this
                         file or etc/subscriptions.json is required.
etc/subscriptions.json   the form before #77, still read: [{sender?: key, box?, handler}], each a mailbox row
etc/routes.json          the form before #77, still read (#40): [{path | prefix, program, fn, auth?: "none", read?: op, root?, index?}],
                         each an http row (auth none → sender "*", else "session") or, for a `libp2p:` path, a
                         libp2p row; default the stock http rows (root, index: the static handler's, #52)
etc/reads.json           optional (#40): who may call a route marked `read: op`, [{caller?: key, op}]; default the stock reads
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
  `read` an op the reads table must allow the caller. The stock http rows
  are the BRC-33 messagebox — `sendMessage`, `listMessages`,
  `acknowledgeMessage` at the root and under `/messagebox` (program
  `messagebox`) — and the explorer, prefix `/explore` (program `frontdoor`,
  fn `explore`, `read: "explore"`). The stock reads are
  `[{caller: "$owner", op: "explore"}]`: the owner may explore. A tree that
  writes `etc/routes.json` replaces the stock http rows whole (include them
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
  `peers` operation on the owner's messages (`skein-host peers`) and, to
  review, by the resolve program's lookups.
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
  plus the kernel's `shell`. The shell is the VM's own program: its modules
  (brush, coreutils, the tools) stay the kernel's pinned ones. Handler modules
  no longer enter through the pinned table: their CIDs come from the tree.
- A `.wasm` is accepted by its preamble: a core module (version 1) or a
  component (version 0x0d, layer 1). Either is stored as a raw block, and the
  kernel's runner tells them apart when it runs one (`runner.zig`). Anything
  else is refused.
- **Defaults** come from the tree. They stack in this order, later over
  earlier: `DEFAULTS`, the host's defaults (the router's `genesis.defaults`),
  which only fill what the tree leaves unset, then the tree's `defaults`. An
  instance's behaviour comes from its tree. The one exception is an explicit
  dev override, `SKEIN_FUEL_PER_STEP`: it wins over the tree, and the router
  logs a warning when it replaces a value the tree set.
- `peers` and `names`, when the tree omits them, are the host's (as in code
  genesis). `collect` defaults to `["completions"]`.
- The genesis gains `tree: <root>`. It is a git-raw CID, checked by
  `log.zig isGenesis`. The head `main` moves at the genesis with no thread
  (`thread` is absent from that head update).

`skein-host system <dir>` writes the stock system as such a tree:
`bin/*.cid` + `bin/*.json` taken from the kernel's own records, plus `etc/`
(`config.json` with the stock `scopes`, `dispatch.json`, `reads.json`).
Booting from it unchanged gives the same programs and rows as code genesis,
plus the tree.

The stock `etc/dispatch.json` has no `register` box (#40): registration —
a sender entering itself in the address book — is **application wiring**, not
core. An application that wants it adds its own row, with its own rules on
who may call it: e.g. `{"address": "register", "program": "resolve"}` (anyone;
the resolve program's claim handler records `{handle, domain}` only if the
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
| shruggr/skein-workbench | `run` (the shell over a tree) and `chat` (the turn loop), and the shell's toolset | nothing to install today: the stock genesis already wires `run` → run-handler and `chat` → loop, and their modules are pinned here (wasm/README.md) |
| shruggr/skein-static | the static file handler (#52) | `skein-host install https://github.com/shruggr/skein-static --instance <h>`: its routes under `/static/`; or at boot, `bin/static.wasm` and a route (above, "Static files") |
| shruggr/skein-chain | the chain module (#78): the one writer of the instance's chain state under `chain/state`; ingest a BEEF, broadcast, answers on each state change | `skein-host install https://github.com/shruggr/skein-chain --instance <h>`: rows `chain` from anyone and `status` from `$status` (optional); or at boot, `bin/chain.wasm` and those two rows in `etc/dispatch.json` (the stock scope `chain: ["chain/"]` covers its writes) |
| shruggr/skein-overlay | the overlay services engine (#36) and its demo topic manager and lookup service | `skein-host install https://github.com/shruggr/skein-overlay --instance <h>`: its wiring derived from `config.overlay` (docs/APPS.md §6), its topics subscribed by the instance's libp2p node; or at boot, a system tree (docs/OVERLAY.md in that repo) |

The SDK they build against is shruggr/skein-sdk, a sibling repo: a Zig
package dependency by URL+hash (#75), not a path in this tree. Developing
both at once: `scripts/sdk-local.sh` (README.md).

There are two ways to install an app.

- **At boot**, an app is part of a system tree. Copy the repo's `bin/`
  entries the tree needs into its `bin/`, its rows into `etc/dispatch.json`
  and, for the heads it writes outside its name, its `scopes` into
  `etc/config.json`. Then `skein-host add <h> --boot <dir>` (above).
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
  prompt: the head `<app>/app`, the grants, each row (`row <transport>
  <address> from <who> → <role>.<fn>`: an http address under `/<app>/`, a
  libp2p topic or protocol as it is), `start`/`stop`, `requires`/`provides`,
  what an overlay publishes, and the messages it will send. An overlay
  app's wiring (docs/APPS.md §6) is derived from its `config.overlay` and
  marked "(derived: config.overlay)". Approved (`--approve-all`, or "y" at
  a terminal; `--dry-run` only prints), it sends them as the owner
  (SKEIN_OWNER_WALLET, as `deploy` does), in order — each a kernel
  operation on an admin box (docs/APPS.md §3, src/host/install.ts):

  1. `objects`: the tree's git objects, its `bin/*.wasm` modules, a program
     record per program (with `app: <name>` and the transitional grants as
     `heads`), and the **app record**, ≤ 1 MiB per message, no root named
     (an app never becomes `main`);
  2. `head` `{name: "<app>/app", tree: <the app record>}` (a manifest in
     the form before #77: the alias `{name: "<app>", tree}` too);
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
same master key and handle (the router checks the oracle against the genesis).

### Writing packets

A checkpoint of a stock-system instance is large: about 88 MB in the test.
The state record reaches the shell's program record, and so its pinned
modules and python's standard library (`python314.zip`). All of these are in
the closure.

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
skein-host system <dir>                                   the stock system tree
skein-host add <h> --boot <dir>                           Source A
skein-host add <h> --boot <tree-cid> [--from store.db]    a tree already in a store
skein-host add <h> --packet <file> [--scope cid] [--proofs roots.json]   Source B (tree or checkpoint)
skein-host pack <h|dir|tree-cid> <out> [--from store.db] [--tree cid] [--checkpoint] [--form ordfs|git] [--no-index] [--mined roots.json]
```

`add --boot/--packet` runs the loader when the row is added, on its new, empty
store (`Router.bootRow` → `bootStore`: a kernel started, `boot`, stopped). The
router then hydrates the instance like any other store, and the kernel
processes the genesis at that first start. The owner is `SKEIN_OWNER` (`bin/skein-host` fills it from `$SKEIN_HOME/owner.identity`). The
command is a one-shot (#61): the router it boots through is closed
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
  address escapes, the senders, the form before #77 converted, shapes,
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
