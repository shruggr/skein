# The wallet in the VM

What is built for issue #29 (phase 1 merged; phase 2 on branch
`worktree-agent-aff20e1c30a3be594`). The design is the issue body ("Decided
(2026-09-28)", "Browser with Yours") as revised in its comments (Q3/Q5, "drop
the checkpoint op", "no messagebox for ARC or ChainTracks"); this file
describes what exists. A wallet is two things: a **root key**, which stays
outside as the per-instance **signing oracle** (a ProtoWallet, #18), and
**wallet state**, which lives inside as records. Nothing in the VM holds a
key: every key operation is a call to the oracle.

The wallet runs on the Zig kernel: its transactions and headers are
`bitcoin-tx` / `bitcoin-block` blocks, and it uses the kernel's `emit` and
`deadline` imports (#70: it broadcasts by a message to the host's
broadcaster; kernel-zig/README.md, "For the wallet") — its component build
imports the same `emit` from `skein:kernel/skein`.

## Pieces

- `wallet-zig/` — Zig 0.16.0 (pinned in `mise.toml`), over **bsvz** (pinned
  and patched by `scripts/fetch-bsvz.sh`). The library (`src/`) and the
  handler program (`src/program.zig`, wasm32-wasi → `wasm/wallet.wasm`,
  module `MODULES.wallet`, program record `WALLET` in
  `src/runtime/programs.ts`, installed by the Zig kernel; not in a genesis by
  default). The index maps are the kernel's Merkle search trees:
  `kernel-zig/src/mst.zig` built as a module of wallet-zig (`build.zig`),
  shared, not copied.
- `wallet-zig/vectors/` — the test-vector corpus (issue #14's rule): made by
  `gen-go` from go-sdk (fixtures snapshotted into `inputs/`, mainnet headers
  fetched from WhatsOnChain once), cross-checked by `gen-ts` against
  `@bsv/sdk` and the TS wallet-toolbox's chaintracks header utilities.
- Nothing is taken from zig-wallet-toolbox: its "builder" is JSON glue around
  a remote storage's `createAction`, and its storage and services are HTTP.
  bsvz supplies the primitives: transaction and BUMP parsing and merging,
  sighash preimages, the script interpreter, BRC-42/43 key derivation, hashes.

### The bsvz pin: Chronicle rules (#53)

`scripts/fetch-bsvz.sh` pins bsvz at the head of the `chronicle` branch of
shruggr/bsvz (8e1c956, opldotdev/bsvz PR #2, still open; once merged the pin
moves to the merged opldotdev commit). That branch carries the Zig 0.16
migration and Chronicle (SV Node 1.2.0, mainnet height 943,816): OP_2MUL /
OP_2DIV, OP_VER / OP_VERIF / OP_VERNOTIF, OP_SUBSTR / OP_LEFT / OP_RIGHT /
OP_LSHIFTNUM / OP_RSHIFTNUM and 32 MiB script numbers, **on by default**:
`ExecutionFlags{}` is post-Chronicle mainnet, and `postGenesisBsv()` /
`legacyReference()` are the opt-outs. wallet-zig passes no flags, so SPV
(`src/spv.zig`) and the overlay (`src/overlay.zig`) verify with Chronicle
rules. `wallet-zig/vectors/chronicle.json` (Rúnar AMM pool spends, from the
amm-poc fixtures) is the check: each pool input verifies by default, fails
with `UnknownOpcode` under `postGenesisBsv()` and fails under
`legacyReference()`.

### bsvz on wasm32-wasi

One hunk (`wallet-zig/patches/bsvz.patch`): `Preimage.parse` sliced with a
`u64` (a compile error on 32-bit targets); it applies unchanged to the
Chronicle pin. wallet-zig's tests and vectors pass under wasm32-wasi
(`zig build test-wasm`, Node's WASI).
`bsvz.broadcast` (HTTP) does not build for WASI and is never imported. bsvz's
own `Beef` keeps transactions in a hash map and serializes them in txid
order, which breaks BRC-96's parents-first rule; wallet-zig has its own BEEF
codec (`src/beef.zig`) and uses only bsvz's transaction and BUMP parsers.

## Records

| record | block | fields | notes |
|---|---|---|---|
| header | `bitcoin-block` (0xb0, dbl-sha2-256) | the 80 bytes | CID = block hash; height is the `headers` map's key; decoded with links to the previous header and the merkle root (#42, docs/VM.md) |
| transaction | `bitcoin-tx` (0xb1, dbl-sha2-256) | the standard serialization | CID = txid; decoded with each input a link to the transaction it spends |
| merkle node | `bitcoin-tx` (0xb1, dbl-sha2-256), exactly 64 bytes | left hash ‖ right hash | CID = the node's merkle hash (#29, below; IPLD's convention, #42) |
| `action` | dag-cbor | `txid`, `tx` (link), `description`, `labels`, `noSend?` | a transaction that is ours |
| `output` | dag-cbor | `txid`, `vout`, `tx` (link), `basket`, `protocol`, protocol fields | satoshis and script come from the tx |
| `draft` | dag-cbor | `description`, `labels`, `outputs`, `inputs` (outpoints), `derivationPrefix`, `derivationSuffix`, `satsPerKb`, `noSend` | a signable createAction; its CID is signAction's `reference` |
| `broadcast` | dag-cbor | `txid`, `subject` (the tx's CID), `arc` (URL), `txStatus` (last heard), `since` (ms, first broadcast) | a transaction awaiting its status |
| `settlement` | dag-cbor | `txid`, `status: "rejected"`, `reason`, `cause?` (the root txid), `at` | a transaction that will never be mined (#37) |
| `wallet-state` | dag-cbor | `network`, `maps: {name: root \| null}` | what the head `wallet` names |
| `wallet-result` | dag-cbor | `op`, per-op fields, `state` | a step's answer, kept in its thread |

Every bitcoin block the wallet holds is **kept** by the step that puts it
(#42, docs/VM.md "Edges"): each input of each transaction is a `spends`
edge in the kernel's index (locator = the vout); headers and merkle nodes
contribute no edges (decided 2026-09-30) — a proof is read down from the
root. The wallet reads the edges with the `edges` call. The result record stays the last thing a step
keeps (a resting thread finds what it awaits there).

Output `protocol`s: `"wallet payment"` (a BRC-29 payment to us: basket
`default`, `derivationPrefix`, `derivationSuffix`, `senderIdentityKey`),
`"wallet change"` (our change: basket `default`, `derivationPrefix`,
`derivationSuffix`, counterparty self), `"basket insertion"` (its `basket`,
`tags`, `customInstructions?`). Only the first two are spent by the builder:
the wallet holds their keys (through the oracle).

### Index maps

Each is a Merkle search tree (#30: dag-cbor nodes `[left, [[key, value,
right]…]]`, canonical — the same contents give the same root whatever the
order), its root in the state record. Keys are bytes, ordered bytewise.

| map | key → value | |
|---|---|---|
| `headers` | height (u32 BE) → header | the best chain |
| `heights` | block hash → height | the best chain, backwards (fork points) |
| `txs` | txid → transaction | every transaction we hold (ours and their ancestry) |
| `proofs` | txid → `{block, depth, position}` | the block whose merkle tree holds the transaction (`block`, a bitcoin-block link) and where in it: the tree's `depth` and the leaf's `position` (its BUMP offset, a dag-cbor uint: BSV blocks may hold billions of transactions) |
| `actions` | txid → `action` | our transactions |
| `outputs` | txid ‖ vout (u32 BE) → `output` | output by outpoint |
| `awaiting` | txid → `broadcast` | transactions awaiting a status |
| `dependents` | txid ‖ tag ‖ id → rel (text) | what depends on a transaction, and how (see Settlement) — but spending it |
| `rejected` | txid → `settlement` | transactions that will never be mined |
| `proofHeights` | height (u32 BE) ‖ txid → null | proofs by block height: what a reorg reverts |
| `drafts` | draft CID → null \| `settlement` | signable drafts; a link once rejected |
| `spent` | outpoint → spending txid | derived: the first (lowest txid) spender we hold that is not rejected |
| `byBasket` | len ‖ basket ‖ 0 (spendable) \| 1 (spent) ‖ outpoint → null | derived: our outputs by basket + spendable |
| `unproven` | txid → null | derived, sparse: the settlement index — held transactions neither proven nor rejected |

The same record also carries an overlay's maps (#36: `admitted`,
`applied` and the derived `byTopic`; docs/OVERLAY.md): one chain and one
settlement for a wallet and an overlay in one instance. A wallet-only
instance has them empty. Query indexes are not here: each lookup service
keeps its own under its own head (#50). A rejection that removes a topic's
judgement is noted (`Wallet.unapplied`), and the wallet program calls that
topic's lookup services' `rejected` hook in the same step.

**Who spends what is not a map of the wallet's** (#42): it is the kernel's
`spends` edges. The spenders of txid:vout are the edges into the
transaction's CID with rel `spends` and locator = vout, from each kept
spending transaction, restricted to the ones the state holds (`txs`), lowest
txid first (`Wallet.spendersOf`). It is the same set the former `spenders`
map held (one per input of every held transaction, ancestry included); a
cross-check against it held on every scenario before the map was removed.
Within a step, the edges of the blocks the step kept so far are already
visible.

**Status and spendability are computed, never stored.** `rejected` means a
`settlement` record for the txid is in `rejected`; else `proven` means the
block `proofs` names for it (its merkle path checked against that header when
it arrived) is on our best chain; anything else is `unproven` (a reorg that
drops the block turns it back, with nothing to update). Spendable means ours (an `output`) and not
consumed (no transaction we hold, other than a rejected one, spends it). The
ARC status in a `broadcast` record is provisional information, except a
rejection (below).

### Proofs: the merkle tree as IPLD nodes (#29)

A merkle node is 64 bytes, left hash ‖ right hash, and its hash is the
dbl-sha256 of those bytes; as a 64-byte `bitcoin-tx` block (dbl-sha2-256;
IPLD's convention, #42: the kernel decodes it as `[left, right]`,
kernel-zig/src/bitcoin.zig) **its CID is its merkle hash**. The header's merkle
root names the root node; each node names its two children — nodes, or at the
bottom transactions (bitcoin-tx CIDs: the txids). The tree is **sparse**: we
hold only the nodes on the paths to our transactions; the other children are
hashes we cannot dereference. Verification is the DAG itself: a node's hash
is the hash of its children.

- **Receiving a merkle path** (a BUMP, BRC-74: a `proof` / `status` entry,
  ARC's answer, a BEEF's BUMPs at internalize or submit) checks the path's
  root against our header at its height, then `putblock`s every node the
  path reveals — each pair of siblings it gives (a `duplicate` sibling is the
  left one again) makes a node, whose hash is the parent one level up —
  hash-checked, nothing rewritten (wallet-zig/src/merkle.zig `reveal`). A
  path that also gives a node at a position with another hash than its
  children make is refused (`ConflictingNode`); one whose root is not our
  header's is refused (`RootMismatch`) and puts nothing. `proofs[txid]` then
  names the header (a bitcoin-block link) and the transaction's position in
  the tree — the BUMP's height as `depth` and the txid's leaf offset as
  `position` (#42, decided 2026-09-30), written once when the proof arrives
  (a submission's decoded proofs carry them in the submit entry, #50);
  `proofHeights` keeps its height (what a reorg re-settles). The
  per-transaction path records are gone.
- **Merging is free.** Nodes are shared by every transaction of the block:
  two BUMPs of one block give one set of node blocks, deduplicated by CID,
  whatever order they arrive in.
- **A proof is rebuilt on demand** (`Wallet.proofFor` → `merkle.pathFor`):
  from the header's merkle root, one node read per level down to the
  transaction, turning left or right by the position's bits (most
  significant first) — no search, no branching: `depth` reads. The siblings
  read on the way are the BUMP (a right sibling equal to the left is BRC-74's
  `duplicate`): the minimal one for that transaction. A descent that meets a
  node we do not hold, or ends elsewhere than the txid, proves nothing.
  `beefOf` / `atomicBeef` / `beefOfMany` embed these, merged per block.
  (The position is not optional: a store written before it — `proofs[txid]`
  a bare header link — reads as `BadIndex`; such state is re-genesised, not
  migrated.)
- **An orphaned header** behaves as before: the proof names a block no longer
  on our best chain, so the transaction is `unproven` (settlement reverts);
  the nodes stay, and a new path against the new block adds its own.

**Derived maps are maintained, not rebuilt (#41).** Each write that changes
a fact updates the few index keys that fact touches, at write time; `save`
only flushes the new nodes and writes the maps' roots into the state record.
They remain a function of the records and the best chain that anyone can
recompute (same contents, same root). The rules:

| fact | where | index keys touched |
|---|---|---|
| a `spends` edge (a transaction held and kept: `putTx`) | each input's outpoint | `spent[op]` = the first spender of `op` (its `spends` edges) not rejected; if that turned `op` spent/unspent, its `byBasket` key moves (0 ↔ 1) |
| a transaction held | its txid | into `unproven` (unless already proven or rejected) |
| an output record written / replaced (`putOutput`) | its outpoint | its `byBasket` key under its basket and spent state (the old key dropped on a replace) |
| a proof stored (`putProof`) | its txid | leaves `unproven` when the proof holds on our chain |
| headers added from height h (extension or reorg) | each txid in `proofHeights` ≥ h | into or out of `unproven`, by whether its proof holds now |
| a rejection (`reject`, each transaction it bubbles to) | the txid, its inputs, its outputs | leaves `unproven`; each input's `spent` is recomputed (freed unless another spender stands) and its `byBasket` key moves; each removed output record's `byBasket` key goes; the overlay's keys (docs/OVERLAY.md) |

**Sparse where the query allows.** `unproven` is the settlement index: it
holds only what is still unsettled. A proven transaction leaves it (a reorg
that undoes the proof puts it back), a rejected one is in `rejected`; so it
stays the size of the in-flight set, not of the history. The old dense
`bySettlement` / `byStatus` (every transaction by status) are gone — nothing
queried them, and status stays computed per txid. Cost: adding one
transaction of ours (tx, action, one output) writes ~20 blocks in total (21 before `spenders` folded into the kernel's edges, #42) —
index nodes, records and the state record — against a wallet of 10k outputs
(15 at 100 outputs); with the rebuild at every save it was 335, growing with
the store.

## Settlement (#37)

Every transaction the wallet holds has a settlement state resolved later:
`unproven` (held, no proof), `proven` (a merkle path against a header on our
best chain) or `rejected`. Anything derived from an unproven transaction is
provisional until it settles.

**Transitions.**

| from → to | by | |
|---|---|---|
| unproven → proven | a `proof` / `status` entry with a path, ARC's answer, `{op: "proof"}` | the path's root is our header's at its height |
| proven → unproven | a reorg (a heavier branch replaces ours from height h) | every proof at ≥ h (`proofHeights`) stops holding; ours are re-posted to ARC and awaited like a fresh broadcast |
| unproven → rejected | ARC says `REJECTED` / `DOUBLE_SPEND_ATTEMPTED` / `INVALID` / `MALFORMED` (or a 4xx) | reason: ARC's status |
| unproven → rejected | a competing spend of one of its inputs is proven | reason `double-spent` (a transaction arriving after such a proof is rejected at once) |
| unproven → rejected | still awaited `walletAbandonMs` after its broadcast (the `since` of its `broadcast` record), at a deadline wake | reason `abandoned` |
| unproven → rejected | a transaction it depends on is rejected | reason `input-rejected`, `cause` the root txid |

A proven transaction is never rejected. A rejection is terminal: a proof
arriving later for a rejected transaction is kept as a record, the status
stays `rejected`.

**Settlement is state to read, not an event to deliver** (decided
2026-09-30). The step that learns of a rejection (a `status` entry, a
competing proof, the abandonment deadline) writes the settlement record,
walks what depended on it and updates the maintained indexes; anyone who
asks afterwards gets the corrected answer. Nothing is sent to anyone: a
thread that mentioned the transaction reads its state the next time it
acts, another instance that received it learns from its own feed and runs
the same step, a page reads when it renders.

A rejection is recorded as `{kind: "settlement", txid, status: "rejected",
reason, cause?, at}` (the step's time), named by `rejected`; status stays
computed from it.

**Relations.** Where the wallet writes a record it writes the relation to
the transaction the record depends on, with its kind, in `dependents` (key
target txid ‖ tag ‖ id; tag `t` a transaction, `a` our action, `o` an
output record by outpoint, `d` a draft by CID, `r` any other record by CID):

| rel | written for | propagates |
|---|---|---|
| `spends` | every input of every transaction we hold (a BEEF's ancestry, ours, a competing spend) → the transaction it consumes: **not** in `dependents` but the kernel's edges (#42, above) | yes |
| `derives-from` | our action, each output record, each draft's inputs → the transaction | yes |
| `admits` | an overlay's admitted output (tag `m`) or judgement (tag `p`) → its transaction (#36, docs/OVERLAY.md): removed on rejection | yes |
| `mentions` | a record that merely names the transaction | no |

**Bubbling** (`Wallet.reject`): the rejected txid is queued; for each
transaction taken from the queue (skipped if already rejected or proven): a
settlement record, drop it from `awaiting`, then walk its `dependents` in key
order following only propagating relations — an `o` output record is
removed from `outputs` (the output vanishes), a `d` draft is marked rejected
(signAction refuses it: `DraftRejected`) — and then its `spends` edges: each
held transaction that spends it, in txid order, is queued (transitively
rejected, `input-rejected`). Then the derived keys the
rejections touch are updated (above): the inputs the rejected transactions
consumed are spendable again unless another held transaction spends them. Breadth first
in key order, from records only: the same rejection on the same state gives
the same state record. This is the "replay of the affected subgraph" — as
recomputation of derived state, recorded as one update on the wallet's head
by the step that learned it.

**Threads fork, they do not replay.** A thread whose history took the
transaction as input is never re-run. The thread awaiting the transaction's
CID (the broadcast's awaiting-callback thread, or any program that
`await`ed it) receives the `status` entry as a new input, routed by its
`subject`; a wallet thread whose transaction was rejected by another step
finds it rejected at its next deadline and finishes. Records that merely
`mentions` a transaction change nothing; whoever holds one reads its
settlement when it next acts.

The wallet's own result records name the transactions they are about as
`refs: [{to: <tx CID>, rel: "mentions"}]`; the kernel makes those edges
(docs/VM.md, "Edges").

## The chain tracker

The anchor is the **network's genesis header**, a constant in the program
(`main`, `test`, `regtest`; genesis `defaults.walletNetwork`, default
`main`; the state record carries its network and a state made for another
is refused). There is no trusted input: every header, from any sender, must
chain back to it. An empty chain starts at height 0 with the genesis header;
a run of headers is accepted when each target is usable (not zero, negative
or over 256 bits — where go-chaintracks and the TS toolbox disagree,
`vectors/headers.json`), each hash meets its target, they link, and the first
links to a header on our best chain (found by hash in `heights`); a
competing branch replaces ours from the fork point when it carries more
work. **Not checked, by decision (Q3, permanent):** the difficulty-adjustment
rule, timestamps, versions.

The full mainnet chain (~900k × 80 B) is only held by an instance fed by a
header service; an instance without a feed cannot validate transactions,
and a signing-only wallet needs none. A bootstrap packet (#4) may ship the
headers pre-verified. Tests: mainnet heights 0..10 (real, from WhatsOnChain)
for the tracker; regtest chains mined from its genesis for the wallet.

## SPV

`internalize` takes an Atomic BEEF (BRC-95). Every BUMP's root must be our
header's merkle root at its height (Q5: a payment is synchronous — it
validates or it fails; an unknown height is refused, never deferred); every
transaction must be in its BUMP, or have every input's source earlier in the
BEEF or already held by us, with each input's script verified by bsvz's
interpreter; a txid-only entry must be a transaction we hold. The subject
may be unmined: it is recorded `unproven`, and its outputs are spendable at
once.

## The builder and the oracle

`createAction` (BRC-100's, for the wallet's own funds): inputs are our
spendable `default`-basket outputs (payments and change), largest first,
until they cover the outputs and the fee; the outputs are the caller's, in
order; then one change output, P2PKH to a fresh BRC-29 key of ours
(protocol `[2, "3241645161d8"]`, keyID `"<prefix> <suffix>"` drawn from the
thread's random, counterparty self). Fee: SatoshisPerKilobyte (genesis
`defaults.walletFeeRate`, sat/kB, default 100) over the size with each P2PKH
unlocking script estimated at 106 bytes (go-sdk's `EstimateLength`), change
included; a change of zero drops the change output (go-sdk `Fee`,
`ChangeDistributionEqual`). The result is the Atomic BEEF: ancestry back to
proven transactions (their BUMPs, merged per block), parents first.
`options.signAndProcess: false` keeps a `draft` and returns it signable
(`reference`, the unsigned BEEF); `signAction({reference})` rebuilds the same
transaction (its inputs must still be unspent) and signs it.
`options.noSend: true` records without broadcasting. Caller-supplied inputs,
`lockTime`, `randomizeOutputs`, `sendWith` are not taken.

**Every key operation is an oracle call** over the `wallet` import (BRC-100
wire frames, recorded as `oracle` records): `getPublicKey` (call 8; forSelf; counterparty the
payment's sender, or self for change) for each input's key and the change
key, and `createSignature` (call 15) with `hashToDirectlySign` = the input's
BIP143/ForkID sighash (`ALL|FORKID`) — go-sdk's own pattern
(transaction/template/pushdrop). The oracle sees a key reference and a
32-byte hash, nothing else; the unlocking script is `<DER ‖ 0x41> <pubkey>`.
`vectors/signing.json` (go-sdk ProtoWallet) fixes every frame, preimage,
sighash, fee, change amount and the final transaction; wallet-zig reproduces
them byte for byte.

`internalize` asks the oracle only `getPublicKey` (the BRC-29 payee key).
This is how Yours funds skein ("Browser with Yours"): a BRC-29 payment to a
key derived for skein, internalized here as skein's own UTXO.

## Feeds and calls: plain entries and messages

Two mechanisms, split by lifetime (#29, "no messagebox for ARC or
ChainTracks"). Neither is a message: `emit` stays for identities.

**Plain entries** — subscriptions are host wiring: the router holds the SSE
feeds and webhooks (ChainTracks headers; Arcade's statuses, through the
host's broadcaster, below) and admits each event as a plain, unsigned log
entry `{kind: "log", n, prev, time, box, event}`; `event` names a record the
router puts first. Headers go to every instance whose config declares the
feed (`feeds: [{kind: "headers", url, box?}]`); a status goes to every
instance that holds its transaction. The wallet takes three kinds:

| record | fields | |
|---|---|---|
| `header` | `raw` (80 bytes) | one header; added to the chain (self-validating) |
| `proof` | `subject` (the tx's CID), `txid` (hex), `path` (BRC-74 bytes) | a merkle proof for a transaction we hold |
| `status` | `subject`, `txid`, `txStatus` (Arcade's), `merklePath?` (BRC-74 bytes), `blockHeight?`, `blockHash?` | a status from the host's broadcaster (its SSE stream or a webhook) |

The kernel routes a plain entry to the thread whose tip awaits its `subject`
(a transaction's CID is its txid), else to a subscription with **no sender**
on the entry's box (the instance subscribes e.g. `{match: {box: "chain"},
handler: WALLET}`). What arrives is validated inside: headers by work and
links, proofs against our headers; a status is provisional until its proof.

**Broadcasting is a message** (#70, #67: external communication is a
thread). The wallet `emit`s to the address book's `broadcast` provider (the
entry with role `broadcast`, which the genesis seeds when the host has an
Arcade; none: nothing is broadcast), `subject` the transaction's CID, and
ends its step awaiting the answer, the transaction's CID (a `status` /
`proof` entry) and a deadline; whichever comes first steps it. The answer
is the provider's signed message `{replyTo, status, body}`: Arcade's own
answer, its HTTP status and JSON body. Replay re-reads the answer from the
log and never touches the network; the preview1 and component builds emit
the same messages (`kernel-zig/equiv/abi.ts`).

| message | when | the answer's `body` |
|---|---|---|
| box `broadcast`, `{tx: <the Atomic BEEF>}` | after `createAction` / `signAction` (not `noSend`) | JSON `{txid, txStatus, merklePath?, extraInfo}`; a 4xx without a `txStatus` is a rejection; a 5xx (Arcade's backpressure, Arcade unreachable) is no answer: pending, re-asked at the deadline |
| box `status`, `{txid}` | at the deadline | the same JSON; a 404 (ARC never took it: the post failed transiently, or it lost its history) posts the BEEF again (box `broadcast`), whose answer counts |

**The host's broadcaster** (#58, `src/host/arc.ts`): one Arcade
(bsv-blockchain/arcade) per host, configured on the host
(`SKEIN_ARC_URL`, `SKEIN_ARC_TOKEN`; scripts/host/README.md); the
`broadcast` provider and the router's routes (`POST /arc/v1/tx`, `GET
/arc/v1/tx/{txid}`, for clients outside) both use it. It is a plain
proxy: a broadcast sends the transaction to Arcade's `POST
/tx` in Extended Format (the Atomic BEEF's subject with its inputs'
sources) under the host's one callback token (`X-CallbackToken`,
`X-FullStatusUpdates: true`, `X-CallbackUrl` when the host has a public
webhook URL), and answers exactly what Arcade answered — 202 `RECEIVED`,
a duplicate's current status, 400 with a `reason`, 503 with `Retry-After`
— so the answer the wallet keeps is a receipt; a status question is Arcade's
`GET /tx/{txid}` as is. There is no queue on the host: **the wallet's
`broadcast` record is the queue** (a step writes it, emits the message, awaits
the tx CID with a deadline; a crash loses nothing, it is all in the log).

Statuses come back over **one SSE subscription per host**: Arcade's
`/events?callbackToken=<the host token>` carries every transaction
submitted under the token. The router resumes it with `Last-Event-ID` (the
last event id it took, in host.db) and reconnects with backoff; Arcade's
webhooks, when it has a callback URL, take the same path (`POST
/arc/callback`, the host token as bearer). Each status becomes the `status`
record above and is admitted into box `chain` of **every instance whose
state holds the transaction** — not only the one that broadcast it: a
payee that internalized it, an overlay that admitted it. Who holds it is
read, never written (the kernel's `has` of the tx CID), and cached: the
route notes the instance that asked, and a txid's first status after the
router starts reads every enabled instance (hydrating it), later ones only
the running instances not yet known. A status already routed (txid +
`txStatus` + `blockHash`, in host.db) is not routed again. Arcade's
statuses: `RECEIVED`, `SENT_TO_NETWORK`, `ACCEPTED_BY_NETWORK`,
`SEEN_ON_NETWORK`, `SEEN_MULTIPLE_NODES`, `MINED` (with the BUMP),
`IMMUTABLE`, and the terminal `REJECTED` / `DOUBLE_SPEND_ATTEMPTED`; a reorg
turns `MINED` back to `SEEN_ON_NETWORK` and proves again in the new block.
The deadline's re-ask stays the backstop for anything the stream missed —
even an Arcade that lost its history (the 404 posts it again).

**The awaiting-callback thread** is the whole monitor: after a broadcast
the step notes it in `awaiting`, then `await`s the transaction's CID and
sets a `deadline` (`defaults.walletRecheckMs`, default 600000), so the thread
rests `waiting` with `until`. A `status` or `proof` entry for that CID steps
it (`input.event`); the deadline's wake entry steps it too (`input.woke`),
and it asks the broadcaster again (box `status`; a 404 posts it again). Each time: a merkle path proves the
transaction (a header not yet held leaves it pending), a rejection
(`REJECTED`, `DOUBLE_SPEND_ATTEMPTED`, `INVALID`, `MALFORMED`, or a 4xx)
rejects it and bubbles (Settlement, above); proven or rejected, it stops
awaiting and the thread finishes; otherwise it awaits again with a new
deadline. At a deadline, a transaction awaited for `defaults.walletAbandonMs`
(default 86400000) since its broadcast is abandoned instead of re-asked. One
thread may await several transactions (a reorg re-broadcasts all it reverted
from one step): the result lists them as `awaited`. The broadcaster is the address book's entry with role `broadcast`.

Not built: catching up on headers after a gap through the fetch provider (a feed's gap is
refused as `Unconnected` until the missing headers arrive); fetching a
missing proof on demand. A status whose merkle path does not match our
header at its height (Arcade still reporting a block our chain orphaned)
fails the step (`RootMismatch`) rather than being ignored.

## The program: the `wallet` box

A handler (`WALLET`), subscribed to an owner's box (owner messages) and a
sender-less box (plain entries). Each step loads the state the head `wallet`
names, applies the input, saves new map nodes and a new `wallet-state`,
advances the head, puts a `wallet-result`, keeps it, and prints its CID. An
error ends the step `errored`; no head moves.

| body (owner) | does → result |
|---|---|
| `{op: "headers", headers: [bytes]}` | a run of headers, parents first → `{added, known, replaced, ignored, tip}` |
| `{op: "internalize", tx, outputs, description, labels?}` | BRC-100 `internalizeAction` → `{txid, status, outputs}` |
| `{op: "proof", txid, path}` | a BRC-74 path for a transaction we hold → `{txid, status}` |
| `{op: "createAction", description, outputs: [{lockingScript, satoshis, outputDescription?, basket?, tags?, customInstructions?}], labels?, options?: {signAndProcess?, noSend?}}` | → `{txid, tx (Atomic BEEF), reference?, arc?, outcome?, awaiting?}` |
| `{op: "signAction", reference}` | → as createAction |
| `{op: "list", basket?, includeSpent?}` | → `{basket, outputs: [{txid, vout, satoshis, lockingScript, spendable, status}], total}` |

| plain entry / callback | result |
|---|---|
| `header` (args.event) | `{event: "header", added, known, replaced, ignored, tip, reverted?}` |
| `proof` / `status` (args.event) | `{event, txid, outcome: proven \| pending \| rejected}` |
| a callback (input.event / input.woke) | `op: "callback"`: `{txid, outcome, event? \| arc?, awaiting?, awaited?}` |

Any result may also carry `reverted` (after a reorg) and `refs` (the
transactions it names, rel `mentions`).

`outputs` of `internalize` are BRC-100's: `{outputIndex, protocol: "wallet
payment", paymentRemittance: {derivationPrefix, derivationSuffix,
senderIdentityKey}}` or `{outputIndex, protocol: "basket insertion",
insertionRemittance: {basket, customInstructions?, tags?}}`.

Config (genesis `defaults`, strings): `walletNetwork` (`main` \| `test` \|
`regtest`), `walletFeeRate` (sat/kB), `walletRecheckMs`, `walletAbandonMs`
(default 86400000; 0: never). Where it broadcasts is not config but the
address book (#70: the `broadcast` provider, seeded by the genesis when the
host has an Arcade; none: no broadcast).

## Running it

```
scripts/fetch-bsvz.sh                         # bsvz at the pinned rev, patched, in .build/bsvz
cd wallet-zig && zig build test               # library + vectors, native
cd wallet-zig && zig build test-wasm          # the same, built for wasm32-wasi, under Node's WASI
scripts/build-programs.sh && scripts/pin-programs.sh   # rebuild wasm/wallet.wasm, repin its CID (also kernel-zig/src/programs.zig)
node --experimental-strip-types --no-warnings kernel-zig/equiv/wallet.ts   # end to end on the Zig kernel (also in equiv/run.sh)
node wallet-zig/vectors/gen-ts/run.mjs        # TS cross-check of the vectors
(cd wallet-zig/vectors/gen-go && go run . gen)  # regenerate vectors (extract / fetch refresh inputs)
```

Vector counts (`zig build test`): tx 39 (fees 429), BEEF 27, merkle 43 (the
vector paths' nodes stored and every leaf's BUMP rebuilt from them; three
transactions of one block proven by separate BUMPs in all six orders: one
node set, each BUMP rebuilt byte for byte), headers 46, BRC-29 24, wire 7,
signing 10, plus 6 wallet scenarios and the index cost check (#41) (3 of
them settlement: each transition, bubbling, double spend, abandonment); the TS
cross-check: 458. The wasm build is reproducible.

## Open

- The plain-entry shape and the unsigned admission predate #33's entry
  reshape (format 2); the router's side is #33.
- Certificates, labels as their own index, relinquish, caller-supplied
  inputs, output randomization: not built.
