# skein-amm

A non-custodial BSV ↔ token AMM over Mandala tokens (BRC-162), as one
[skein](https://github.com/shruggr/skein) overlay app, name `amm`. Its tree
carries the overlay engine, the Mandala components, the AMM's own programs
and its pages. Version **0.8.1**: on skein-overlay 0.12.0 and skein-mandala
0.9.1 (skein-sdk v0.11.0, skein log format 10: the BEEF envelope beside the
pointer record, shruggr/skein#146), every skein a market and a validator
from install, always (David Case, 2026-10-09: no switch; the Validator
page shows both always on), the token topic's gossip one mesh for submit
and admit messages with `-proof` and `-live` separate, each registered
topic's beat body its view digest; the pages at the origin root (`/`,
shruggr/skein#147) take `<origin>/amm` as the app's base. 0.8.0: on
skein-overlay 0.11.0 and skein-mandala
0.9.0 (BRC-207; David Case, 2026-10-08), a token's topic is
`tm_mandala_<assetId>` and its lookup `ls_mandala_<assetId>`, the asset id
`<txid>_<vout>` (a Mandala token's `tm_mandala_<txid>_0`, its liveness topic
`tm_mandala_<txid>_0-live`); 0.7.2's `tm_<txid>_0` is no topic (no alias).
Registering a token is two engine calls, its topic then its lookup (the
Token topics page, `mandala/tokens/`, skein-mandala 0.9.0's); the lookup
answers BRC-207's `mandala-spendability` and `mandala-admission`. A Mandala
deploy's icon is embedded in it (BRC-162 draft bsv-blockchain/BRCs#308:
`[mediaType, bytes]`, the pointer forms gone): the Tokens page shows it and
the deploy form embeds it (no icon output). `ls_amm` keeps its index at
`amm/ls_amm` (skein-overlay 0.11.0: one index per lookup program). 0.7.2:
on skein-mandala 0.8.2, a token's topic was `tm_<tokenId>`, `_<vout>` always: a Mandala token's `tm_<txid>_0`, its
liveness topic `tm_<txid>_0-live`; the bare `tm_<txid>` is no topic
(David, 2026-10-08: "that was the decision all along"). 0.7.1: on
skein-overlay 0.10.0 and skein-mandala 0.8.1, every token id is `<txid>_<vout>`, Mandala and legacy
BSV-21 alike, `_0` included, as BRC-162 "Token identification" writes it
(David, 2026-10-07, shruggr/skein#120; supersedes 0.6.3's bare txid).
0.7.0: skein's routes, filters and roles
(shruggr/skein#143), on skein-overlay 0.10.0 and skein-mandala 0.8.0 — the
manifest's `dispatch` and `reads` are `routes` (no senders): the box
`amm/register` is root's (`roles: {root: ["register", "market",
"validator"]}`), the reads are read routes whose filters answer (the pages:
the filter `page`, amm-p2p's `serve`), `/call` lists `kernel.brc104`, and
the box `amm` is the engine's alone, so amm-p2p's message path moved to its
own box `amm/amm-p2p` (docs/AMM.md "Routes"). 0.6.3: the pages wrote a Mandala token's id as the bare
`<txid>` (superseded by 0.7.1), show outpoints as
`<txid>.<vout>`, let every id shown be expanded and copied, and send
`POST /submit` unsigned, with plain `fetch` (David, 2026-10-08). 0.6.2: market and validator are the owner's switch, both
off in the manifest (David, 2026-10-07: "this shouldn't have been a config
in the manifest. This should be a setting that the user is configuring";
"Use it", item 4). 0.6.1: `POST /submit` is BRC-22 again (it answers the
STEAK, and the pages read it; shruggr/skein#112). Market and validator are the engine's two settings
(0.6.0, shruggr/skein#120; David, 2026-10-06 evening: "a skein runs as a market and/or a validator by two settings in the engine's configuration (`config.overlay.market: {window}`, `config.overlay.validator: {every}`), and registering a token's topic is the one act that drives both"): with
`config.overlay.market` the engine's `register` asks the runtime's liveness
tool for the token's `tm_<txid>_0-live`, with `config.overlay.validator` it
beacons it, and amm-validator signs for every registered token; amm-p2p's
`validate` / `unvalidate`, its validated set, its beacons, its liveness and
its start / stop are gone. The listings, the documentation, the pages and
the token list (`/mandala/tokens`) are reads (0.5.0, shruggr/skein#135:
docs/AMM.md "Rows and reads"). The page reads `GET
<base>/.live/tm_<txid>_0-live`, plans over the pools whose validator is there
and names that validator (identity key and peer ID) in the swap, and the
relay dials the peer it is given — or, when it is its own node, hands the
request to its own validator program in-VM. Ported from amm-poc (b-open-io/amm-poc, its
`programs/`, `pool/` and `web/`) in 0.1.0 (shruggr/skein#120).

## What it is

| role | file | what |
|---|---|---|
| `overlay` | `bin/overlay.wasm` | the overlay engine, skein-overlay 0.12.0's build: serves the topics and lookups, keeps the registered sets (`register` / `deregister`, `registerLookup` / `deregisterLookup`, only in `amm/register`, root's) and, always (a market and a validator; `config.overlay.market` / `.validator` give the ms, absent here: 40 000 / 30 000), asks liveness of and beacons each registered token's `tm_mandala_<txid>_0-live` (the body its view digest) and each registered lookup's `<service>-live`, takes submissions by message (box `amm/submit`, answered to the sender's box) and by `POST /submit` (BRC-22: the STEAK) |
| `mandala-topic` | `bin/mandala-topic.wasm` | skein-mandala 0.9.1's topic manager: one topic per token, `tm_mandala_<assetId>` (`tm_mandala_<txid>_0`), judged by the BRC-162 rules alone; the discovery topic `tm_mandala` |
| `mandala-lookup` | `bin/mandala-lookup.wasm` | skein-mandala 0.9.1's lookups `ls_mandala` (a token's value and authority outputs, one output), `ls_mandala_deploys` (a token's deploy output) and each token's `ls_mandala_<assetId>` (BRC-207), one index; the token list (the read route `/mandala/tokens`, its filter `tokens`) |
| `amm-lookup` | `programs/amm-lookup` | `ls_amm`: the live pools of every token topic the overlay serves, each query naming its token |
| `amm-validator` | `programs/amm-validator` | the validator, for every registered token (always, 0.8.1): checks a taker's or an LP's transaction against the pool, signs the pool input last, submits it to its own overlay by message and answers on the engine's answer (`swap`, `addLiquidity`, `deploy`, libp2p direct calls) |
| `amm-p2p` | `programs/amm-p2p` | the marketplace relay (`amm.swap/1`, `amm.pool/1`, `amm.liquidity/1`: a transaction carried to the validator the caller names), and the pages (`www/`, served from the app's own tree) |
| | `src/pool.zig` | the Pool contract as the overlay sees it: recognising a pool, its state, the pool checks (module `pool`, over the `mandala` parser) |
| | `pool/` | the Rúnar contract (`Pool.runar.go`) and its Go tests |
| | `gen/` | the fixture generators (`src/fixtures/`) |
| | `web/ui`, `web/engine` | the pages (validator, LP, swap, tokens) and the matching engine, built into `www/` |
| | `www/mandala/` | skein-mandala 0.9.1's pages: deploy a token, root's token topics |

docs/AMM.md has the pieces, the pool rule, the interfaces, the rows and
what is not wired.

## Build

Zig 0.16.0 (`mise.toml`), Go 1.27 for `pool/` and `gen/`, Node 22 or later
and npm for the pages.

```
zig build test     # the pool library and the three programs, natively
zig build bin      # bin/: this repo's three programs, built; overlay.wasm and mandala-*.wasm, copied
go test ./pool/...
scripts/www.sh     # www/: the pages from web/ui, then the Mandala pages into www/mandala/
```

**The overlay and Mandala artifacts are fetched, not built here.**
`build.zig.zon` names skein-overlay v0.12.0 and skein-mandala v0.9.1 by tag
URL and hash; `zig build bin` copies `bin/overlay.wasm` from the
skein-overlay package and `bin/mandala-topic.wasm`, `bin/mandala-lookup.wasm`
from the skein-mandala package, byte for byte. skein-mandala's pages are
outside its package's `paths`, so `scripts/mandala-pages.sh` fetches the same
tag's tarball by URL and checks its sha256 before copying its `www/` into
`www/mandala/`. `bin/` and `www/` are committed: what a skein installs is the
finished tree, and nothing is built on the skein.

The pages need two local checkouts (web/ui/README.md): Rúnar at
`~/Work/bsv/runar` (`RUNAR_DIR`; d207ee8e, the commit go.mod pins) and
1sat-sdk at `~/Work/bsv/1sat-sdk` (`ONESAT_SDK_DIR`), whose
sources are bundled; the committed `www/` (0.8.1) was built with
`ONESAT_SDK_DIR` at the embedded-icon draft, b-open-io/1sat-sdk#92
(aff025c3, unpublished; web/ui/README.md "Mandala from the local 1sat-sdk
checkout"), before 0.8.0 with master 183c0ce3. Their tests:

```
cd web/engine && npm ci && npm test
cd web/ui && npm ci && npm test && npm run typecheck
```

Regenerate the fixtures after changing `pool/Pool.runar.go`, from the repo
root: `go run ./gen/vectors`, then `go run ./gen/addliquidity`.

## Use

The base URL of the app is `https://<handle>.<host>/amm` (on a host without
wildcard DNS, `<host>/@<handle>/amm`).

1. **Install the chain app, then the AMM**, as root (skein docs/APPS.md
   §3: the management page, or `skein plan install` and `skein send`):

   ```
   skein plan install https://github.com/shruggr/skein-chain#<commit> --origin <instance> --out chain/ && skein send <instance> chain/
   skein plan install https://github.com/shruggr/skein-amm#<commit> --origin <instance> --out amm/ && skein send <instance> amm/
   ```

2. **Deploy a token** at `<base>/mandala/deploy/` (anyone, with their own
   wallet). The page shows the token's topic, `tm_mandala_<txid>_0`, and its
   lookup, `ls_mandala_<txid>_0`.
3. **Register the token** at `<base>/mandala/tokens/` (root). The page
   sends root's messages to the app's box `register` (`amm/register`,
   shruggr/skein#128), which the route `{address: "register", handler:
   "overlay.register"}` takes to the engine, gated by `roles: {root:
   ["register", "registerLookup", "deregisterLookup", "market",
   "validator"]}` (shruggr/skein#143: any other key's message is recorded
   and runs nothing): its topic, then its lookup (BRC-207); deregistering
   reverses both:

   ```
   box:  amm/register
   body: {"fn": "register", "args": {"topic": "tm_mandala_<txid>_0", "program": "mandala-topic"}}
   body: {"fn": "registerLookup", "args": {"service": "ls_mandala_<txid>_0", "program": "mandala-lookup", "topics": ["tm_mandala_<txid>_0"]}}
   body: {"fn": "deregisterLookup", "args": {"service": "ls_mandala_<txid>_0"}}
   body: {"fn": "deregister", "args": {"topic": "tm_mandala_<txid>_0"}}
   ```

   `tm_mandala` (the discovery topic) is registered by `register` alone.
4. **Market and validator, always** (0.8.1, skein-overlay 0.12.0; David
   Case, 2026-10-09: "every skein is marketplace AND validator from
   install, always"): no switch (0.6.2's `{fn: "market" | "validator"}`
   and the Token topics page's two switches are gone). The register above
   is the one act that drives both: the engine's `register` also emits
   `{event: "liveness", topic: "tm_mandala_<txid>_0-live", window}` — the
   runtime's liveness tool subscribes the topic without admitting its
   messages, verifies each beat and keeps the ones within the window in
   memory, served at `GET <base>/.live/tm_mandala_<txid>_0-live` →
   `[{sender, at, body, from}]` (404 when no liveness is kept; skein
   docs/MESSAGES.md "Liveness (#138)") — and `{event: "beacon", topic:
   "tm_mandala_<txid>_0-live", every, body}`: the host's node publishes a
   signed beat every `every` ms — the frame carries the instance's identity
   key (`sender`), the gossip message its peer ID (`from`), the body the
   topic's view digest `{view: {count, digest}}`, re-declared when it
   changes — and amm-validator signs swaps and takes on new liquidity
   (signs an LP's addLiquidity, consents to an LP's pool deploy) for every
   registered token, refusing any other `not_validating`. A deregister
   reverses both (`unliveness`, `unbeacon`). The ms are
   `config.overlay.market: {window}` / `config.overlay.validator: {every}`
   (e.g. at install, `--config '{"overlay": {"market": {"window": 40000},
   "validator": {"every": 30000}}}'`), else 40 000 / 30 000; this manifest
   sets neither. `config.amm.ammP2p.market`, `heartbeatSeconds` and
   `offlineSeconds` are gone (`validator.every` is the beat,
   `market.window` the offline threshold), and so are `validate` /
   `unvalidate` (the box `amm/validate`), the validated set and amm-p2p's
   start / stop.

   **The validator named** (0.4.0): the Swap page reads each token's
   `.live` read, takes each beat's `sender` (the validator) and `from` (its
   peer ID), plans only over the pools whose validator beat within the window, and sends
   `amm.swap.submit` with that validator's `peerId` beside its `validator`
   key (`amm.pool.submit` and `amm.liquidity.submit` the same, from the
   Pools page). The relay looks at no liveness: it dials `peerId`, or, when
   `peerId` is its own node's, calls its own `amm-validator` in-VM with the
   same package, as the front door calls the route's handler for a frame.
5. **The pages** at `<base>/`, served from the app's own tree (`www/`):
   Tokens (the wallet's tokens), Pools (create a pool, add and remove
   liquidity), Swap, Validator (this instance as a validator: the registered
   tokens and the two settings, no buttons); the Mandala
   pages at `<base>/mandala/`. They call `<base>/lookup` (`ls_amm`,
   `ls_mandala`), `<base>/.live/tm_mandala_<txid>_0-live` (the runtime's liveness read),
   `<base>/call` (the relay) and `<base>/submit`. The pages are a read route
   (its filter `page`: anyone, signed or not, nothing logged; 0.7.0);
   `/call` takes a signed request (`kernel.brc104`); `/submit` takes an
   unsigned POST whose BEEF validates (`kernel.beef`), and the pages send it
   with plain `fetch` (0.6.3). `<base>/live` is gone (0.5.0).

**Submit and look up** (BRC-22, synchronous: skein-overlay 0.9.1; by message instead, answered later to the submitter's box; BRC-24):

```
POST <base>/submit                     → 200, the STEAK (BRC-22; 503 + Retry-After while undecided)
X-Topics: ["tm_mandala_<txid>_0"]
Content-Type: application/octet-stream
<BEEF>

POST <base>/lookup
{"service": "ls_amm", "query": {"tokenId": "<txid>"}}
{"service": "ls_amm", "query": {"tokenId": "<txid>", "outpoint": "<txid>_0", "beef": true}}
{"service": "ls_amm", "query": {"tokenId": "<txid>", "validatorIdentityKey": "<hex>"}}
{"service": "ls_mandala", "query": {"tokenId": "<txid>"}}
{"service": "ls_mandala_deploys", "query": {"tokenId": "<txid>"}}
{"service": "ls_mandala_<txid>_0", "query": {"type": "mandala-spendability", "version": 1, "assetId": "<txid>_0", "topic": "tm_mandala_<txid>_0", "outpoints": ["<txid>.1"]}}
```

At the skein's origin (the @bsv/sdk clients' form), once root adds the two
root routes (skein-overlay README "Root routes"):

```
skein routes add --transport http --filters kernel.beef --fn submit /submit amm.overlay <origin>
skein routes add --transport http --filters amm.lookup /lookup <origin>
```

## Versions

| | |
|---|---|
| this app | 0.8.1 |
| skein-overlay | v0.12.0 (73a5617) by tag URL and hash (`build.zig.zon`): the engine in `bin/`, the modules `topic`, `lookup`, `sk`, and its engine sources for amm-validator and amm-p2p |
| skein-mandala | v0.9.1 (0ab0e14) by tag URL and hash: `bin/mandala-*.wasm`, the module `mandala`; its pages by the tag's tarball and sha256 (`scripts/mandala-pages.sh`) |
| skein-sdk | v0.11.0, through skein-overlay (`files` serves the pages; `sk.peerAt` finds the host's providers) |
| skein | log format 10, the BEEF envelope beside the pointer record (shruggr/skein#146); routes-roles e3f50fe (format 9: routes, filters, roles, shruggr/skein#143); before, main f45c887 (the liveness tool and `GET /<app>/.live/<topic>`, docs/MESSAGES.md "Liveness (#138)"; the beacon's signed frame, "Beacons"; the node's key from the instance root, signer.ts `peerKey`) |
| requires | `chain/1` (shruggr/skein-chain v0.3.2) |
| Rúnar | d207ee8e (go.mod; the pages' runar-sdk) |
| the pages | `@1sat/actions` 0.0.228, `@1sat/connect` 0.0.99, `@1sat/react` 0.0.97, `@1sat/templates` 0.0.39 (Mandala from b-open-io/1sat-sdk#92, aff025c3, unpublished; before 0.8.0, 183c0ce3), `@bsv/sdk` 2.8.10 (`web/ui/package-lock.json`) |

## Contributing

Work is tracked in shruggr/skein; start at issue
[#31](https://github.com/shruggr/skein/issues/31), this repo's issue is
[#120](https://github.com/shruggr/skein/issues/120). MIT, as skein.
