# Bootstrap: one loader, two sources (issue #4)

An instance boots from a **system tree**. The loader (`src/host/boot.ts`)
**pre-fills the store** with the tree's objects and writes the genesis from the
tree's config and subscriptions, naming the tree. When the kernel processes
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
`STOCK_SUBSCRIPTIONS`, `STOCK_ROUTES` and `STOCK_READS`. The router's
hydration of an empty store calls `boot` with this source. A **mailbox
instance** (#40, `skein-host add <h> --mailbox --owner <key>`) is code genesis
too, with only the kernel's `frontdoor` and `messagebox` programs,
`MAILBOX_SUBSCRIPTIONS` (`:ack` → messagebox, every
message from anyone in any box → messagebox), the stock routes and reads, and
no peers or names.

## The system tree

```
bin/<name>.wasm          a handler program: a WASI preview 1 core module or a WASI 0.2 component (#34), stored as a raw block, or
bin/<name>.cid           the CID (raw, bafkrei…) of a module the source or the kernel holds
bin/<name>.json          optional: the program record's {inputs, services, description}
                         (default: the handler inputs {envelope, body, box, sender}, no services)
etc/config.json          optional: {defaults: {k: string}, peers: {role: key}, names: [{identityKey, handle, domain}], collect: [box],
                                   feeds: [{kind: "headers", url, box?}]  (the router holds them, #33; statuses: the host's broadcaster, #58),
                                   owner: {messagebox: url},  (#40: the owner's messagebox, the one peer a genesis names)
                                   libp2p: {topics?: [topic], protocols?: {protocol: program | {program, fn?}}, listen?: [multiaddr]}}
                                   (#51: the router's libp2p host runs a node for the instance)
etc/subscriptions.json   required: [{sender?: key, box?, handler}]
etc/routes.json          optional (#40): the front door's routes, [{path | prefix, program, fn, auth?: "none", read?: op}]; default the stock routes
etc/reads.json           optional (#40): who may call a route marked `read: op`, [{caller?: key, op}]; default the stock reads
…                        anything else: the instance's own files (SOUL.md, skills/, …)
```

- A **key** is an identity key in hex, or `$owner` / `$infer`. Those are the
  host's (`SKEIN_OWNER`, `SKEIN_INFER`), so one published tree serves any
  owner. A subscription with no `sender` takes anyone.
- A **handler** is a `bin/` name or a program record's CID; so is a route's
  `program`. A route to a program the system lacks is dropped.
- **Routes and reads** (#40) are the front door's tables (docs/MESSAGES.md):
  an exact `path` or a `prefix` (exact paths first, then the longest prefix),
  the program and function the front door calls with the request, `auth:
  "none"` for an open route (an overlay's, docs/OVERLAY.md), else BRC-104,
  and `read` an op the reads table must allow the caller. The stock routes
  are the BRC-33 messagebox — `sendMessage`, `listMessages`,
  `acknowledgeMessage` at the root and under `/messagebox` (program
  `messagebox`) — and the explorer, prefix `/explore` (program `frontdoor`,
  fn `explore`, `read: "explore"`). The stock reads are
  `[{caller: "$owner", op: "explore"}]`: the owner may explore. A tree that
  writes `etc/routes.json` replaces the stock routes whole (include them to
  keep the messagebox); likewise `etc/reads.json`.
- **`owner.messagebox`** becomes the genesis's `defaults.ownerMessagebox`:
  where the instance delivers what it sends its owner. Unset, the host's
  (`SKEIN_OWNER_MESSAGEBOX`, else the owner's mailbox instance on this host)
  fills it. It is the only peer a genesis names: the address book
  (head `peers`) is written only by the instance's own programs (its resolve,
  or the admin through the `peers` box: `skein-host peers`).
- **`libp2p`** (#51) becomes the genesis's `libp2p: {topics, protocols,
  listen?}`: the router's libp2p host runs a node for the instance (its own
  peer key, derived from the master secret, key ID `libp2p:<handle>`),
  subscribes `topics` and serves `protocols`. Each topic message and stream
  frame is a front-door call routed by `libp2p:<topic>` /
  `libp2p:<protocol>` (docs/MESSAGES.md, "libp2p"): a topic's route comes
  from `etc/routes.json` (`{path: "libp2p:<topic>", program, fn}`); a
  protocol names its handler here — a program (fn `libp2p`) or `{program,
  fn}` — which becomes its route unless `etc/routes.json` has one. `listen`
  is this node's addresses over the host's `SKEIN_LIBP2P_LISTEN` (a fixed port
  belongs to one node). No `libp2p`: no node, and the `libp2p` import is
  refused. The host-wide settings (listen, bootstrap, DHT, relays, mDNS) are
  the router's, not the tree's (scripts/host/README.md).
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
(`config.json`, `subscriptions.json`, `routes.json`, `reads.json`).
Booting from it unchanged gives the same programs and subscriptions as code
genesis, plus the tree.

The stock `etc/subscriptions.json` has no `register` box (#40): registration —
a sender entering itself in the address book — is **application wiring**, not
core. An application that wants it adds its own line, with its own rules on
who may call it: e.g. `{"box": "register", "handler": "resolve"}` (anyone; the
resolve program's claim handler records `{handle, domain}` only if the handle
resolves to the sender), or `{"sender": "<key>", "box": "register", "handler":
"<its own program>"}`. Without one, the admin configures the address book
(`skein-host peers <handle> add <key> <mailbox-url> [--handle h@d]`), and a
sender in it is answered; any other sender on an open box is still admitted,
and an answer to it fails with "no route".

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
processes the genesis at that first start. The owner is `SKEIN_OWNER`.

## Kernel surface (kernel-zig)

- genesis `tree?`: `log.zig`. Processing sets `main`: `scheduler.zig`.
  `heads.By.thread` is optional.
- `serve` frames: `has` (any codec), `putblock {cid, bytes}` (hash-checked),
  and `restore <state>` (`SqliteStore.restore`).
- `replay.zig` copyLog copies the genesis tree.

## Tests

- `src/host/packet.test.ts`: both forms, with and without an index; the
  scope-mismatch, hash-mismatch, incomplete, unproven and malformed refusals; a
  patched file resolved through its base, and incomplete without it.
- `src/host/boot.test.ts`: the tree read and resolved (including a component
  in `bin/`, and the order of defaults); its refusals.
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
