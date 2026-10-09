# The AMM on a skein

A constant-product AMM between BSV and one Mandala token per pool, served by
a skein overlay app. Decided in shruggr/skein#120: Mandala is components (a
topic manager and a lookup service, shruggr/skein-mandala); the AMM is an
app that carries them with its own pool lookup, validator and relay; one
topic per token, registered by root at runtime.

## The pieces

| role | source | what it does |
|---|---|---|
| `overlay` | skein-overlay 0.12.1 (`bin/overlay.wasm`, copied) | a submission by message in box `amm/submit`, answered to the submitter's box, or by `POST /submit` (BRC-22, the STEAK); `/lookup`, gossip, the listing and documentation reads; `register` / `deregister` a topic (and `registerLookup` / `deregisterLookup` its lookup), and with it the market's liveness and the validator's beacon on `tm_mandala_<txid>_0-live` (below, "Market and validator"), and each registered lookup's beacon and liveness on `<service>-live`; hands every admitted BEEF to the chain app |
| `mandala-topic` | skein-mandala 0.9.2 (copied) | judges `tm_mandala_<txid>_0` (`tm_mandala_<assetId>`, `_<vout>` always) by the BRC-162 rules; `tm_mandala` admits every deploy |
| `mandala-lookup` | skein-mandala 0.9.2 (copied) | `ls_mandala`, `ls_mandala_deploys`, each token's `ls_mandala_<assetId>` (BRC-207: `mandala-spendability`, `mandala-admission`), one index; its fn `tokens`, the token list, the read route `/mandala/tokens` (0.6.0: the token list is a read of the components) |
| `amm-lookup` | `programs/amm-lookup` | `ls_amm`: the listed pools (below, "The claim and the listing"), per token; its beat, the prices ("Prices") |
| `amm-validator` | `programs/amm-validator` | the validator's two direct calls (`swap`, `deploy`), for every registered token (always, 0.8.1); submits by message to its own overlay; files the claim in the wallet; root's `rescind` |
| `amm-p2p` | `programs/amm-p2p` | the relay (`amm.swap/1`, `amm.pool/1`), the holders' listing requests, the reads `/requests` and `/spends`, the pages (`www/` from the app's tree); the catch-up utility, unscheduled |
| | `src/pool.zig` | the pool library (module `pool`), over `mandala`'s parser and rules |
| | `pool/Pool.runar.go` | the contract |
| | `web/ui` → `www/` | the AMM pages; `www/mandala/` the Mandala pages |

The topic knows no application: a pool output is a token output like any
other and is admitted exactly when the BRC-162 rules admit it. Which of
those outputs are pools is the lookup's judgement, and whether one may be
spent is the validator's.

## The pool rule

A pool is a BRC-162 value output at output 0 whose lock is the compiled
Pool code, `OP_RETURN`, and the state: TokenReserve (8 bytes), LpPubKey,
ValidatorPubKey, ValidatorIdentity (33 bytes each). The BSV reserve is the
output's satoshis; the token reserve is the prefix's amount, duplicated in
state.

- **Indexed** (amm-lookup, `pool.check`): at output 0; the prefix's id and
  amount equal the AssetId and TokenReserve the code and state carry (the
  contract writes the prefix from its copies and never reads it). The id is
  32 bytes, so only a token deployed at output 0 has pools. The
  ValidatorPubKey is not checked.
- **Methods** (the contract; 0.9.0, David Case 2026-10-09: "Contract =
  Swap + Close"): `Swap(validatorSig, nextValidatorPubKey, amountIn, bsvIn,
  userPkh, commissionPkh)`, the validator's; `Close(lpSig, bsvFee)`, the
  LP's alone: 0 ≤ bsvFee ≤ the pool's sats, the BSV payout (the pool's sats
  less bsvFee, an output only when nonzero) to P2PKH of the LP key, then
  every token to the same key in one BRC-162 value output, no continuation;
  bsvFee 0 pays everything out (the LP funds the fee from another input,
  its change Rúnar's change output). AddLiquidity and RemoveLiquidity are
  gone: resizing a position is a Close and a new deploy. Fees are fixed at
  deploy, in basis points of the input, rounded up, paid in the input
  asset: LpFeeBps to the LP, ValidatorFeeBps to the validator,
  CommissionBps to whoever relays the swap — the validator's terms (below,
  "The deploy"). The contract builds every output; a swap carries no
  others.
- **Keys rotate.** The validator names its next key on every Swap it signs;
  the LP's key is the pool's for its life (Close is its only spend). The
  validator's key is the BRC-42 child of its ValidatorIdentity,
  protocol `[1, "amm pool"]`, key ID the outpoint of input 0 of the
  transaction that created the pool, counterparty anyone. The overlay does
  not check it; the validator does before signing.
- **The validator signs last** (amm-validator README "What is checked"):
  the pool is ours and live, the call is the method's, the next key is our
  child, the topic would admit the transaction, the pool checks pass, the
  outputs are the contract's, every other input (and every unproven parent)
  is signed. Then it signs the pool input through the signer and submits
  the transaction to its own overlay by message — `{fn: "submit", args:
  {beef, topics: [tm_mandala_<txid>_0]}}` from the instance to itself, box
  `amm/submit` —
  and answers the direct call on the engine's first answer (`admitted`,
  `rejected`).

## The deploy (0.9.0)

David Case, 2026-10-09: "Fees are the validator's"; "Deploy is delivered,
not broadcast".

- **The terms.** The validator's fees are skein-wide config,
  `config.amm.ammValidator` `{lpFeeBps, validatorFeeBps, commissionBps}`
  (this manifest: 30, 5, 0; amm-validator's defaults the same). An LP
  posting here accepts them: the page has no fee inputs and reads them with
  `amm.pool.terms`. The validator refuses a deploy whose pool fields differ
  (`fees_unacceptable`, the field and the term in `detail`).
- **Delivered.** The LP builds the deploy and signs every input
  SIGHASH_SINGLE|FORKID, input i over its own output i: input 0, the first
  token input, with the pool at output 0; each further input (the other
  token inputs, the funding) with an LP output — the token change, else a
  1-sat sats change (a BRC-29 payment to self). The token inputs carry
  exactly ONE unit more than the pool and the token change take. The LP
  delivers it through the relay (`amm.pool.submit`, this skein's own
  validator), never broadcasts it. amm-validator refuses one not paired
  (`not_paired`), an input not SIGHASH_SINGLE|FORKID (`bad_sighash`), not
  one unit unassigned (`unassigned_not_one`), inputs that do not cover the
  delivered outputs and the claim's sat (`claim_unfunded`), and what it
  refused before (the key, the topic, the signatures, the parents).
- **The claim.** The validator appends the claim after the LP's outputs: a
  BRC-162 value output of ONE unit of the token, P2PKH to the pool's
  validator key (`validatorKey(identity, <the first token input>)`, the key
  the contract names), its payload that key's DER signature (through the
  signer, as it signs a swap) over sha256(the pool output's locking script
  ‖ the first token input's txid, internal byte order ‖ its vout, 4 bytes
  LE) — the deploy's txid cannot be signed: it includes the claim
  (`src/pool.zig` `claimDigest`, `claimScript`, `verifiedClaim`). The LP's
  SINGLE signatures still hold. Then it submits the claimed deploy to its
  own overlay (the chain app broadcasts it), answers `{ok: true, tx, txid}`
  (the claimed deploy), and files the claim in its wallet: it launches the
  genesis wallet program on `{op: "internalize", tx: <the claimed deploy,
  Atomic BEEF>, outputs: [{outputIndex: <the claim>, protocol: "basket
  insertion", insertionRemittance: {basket: "amm-claims",
  customInstructions: {protocolID: [1, "amm pool"], keyID, counterparty:
  "anyone", amm: {claim}}, tags: ["amm-claim"]}}]}` (skein docs/WALLET.md;
  amm-validator `filing.zig`).

## The claim and the listing (0.9.0)

`ls_amm` lists a pool ONLY while both its contract output and its claim
output are unspent, and only if the claim verifies: its payload is the
pool's named validator key's signature, that key is `validatorKey(validator
identity, first token input)`, and the claim is locked to it. A deploy
without such a claim (the LP's as delivered, a claim another key signed, a
pool naming a key that is not the derivation) is never listed; a swap's
continuation carries its pool's claim. Every query answers listed pools
only (`{outpoint}` a pool not listed: `NotListed`). The validator rescinds
by spending the claim; the LP leaves by Close.

**Rescind** (root's message `{fn: "rescind", args: {pool: "<deploy
txid>.0"}}` in the box `amm/validator`, gated by `roles: {root:
["rescind"]}`): amm-validator has the instance's wallet spend the claim as
a caller input (shruggr/skein#93): `createAction` with the claim
(`unlockingScriptLength`, its source's BEEF), one `OP_FALSE OP_RETURN`
output, `noSend` — a draft; it signs the draft's claim input with the
pool's validator key (P2PKH, ALL|FORKID); `signAction {reference, spends}`;
then submits the rescind to its overlay (the unit burned: the topic takes
the spend, `ls_amm` hears it) and answers root. Each wallet call is a thread
of the genesis wallet program (amm-validator `rescind.zig`).

**The LP's view** comes from the chain state by outpoint, not the listing:
the read `GET <base>/spends?outpoint=<txid>.<vout>` (amm-p2p, the chain
app's `spent` as the overlay reads it) follows the pool from its deploy to
its current output (each spender's output 0 while it is a pool; `closed`
once Close spent it) and tells the claim spent (rescinded: the page offers
Close). The current output's BEEF comes from `ls_mandala {txid,
outputIndex}`.

## Prices (0.9.0)

David Case, 2026-10-09: "Pricing lives in the AMM LOOKUP's own beacon";
"beats are libp2p service discovery". `ls_amm`, registered (skein-overlay
0.12: a registered lookup beats on `<service>-live` and keeps liveness on
it), beats on `ls_amm-live` a body (dag-cbor) carrying, per token, this
skein's per-validator totals of its listed pools:

```
{tokens: {"<assetId>": {"<validator identity, hex>": {sats, tokens, pools}}}}
```

re-declared by a hook whenever it changes (the lookup keeps the last body's
record, `beat`; `Service.beat`) and answered by fn `beat` at the beacon's
declaration. The page reads `GET <base>/.live/ls_amm-live` (each live
skein's latest beat) and combines them: a token's price is Σsats / Σtokens
across the live validators (a validator is live when its own beat is held,
on `ls_amm-live` or the token's topic); one report per validator (its own
beat's, else the newest naming it). Polled every `REFRESH_MS`. A token no
beat reports is priced from this skein's own listing and liveness. The
topic manager's beat carries no prices.

## Interfaces

**Overlay** (base URL `<handle>.<host>/amm`):

| route | what |
|---|---|
| `POST /submit` | BRC-22 (`X-Topics` a registered topic): the request waits on the submission and answers the STEAK; 400 for a BEEF that does not verify or a rejected transaction; 503 + Retry-After while undecided (skein-overlay 0.9.1; 0.7.3–0.9.0 answered `{id}`) |
| `POST /lookup` | BRC-24: `ls_amm` `{tokenId}`, `{tokenId, outpoint, beef?}`, `{tokenId, validatorIdentityKey}` (listed pools only, 0.9.0); `ls_mandala`, `ls_mandala_deploys` (skein-mandala README) |
| `GET /requests` | amm-p2p `requests` (0.9.0): the holders' listing requests not yet registered, newest first, `[{tokenId, from, at}]`; a read |
| `GET /spends?outpoint=<txid>.<vout>` | amm-p2p `spends` (0.9.0): the chain state of an outpoint, a pool followed to its current output, `{outpoint, spentBy?, current?, hops, closed}`; a read |
| `GET /listTopicManagers`, `/listLookupServiceProviders`, `/getDocumentationFor…` | the listings (each program's `metadata` / `documentation`); reads since 0.5.0 |
| `GET /.live/tm_mandala_<txid>_0-live` | the runtime's liveness read (skein #138, no program): `[{sender, at, body, from}]` newest first, the beats within the window (`body` the topic's view digest; the validator is `sender`, its peer ID `from`); 404 when the app keeps no liveness for the topic (the topic not registered) |
| `GET /mandala/tokens` | mandala-lookup `tokens`: the token list, `{limit?, skip?}` → `[{tokenId, topic, sym, dec, icon?, txid, vout}]` (`icon` a Mandala deploy's embedded image as a data URL, skein-mandala 0.9.0); a read (0.6.0) |
| `POST /call` | amm-p2p: `{fn, args}` for the two interfaces below |
| `GET /…` (prefix `/`) | amm-p2p `serve`: the pages, `www/` of the app's own tree (skein-sdk `files.serve`); a read since 0.5.0 |

A token id in a query is any form (`<txid>`, `<txid>_<vout>`, `<txid>.<vout>`); the pages write every token id as `<txid>_<vout>`, Mandala and legacy BSV-21 alike, `_0` included (BRC-162 "Token identification"; 0.7.1, David 2026-10-07), and show outpoints as `<txid>.<vout>` (0.6.3, David 2026-10-08), while `ls_amm`'s `outpoint` and the relay's take `<txid>_<vout>`.

Which of these is a read and which a route with a handler is "Read routes",
below. `GET /live` is gone (0.5.0; it answered 410 from 0.4.0).

**Box `amm/register`** (the manifest's `"register"`, relative to the app,
shruggr/skein#128): the engine's `register {topic, program}`, `deregister
{topic}`, `registerLookup {service, program, topics?}`, `deregisterLookup
{service}` (skein-overlay 0.11.0: a token is its topic `tm_mandala_<assetId>`
and its lookup `ls_mandala_<assetId>`, BRC-207), from root (`roles`, 0.7.0). skein-overlay 0.7.7+ takes them in this box only
(0.7.5–0.7.6: `amm/overlay`).

**Box `amm/submit`** (the manifest's `"submit"`, `kernel.beef`): the
engine's `submit {beef, topics, offChainValues?}` from anyone (the
validator's own submissions among them) and `POST /submit`'s submission
event (skein-overlay 0.7.6), answered to the sender in this box; `register` / `deregister` here are refused (`bad-args`).

**Box `amm/amm-p2p`** (a message `{fn, args}`, skein docs/APPS.md §4; the
box `amm` before 0.7.0), and the route `/call` (a signed request):

| interface | functions | from |
|---|---|---|
| `amm.swap/1` | `submit` (writes), `status`, `terms` | anyone (root too) |
| `amm.pool/1` | `submit` (writes), `status`, `terms` (0.9.0: `{validator, peerId?, lpFeeBps, validatorFeeBps, commissionBps}`, this skein's validator and its terms) | anyone |

`amm.liquidity/1` is gone (0.9.0, with AddLiquidity).

**Box `amm/validator`** (0.9.0): root's `{fn: "rescind", args: {pool:
"<deploy txid>.0"}}` → amm-validator (above, "Rescind"), answered `{fn:
"rescind", request, result | error}` to the sender in this box.

**Box `amm/requests`** (0.9.0): a holder's listing request, `{fn:
"request", args: {tokenId}}` from anyone → amm-p2p, recorded under the head
`amm/requests` (the latest per token); nothing else runs. Settings reads
them with `GET /requests`; registering the token settles its request.

**Box `amm`** (derived): the engine's own `watch`, `resume`, `wait` (from
the instance itself) and, as an event route, the libp2p routes' admits.

`amm.*.submit` takes the funding transaction (the wallet's `noSend`
action) and the swap or the delivered deploy, and the validator the caller names —
`validator` (its identity key) and `peerId` (its libp2p peer ID, text, 0.4.0)
— checks the pair, records it under `amm/app` and relays it to that
validator: it dials `peerId` over libp2p, or, when `peerId` is its own
node's, calls its own `amm-validator` in-VM with the same package (a node
does not dial itself). It looks at no liveness. The record settles
`accepted`, `refused`, `timeout` or `failed` (amm-p2p README "The
marketplace relay"); a deploy is accepted with the validator's claimed
deploy, the delivered one with one output appended (0.9.0), and its record's
`pool` is the claimed deploy's output 0.

**libp2p**: `/amm-validator/1/swap`, `/deploy` (0.9.0: `/addLiquidity` gone)
(amm-validator; one signed-message package per frame); the engine's
`<topic>` (submit and admit messages, one mesh) and `-proof` for each
registered topic (skein-overlay 0.12.0; `-admit` before); `tm_mandala_<txid>_0-live`,
beaconed by a validator's host and subscribed, without admitting anything,
by a market's liveness tool (below); `ls_amm-live`, the AMM lookup's beat
(the prices, above), once root registers `ls_amm`.

**Box `amm/amm-p2p`** (also): the cron provider's ticks, `{kind: "amm-p2p-tick",
job: "catchup"}` — a utility nothing schedules (0.6.0). amm-p2p takes no
start or stop: the manifest has none, and the owner's `{kind:
"amm-p2p-start" | "amm-p2p-stop"}` is refused (`BadMessage`).

**Market and validator, always** (0.6.0, shruggr/skein#120; 0.8.1,
skein-overlay 0.12.0). David, 2026-10-09: "every skein is marketplace AND
validator from install, always". Two roles of the engine, never off; the
owner's switch of 0.6.2 (skein-overlay 0.9.2, `{fn: "market" |
"validator"}` in `amm/register`, kept in `amm/topics`) and the Token topics
page's Market and Validator switches are gone. `config.overlay.market:
{window}` / `.validator: {every}` give the ms (this manifest sets neither:
40 000 / 30 000). (0.8.1's Validator page is gone with the 0.9.0 pages.)

The engine, on `register {topic: "tm_mandala_<txid>_0", program: "mandala-topic"}`
(box `amm/register`, from root): subscribes the topic and seeds; emits
`{event: "liveness", topic: "tm_mandala_<txid>_0-live", window}` and
`{event: "beacon", topic: "tm_mandala_<txid>_0-live", every, body}` — the
frame carries the sender's identity key and the gossip message the peer
id; the body is the topic's view digest `{view: {count, digest}}`
(skein-overlay 0.12.0), re-declared when it changes. `deregister` reverses
both (`unliveness`, `unbeacon`). A start or a re-read emits nothing: the
intents stand in the log.

- **The validator.** amm-validator signs swaps and takes an LP's
  delivered deploy at its terms, appending its claim (above, "The deploy")
  — for any token whose topic is in the engine's registered set (the head
  `amm/topics`; always, 0.8.1); otherwise every
  `swap` and `deploy` is refused `{ok: false, reason:
  "not_validating", detail}` before anything is checked or signed. It reads
  the set at each call. Each beat is the host's signed
  frame (docs/MESSAGES.md "Beacons"): dag-cbor `{body, at, sender,
  signature}`, `body` the topic's view digest, `sender` the instance's identity key; the
  gossip message's peer is the node's peer ID, derived from the instance's
  root (`[2, "skein instance"]`, key ID `libp2p:<handle>`, counterparty
  self; skein signer.ts `peerKey`).
- **The market.** The runtime's liveness tool subscribes `tm_mandala_<txid>_0-live`
  without admitting its messages (no entry, nothing logged), verifies each
  beat's signature against `sender`, and keeps the beats newer than
  `window`, the latest per sender, with the node's own published beats, in
  memory; it serves them at `GET <base>/.live/tm_mandala_<txid>_0-live` → `[{sender,
  at, body: <base64>, from: <peer ID>}]` newest first (404 when no liveness
  is kept). The window is a margin over the beat (40 s against 30 s).
- **The page** reads that endpoint per token, takes each beat's `sender`
  (the validator) and `from` (its peer ID), plans (`market/plan.ts`) only
  over the pools whose validator is there, and names the chosen one in the
  swap (`validator` and `peerId`); the prices combine the `ls_amm-live`
  beats over the live validators (above, "Prices").

Gone in 0.6.0: `validate` / `unvalidate` (the box `amm/validate` and its
row), amm-p2p's validated set (the record's `validated` under `amm/p2p`),
its `beacon` / `liveness` emits and their bookkeeping (the maps `beacons`,
`subscriptions`), its start / stop and the cron fallback's heartbeat, and
`config.amm.ammP2p` (`market`, `heartbeatSeconds`, `offlineSeconds`:
`validator.every` is the beat, `market.window` the offline threshold).
Per-token permissioning is a later refinement: "if we needed that kind of
split, we would split it across multiple skeins".

## The manifest

`etc/app.json`: the six programs; `config.overlay` with no topics and the
lookups `ls_mandala`, `ls_mandala_deploys` (both `mandala-lookup`) and
`ls_amm` (`amm-lookup`), none with a `topics` list, so each listens to every
topic served; gossip on (the default); no `market` or `validator` (0.8.1:
both always on, at the defaults 40 000 / 30 000 ms; 0.6.0–0.6.1 set
`market: {window: 40000}` and `validator: {every: 30000}`, 0.6.2–0.8.0 had
root's switch); `config.amm` (`ammValidator`: the validator's terms
`{lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 0}`, 0.9.0; before, the
bounds `minValidatorFeeBps`, `maxLpFeeBps`, `maxCommissionBps`;
`commission`); `provides` the two `amm.*` interfaces (each `submit` with
`peerId: "string"` beside `validator`, 0.4.0; `amm.pool.terms`, 0.9.0);
`requires: ["chain/1"]`; no `start` / `stop` (0.6.0). No
`config.overlay.terms`: skein's install refuses an unknown `config.overlay`
field (the topic beat's `terms`, skein-overlay 0.12.1, waits on it).

### Routes

shruggr/skein#143 (0.7.0): a route names a transport, an address, its
filters and a handler; no sender. Mailbox addresses are relative to the app
(shruggr/skein#128: `"x"` is the box `amm/x`); one route per box. Who may
run a function is `roles`: `{"root": ["register", "registerLookup", "deregisterLookup", "rescind"]}`.

1. `register` → `overlay.register` (register / deregister and
   registerLookup / deregisterLookup; root's: any other key's message is recorded and runs nothing)
2. `submit`, `kernel.beef` → `overlay.submit` (submissions by message from
   anyone whose BEEF validates; the validator's own among them; skein-overlay 0.7.6)
3. `amm-p2p` → `amm-p2p` (the relay's interfaces by message, `{fn, args}`,
   answered to the sender in that box; the cron provider's ticks). Before
   0.7.0 the relay's message path was the app's box `amm` (a row from `*`
   after the engine's `event` and `$self` rows); since #143 a box has one
   route, and `amm` is the engine's (its own watch, resume and wait), so the
   relay took its own box.
4. `validator` → `amm-validator` (0.9.0: root's `rescind`, and the steps
   of its thread)
5. `requests` → `amm-p2p` (0.9.0: a holder's listing request, anyone)
6. http `/call`, `kernel.brc104` → `amm-p2p.call` (a signed request; the
   caller is its key)
7. libp2p `/amm-validator/1/swap`, `/deploy` → `amm-validator.swap`,
   `.deploy` (each refused `not_validating` for a topic not registered;
   `/addLiquidity` gone, 0.9.0)
8. the read routes, below

then, derived by the install from `config.overlay`: the box `amm` as an
`event` route and a `mailbox` route → `overlay` (gossiped submissions,
peers' admits; the engine's own watch, resume, wait), http `/submit`
(`kernel.beef`) → `overlay.submit`, and the read route `/lookup` (the
filter `lookup`, `overlay.lookup`).

### Read routes

An http route with no handler is a **read**: its filters run over the
request and the last one answers (`{answer: {status, type, body}}`), any
method, signed or not, **no entry, nothing logged** (a function that
writes fails inside the call). Exact paths match before a prefix, so
`/call`, `/submit` and `/lookup` are taken before the read `/`.

| path under `/amm/` | route | filter → program, fn | since |
|---|---|---|---|
| `/submit` | handler (derived), `kernel.beef` | → `overlay.submit` | |
| `/call` | handler, `kernel.brc104` | → `amm-p2p.call` | |
| `/lookup` | read (derived) | `lookup` → `overlay.lookup` | skein #135 |
| `/listTopicManagers`, `/listLookupServiceProviders` | read | `listTopicManagers`, `listLookupServiceProviders` → `overlay.<the same>` | 0.5.0 (http rows before) |
| `/getDocumentationForTopicManager`, `/getDocumentationForLookupServiceProvider` | read | `topicDocumentation`, `lookupDocumentation` → `overlay.<the same>` | 0.5.0 (http rows before) |
| `/` (prefix) | read, `root: "www"`, `index: "index.html"` | `page` → `amm-p2p.serve` | 0.5.0 (an http row before) |
| `/mandala/tokens` | read | `tokens` → `mandala-lookup.tokens` | 0.6.0 |
| `/requests` | read | `requests` → `amm-p2p.requests` | 0.9.0 |
| `/spends` | read | `spends` → `amm-p2p.spends` | 0.9.0 |
| `/.live/tm_mandala_<txid>_0-live`, `/.live/ls_amm-live` | the runtime's liveness read (no program, skein #138) | | |
| `/live` | gone | | 0.5.0 (410 in 0.4.0) |

amm-p2p's `serve` reads only (the head `amm/app` and the tree's blobs);
called as a filter it answers `{answer: <the page>}` (0.7.0).

**At the origin's root** (0.9.0: the landing at `/`, shruggr/skein#147):
root adds a root route to the same filter (skein-overlay README "Root
routes": root's own route, no `app`, outside `/<app>/`); the pages served
there take `<origin>/amm` as the app's base (0.8.1). No skein change is
needed:

```
skein routes add --transport http --prefix --filters amm.page --settings '{"root":"www","index":"index.html"}' / <origin>
```

## Not wired

- **The want-answer stream** `/skein/overlay/beef/1.0.0` (skein-overlay
  0.7.1+'s manifest row): not carried, as skein-mandala 0.6.0 does not; a
  submission paused on a parent resumes only when a later submission brings
  it.
- **`tm_mandala_<txid>_0-live` for an unregistered token.** Liveness is
  kept for a registered topic (every skein a market, 0.8.1); for a token
  not registered here the `.live` read answers 404 and its Swap page plans
  nothing.
- **Catch-up and proofs by block.** Never specified; sync is
  shruggr/skein#112's `want`. The `/amm/proofs/1.0.0` row is gone and no
  start schedules the catch-up pass; the code stays as a utility
  (`proofsByBlock`, `catchup`).
- **A setting changed after a register.** The roles' events are emitted at
  `register` / `deregister` only (the
  intents stand in the log; root's switch is gone, 0.8.1): a market window or a beat changed by a
  reinstall applies to the topics registered after it; a topic registered
  before keeps its standing liveness and beacon (deregister and register it
  again). An instance upgraded from 0.5.0 keeps
  the beacons and liveness amm-p2p emitted then (keyed by app and topic, as
  the engine's are; a register of a topic registered already emits nothing,
  so deregister and register it to replace them). Their beats still carry
  0.5.0's body, which the page no longer reads.
- **Governance per token** (#120 item 4) and the other Mandala queries:
  skein-mandala docs/MANDALA.md "Not built".
- **`ls_amm` beats once registered.** skein-overlay 0.12 declares a
  lookup's beacon (and keeps liveness on `<service>-live`) at
  `registerLookup`, not for a service the manifest declares; `ls_amm` is
  declared (so `/lookup` answers it from install) and root registers it too
  (the Settings page's register sends `registerLookup ls_amm`,
  idempotent). Until then there are no prices beats, and the pages price a
  token from this skein's own listing.
- **Root, as the page sees it.** No read tells a page a key's grants
  (shruggr/skein#143): `isRoot` is a stub, every connected wallet sees
  Settings, and the skein refuses a non-root's register messages.
- **Pending payouts.** A swap payout the wallet did not take in at once is
  kept in the browser (`wallet/pendingPayouts.ts`); 0.8.1's Pending payouts
  page, which retried them, is gone with the old pages, and the Open
  Exchange pages have no place for it.
- **Spends the chain app records of a transaction never submitted to the
  topic** (a pool spent by a transaction that bypassed the overlay): the
  listing does not fold them out (skein-overlay 0.12.1 "Beats"); the LP's
  page reads them (`/spends`).
- **Run end to end.** The programs are tested natively and the pages
  against fakes; this app has not been installed on a skein.
