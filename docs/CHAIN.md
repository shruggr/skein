# The chain state: proofs and settlement

The chain state is the chain app's ([shruggr/skein-chain](https://github.com/shruggr/skein-chain),
its docs/CHAIN.md the reference), under the head `chain/state`; every other
app reads it by CID. This file keeps the two parts the kernel's docs cite:
how proofs are stored (the kernel's bitcoin codecs make them a DAG) and
what settlement is. (Before 0.7.0 this was docs/WALLET.md, beside the
genesis wallet program; that program is gone — a wallet is an app,
shruggr/skein-wallet.)

## Proofs: the merkle tree as IPLD nodes (#29)

The chain app's (shruggr/skein-chain, over the SDK's `chain` module): a
reader builds BEEFs from the proofs in the chain state (`proofFor`, below)
and never writes them. What the chain state stores:

A merkle node is 64 bytes, left hash ‖ right hash, and its hash is the
dbl-sha256 of those bytes; as a 64-byte `bitcoin-tx` block (dbl-sha2-256;
IPLD's convention, #42: the kernel decodes it as `[left, right]`,
kernel-zig/src/bitcoin.zig) **its CID is its merkle hash**. The header's merkle
root names the root node; each node names its two children — nodes, or at the
bottom transactions (bitcoin-tx CIDs: the txids). The tree is **sparse**: we
hold only the nodes on the paths to the transactions held; the other children are
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
`input-rejected`). A reorg turns a proven transaction back to unproven. Every status is a
fact the chain app emits (`chain/tx/<txid>`, the latest wins), and every
reader computes settlement from the chain state at read time: nothing a
reader keeps is rewritten on a rejection. A record that stands on a
transaction names it in its `refs` (`{to: <tx CID>, rel}`); the kernel
makes those edges (docs/VM.md, "Edges"), and the relation kind decides
whether a rejection propagates.
