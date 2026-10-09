# amm-lookup

The AMM pool liquidity lookup service, `ls_amm`: a lookup service on
skein-overlay 0.6.0's lookup contract (the `lookup` module). One service over
every Mandala token topic the overlay serves (`tm_mandala_<txid>_<vout>`, judged by
skein-mandala's topic manager: plain BRC-162 rules, no AMM knowledge). It
judges which admitted outputs are pools worth indexing by running the pool
checks (`src/pool.zig`, the `pool` module), keeps an index of the unspent
ones that pass, per token, and answers the matching engine's inventory
queries from it.

Ported from amm-poc `programs/amm-lookup`, where it was one service per token
(`ls_amm_<txid>`, its own head per token, a `topics` list in the manifest).
Here `config.overlay` names it with no `topics` list, so it listens to every
topic the overlay serves, declared or registered with the engine
(shruggr/skein#120), and every query names its token.

```
zig build test-amm-lookup    # from the repo root: the checks, the index, the queries, natively
```

## Layout

| file | what |
|---|---|
| `src/index.zig` | The pool checks as this service's judgement (`judge`), the index (the hooks) and the queries (`answer`), independent of the VM. |
| `src/main.zig` | `metadata` and `documentation` (skein-overlay#2: the listing and documentation routes), and `lookup.main(idx.spec)`. |
| `test.zig` | Tests over the generated fixtures (`src/fixtures/vectors.zig`, from `pool/Pool.runar.go`). |
| `fixtures/pool-state-answer.json`, `fixtures/outpoint-answer.json` | The wire shape of a `{tokenId}` and a `{tokenId, outpoint}` answer ("The engine's PoolState shape" below). |

## Names

A query names its token with `tokenId`, in any of skein-mandala 0.4.0's forms
(the `mandala` module's `name.tokenIdOfString`): `<txid>`, `<txid>_<vout>` or
`<txid>.<vout>`. `<txid>`, `<txid>_0` and `<txid>.0` all name the token at
output 0 and its topic `tm_mandala_<txid>_0` (skein-mandala 0.8.2: the topic is
`tm_mandala_<assetId>`, `_0` included); `<txid>_<vout>` with a non-zero vout
names `tm_mandala_<txid>_<vout>` (a BRC-161 token). Any other id is refused. A hook
for a topic that is not a token's (`tm_mandala`) does nothing. A pool
exists only for a token whose binary id is 32 bytes (a token deployed at
output 0): the Pool contract hard-codes a 32-byte id push.

## The pool checks (`judge`, run by `admitted`)

The checks `pool.check` runs, unchanged: a pool is at output 0; its prefix
id and amount equal the asset id and TokenReserve its code and state carry.
A transaction whose pools fail has none of them indexed; they stay valid
token outputs in the topic, not searchable here.

The ValidatorPubKey is not checked (decided 2026-10-01): a pool with any
validator key is a pool to the overlay and is indexed. How a validator
derives its signing key is its own convention (amm-validator checks its own
key before signing).

The checks read only the admitted token outputs (`outputsToAdmit`);
`coinsRetained` and the spent coins' sources are not read.

## The index

Under the service's own head, `<app>/ls_amm` (the engine keeps it; the app
writes only under its own name), three maps. `tp` = len ‖ topic (skein-sdk
`store.nameKey`), so every key is per token; an outpoint = txid (internal
order) ‖ vout, big-endian u32:

| map | key → value | |
|---|---|---|
| `pools` | `tp ‖ outpoint → record` (a CID link) | an unspent pool output the topic admitted |
| `byValidator` | `validatorIdentityKey (33 bytes) ‖ tp ‖ outpoint → null` | a set index for the validator query |
| `spentPools` | `tp ‖ outpoint → record` (a CID link) | a checked pool a spend consumed, kept for `rejected` to give back and for `{outpoint}` to follow |

The record (`{kind: "amm-pool", txid, vout, bsvReserve, tokenReserve,
liquidityFeeBps, validationFeeBps, commissionBps, lpPubKey,
validatorIdentityKey, admittedAt}`) carries every field `pool.zig` parses
but the rotating ValidatorPubKey. `admittedAt` is always `null`: a hook has
no time source.

**The hooks**:
- `admitted`: run the pool checks; when they pass, index each output in
  `outputsToAdmit` that is a pool. When they fail, index nothing (the
  reason has no place in the contract: a hook returns `void`).
- `spent`: move the spent pool from `pools` to `spentPools`. The
  continuation arrives through its own `admitted` call.
- `rejected`: drop the transaction's own pools (live or spent) and move
  each pool it had spent from `spentPools` back to `pools`, as it was
  indexed when first admitted.

## Queries (`/lookup`, service `ls_amm`)

Every query names its token (`tokenId`, above); a query without one is
refused.

- `{tokenId}`: every live pool of the token, a freeform list in the
  engine's `PoolState` shape plus `outpoint: "<txid>_<vout>"`.
- `{tokenId, outpoint}`: that pool, or its newest continuation, `{current,
  hops}`. From an outpoint that is not live, the walk follows the spends
  forward: a hop is a checked pool this topic indexed and a spend consumed
  (`spentPools`), its spender is the chain state's (`spentBy`, the chain
  app's `chain/state`, read only), and the continuation is output 0 of the
  spend. An outpoint in neither map, or a spend that did not recreate a
  pool, is `UnknownOutpoint`. (amm-poc followed the wallet library's
  topic-aware `spender` join over the head `wallet`; that state is gone since
  skein #79.)
- `{tokenId, outpoint, beef: true}`: the `output-list` form of the same
  outpoint, whose BEEF the engine builds from the chain state.
- `{tokenId, validatorIdentityKey}`: that validator's live pools of the
  token, via `byValidator`.

### The engine's `PoolState` shape

```ts
interface PoolState {
  outpoint: string;
  bsvReserve: bigint;
  tokenReserve: bigint;
  liquidityFeeBps: bigint;
  validationFeeBps: bigint;
  commissionBps: bigint;   // the Pool's CommissionBps (the relay's commission)
  validatorIdentityKey: string;
  lastSeen?: number;
}
```

The `/lookup` route renders a dag-cbor integer as a plain JSON number, so a
reserve above 2^53 - 1 loses precision in a client's `JSON.parse`. That is
the route's encoding, not this service's. `validatorIdentityKey` is
lowercase hex text.

## Liveness join

`setLiveJoin` / `liveOf` merge `lastSeen` from a `live` map
(`identityKey → {peerId, at}`) when one is wired; nothing wires one in
`main.zig` (since skein-amm 0.4.0 liveness is the runtime's read, `GET
/amm/.live/tm_mandala_<txid>_0-live`, which the page joins itself; no map is kept in
the graph). Without a join, `lastSeen` is left out.

## Tests

Over the generated fixtures (held in a `MemStore`) and hand-built spends
sharing the compiled Pool template:

- names: every token id form to its topic; other ids refused; a query
  without a token refused;
- a pool deploy that passes is indexed once, and the answers match the
  engine's shape; `commissionBps` answered;
- pools that fail a check are not indexed (prefix amount ≠ TokenReserve, a
  pool at output 1);
- a pool with any validator key is indexed;
- another topic's call indexes nothing;
- a swap replaces the pool it spent; a rejection restores it from
  `spentPools`;
- `{outpoint}` follows three hops to the newest continuation over the
  chain state's spends;
- `{validatorIdentityKey}` returns only that validator's pools;
- the liveness join.
