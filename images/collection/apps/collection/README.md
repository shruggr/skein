# skein-collection

The 1Sat collection overlay for a [skein](https://github.com/shruggr/skein),
as an app: one topic per collection, a discovery topic, and the items
lookup, running in the overlay engine
([shruggr/skein-overlay](https://github.com/shruggr/skein-overlay)) the app
carries. Version **0.1.0**, Zig 0.16.0. Spec: shruggr/skein#151.

## What it is

| program | file | what |
|---|---|---|
| `overlay` | `bin/overlay.wasm` | the engine, skein-overlay 0.13.0's build |
| `collection-topic` | `bin/collection-topic.wasm` | the topic manager: `tm_1sat_collection` and `tm_col_<txid>_<vout>` |
| `collection-lookup` | `bin/collection-lookup.wasm` | the lookup `ls_collection` and its four reads |

`tm_col_<txid>_<vout>` (a collection, by its mint outpoint) admits:

1. the collection's mint: a 1-sat inscription, MAP `type=ord subType=collection`, a SIGMA that verifies;
2. each item mint: a 1-sat inscription, MAP `subType=collectionItem`, `subTypeData.collectionId`
   naming the collection (`_<n>` is output `n` of the item's own transaction), a valid SIGMA from
   the collection's signer;
3. every later output holding an admitted output's satoshi, by the ordinal position rule, whatever
   its locking script (a P2PKH transfer, an OrdLock v2 listing).

It retains every topic coin it spends, and names as ancillary txids the source transactions of the
inputs before the ordinal's that are not topic coins (the funding parents that fix the satoshi's
offset). `tm_1sat_collection` admits rule 1 for every collection.

`ls_collection` keeps its index under `<app>/ls_collection` from the engine's admit, spend and
reject hooks and answers four reads, as BRC-24 queries and as read routes:

| read | BRC-24 query | route |
|---|---|---|
| a collection's items (origin, current outpoint, owner, mint metadata) | `{find: "items", collection}` | `/<app>/collection/items?collection=` |
| an item's chain of custody (mint, transfer, listing, sale, cancel) | `{find: "history", origin}` | `/<app>/collection/history?origin=` |
| open OrdLock v2 listings (price, seller, payout) | `{find: "listings", collection}` | `/<app>/collection/listings?collection=` |
| listing spends (purchase or cancel), newest first | `{find: "sales", collection}` | `/<app>/collection/sales?collection=` |

Each takes `limit` (1 to 100, default 100) and `skip` (0 to 100000). docs/COLLECTION.md has the
rules, the index and the answers in full.

## Use it

Install the chain app, then this app (the image `collection` in shruggr/skein boots with both):

```
skein-host install https://github.com/shruggr/skein-chain --instance <handle>
skein-host install https://github.com/shruggr/skein-collection --instance <handle>
```

The manifest declares no topics and no lookups. Root registers each collection it follows, and the
lookup once, in the app's box `<app>/register`:

```
{fn: "register", args: {topic: "tm_col_<txid>_<vout>", program: "collection-topic"}}
{fn: "registerLookup", args: {service: "ls_collection", program: "collection-lookup"}}
```

Registered without `topics`, the lookup hears every topic. `tm_1sat_collection` is registered the
same way for every collection mint. Submissions go to `POST /<app>/submit` (BRC-22, `X-Topics`) or
by message into `<app>/submit`; skein-overlay's README has the rest.

## Build and test

Zig 0.16.0 (`mise.toml`).

```
zig build          # zig-out/bin/{collection-topic,collection-lookup}.wasm
zig build bin      # the same, into bin/ (committed)
zig build test     # the rules, the topic, the lookup and its reads, natively
```

`test.zig` builds collections, items, transfers, listings, purchases and cancels by hand, signed as
1sat-sdk signs, and runs them through the topic contract and the lookup's hooks as the engine
does; plus the on-chain item `34adf92c` (`testdata/`).

## Versions

| | |
|---|---|
| this app and package | 0.1.0 (tag `v0.1.0`) |
| skein-overlay | v0.13.0 by tag URL and hash in `build.zig.zon` (modules `topic`, `lookup`, `sk`); the engine in `bin/` is its build |
| skein-1sat | v0.1.0 by tag URL and hash (module `onesat`) |
| skein-sdk | v0.11.0, through skein-overlay (modules `chain`, `sk`, `cbor`) |
| requires | `chain/1` (shruggr/skein-chain) |

## Contributing

Work is tracked in shruggr/skein; this repo's issue is
[#151](https://github.com/shruggr/skein/issues/151). MIT, as skein.
