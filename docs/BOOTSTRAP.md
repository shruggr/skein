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
(`genesis.ts codeSystem`). That is the kernel's pinned programs and
`STOCK_SUBSCRIPTIONS`. Its genesis is byte for byte what code genesis wrote
before. The router's hydration of an empty store calls `boot` with this source.

## The system tree

```
bin/<name>.wasm          a handler program: a WASI preview 1 core module or a WASI 0.2 component (#34), stored as a raw block, or
bin/<name>.cid           the CID (raw, bafkrei…) of a module the source or the kernel holds
bin/<name>.json          optional: the program record's {inputs, services, description}
                         (default: the handler inputs {envelope, body, box, sender}, no services)
etc/config.json          optional: {defaults: {k: string}, peers: {role: key}, names: [{identityKey, handle, domain}], collect: [box]}
etc/subscriptions.json   required: [{sender?: key, box, handler}]
…                        anything else: the instance's own files (SOUL.md, skills/, …)
```

- A **key** is an identity key in hex, or `$owner` / `$infer`. Those are the
  host's (`SKEIN_OWNER`, `SKEIN_INFER`), so one published tree serves any
  owner. A subscription with no `sender` takes anyone.
- A **handler** is a `bin/` name or a program record's CID.
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
`bin/*.cid` + `bin/*.json` taken from the kernel's own records, plus `etc/`.
Booting from it unchanged gives the same programs and subscriptions as code
genesis, plus the tree.

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
| completeness | **system tree:** every tree and blob reachable from the root, patched files walked to their bases, and the module every `bin/<name>.cid` names. **checkpoint:** every link (dag-cbor links, tree entries) from the state record down, plus every extra the index lists | `incomplete` |
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
Examples are a run's args, and the signed part of an emitted §7.2 envelope,
which a compact session reply's `replyTo` names. Extras are listed in the index,
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
  linking a step's args and an emit's signed part from its update. Then
  completeness could require them.
- **Real carriers.** Real inscription (1sat `ord`) and B-protocol carriers are
  not mapped yet. Only the OP_RETURN `(content-type, payload)` form is read.
