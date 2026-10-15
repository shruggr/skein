# 1Sat collections on a skein

shruggr/skein#151. The topic manager is `src/collection_topic.zig` over
`src/rules.zig` and `src/mint.zig`; the lookup is `src/collection_lookup.zig`.

## Names

| name | what |
|---|---|
| `tm_1sat_collection` | every collection mint (the Go name, shared with 1sat-stack) |
| `tm_col_<txid>_<vout>` | one collection, by its mint outpoint |
| `ls_collection` | the lookup |

A collection id and an item's origin are outpoints `<txid>_<vout>`: the txid in display order, 64
lowercase hex characters, the index in decimal without leading zeros. Any other form is no topic
and no id.

## Mints

A mint output holds exactly one satoshi and an `ord` inscription. Its MAP is the first MAP
protocol in its Bitcom tape that decodes. `subTypeData` is JSON; its `collectionId` (a string),
`mintNumber` and `rank` are read each on its own, keys matched without regard to case. A number is a
JSON integer or a string of decimal digits; on-chain items write `"mintNumber":"42"`.

- **Collection mint**: MAP `type=ord`, `subType=collection`, and a SIGMA that verifies. Its signer
  (that SIGMA's address) is the collection's issuer.
- **Item mint**: MAP `subType=collectionItem`, `collectionId` naming the collection, and a SIGMA
  that verifies whose address is the issuer's. A relative id `_<n>` is output `n` of the item's own
  transaction (leading zeros taken).

A SIGMA verifies as 1sat-sdk signs: `sha256(sha256(input txid in display order ‖ vin LE) ‖
sha256(script before the tape))`, BSM over the recovered key's mainnet address (skein-1sat
`sigma`).

## The topics

`tm_1sat_collection` admits every collection mint of a transaction and retains nothing.

`tm_col_<txid>_<vout>` admits, for one transaction:

1. output `<vout>` when the transaction is `<txid>` and the output is a collection mint;
2. every item mint of the collection. The issuer is read from the collection's mint: this
   transaction, or one the call can read (in the submitted BEEF, or held). When it cannot be read,
   no item of the transaction is admitted;
3. for every topic coin the transaction spends, the output its satoshi lands in, by the ordinal
   rule: the offset is the sum of the source satoshis of the inputs before it, zero-satoshi
   outputs are skipped, and the satoshi must land at the start of a 1-sat output. Absorbed into a
   multi-sat output, or past the outputs, it is gone. Any locking script.

It retains every topic coin the transaction spends, and names as `ancillaryTxids` the source
transactions of the inputs before each such coin that are not topic coins themselves. The engine
keeps them on the admittance and serves them on `/holds`, so a peer can recompute the landing. A
source output the rule needs and the call cannot read is an error; the engine pauses a submission
missing a parent before it asks the topic.

The collection's own mint is a topic coin like any other: its satoshi is followed too.

## The lookup

One index, the head `<app>/ls_collection`, written by the hooks of any `tm_col_<id>` topic (others
do nothing). Keys are outpoints as txid (display order) ‖ index (u32 big-endian).

| map | key | value |
|---|---|---|
| `items` | collection ‖ origin | current outpoint (null once gone), owner, steps, name, mintNumber, rank, contentType, the MAP fields |
| `outputs` | outpoint | collection, origin, step, kind, owner, listing (price, seller, payout script), spender |
| `history` | origin ‖ step | outpoint, kind |
| `listings` | collection ‖ outpoint | unspent OrdLock v2 listings |
| `sales` | collection ‖ spending txid ‖ outpoint | type, price, seller, payout script, origin |

- `admitted`: for each retained coin the index holds, the output its satoshi landed in (the same
  rule, over source outputs read from the store) is the item's next step: out of a listing by the
  purchase branch `sale`, by the cancel branch `cancel`; into a listing `listing`; else
  `transfer`. Any other admitted item mint of the collection is a new item, step 0, `mint`.
- `spent`: the coin's spender is recorded. A spent listing leaves `listings`; its spend, by the
  unlocking script's last byte (`OP_0` purchase, `OP_1` cancel; skein-1sat `ordlock.classify`),
  goes in `sales`. An item still at the spent coin has no current outpoint.
- `rejected`: the transaction's outputs leave every map (an item it minted goes), and the coins it
  spent are unspent again: their listings and the item's current outpoint come back, their sales
  go.

An owner is `listed` for an OrdLock v2 listing, else the P2PKH address (the inscription's
1SAT_P2PKH, or a bare P2PKH lock), else null. Addresses are mainnet's.

## The reads

| `find` | takes | rows, in order |
|---|---|---|
| `items` | `collection` | `{origin, outpoint, owner, name, mintNumber, rank, contentType, map}`, origin order |
| `history` | `origin` | `{outpoint, kind}`, mint first |
| `listings` | `collection` | `{outpoint, origin, price, seller, payout, payoutScript}`, outpoint order |
| `sales` | `collection` | `{outpoint, origin, type, price, seller, payout, payoutScript, txid, height, time}`, newest first |

`limit` is 1 to 100 (default 100), `skip` 0 to 100000 (default 0). Anything else is refused.
`payout` is the pay output's P2PKH address (null for another script), `payoutScript` its script in
hex; `seller` the cancel key's address. A sale's `txid` is the spending transaction; `height` and
`time` (the block header's timestamp) come from the chain state's proof, null while unmined.
Newest first: unmined first, then the higher block, then the later position in it.

- **BRC-24**: `POST /<app>/lookup` `{service: "ls_collection", query: {find, …}}`. The answer is an
  output-list, each output with its transaction's BEEF and its row as JSON in `context`: an item's
  current outpoint (its origin once gone), a step's outpoint, a listing's outpoint, a sale's spent
  listing.
- **Read routes**: `/<app>/collection/items`, `/history`, `/listings`, `/sales`, any method, the
  fields in the query string or a JSON body; 200 with the rows as a JSON array, or 400. Anyone,
  nothing logged.

## The manifest

`programs`: the engine `overlay`, `collection-topic`, `collection-lookup`. `config.overlay` is
empty: no topics, no lookups; the install derives the engine's routes (`/submit`, `/lookup`, the
app's box). `roles: {root: [register, registerLookup, deregisterLookup]}` gates the box
`<app>/register`. The four read routes name the filters `items`, `history`, `listings`, `sales`,
each `collection-lookup.<find>`.

## Not built

- A page.
- Search beyond the four reads, and a list of collections (`tm_1sat_collection`'s lookup).
- Seeding from JungleBus, sync and discovery between peers (shruggr/skein#150).
