# The wallet in the VM

What is built for issue #29, phase 1 (branch `wallet-zig-29`). The design is
the issue body ("Decided (2026-09-28)", "Browser with Yours"); this file
describes what exists. A wallet is two things: a **root key**, which stays
outside as the per-instance **signing oracle**, and **wallet state**, which
lives inside as records. Nothing here signs.

## Pieces

- `wallet-zig/` — Zig 0.15.2 (pinned in `mise.toml`), over **bsvz** (pinned
  and patched by `scripts/fetch-bsvz.sh`). The library (`src/`) and the
  handler program (`src/program.zig`, wasm32-wasi → `wasm/wallet.wasm`,
  module `MODULES.wallet`, program record `WALLET` in
  `src/runtime/programs.ts`; not in a genesis by default).
- `wallet-zig/vectors/` — the test-vector corpus (issue #14's rule): made by
  `gen-go` from go-sdk (fixtures snapshotted into `inputs/`, mainnet headers
  fetched from WhatsOnChain once), cross-checked by `gen-ts` against
  `@bsv/sdk` and the TS wallet-toolbox's chaintracks header utilities.
- Nothing is taken from zig-wallet-toolbox: its "builder" is JSON glue around
  a remote storage's `createAction`, and its storage and services are HTTP.
  bsvz supplies the primitives: transaction and BUMP parsing, the script
  interpreter, BRC-42/43 key derivation, hashes.

### bsvz on wasm32-wasi

One hunk (`wallet-zig/patches/bsvz.patch`): `Preimage.parse` sliced with a
`u64` (a compile error on 32-bit targets). With it, bsvz's 306 unit tests
pass under wasm32-wasi (Node's WASI), and its Go script-interpreter corpus
runs 132 of 135: two fail natively too (bsvz's pinned expectations vs the
local go-sdk corpus), one opens a directory Node's WASI sandbox refuses.
`bsvz.broadcast` (HTTP) does not build for WASI and is never imported. bsvz's
own `Beef` keeps transactions in a hash map and serializes them in txid
order, which breaks BRC-96's parents-first rule; wallet-zig has its own BEEF
codec (`src/beef.zig`) and uses only bsvz's transaction and BUMP parsers.

## Records

Every record is dag-cbor (CIDv1, sha2-256), put through the `put` import.

| kind | fields | notes |
|---|---|---|
| `header` | `height`, `raw` (80 bytes) | hash, target, work computed from `raw` |
| `tx` | `raw` | the txid is computed (double SHA-256 of `raw`), not stored |
| `proof` | `txid` (hex), `height`, `path` (BRC-74 bytes) | links a txid to the header at `height` |
| `action` | `txid`, `tx` (link), `description`, `labels` | a transaction that is ours |
| `output` | `txid`, `vout`, `tx` (link), `basket`, `protocol`, remittance fields | satoshis and script come from the tx |
| `wallet-index` | `name`, `entries` {key: value} | an index map |
| `wallet-state` | `indexes` {name: link} | what the head `wallet` names |
| `wallet-result` | `op`, per-op fields, `state` | a step's answer, kept in its thread |

An `output` from a BRC-29 payment has `basket: "default"`, `protocol:
"wallet payment"`, `derivationPrefix`, `derivationSuffix`,
`senderIdentityKey`; from a basket insertion, `protocol: "basket insertion"`,
its `basket`, `tags`, `customInstructions?`.

### Index maps

Keys sort as dag-cbor sorts map keys (length, then bytes).

| index | key → value | |
|---|---|---|
| `headers` | height (10 digits) → `header` | the best chain: header by height |
| `txs` | txid → `tx` | every transaction we hold (ours and their ancestry) |
| `proofs` | txid → `proof` | proof by txid |
| `actions` | txid → `action` | our transactions |
| `outputs` | `txid.vout` → `output` | output by outpoint |
| `spent` | `txid.vout` → spending txid | derived: inputs of our actions |
| `byBasket` | `basket/spendable` \| `basket/spent` → [outpoint] | derived: outputs by basket + spendable |
| `byStatus` | `proven` \| `unproven` → [txid] | derived: our actions by status |

**Status and spendability are computed, never stored.** `proven` means we
hold a proof whose root is the merkle root of our best-chain header at its
height; anything else is `unproven` (so a reorg that drops the block turns
it back, with nothing to update). Spendable means ours (an `output`) and not
consumed (no action of ours spends it). The derived maps are rebuilt from the
primary ones on every save, so they are a function of the records and the
best chain that anyone can recompute. They are flat records rewritten whole
on change (#30's shape without its persistent-map spine; see "Open").
"Transactions awaiting a callback" is not a map yet: it is the set of threads
waiting on an Arcade reply, which does not exist until broadcast does.

## The chain tracker

Header records from a **checkpoint** (trusted: the first header, sent by
whoever the subscriptions let send it), extended by runs of headers that link
to a header on our best chain. A header is accepted when its target is
usable (not zero, negative or over 256 bits — where go-chaintracks and the TS
toolbox disagree, `vectors/headers.json`), its hash meets that target, and it
links; a competing branch replaces ours from the fork point when it carries
more work. **Not checked:** the difficulty-adjustment rule (that `bits` is the
one the chain requires), timestamps, versions. A peer can feed a branch at
low difficulty; it only wins by carrying more work than ours.

## SPV

`internalize` takes an Atomic BEEF (BRC-95). Every BUMP's root must be our
header's merkle root at its height (an unknown height is refused, not
deferred); every transaction must be in its BUMP, or have every input's
source earlier in the BEEF or already held by us, with each input's script
verified by bsvz's interpreter; a txid-only entry must be a transaction we
hold. The subject may be unmined: it is recorded `unproven`, and its outputs
are spendable at once (as in the toolbox).

## The program: the `wallet` box

A handler (`WALLET`), subscribed to a box like any program. Each step loads
the state the head `wallet` names, applies the body, saves new index records
and a new `wallet-state`, advances the head, puts a `wallet-result`, keeps it,
and prints its CID. An error ends the step `errored`; no head moves.

| body | does |
|---|---|
| `{op: "checkpoint", height, header}` | the first header, into an empty chain |
| `{op: "headers", headers: [bytes]}` | a run of headers, parents first → `{added, known, replaced, ignored, tip}` |
| `{op: "internalize", tx, outputs, description, labels?}` | BRC-100 `internalizeAction` (below) → `{txid, status, outputs}` |
| `{op: "proof", txid, path}` | a BRC-74 path for a transaction we hold → `{txid, status}` |
| `{op: "list", basket?, includeSpent?}` | outputs in a basket (default `default`) → `{basket, outputs: [{txid, vout, satoshis, lockingScript, spendable, status}], total}` |

`outputs` of `internalize` are BRC-100's: `{outputIndex, protocol: "wallet
payment", paymentRemittance: {derivationPrefix, derivationSuffix,
senderIdentityKey}}` or `{outputIndex, protocol: "basket insertion",
insertionRemittance: {basket, customInstructions?, tags?}}`.

**The oracle.** The only attested call is `getPublicKey` (wire call 8,
`wallet-zig/src/wire.zig`) for the BRC-29 payee key: protocol `[2,
"3241645161d8"]`, keyID `"<derivationPrefix> <derivationSuffix>"`,
counterparty the sender, forSelf. The output is ours when it is P2PKH to that
key. This is how Yours funds skein (#29, "Browser with Yours"): a BRC-29
payment to a key derived for skein, internalized here as skein's own UTXO.
Signing (`createSignature` for spends) is not called by anything yet.

## Peers as message boxes (shapes only; not built)

Both are peers reached by envelopes like any other; replies carry `replyTo`
(the emit's CID), so a thread `await`s them. Bodies are dag-cbor; binary
fields are bytes.

**ChainTracks** — headers and proofs. Its messages need no authentication:
they self-validate against the chain we hold, so its boxes may be subscribed
for any sender and routed straight to `wallet`.

| direction | box | body |
|---|---|---|
| → ChainTracks | `chaintracks` | `{op: "subscribe", from: height}` — push new headers from `from` on |
| ← ChainTracks | `headers` | `{op: "headers", headers: [bytes]}` — the `wallet` program's own op, as is |
| → ChainTracks | `chaintracks` | `{op: "headers-request", from: height, count}` |
| → ChainTracks | `chaintracks` | `{op: "proof-request", txid}` |
| ← ChainTracks | `headers` | `{op: "proof", txid, path}` (reply to a proof-request), or `{op: "proof", txid, unknown: true}` |

**Arcade** — broadcast and status callbacks.

| direction | box | body |
|---|---|---|
| → Arcade | `arcade` | `{op: "broadcast", beef: bytes}` — Atomic BEEF of the transaction |
| ← Arcade | `arcade-status` | `{replyTo, txid, status: "accepted" \| "mined" \| "rejected" \| "double-spend", path?, reason?}` |
| → Arcade | `arcade` | `{op: "status", txid}` — the re-ask after a deadline |

Broadcast is: emit the BEEF, the thread awaits the reply; a deadline wake
(`sleep`) re-asks the same box; a `mined` reply's `path` is a `proof` op. A
fallback is the same message to a different peer. That is the whole monitor.

## Running it

```
scripts/fetch-bsvz.sh                         # bsvz at the pinned rev, patched, in .build/bsvz
cd wallet-zig && zig build test               # library + vectors, native
cd wallet-zig && zig build test-wasm          # the same, built for wasm32-wasi, under Node's WASI
scripts/build-programs.sh && scripts/pin-programs.sh   # rebuild wasm/wallet.wasm, repin its CID
npm test                                      # includes src/runtime/wallet-program.test.ts
node wallet-zig/vectors/gen-ts/run.mjs        # TS cross-check of the vectors
(cd wallet-zig/vectors/gen-go && go run . gen)  # regenerate vectors (extract / fetch refresh inputs)
```

The wasm build is reproducible (same bytes from another checkout path).

## Open

- Index maps are flat records rewritten whole; #30's persistent maps replace
  them behind `store.Index` when #30 is built.
- Transactions are `{kind: "tx", raw}` dag-cbor records, not `bitcoin-tx`
  (0xb1, dbl-sha2-256) blocks whose CID *is* the txid: the TS kernel's
  `putblock` accepts only git-raw/raw/dag-cbor with sha1/sha2-256.
- Header validation stops at work and links (above).
- Not built: createAction/signAction (the builder: inputs, fee and change,
  BEEF assembly, asking the oracle to sign), the peers, certificates, labels
  as their own index, relinquish.
