# The wallet in the VM

What is built for issue #29 and re-split by #79 (both merged). The design is the issue body ("Decided
(2026-09-28)", "Browser with Yours") as revised in its comments (Q3/Q5, "drop
the checkpoint op", "no messagebox for ARC or ChainTracks"); this file
describes what exists. A wallet is two things: a **root key**, which stays
outside as the per-instance **signing oracle** (a ProtoWallet, #18), and
**wallet state**, which lives inside as records. Nothing in the VM holds a
key: every key operation is a call to the oracle.

**Since #79 the wallet keeps only its own records, under its own name**
(`wallet/state`: actions, coins, its own spends, drafts) **and the chain is
the chain app's** ([shruggr/skein-chain](https://github.com/shruggr/skein-chain),
`chain/state`: headers, transactions, proofs, spends, settlement,
broadcasts; docs/APPS.md §6a). The wallet reads the chain state by CID and
hands every transaction it builds or receives to the chain app as an
`ingest` message to the instance itself, then waits on its answers; it
never broadcasts and takes no headers, proofs or statuses. Its
transactions are `bitcoin-tx` blocks; it uses the kernel's `emit` and
`await` (its component build imports the same from `skein:kernel/skein`).

## Pieces

- The library: the SDK's `wallet` module (shruggr/skein-sdk, #71; a sibling
  repo, `wallet/src/`, a Zig package dependency by URL+hash, #75; over its
  `chain` module, `chain/src/`, since 0.4.0, #78), Zig 0.16.0,
  over **bsvz** (the SDK's lazy URL+hash dependency: shruggr/bsvz branch
  `skein-sdk`). The index maps are the Merkle search trees of the SDK's `mst`
  module, the kernel's own, shared, not copied.
- The handler program: `programs/wallet` (wasm32-wasi → `wasm/wallet.wasm`,
  module `MODULES.wallet`, program record `WALLET` in
  `src/runtime/programs.ts`, installed by the Zig kernel; not in a genesis by
  default), a boundary program, built against the SDK by URL+hash. Since #79
  it uses the SDK's `wallet` module for the builder, BRC-29 and the wire
  frames, and its `chain` module (re-exported as `chainstate`) to read the
  chain state; its own records are the program's (`programs/wallet/main.zig`).
  The SDK's `wallet.Wallet` (the chain, the wallet's records and an overlay's
  maps in one state record) is not used by skein's programs since #79;
  the wallet program's own shape has not moved into the SDK.
- the SDK's `wallet/vectors/` — the test-vector corpus (issue #14's rule): made by
  `gen-go` from go-sdk (fixtures snapshotted into `inputs/`, mainnet headers
  fetched from WhatsOnChain once), cross-checked by `gen-ts` against
  `@bsv/sdk` and the TS wallet-toolbox's chaintracks header utilities.
- Nothing is taken from zig-wallet-toolbox: its "builder" is JSON glue around
  a remote storage's `createAction`, and its storage and services are HTTP.
  bsvz supplies the primitives: transaction and BUMP parsing and merging,
  sighash preimages, the script interpreter, BRC-42/43 key derivation, hashes.

### The bsvz pin: Chronicle rules (#53)

The SDK pins bsvz at branch `skein-sdk` of shruggr/bsvz (309085f): the head
of its `chronicle` branch (8e1c956, opldotdev/bsvz PR #2, still open) plus
the one wasm32 hunk below. Once that PR is merged with the fix, the pin
moves to the merged opldotdev commit. That branch carries the Zig 0.16
migration and Chronicle (SV Node 1.2.0, mainnet height 943,816): OP_2MUL /
OP_2DIV, OP_VER / OP_VERIF / OP_VERNOTIF, OP_SUBSTR / OP_LEFT / OP_RIGHT /
OP_LSHIFTNUM / OP_RSHIFTNUM and 32 MiB script numbers, **on by default**:
`ExecutionFlags{}` is post-Chronicle mainnet, and `postGenesisBsv()` /
`legacyReference()` are the opt-outs. The wallet passes no flags, so SPV
(`src/spv.zig`) and the overlay (`src/overlay.zig`) verify with Chronicle
rules. The SDK's `wallet/vectors/chronicle.json` (Rúnar AMM pool spends, from
the amm-poc fixtures; a copy lives in skein as `kernel-zig/test/vectors/chronicle.json`
for `equiv/overlay.ts`, #75) is the check: each pool input verifies by default,
fails with `UnknownOpcode` under `postGenesisBsv()` and fails under
`legacyReference()`.

### bsvz on wasm32-wasi

One hunk (the SDK's `wallet/patches/bsvz.patch`, committed on the `skein-sdk`
branch): `Preimage.parse` sliced with a `u64` (a compile error on 32-bit
targets); it applies unchanged to the Chronicle pin. The wallet's tests and
vectors pass under wasm32-wasi
(`zig build test-wasm`, Node's WASI).
`bsvz.broadcast` (HTTP) does not build for WASI and is never imported. bsvz's
own `Beef` keeps transactions in a hash map and serializes them in txid
order, which breaks BRC-96's parents-first rule; the wallet has its own BEEF
codec (`src/beef.zig`) and uses only bsvz's transaction and BUMP parsers.

## Records

| record | block | fields | notes |
|---|---|---|---|
| transaction | `bitcoin-tx` (0xb1, dbl-sha2-256) | the standard serialization | CID = txid; put and kept by the step that builds or internalizes it (so its inputs are the kernel's `spends` edges, #42), and by the chain app when it ingests it |
| `action` | dag-cbor | `txid`, `tx` (link), `description`, `labels`, `noSend?` | a transaction that is ours |
| `output` | dag-cbor | `txid`, `vout`, `tx` (link), `basket`, `protocol`, protocol fields | a coin; satoshis and script come from the tx |
| `draft` | dag-cbor | `description`, `labels`, `outputs`, `inputs` (outpoints), `derivationPrefix`, `derivationSuffix`, `satsPerKb`, `noSend` | a signable createAction; its CID is signAction's `reference` |
| `wallet-state` | dag-cbor | `network`, `chain` (the `chain/state` it was read against, or null), `maps: {name: root \| null}` | what the head `wallet/state` names |
| `wallet-result` | dag-cbor | `op`, per-op fields, `state` | a step's answer, kept in its thread |

Output `protocol`s: `"wallet payment"` (a BRC-29 payment to us: basket
`default`, `derivationPrefix`, `derivationSuffix`, `senderIdentityKey`),
`"wallet change"` (our change: basket `default`, `derivationPrefix`,
`derivationSuffix`, counterparty self), `"basket insertion"` (its `basket`,
`tags`, `customInstructions?`). Only the first two are spent by the builder:
the wallet holds their keys (through the oracle).

### Index maps

Merkle search trees (#30: dag-cbor nodes `[left, [[key, value, right]…]]`,
canonical), their roots in the state record; keys are bytes, ordered
bytewise.

| map | key → value | |
|---|---|---|
| `actions` | txid → `action` | our transactions |
| `outputs` | txid ‖ vout (u32 BE) → `output` | our coins by outpoint |
| `byBasket` | len ‖ basket ‖ outpoint → null | our coins by basket |
| `spent` | txid ‖ vout → spending txid (bytes) | the inputs our own actions consumed |
| `drafts` | draft CID → null | signable drafts |

**What the chain says is read, never copied** (#79). The chain state
(`chain/state`, the SDK's `chain.state.State`, loaded read only from the
head's CID) holds every transaction ingested, its proof, its settlement and
the held spenders of each outpoint (its `spent` map, from the kernel's
`spends` edges). From it, at read time:

- a coin's **status** is its transaction's: `proven`, `rejected`, or
  `unproven` (also while the chain app has not ingested it yet: the
  wallet's own, on its way);
- a coin is **live** unless its transaction is rejected: a rejected
  transaction's coins vanish from every listing, with nothing rewritten;
- a coin is **spent** if one of our actions not rejected spent it (the
  wallet's `spent` — an action of ours the chain app has not ingested yet
  still spends it), or the chain state names a held, non-rejected spender
  of it; a rejected spend gives its inputs back by the same rule.

So the wallet keeps no derived settlement of its own (the old `unproven`,
`rejected`, `proofs`, `headers`, `awaiting`, `dependents` and the spent
flag in `byBasket` are gone), and a rejection, a proof or a reorg the
chain app records changes what the wallet reads without a step of the
wallet's.

### Proofs: the merkle tree as IPLD nodes (#29)

The chain app's (shruggr/skein-chain, over the SDK's `chain` module): the
wallet reads proofs from the chain state when it builds a BEEF (`proofFor`,
below) and never writes them. What the chain state stores:

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
  hash-checked, nothing rewritten (the SDK's `wallet/src/merkle.zig` `reveal`). A
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
- **A proof is rebuilt on demand** (the chain state's `proofFor` → `merkle.pathFor`):
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

## Settlement (#37), the chain app's

Every transaction has a settlement state, kept by the chain app (its
docs/CHAIN.md): `unproven`, `proven` (a merkle path against a header on its
best chain) or `rejected` (a status provider's rejection, a competing spend
proven, abandonment at `abandonMs`, or something it spends rejected —
`input-rejected`). A reorg turns a proven transaction back to unproven and
the chain app broadcasts it again. **The wallet reads it** (above) and is
told: each transaction it ingested answers its thread on each change —
`accepted`, `proven`, `rejected` (with `reason`) — so the thread that built
or received a transaction learns its fate, and everything else learns it by
reading when it next acts. Nothing of the wallet's is rewritten on a
rejection: the rejected transaction's coins stop being listed, the inputs it
spent are spendable again, a draft built on a rejected input is refused at
signAction (`DraftRejected`), one whose inputs were spent since is refused
(`InputSpent`).

The wallet's own result records name the transactions they are about as
`refs: [{to: <tx CID>, rel: "mentions"}]`; the kernel makes those edges
(docs/VM.md, "Edges").

## The chain tracker

The chain app's ([shruggr/skein-chain](https://github.com/shruggr/skein-chain),
docs/CHAIN.md; the SDK's `chain/src/chain.zig`): headers come to it from the
host's feeds (events in box `chain`), anchored at the network's genesis
header (`main`, `test`, `regtest`); every header must chain back to it;
usable target, proof of work, links; a heavier branch replaces ours from
the fork point (it arrives as one run, `raws`). **Not checked, by decision
(Q3, permanent):** the difficulty-adjustment rule, timestamps, versions. The
wallet's network is the chain state's (`network` on its record; a wallet
state made for another network is refused); with no chain app yet, it is
`defaults.walletNetwork`.

## SPV

`internalize` takes an Atomic BEEF (BRC-95) and checks it against the chain
state's headers, read only: every BUMP's root must be the header's merkle
root at its height (Q5: a payment is synchronous — it validates or it
fails; an unknown height is refused, never deferred); every transaction must
be in its BUMP, or have every input's source earlier in the BEEF or held by
the chain state, with each input's script verified by bsvz's interpreter. A
transaction the chain state has rejected is refused. Then the wallet records
the action and its coins and ingests the BEEF at the chain app (which runs
the same SPV, records it, and broadcasts it if it is unproven). The subject
may be unmined: its coins are spendable at once.

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
Its ancestry is read from the chain state (a transaction the chain app has
not ingested yet — the wallet's own, just built — from the store, where the
wallet put it). `options.signAndProcess: false` keeps a `draft` and returns
it signable (`reference`, the unsigned BEEF); `signAction({reference})`
rebuilds the same transaction (its inputs must still be live and unspent)
and signs it. `options.noSend: true` records without handing it to the
chain app. Caller-supplied inputs,
`lockTime`, `randomizeOutputs`, `sendWith` are not taken.

**Every key operation is an oracle call** over the `wallet` import (BRC-100
wire frames, recorded as `oracle` records): `getPublicKey` (call 8; forSelf; counterparty the
payment's sender, or self for change) for each input's key and the change
key, and `createSignature` (call 15) with `hashToDirectlySign` = the input's
BIP143/ForkID sighash (`ALL|FORKID`) — go-sdk's own pattern
(transaction/template/pushdrop). The oracle sees a key reference and a
32-byte hash, nothing else; the unlocking script is `<DER ‖ 0x41> <pubkey>`.
`vectors/signing.json` (go-sdk ProtoWallet) fixes every frame, preimage,
sighash, fee, change amount and the final transaction; the wallet reproduces
them byte for byte.

`internalize` asks the oracle only `getPublicKey` (the BRC-29 payee key).
This is how Yours funds skein ("Browser with Yours"): a BRC-29 payment to a
key derived for skein, internalized here as skein's own UTXO.

## Ingest by message (#79)

A transaction the wallet built (createAction, signAction; not `noSend`, not
a draft) or received (internalize) goes to the chain app as a message:

```
emit {to: <the instance's own identity>, box: "chain", body: {fn: "ingest", args: {beef: <the Atomic BEEF>}}}
```

— to the instance itself (docs/VM.md "emit": the host's loopback),
admitted by the chain app's row from `$self` — and the step ends awaiting
that message (`ingest` in its result). The chain app answers at the
instance, each answer `{fn, request, replyTo: <the message>, result: {txid,
tx, state, txStatus?, reason?, block?, height?, …}}` (or `error`), and each
steps the wallet's thread (input `reply`, `op: "callback"` in the result):
`accepted` — the thread awaits the message again; `proven` or `rejected` —
the thread finishes. No deadline: abandonment is the chain app's
(`rejected`, reason `abandoned`). Broadcasting, proofs and statuses are the
chain app's wiring (docs/MESSAGES.md, "Broadcast out, proofs and statuses
in"): the wallet sees none of them. Replay re-reads the steps from the log;
the preview1 and component builds emit the same messages
(`kernel-zig/equiv/abi.ts`).

## The program: the `wallet` box

A handler (`WALLET`), on a row for the owner's `wallet` box; a genesis-wired
program named `wallet` writes `wallet/…` (its default write scope). Each step loads
`wallet/state` and `chain/state`, applies the input, saves new map nodes and
a new `wallet-state`, advances `wallet/state`, puts a `wallet-result`, keeps
it, and prints its CID. An error ends the step `errored`; no head moves.

| body (owner) | does → result |
|---|---|
| `{op: "internalize", tx, outputs, description, labels?}` | BRC-100 `internalizeAction`, then ingested → `{txid, status, outputs, ingest, outcome: "pending", awaiting: true}` |
| `{op: "createAction", description, outputs: [{lockingScript, satoshis, outputDescription?, basket?, tags?, customInstructions?}], labels?, options?: {signAndProcess?, noSend?}}` | → `{txid, tx (Atomic BEEF), reference?}`, and unless a draft or noSend `{ingest, outcome: "pending", awaiting: true}` |
| `{op: "signAction", reference}` | → as createAction |
| `{op: "list", basket?, includeSpent?}` | → `{basket, outputs: [{txid, vout, satoshis, lockingScript, spendable, status}], total}` |
| `{op: "headers" \| "proof", …}` | refused: the chain app's (#79) |

| the chain app's answer (input `reply`) | result |
|---|---|
| `{result: {state, txid, txStatus?, reason?}}` | `op: "callback"`: `{ingest, txid, outcome: accepted \| proven \| rejected, txStatus?, reason?, awaiting?}` |
| `{error: {code, message}}` | `op: "callback"`: `{ingest, outcome: "error", error}` |

Any result may carry `refs` (the transactions it names, rel `mentions`).
`outputs` of `internalize` are BRC-100's: `{outputIndex, protocol: "wallet
payment", paymentRemittance: {derivationPrefix, derivationSuffix,
senderIdentityKey}}` or `{outputIndex, protocol: "basket insertion",
insertionRemittance: {basket, customInstructions?, tags?}}`.

Config (genesis `defaults`, strings): `walletNetwork` (`main` \| `test` \|
`regtest`, until there is a chain state) and `walletFeeRate` (sat/kB).
`walletAbandonMs` is the chain app's (`config.chain.abandonMs`, else this
default).

## Running it

```
git clone https://github.com/shruggr/skein-sdk ../skein-sdk   # a sibling checkout, for dev (#75); bsvz is fetched by zig build
cd ../skein-sdk && zig build test             # the SDK: the wallet library + vectors (and the codecs), native
cd ../skein-sdk && zig build test-wasm        # the wallet's tests built for wasm32-wasi, under Node's WASI
scripts/build-programs.sh && scripts/pin-programs.sh   # rebuild wasm/wallet.wasm, repin its CID (also kernel-zig/src/programs.zig); fetches skein_sdk by URL+hash — scripts/sdk-local.sh overrides it with ../skein-sdk
node --experimental-strip-types --no-warnings kernel-zig/equiv/wallet.ts   # end to end on the Zig kernel with the chain app (also in equiv/run.sh)
node ../skein-sdk/wallet/vectors/gen-ts/run.mjs    # TS cross-check of the vectors
(cd ../skein-sdk/wallet/vectors/gen-go && go run . gen)  # regenerate vectors (extract / fetch refresh inputs)
```

Vector counts (`zig build test`): tx 39 (fees 429), BEEF 27, merkle 43 (the
vector paths' nodes stored and every leaf's BUMP rebuilt from them; three
transactions of one block proven by separate BUMPs in all six orders: one
node set, each BUMP rebuilt byte for byte), headers 46, BRC-29 24, wire 7,
signing 10, plus 6 wallet scenarios and the index cost check (#41) (3 of
them settlement: each transition, bubbling, double spend, abandonment); the TS
cross-check: 458. The wasm build is reproducible.

## Open

- Certificates, labels as their own index, relinquish, caller-supplied
  inputs, output randomization: not built.
