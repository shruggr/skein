# The AMM on a skein

A constant-product AMM between BSV and one Mandala token per pool, served by
a skein overlay app. Decided in shruggr/skein#120: Mandala is components (a
topic manager and a lookup service, shruggr/skein-mandala); the AMM is an
app that carries them with its own pool lookup, validator and relay; one
topic per token, registered by root at runtime.

## The pieces

| role | source | what it does |
|---|---|---|
| `overlay` | skein-overlay 0.11.0 (`bin/overlay.wasm`, copied) | a submission by message in box `amm/submit`, answered to the submitter's box, or by `POST /submit` (BRC-22, the STEAK); `/lookup`, gossip, the listing and documentation reads; `register` / `deregister` a topic (and `registerLookup` / `deregisterLookup` its lookup), and with it the market's liveness and the validator's beacon on `tm_mandala_<txid>_0-live` (below, "Market and validator"); hands every admitted BEEF to the chain app |
| `mandala-topic` | skein-mandala 0.9.0 (copied) | judges `tm_mandala_<txid>_0` (`tm_mandala_<assetId>`, `_<vout>` always) by the BRC-162 rules; `tm_mandala` admits every deploy |
| `mandala-lookup` | skein-mandala 0.9.0 (copied) | `ls_mandala`, `ls_mandala_deploys`, each token's `ls_mandala_<assetId>` (BRC-207: `mandala-spendability`, `mandala-admission`), one index; its fn `tokens`, the token list, the read route `/mandala/tokens` (0.6.0: the token list is a read of the components) |
| `amm-lookup` | `programs/amm-lookup` | `ls_amm`: the live pools that pass the pool checks, per token |
| `amm-validator` | `programs/amm-validator` | the validator's three direct calls, for every registered token when the validator role is on (root's switch, else `config.overlay.validator`); submits by message to its own overlay |
| `amm-p2p` | `programs/amm-p2p` | the relay, the pages (`www/` from the app's tree); the catch-up utility, unscheduled |
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
- **Methods** (the contract): `Swap(validatorSig, nextValidatorPubKey,
  amountIn, bsvIn, userPkh, commissionPkh)`; `AddLiquidity(lpSig,
  validatorSig, nextLpPubKey, nextValidatorPubKey, addBsv, addTokens)`;
  `RemoveLiquidity`, the LP's alone. Fees are fixed at deploy, in basis
  points of the input, rounded up, paid in the input asset: LpFeeBps to the
  LP, ValidatorFeeBps to the validator, CommissionBps to whoever relays the
  swap. The contract builds every output; a swap carries no others.
- **Keys rotate.** Each party names its next key on every spend it signs.
  The validator's key is the BRC-42 child of its ValidatorIdentity,
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

## Interfaces

**Overlay** (base URL `<handle>.<host>/amm`):

| route | what |
|---|---|
| `POST /submit` | BRC-22 (`X-Topics` a registered topic): the request waits on the submission and answers the STEAK; 400 for a BEEF that does not verify or a rejected transaction; 503 + Retry-After while undecided (skein-overlay 0.9.1; 0.7.3–0.9.0 answered `{id}`) |
| `POST /lookup` | BRC-24: `ls_amm` `{tokenId}`, `{tokenId, outpoint, beef?}`, `{tokenId, validatorIdentityKey}`; `ls_mandala`, `ls_mandala_deploys` (skein-mandala README) |
| `GET /listTopicManagers`, `/listLookupServiceProviders`, `/getDocumentationFor…` | the listings (each program's `metadata` / `documentation`); reads since 0.5.0 |
| `GET /.live/tm_mandala_<txid>_0-live` | the runtime's liveness read (skein #138, no program): `[{sender, at, body, from}]` newest first, the beats within the window (`body` empty: the validator is `sender`, its peer ID `from`); 404 when the app keeps no liveness for the topic (not a market, or the topic not registered) |
| `GET /mandala/tokens` | mandala-lookup `tokens`: the token list, `{limit?, skip?}` → `[{tokenId, topic, sym, dec, icon?, txid, vout}]` (`icon` a Mandala deploy's embedded image as a data URL, skein-mandala 0.9.0); a read (0.6.0) |
| `POST /call` | amm-p2p: `{fn, args}` for the three interfaces below |
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
| `amm.pool/1` | `submit` (writes), `status` | anyone |
| `amm.liquidity/1` | `submit` (writes), `status` | anyone |

**Box `amm`** (derived): the engine's own `watch`, `resume`, `wait` (from
the instance itself) and, as an event route, the libp2p routes' admits.

`amm.*.submit` takes the funding transaction (the wallet's `noSend`
action) and the swap, deploy or add, and the validator the caller names —
`validator` (its identity key) and `peerId` (its libp2p peer ID, text, 0.4.0)
— checks the pair, records it under `amm/app` and relays it to that
validator: it dials `peerId` over libp2p, or, when `peerId` is its own
node's, calls its own `amm-validator` in-VM with the same package (a node
does not dial itself). It looks at no liveness. The record settles
`accepted`, `refused`, `timeout` or `failed` (amm-p2p README "The
marketplace relay").

**libp2p**: `/amm-validator/1/swap`, `/addLiquidity`, `/deploy`
(amm-validator; one signed-message package per frame); the engine's
`<topic>`, `-admit`, `-proof` for each registered topic; `tm_mandala_<txid>_0-live`,
beaconed by a validator's host and subscribed, without admitting anything,
by a market's liveness tool (below).

**Box `amm/amm-p2p`** (also): the cron provider's ticks, `{kind: "amm-p2p-tick",
job: "catchup"}` — a utility nothing schedules (0.6.0). amm-p2p takes no
start or stop: the manifest has none, and the owner's `{kind:
"amm-p2p-start" | "amm-p2p-stop"}` is refused (`BadMessage`).

**Market and validator** (0.6.0, shruggr/skein#120). David, 2026-10-06
evening: "a skein runs as a market and/or a validator by two settings in the engine's configuration (`config.overlay.market: {window}`, `config.overlay.validator: {every}`), and registering a token's topic is the one act that drives both". Two roles of the engine (skein-overlay 0.9.0+), the only role settings.

**Root's switch** (0.6.2, skein-overlay 0.9.2; root since 0.7.0). David, 2026-10-07:
"this shouldn't have been a config in the manifest. This should be a
setting that the user is configuring". This manifest sets neither: both
roles are off as installed. Root turns one on at install with
`--config '{"overlay": {"market": {"window": 40000}, "validator": {"every":
30000}}}'` (the initial value), or at any time by a message to the engine
in `amm/register`, as register is sent — the Market and Validator switches
on the Token topics page (`mandala/tokens/`, skein-mandala 0.7.3):

```
{"fn": "market", "args": {"window": 40000}}    |  {"fn": "market", "args": {"off": true}}
{"fn": "validator", "args": {"every": 30000}}  |  {"fn": "validator", "args": {"off": true}}
```

answered `{market?: {window}, validator?: {every}}`, the roles in effect.
The switch is kept beside the registered set in `amm/topics` (`market?` /
`validator?`, `{window}` / `{every}` or `{off: true}`) and has precedence
over `config.overlay` from then on. On emits `liveness` / `beacon` on
`tm_mandala_<txid>_0-live` for every token already registered, off `unliveness` /
`unbeacon`; registers and deregisters from then on follow the roles in
effect. The Validator page shows the roles in effect, read the same way
(the switch in `amm/topics` over the app record's `config.overlay`;
web/ui `src/validator/control.ts` `withSwitches`).

The engine, on `register {topic: "tm_mandala_<txid>_0", program: "mandala-topic"}`
(box `amm/register`, from root): subscribes the topic and seeds; with
the market on, emits `{event: "liveness", topic: "tm_mandala_<txid>_0-live", window}`; with
`validator`, `{event: "beacon", topic: "tm_mandala_<txid>_0-live", every, body:
<empty>}` — "the beat needs no body: the frame carries the sender's
identity key and the gossip message the peer id". `deregister` reverses
both (`unliveness`, `unbeacon`). A start or a re-read emits nothing: the
intents stand in the log.

- **The validator.** amm-validator signs swaps and takes on new liquidity
  — signs an LP's `addLiquidity`, consents to a pool `deploy` as the pool's
  validator (receiving liquidity, not the node putting up funds of its own)
  — for any token whose topic is in the engine's registered set (the head
  `amm/topics`) when the validator role is on (the switch kept there, else
  `config.overlay.validator`); otherwise every
  `swap`, `addLiquidity` and `deploy` is refused `{ok: false, reason:
  "not_validating", detail}` before anything is checked or signed. It reads
  the setting and the set at each call. Each beat is the host's signed
  frame (docs/MESSAGES.md "Beacons"): dag-cbor `{body, at, sender,
  signature}`, `body` empty, `sender` the instance's identity key; the
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
  (the validator) and `from` (its peer ID), shows the validators within the
  window, plans (`market/plan.ts`) only over the pools whose validator is
  there, and names the chosen one in the swap (`validator` and `peerId`).

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
topic served; gossip on (the default); no `market` or `validator` (0.6.2:
both off until root turns one on, above; 0.6.0–0.6.1 set
`market: {window: 40000}` and `validator: {every: 30000}`); `config.amm` (`ammValidator`,
`commission`); `provides` the three `amm.*` interfaces (each `submit` with
`peerId: "string"` beside `validator`, 0.4.0); `requires: ["chain/1"]`; no
`start` / `stop` (0.6.0).

### Routes

shruggr/skein#143 (0.7.0): a route names a transport, an address, its
filters and a handler; no sender. Mailbox addresses are relative to the app
(shruggr/skein#128: `"x"` is the box `amm/x`); one route per box. Who may
run a function is `roles`: `{"root": ["register", "registerLookup", "deregisterLookup", "market", "validator"]}`.

1. `register` → `overlay.register` (register / deregister and the
   switches; root's: any other key's message is recorded and runs nothing)
2. `submit`, `kernel.beef` → `overlay.submit` (submissions by message from
   anyone whose BEEF validates; the validator's own among them; skein-overlay 0.7.6)
3. `amm-p2p` → `amm-p2p` (the relay's interfaces by message, `{fn, args}`,
   answered to the sender in that box; the cron provider's ticks). Before
   0.7.0 the relay's message path was the app's box `amm` (a row from `*`
   after the engine's `event` and `$self` rows); since #143 a box has one
   route, and `amm` is the engine's (its own watch, resume and wait), so the
   relay took its own box.
4. http `/call`, `kernel.brc104` → `amm-p2p.call` (a signed request; the
   caller is its key)
5. libp2p `/amm-validator/1/swap`, `/addLiquidity`, `/deploy` →
   `amm-validator.swap`, `.addLiquidity`, `.deploy` (each refused
   `not_validating` with the validator role off, or for a topic not registered)
6. the read routes, below

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
| `/.live/tm_mandala_<txid>_0-live` | the runtime's liveness read (no program, skein #138) | | |
| `/live` | gone | | 0.5.0 (410 in 0.4.0) |

amm-p2p's `serve` reads only (the head `amm/app` and the tree's blobs);
called as a filter it answers `{answer: <the page>}` (0.7.0).

## Not wired

- **The want-answer stream** `/skein/overlay/beef/1.0.0` (skein-overlay
  0.7.1+'s manifest row): not carried, as skein-mandala 0.6.0 does not; a
  submission paused on a parent resumes only when a later submission brings
  it.
- **`tm_mandala_<txid>_0-live` off a market host.** Liveness is kept by a host
  serving a market (the market role on, above); on any other host its
  `.live` read answers 404 and its Swap page plans nothing.
- **Catch-up and proofs by block.** Never specified; sync is
  shruggr/skein#112's `want`. The `/amm/proofs/1.0.0` row is gone and no
  start schedules the catch-up pass; the code stays as a utility
  (`proofsByBlock`, `catchup`).
- **A setting changed after a register.** The roles' events are emitted at
  `register` / `deregister` and at root's switch (0.6.2) only (the
  intents stand in the log): a market window or a beat changed by a
  reinstall applies to the topics registered after it; a topic registered
  before keeps its standing liveness and beacon (deregister and register it
  again, or switch the role: the switch emits for every registered topic). An instance upgraded from 0.5.0 keeps
  the beacons and liveness amm-p2p emitted then (keyed by app and topic, as
  the engine's are; a register of a topic registered already emits nothing,
  so deregister and register it to replace them). Their beats still carry
  0.5.0's body, which the page no longer reads.
- **Governance per token** (#120 item 4) and the other Mandala queries:
  skein-mandala docs/MANDALA.md "Not built".
- **Run end to end.** The programs are tested natively and the pages
  against fakes; this app has not been installed on a skein.
