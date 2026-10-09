# @amm-poc/market-ui

Four pages — **Tokens** (the wallet's tokens, Mandala deploy), **Pools**
(create a pool, my pools, add and remove liquidity), **Swap**, **Validator** (your
own instance as a validator) — for the AMM. The header shows the
connected wallet's identity (short), the overlay's host, and links to the
Mandala pages the app carries (`mandala/deploy/`, `mandala/tokens/`).

Moved from amm-poc `web/ui` (with its matching engine, `../engine`).
Changed for skein-amm: the build writes `../../www/` (the app's pages,
committed; `../../scripts/www.sh` builds them and copies the Mandala pages
into `www/mandala/`); the base URL is the page's own directory
(`src/lib/config.ts` `appBaseOf`: `https://<handle>.<host>/amm` or
`<host>/@<handle>/amm`), `VITE_AMM_OVERLAY` overriding it; pool lookups go to
the one service `ls_amm` with the token in the query (`{tokenId, …}`); the
Validator page reads the policy from the app record's `config.amm` through
the explorer. The records of runs against "v2/amm3" below are amm-poc's
deploy.

**skein-amm 0.4.0: liveness is the runtime's read** (shruggr/skein#120,
#138). Every page that showed `GET <base>/live` now reads, per token topic,
`GET <base>/.live/tm_mandala_<txid>_0-live` → `[{sender, at, body, from}]` newest first
(404: the instance keeps no liveness for it), decodes each `body` (dag-cbor
`{identityKey, peerId}`, the beacon's) and keeps the validators within the
window (`LIVE_WINDOW_MS`, 40 s; `src/lib/overlay.ts` `fetchLive`,
`parseLiveBeats`). The Swap page plans only over the pools whose validator
is there (`src/market/plan.ts` `livePools`) and names that validator in the
swap: `amm.swap.submit` carries its `peerId` beside `validator`, as
`amm.pool.submit` and `amm.liquidity.submit` do from the Pools page (whose
picker lists the validators live on any served token, merged). The Validator
page reads the peer's `.live` read of this instance's token topics. Where the
text below says `/live`, `thresholdMs` or "heartbeat seen", read this.

**skein-amm 0.6.3: ids** (David, 2026-10-08): every outpoint is
shown `<txid>.<vout>`; every txid, token id, outpoint and topic shown is an
`<Id>` (`src/components/Id.tsx`: shortened, whole on a click, a copy
button). The remove-liquidity
submit, `POST <base>/submit`, is plain `fetch`, unsigned ("We shouldn't be
using authfetch for the submit http method").

**skein-amm 0.8.0: BRC-207 topic names and embedded icons** (David Case,
2026-10-08; skein-mandala 0.9.0): a token's topic is `tm_mandala_<assetId>`,
the asset id `<txid>_<vout>`, `_0` included, so a Mandala token's is
`tm_mandala_<txid>_0` and its liveness topic `tm_mandala_<txid>_0-live`; 0.7.2's
`tm_<txid>_0` is no topic (no alias). A Mandala deploy's icon is the image
embedded in it (BRC-162 draft bsv-blockchain/BRCs#308, `[mediaType,
bytes]`): the Tokens page shows it, and the deploy form embeds an uploaded
image or a picked ordinal's bytes (below, "Deploy"). **skein-amm 0.7.2: topic names** (David, 2026-10-08: "that was the decision
all along"; skein-mandala 0.8.2): a token's topic was `tm_<tokenId>`. The pool deploy
and the remove-liquidity submit name the token's topic from its full id
(`src/lp/poolDeploy.ts`, `src/lp/removeLiquidity.ts`), and `parseTokenTopic`
(`src/lib/overlay.ts`) takes `tm_mandala_<txid>_<vout>` only.

**skein-amm 0.7.1: one token id form** (David, 2026-10-07, shruggr/skein#120;
supersedes 0.6.3's bare txid): every token id, Mandala and legacy BSV-21
alike, is `<txid>_<vout>`, `_0` included, as BRC-162 "Token identification"
writes it; the bare 32-byte txid is the wire form only. The pages, the
wallet's filings and `ls_amm` queries carry the same string
(`src/lib/tokenId.ts`), so the pages no longer read `/mandala/tokens` to
learn a token's origin.

**skein-amm 0.7.0: root, not an owner** (shruggr/skein#143, skein's routes,
filters and roles). The explorer (`/explore`) and the engine's
`amm/register` box (register, deregister, the Market and Validator
switches) are gated by the role `root`, which the key that claimed the
instance holds (and any key root grants it to). The pages send the same
messages and reads; read "the owner" below as root. Gone: the genesis
`owner` the Validator page read (`readGenesis`) and `VITE_AMM_OWNER_IDENTITY`
(nothing used it). The pages are served by the read route `/` (its filter
`page`, amm-p2p's `serve`); `/call` takes a signed request
(`kernel.brc104`), unchanged for the pages.

**skein-amm 0.6.2: the roles are the owner's switch** (skein-overlay 0.9.2;
David, 2026-10-07: "this shouldn't have been a config in the manifest. This
should be a setting that the user is configuring"). The manifest sets
neither; the owner turns each on with the Market and Validator switches on
the Token topics page (`mandala/tokens/`, skein-mandala 0.7.3: `{fn:
"market" | "validator", …}` to `amm/register`), or `--config` at install.
The Validator page's Policy shows the roles in effect, read as the engine
reads them: the switch kept in `amm/topics` over the app record's
`config.overlay.market` / `.validator` (`src/validator/control.ts`
`withSwitches`). Below, "with `config.overlay.market`" reads "with the
market on".

**skein-amm 0.6.0: market and validator are the engine's** (shruggr/skein#120,
David 2026-10-06 evening). Registering a token's topic (the Tokens page) is
the one act: with `config.overlay.market {window}` the engine asks for the
topic's liveness, with `config.overlay.validator {every}` it beacons
`tm_mandala_<txid>_0-live`, and amm-validator signs for every registered token. The
beat has no body: `parseLiveBeats` takes the validator's identity from each
entry's `sender` and its peer ID from `from`. The Validator page has no
buttons any more — no "Start / Stop heartbeat" (amm-p2p takes no start or
stop), no per-topic "Validate / Stop validating" (no validated set) — and
shows the registered tokens and, through the explorer (owner only), the two
settings beside the validator's fees (`src/validator/control.ts`
`policyOf`). Where the text below describes the Register / heartbeat
section, `validate` or `config.amm.ammP2p`, read this.

## Not built (all pages)

Each is shown in the UI where it applies, with its reason. Details in the
pages' sections below.

- **Swap: run against a live relay.** The page codes against
  `amm.swap.submit` / `amm.swap.status` on the AMM app's `/call` route
  (programs/amm-p2p, being built on branch `relay`); tested against a fake
  relay and a fake wallet only.
- **Swap: token change ("not built: token split").** A token → sats leg
  needs token outputs adding up exactly to the amount; splitting first is
  not built.
- **Swap: retrying a token payout.** A sats payout that the wallet fails to
  internalize stays under Pending payouts; a token payout (basket
  insertion) that fails is reported on the leg only.
- **Pools: the deploy against a live relay.** The page codes against
  `amm.pool.submit` / `amm.pool.status` (same `/call` route and record as
  the swap's); no program provides them yet (programs/amm-p2p has the swap
  functions only), so on v2/amm3 the deploy ends `failed: unknown-fn` and
  the funding is aborted. Tested against a fake relay and wallet only.
- **Pools: AddLiquidity against a live relay.** The page codes against
  `amm.liquidity.submit` / `amm.liquidity.status` (the swap's `/call` route
  and record); no program provides them yet, so on v2/amm3 an add ends
  `failed: unknown-fn` and the funding is aborted. Tested against a fake
  relay and wallet only.
- **Pools: AddLiquidity token split.** Tokens to add must be an exact sum of
  wallet token outputs (a contract call has no token change output): "not
  built: token split" otherwise, as the swap's.
- **A real wallet against v2/amm3.** The instances run a fake header feed;
  a mainnet wallet would refuse the pools' BEEF (Swap, RemoveLiquidity).
  The sequences are tested against a fake wallet only.
- **Tokens / Swap: metadata for tokens the wallet does not hold**: a later
  lookup question.
- **Pools: no pool of the wallet's on v2/amm3**; **recovering an LP key the
  wallet lost** beyond the BEEF's reach.
- **Pools / Validator: the validator's fee terms are not readable** through
  any open route (genesis `defaults.ammValidator`); the Validator page reads
  them through the explorer when the wallet holds root (0.7.0).
- **Validator: editing the policy** (fees, heartbeat interval): a genesis
  config change; the app offers no config change yet (`config.amm` via the
  manifest or a `writes: true` function, skein #72 build 3).
- **Validator: seeing amm-p2p's refusal of a non-owner's start/stop.** The
  messagebox admits it (200; box `amm-p2p` is subscribed for any sender);
  amm-p2p errors its step on the instance's thread, which no HTTP answer
  carries. Only the peer's `/amm/live` shows whether the heartbeat runs.

## Configuration (env)

Vite reads these at build / dev-server start (a local `.env.local`,
untracked, or the environment):

| variable | default | what |
|---|---|---|
| `VITE_AMM_OVERLAY` | the page's own directory (`appBaseOf`) | the AMM app's base URL (every page); its origin is the instance (messagebox, `/.well-known/auth`, `/explore`). Set it for a dev server on another origin |
| `VITE_AMM_PEER_OVERLAY` | (none) | another node's AMM base URL: the Validator page reads this instance's liveness and peer ID from its `.live/tm_mandala_<txid>_0-live` reads (0.4.0); unset disables |
| `VITE_AMM_REFRESH_MS` | `10000` | the Swap page's refresh |
| `VITE_FEE_RATE` | `100` | the swap's miner fee rate, sats per 1000 bytes: the funding output carries `ceil(size × rate / 1000)` for the final swap (below, "Funding") |

## Dev server

```
cat > .env.local <<'ENV'
VITE_AMM_OVERLAY=http://127.0.0.1:8100/@<handle>/amm
VITE_AMM_PEER_OVERLAY=http://127.0.0.1:8100/@<other>/amm
ENV
nohup npm run dev -- --port 4900 --host 127.0.0.1 > .dev.log 2>&1 &
# open http://localhost:4900/ (localhost, so the wallet fetches the manifest: "Permissions")
```

`.env.local` is ignored by git (`*.local`); do not build `www/` with one in place (it would bake the dev base URL in). The instance answers CORS
preflights with `*`, so the page calls it cross-origin, including AuthFetch's
`/.well-known/auth` handshake and its signed requests.

## Permissions

`public/manifest.json` (served at `/manifest.json`, linked from
`index.html`) is a W3C web-app manifest whose `metanet.groupPermissions`
(BRC-73) declares what the pages ask the wallet for. A wallet built on
wallet-toolbox's `WalletPermissionsManager` fetches `<origin>/manifest.json`
inside `waitForAuthentication`, drops what this origin already holds
(`filterAlreadyGrantedPermissions`) and raises **one** grouped prompt for
the rest. Every @1sat/connect connector calls `waitForAuthentication({})`
first on connect (src/wallet/AppWalletProvider.tsx), so that prompt comes
before any other.

Declared:

- Spending: 10,000,000 sats (0.1 BSV) a month — swap inputs, pool
  deposits, fees.
- Baskets: `bsv21` (tokens, pools held as LP), `1sat` (ordinals as icons;
  an inscribed icon), `1sat-deposit` (a swap's exact funding output, held
  until the swap's expiry, relinquished once the swap spent it).
- Protocols:
  - `[0, "onesat"]` (1sat-sdk's `P1SAT_PROTOCOL`: token and legacy LP keys).
    Level 0 is never prompted (`ensureProtocolPermission` returns at level 0,
    WalletPermissionsManager.ts:1210), so the wallet never shows it; declared
    for completeness.
  - `[2, "3241645161d8"]`, counterparty `"self"`: BRC-29 payout keys and LP
    keys ("BRC-29 payouts"). Level-2 grants are keyed by the exact
    counterparty string (`findProtocolToken`), so the page derives with
    counterparty `"self"` — the same key as the user's identity key in hex,
    but only `"self"` can be named in a static manifest.
  - `[1, "identity key retrieval"]`: `getPublicKey({identityKey: true})`
    (connect, the remittance's sender, AuthFetch) is checked as this level-1
    protocol (WalletPermissionsManager.ts:4495), which groups like any
    level-1 entry.
  - `[2, "server hmac"]`, counterparty `"self"`: AuthFetch's session nonces
    (`createNonce` / `verifyNonce`, counterparty self).
  - `[2, "auth message signature"]`, **no counterparty**: AuthFetch's request
    signatures, counterparty = the instance's identity.
  - `[1, "action label amm-swap" | "amm-pool-deploy" |
    "amm-remove-liquidity" | "amm-add-liquidity" | "amm-payout"]`: action labels are checked as
    level-1 protocols `[1, "action label <label>"]` (`ensureLabelAccess`).
- Certificates: none.

Still prompted one-off, and why:

- **AuthFetch to the instance** (`[2, "auth message signature"]` with the
  instance's identity key). The grant needs the exact counterparty, which
  depends on the instance the page is pointed at and is not known when the
  manifest is written (no config names the instance's identity).
  `filterAlreadyGrantedPermissions` skips a level-2 entry without a
  counterparty (WalletPermissionsManager.ts:1739), so it is not in the
  connect prompt; on first use with an instance,
  `maybeRequestPeerGroupedLevel2ProtocolPermissions` (:1961) fills the
  missing counterparty with that instance's key and raises a grouped prompt
  for it — once per instance, not up front.
- **Spending beyond the monthly authorization**: a spending prompt
  (`ensureSpendingAuthorization`).
- **Token inputs filed by other apps** under a level-1/2 protocol other than
  the above (the key named in a basket row's customInstructions): that
  protocol's own prompt.
- **A wallet without grouped-permission support** (no
  `onGroupedPermissionRequested` handler) prompts each item on its own.

Where the manifest must be: the manager fetches
`http://<originator>/manifest.json` only for `localhost:<port>` originators,
`https://` for every other (WalletPermissionsManager.ts:1678), at the origin
root. So in dev open the page as `http://localhost:4900/` (not
`127.0.0.1`), and in a deployment serve the UI at the host root over HTTPS
(deploy/README.md).

LP and taker pages for the AMM PoC — a Vite + React + TypeScript static
site meant to be served by a skein overlay instance's own HTTP routes
(see `deploy/README.md`). See `docs/notes.md` in the main repo, "Overlay
and communication layer on skein (2026-09-29)" — in particular "Market UI
and matching engine", "UI and deployment", "Commission fee (decided
2026-10-02)", "Marketplace relay" and "Direct paths".

## Install / run / test

```
npm ci
npm run dev        # local dev server
npm run build       # typecheck, then ../../www/ (the Mandala pages: ../../scripts/mandala-pages.sh after it)
npm test            # vitest run
npm run typecheck
```

`../engine` needs its own `npm ci` first (a `file:` dependency).

(No `bun` was available in this dev environment either, same as
`web/engine` — npm + vitest throughout.)

## The instance (config)

`src/lib/config.ts`: every request the page makes goes to one skein instance,
the AMM app's base URL (the page's own directory, else `VITE_AMM_OVERLAY`),
or to the connected BRC-100 wallet. Under that
base: `GET listTopicManagers`, `GET listLookupServiceProviders`, `POST lookup`
(BRC-24, service `ls_amm`), `GET live`, and through AuthFetch `POST call` (the swap relay).
`VITE_AMM_REFRESH_MS` (default 10000) is the Swap
page's refresh interval. There are no DEV keys and no DEV services: the old DEV swap builder,
the DEV `ProtoWallet` and the HTTP validator transport are deleted.

The instance sends `access-control-allow-origin: *` on its routes, so a dev
server on another origin calls it cross-origin. Plain
`fetch` (`src/lib/overlay.ts`), because the stock `@bsv/sdk`
`LookupResolver` drops freeform answers and `TopicBroadcaster` refuses topic
names like `tm_<64 hex>` before sending anything.

Names (skein-mandala docs/MANDALA.md): a token's topic is `tm_mandala_<assetId>`,
the asset id `<txid>_<vout>` always (0.8.0, skein-mandala 0.9.0, BRC-207;
David Case 2026-10-08): a token deployed at output 0 is topic
`tm_mandala_<txid>_0`, a BRC-161 token deployed at a non-zero output
`tm_mandala_<txid>_<vout>`; the old `tm_<txid>_<vout>` is no topic. The pages write
every token id `<txid>_<vout>`, `_0` included (BRC-162 "Token
identification"; 0.7.1, David 2026-10-07), and
show an outpoint as `<txid>.<vout>` (0.6.3, David 2026-10-08;
`src/lib/tokenId.ts`); `ls_amm` takes any form in `{tokenId}`. The topics listed are
the ones the owner registered with the engine (`/listTopicManagers`).

## Swap page

`src/pages/Swap.tsx` over `src/market/*` (pure, tested) and `src/lib/overlay.ts`.

1. **Market.** "Overlay: <base URL>"; the token topics from
   `listTopicManagers`; per token its pools from `POST lookup {}` with
   reserves, LP / validator fee / commission bps, marginal price (sats per token in display
   units when decimals are known, else per base unit), and the validator's
   identity with a green / grey dot from `GET live` (`{now, thresholdMs,
   validators: [{identityKey, peerId, at, ageMs, live}]}`). Symbol, decimals
   and icon come from the wallet when it holds the token's deploy output (the
   Tokens page's inventory code); otherwise the id only, with a note that metadata
   for unheld tokens is a later lookup question. Refreshes on a timer.
2. **Plan.** Token, direction, amount in (sats, or tokens in display units),
   max slippage (bps), "split across several pools". The engine plans
   (`plan`; partial fills across pools as it does; the engine prices each
   pool's commission as a third fee on amount in, next to the LP and
   validator fees). Shown per leg: in, out, LP fee, validator fee,
   commission, validator; then total out, the fee totals, effective price,
   mid price (best pool's marginal price, pre-fee), percent below mid (fees
   included) and the engine's minimum out. Below the form: where the
   commission goes (the relay's `amm.swap.terms`, below).
3. **Swap** (`src/market/swapAction.ts`, `relay.ts`, `swapFlow.ts`), per leg
   (docs/notes.md, "Swap funding and signing", "Marketplace relay",
   "Commission fee"). Every signature is the wallet's; the page holds no key.
   - **Terms**, once per Swap click, before anything is built: `POST
     <VITE_AMM_OVERLAY>/call` `{fn: "amm.swap.terms", args: {}}` (AuthFetch,
     as below) → `{commissionPkh: <20 bytes as DAG-JSON bytes> | null}`. An
     error answer stops the swap (nothing built). The pkh is Swap's
     `commissionPkh` for every leg.
   - `POST lookup {outpoint, beef: true}`: the pool output's AtomicBEEF; the
     leg is refused if the lookup's tip is not the planned outpoint.
   - `PoolTemplate.planSwap`: the contract's outputs (pool, payout, LP fee,
     validator fee, commission; each fee only when nonzero) and method args
     (`validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh,
     commissionPkh`), checked against the leg (reserves, the three rates, the
     three fees, amount out).
   - **Commission.** `ceil(amountIn × CommissionBps / 10000)` in the input
     asset (sats in: a P2PKH output of that many sats; tokens in: a 1-sat
     Mandala output), the last output, paid to `commissionPkh`. The relay's
     pkh when it names one. When it names none (a user running their own
     overlay) and the pool's CommissionBps is nonzero, the commission is the
     taker's own: a key derived as for a payout in that asset — sats: a
     BRC-29 payment to self (`getPublicKey({identityKey: true})`, then the
     BRC-29 key; recorded under Pending payouts like a sats payout); tokens:
     `getPublicKey({protocolID: [0, "onesat"], keyID: "<tokenId>-<hex>",
     counterparty: "self", forSelf: true})` — and it is internalized with
     the payout after acceptance. A pool with CommissionBps 0 has no
     commission output whatever the relay says (the pkh is still pushed:
     the relay's, or 20 zero bytes).
   - Payout key. Tokens out: `getPublicKey({protocolID: [0, "onesat"],
     keyID: "<tokenId>-<hex>", counterparty: "self", forSelf: true})`. Sats
     out: `getPublicKey({identityKey: true})`, then the BRC-29 key
     ("BRC-29 payouts" below).
   - Token → sats only: token inputs are Mandala value outputs of the token
     from the `bsv21` basket adding up to **exactly** the leg's amount (else
     "Not built: token split"); `listOutputs({basket: "mandala <txid> 0",
     include: "entire transactions"})` and `listOutputs({basket: "bsv21",
     tags: ["bsv21:<tokenId>"], include: "entire transactions"})` for their
     source transactions.
   - **Funding.** The exact amount is Σ contract outputs − pool sats − token
     inputs' sats (sats in: amount in + 1 sat for the token payout, the fees
     and the commission being part of amount in; tokens in: 1 sat per Mandala
     fee or commission output − the token inputs' sats) plus the miner fee: the final swap's size (pool input at
     `PoolTemplate.maxCallUnlockLength`, i.e. with the validator's
     signature; 108 bytes per P2PKH input; the contract's outputs; no change)
     at `VITE_FEE_RATE`. Then:
     `getPublicKey({protocolID: [0, "onesat"], keyID: "amm-funding-<hex>",
     counterparty: "self", forSelf: true})`;
     `createAction({description: "AMM swap funding", labels: ["amm-swap"],
     outputs: [{lockingScript: P2PKH(that key), satoshis: <exact>, basket:
     "1sat-deposit", tags: ["amm-funding", "hold:<expires>"],
     customInstructions: {protocolID, keyID, counterparty: "self", amm: {pool,
     expires}}}], options: {signAndProcess: false, randomizeOutputs: false,
     noSend: true}})`; `signAction({reference, spends: {}, options: {noSend:
     true}})`. The wallet funds it from its own change and keeps it as a
     signed `nosend` action; nothing is broadcast. `expires` is now + 2 min;
     the hold keeps 1sat-sdk's `sweepDeposit` off the output until then (as
     OrdLock v2 front funding).
   - **Swap transaction**, built by the page: inputs [pool (`callUnlock`:
     the contract pushes, validator slot `OP_0`, `_changeAmount = 0`),
     funding:0, token inputs]; outputs exactly the contract's, no change.
     The funding input and each token input: `createSignature({protocolID,
     keyID, counterparty, hashToDirectlySign: <BIP-143 sighash,
     ALL|FORKID>})` + `getPublicKey` (the key from the output's
     customInstructions). Every input but the pool's is checked with
     @bsv/sdk's `Spend` before anything leaves the page.
   - **Relay.** Through the wallet-backed AuthFetch (BRC-104), `POST
     <VITE_AMM_OVERLAY>/call` (skein docs/APPS.md §4), body `{fn:
     "amm.swap.submit", args: {funding, swap, pool, validator, expires}}`:
     funding the wallet's AtomicBEEF, swap raw, validator the identity's 33
     bytes, each as DAG-JSON bytes `{"/": {"bytes": "<base64>"}}`; pool
     `<txid>_<vout>`, expires unix ms. The answer `{fn, result: <record>}`
     (`{id, status: pending | accepted | refused | timeout | failed, tx?,
     txid?, reason?, detail?, poolState?}`) or `{fn, error: {code,
     message}}`. While pending: `{fn: "amm.swap.status", args: {id}}` every
     second, until the swap's expiry + 30 s.
   - **Accepted**: the final transaction is checked against ours (same
     inputs, taker scripts and outputs; only the validator's slot differs);
     `internalizeAction({tx: <AtomicBEEF>, outputs: [payout, own
     commission?], labels: ["amm-swap"]})` — sats: `protocol: "wallet payment"` with the
     remittance; tokens: `protocol: "basket insertion"`, `{basket: "bsv21",
     tags: ["bsv21:<tokenId>"], customInstructions: {id, amt, op:
     "transfer", sym, dec, protocolID, keyID, counterparty}}` (as 1sat-sdk's
     `transferBsv21` files a self output). Then `relinquishOutput({basket:
     "1sat-deposit", output: <funding>})` and `relinquishOutput({basket:
     "bsv21", output})` per token input. The funding action stays `nosend`;
     wallet-toolbox's `TaskCheckNoSends` finds its proof once the
     validator's broadcast is mined.
   - **Refused / timeout / an error answer to submit**: `abortAction({reference:
     <funding>})` (its inputs are freed; its output never existed on chain).
     A refusal's `poolState` replaces that pool in the plan (the engine
     replans against it until the lookup catches up).
   - **No answer** (network failure, the relay's transport `failed`, still
     pending past the expiry): nothing is aborted, since the validator may
     still have the pair; "Check again" re-reads the record, "Abandon"
     aborts the funding.
4. **Pending payouts.** A sats payout's (or the taker's own sats
   commission's) remittance is recorded before the
   swap is submitted (provisional txid: the validator's signature changes
   it), cleared once internalized, re-keyed to the final txid when the
   wallet did not take it; refused / timed-out swaps drop it. The panel's
   "Internalize now" still finds the final transaction on the instance.
5. **Races.** On each refresh, a planned pool missing from the lookup is
   reported ("… is gone from the lookup …; replanned against N pool(s)") and
   the engine replans over the fresh inventory.

### BRC-29 payouts

The sats a user receives from a pool — a token → sats swap's payout, a
RemoveLiquidity sats withdrawal — are standard BRC-100 wallet payments
(`src/wallet/brc29.ts`), not basket outputs. There is no `1sat-deposit`
basket in the UI any more.

- **Derivation.** Payee side, in the page: `getPublicKey({protocolID: [2,
  "3241645161d8"], keyID: "<derivationPrefix> <derivationSuffix>",
  counterparty: "self", forSelf: true})`; sender identity
  `getPublicKey({identityKey: true})`. The output is P2PKH to that key.
  wallet-toolbox's check at internalization (`setupWalletPaymentForOutput`,
  src/signer/methods/internalizeAction.ts) is `derivePrivateKey([2,
  "3241645161d8"], keyID, senderIdentityKey)`; with senderIdentityKey the
  user's own identity key that is `rootKey.deriveChild(rootKey.toPublicKey(),
  invoice)`, the same key as counterparty "self" (`KeyDeriver.normalizeCounterparty("self")`
  = `rootKey.toPublicKey()`; with counterparty self, forSelf true and false
  agree). The page asks with "self" so the manifest's grant matches
  ("Permissions").
- **Prefix / suffix.** Swap payouts: 8 random bytes each, base64 (as
  wallet-toolbox's `randomBytesBase64(8)`). RemoveLiquidity: the contract pays
  the withdrawal to Hash160 of the pool's current LP key, so the LP key itself
  is now a BRC-29 key — prefix `base64("amm-lp")`, suffix
  `base64("<txid>_<vout>")` of input 0 of the transaction that set it (as
  before, so "my pools" can re-derive it); the withdrawal's remittance is that
  keyID's two halves plus the user's identity. Pools whose LP key predates
  this (`P1SAT_PROTOCOL`, `amm-lp-…`) cannot pay sats as a wallet payment:
  their first RemoveLiquidity must withdraw tokens only (the page refuses
  sats and says so), which moves the pool to a BRC-29 LP key.
- **createAction.** The payout output has no basket (the wallet does not
  track it at creation); its customInstructions carry the remittance,
  `{"protocol": "wallet payment", derivationPrefix, derivationSuffix,
  senderIdentityKey}`, so the wallet's own record of the action has it.
- **Pending payouts** (`src/wallet/pendingPayouts.ts`, panel at the top of
  every page). The remittance plus txid, vout, satoshis, locking script and
  the pool's lookup service, in `localStorage["amm-poc.pending-payouts.v1"]`
  keyed `txid:vout`, written the moment the transaction is built (swap:
  before it is submitted, provisional txid; RemoveLiquidity: once signed), cleared
  only after `internalizeAction` succeeds (or when the action is discarded).
  "Internalize now" fetches the final transaction's BEEF from the instance's
  lookup — `{outpoint: "<txid>_0", beef: true}` for a RemoveLiquidity that
  left a pool; otherwise every live pool of the token, each `{outpoint,
  beef: true}`, searched for the transaction paying the recorded script and
  amount (a swap's final txid is not known in advance) — and internalizes.
- **Internalize.** `wallet.internalizeAction({tx: <AtomicBEEF of the final
  transaction>, outputs: [{outputIndex, protocol: "wallet payment",
  paymentRemittance: {derivationPrefix, derivationSuffix,
  senderIdentityKey}}], description, labels: ["amm-payout"]})` (a swap's own
  call is labelled `amm-swap`).
  RemoveLiquidity: right after a successful `POST /submit`, with signAction's
  AtomicBEEF (wallet-toolbox merges into the existing `nosend` action).
  Swap: right after the relay answers accepted (Swap page, step 3).

### Not built, and why

- **A live relay.** `amm.swap.submit` / `amm.swap.status` are being built
  in programs/amm-p2p (branch `relay`); the page is coded against its
  record (relay.zig `Record.answer`) and tested against a fake.
- **Token change.** A token → sats leg needs token outputs adding up exactly
  to its amount. Splitting a token output first is a separate wallet action
  whose result must be admitted to the token's topic before a validator
  accepts it as an input, so it is not built ("Not built: token split").
- **A real wallet against the v2 instance.** The instances run a fake
  header feed; a mainnet wallet's `internalizeAction` verifies the swap's
  BEEF (the pool's ancestry) against its own chain tracker and would refuse
  it. The sequence is tested against a fake wallet only.
- **Metadata for tokens the wallet does not hold**: a later lookup question.

## Layout

```
public/
  manifest.json        W3C manifest + metanet.groupPermissions ("Permissions")
src/
  lib/
    config.ts          VITE_AMM_OVERLAY / VITE_AMM_PEER_OVERLAY / VITE_AMM_REFRESH_MS
    overlay.ts         the instance client: listTopicManagers, lookup (freeform and BEEF), live; topic names
    keys.ts             validator signing-key derivation (BRC-43, "amm pool", anyone counterparty)
  pool/
    pool.artifact.json  Pool contract artifact, dumped from pool/dump_test.go (see below)
    template.ts          PoolTemplate: decode, lockDeploy, swap / addLiquidity / removeLiquidity, signPoolInput
    mandala.ts          the Mandala prefix for template.ts, a thin adapter over 1sat-sdk's Mandala
    artifact.ts          the artifact typed as runar-sdk's RunarArtifact, method indices
    runar-ir-schema.ts   runar-ir-schema's barrel minus its node-only validators (see below)
    index.ts             the module's exports
  lp/
    wallet.ts           listOutputs: bsv21 + mandala <txid> <vout> baskets, ordinals basket, deploy transactions (BEEF)
    inventory.ts        decode (Mandala, else BSV21 JSON), group by token id, sum, icons
    ordinals.ts         image ordinals as icon candidates (the outpoint holding the bytes)
    images.ts           image bytes from an inscription or a B file
    deploy.ts           the Mandala deploy createAction (keys, outputs, tags, customInstructions)
    amounts.ts          decimals formatting / parsing
    validators.ts       validator picker model: liveness-read rows, BRC-169 handle resolution, raw keys
    poolRows.ts         how a pool held as LP is filed in bsv21 (and why it is no balance / token input)
    poolDeploy.ts       poolable tokens, deposit selection, the deploy plan (lockDeploy), funding + deploy built and signed, completion
    poolRelay.ts        amm.pool.submit / amm.pool.status: wire shapes
    deployFlow.ts       a prepared deploy through the relay: poll, accepted → complete, refused / timeout → abort
    myPools.ts          the instance's pools whose LP key is the wallet's
    removeLiquidity.ts  RemoveLiquidity: broadcast funding, the remove built and signed, the BRC-22 submit, completion
    addLiquidity.ts     AddLiquidity: nosend funding, the add built and LP-signed (validator slot empty), completion / abort
    liquidityRelay.ts   amm.liquidity.submit / amm.liquidity.status and the flow: poll, accepted → complete, refused / timeout → abort
  wallet/
    AppWalletProvider.tsx  1sat-sdk BRC-100 wallet context + connect dialog wiring
    authFetch.ts           useAuthFetch(): @bsv/sdk AuthFetch over the connected wallet (BRC-103/104)
    brc29.ts               BRC-29 payouts to self: derivation, customInstructions, internalizeAction
    pendingPayouts.ts      durable pending-payout records (localStorage), BEEF from the instance, "Internalize now"
  validator/
    instance.ts         this instance: origin -> handle -> identity (BRC-169), peer's .live reads, pools served
    control.ts          heartbeat start/stop via POST /sendMessage (BRC-33), the explorer's genesis read
  market/
    view.ts             market view: tokens, pools, marginal prices, validator liveness
    plan.ts             form -> PlanRequest, Plan -> display (LP / validator fees, commission, price, slippage), races
    swapAction.ts       one leg through the wallet: exact funding (nosend), the swap built and signed, Spend checks,
                        internalize + relinquish on acceptance, abortAction on refusal
    relay.ts            amm.swap.terms / amm.swap.submit / amm.swap.status over the app's /call route (AuthFetch), the record
    swapFlow.ts         submit → poll → accepted / refused / timeout / no answer
  pages/
    Tokens.tsx           Tokens page: inventory table, deploy form, ordinals picker
    Pools.tsx            Pools page: validator picker, create pool, my pools / add and remove liquidity
    Swap.tsx             Swap page
    Validator.tsx        Validator page
    LiveTable.tsx        the liveness-read validators table (picker and Validator page)
    PendingPayouts.tsx   the shell's Pending payouts panel
test/
  keys.test.ts          LP/validator key derivation, pinned vector
  pool.test.ts          decode every fixture pool, rebuild the fixture swaps / removal byte for byte, builder refusals
  mandala.test.ts      Mandala prefix encode/decode
  lp.test.ts            inventory grouping, icon resolution, ordinals picker, deploy outputs and
                        customInstructions per icon choice, the wallet calls, decimals
  fixtures/amm-topic-vectors.json  programs/amm-topic fixture transactions (copied, see its _source)
  overlay.test.ts        parseLookupAnswer against recorded /lookup answers
  swap.test.ts           Swap page: market view from recorded v2 answers, plan display, races; the funding
                         action's shape and exact amount, the swap's inputs checked with Spend for sats in and
                         tokens in (amm-topic fixture pools, funding built in-test by the fake wallet), the
                         relay's call shape and polling, accepted → internalize + relinquish, refused /
                         timeout / error → abortAction, no answer → nothing aborted, pending payouts
  brc29Wallet.ts         the fake wallets' BRC-29 half: KeyDeriver derivation, internalizeAction checked
                         as wallet-toolbox's setupWalletPaymentForOutput (basket insertions accepted)
  pools.test.ts          LP pools: BRC-169 resolver (fake fetch), deploy plan == the fixture pool output,
                         the deploy's wallet calls (fake wallet), my-pools matching, RemoveLiquidity
                         through the wallet == the fixture remove_liquidity byte for byte, submit shape
  addLiquidity.test.ts   AddLiquidity: funding shape and amount, the add's inputs checked with Spend (the validator's
                         slot signed in-test), relay call and polling, accepted → internalize + relinquish, refused → abort
  manifest.test.ts       public/manifest.json: the grouped permissions' shape, every action label used, BRC-29 as "self"
  validator.test.ts      Validator page: start/stop request shape (fake AuthFetch), explorer genesis read,
                         this-instance view from mocked manifest/resolve/live, pools-served filtering
  config.test.ts         the app's base URL and name from the page's URL; the policy from the app record's config.amm
  fixtures/instance-v2/  answers recorded from amm-poc's v2 instance (before ls_amm was one service)
```

## What 1sat-sdk provided

`@1sat/react`'s `WalletProvider`, `ConnectDialogProvider`, `ConnectButton`
and `useWallet()` (BRC-100 connect, provider auto-detect, session
persistence) are used as-is in `src/wallet/AppWalletProvider.tsx` — no
custom wallet-connect code was written, per the task. `useWallet()` gives
every page `status`, `identityKey` and the raw `@bsv/sdk` `WalletInterface`
to sign with.

## What's mocked / not wired

- **The pool deploy** (Pools page) is built and signed by the wallet, and
  stops before the validator's consent (below, "Pools page"): the relay
  carries swaps only.

## Tokens page

A user's own front end to their wallet (docs/notes.md, "Token deploy and the
LP page"). Everything comes from, and goes to, the connected BRC-100 wallet;
no overlay is queried and nothing is submitted to one.

**Inventory** (`src/lp/wallet.ts`, `inventory.ts`). On connect:

- `listOutputs({basket: "bsv21", include: "locking scripts", includeTags,
  includeCustomInstructions})`, and the same for each token's own basket
  `mandala <txid> <vout>` (where 1sat-sdk files a Mandala token's outputs),
  the baskets named by the per-token labels of `listActions({labels:
  ["mandala"], includeLabels: true})`; each script decoded with `Mandala.decode`,
  else the BSV21 inscription template (legacy JSON); grouped by token id,
  amounts summed. The script decides id and amount, not the tags.
- A deploy output in the wallet gives sym / dec / icon (Mandala payload, or
  the JSON deploy's fields). Tokens without one show id and balance only.
- Icons (0.8.0): a Mandala deploy's icon is the image embedded in its
  payload (`[mediaType, bytes]`, BRC-162 draft BRCs#308; the pointer forms
  are gone), rendered as it is (an image media type only). A legacy BSV-21
  JSON deploy's icon is an outpoint, looked up as before in the ordinals
  basket and the deploy transactions (`listOutputs({basket: "bsv21", tags:
  ["bsv21:deploy"], include: "entire transactions"})`'s BEEF); the image
  renders from the inscription (or B file) bytes when the wallet holds them,
  otherwise the outpoint is shown.
- `listOutputs({basket: "1sat", include: "locking scripts", includeTags})`
  for the icon picker: image ordinals, with thumbnails when the output's own
  script carries the inscription. A picked ordinal's bytes are embedded (an
  ordinal whose bytes the wallet does not hold cannot be picked: upload it).

**Deploy** (`src/lp/deploy.ts`): one `createAction`, run through
`@1sat/actions`' `runCreateActionPipeline` (the pipeline 1sat-sdk's actions
use: managed `id:<action>_<i>` tags, `createAction`, `signAction`; the
wallet broadcasts). `randomizeOutputs: false`.

- Output 0: `Mandala.deployValue(amount, …)` or `Mandala.deployAuthority(…)`,
  1 sat, P2PKH to a key from `wallet.getPublicKey({protocolID:
  P1SAT_PROTOCOL, keyID: "bsv21-deploy-<sym>-<hex>" | "bsv21-auth-<sym>-<hex>",
  counterparty: "self", forSelf: true})` (as 1sat-sdk's `resolveDestination`),
  payload `{sym, dec, icon}`. Basket `bsv21`, tags `bsv21:deploy` (+
  `bsv21:auth`), customInstructions from `buildBsv21CustomInstructions`:
  `{amt, op: "deploy+mint" | "deploy+auth", sym, dec, protocolID,
  keyID}`, no `id` (the token id is this outpoint, `<txid>_0`), as
  `deployBsv21Mint` / `deployBsv21Auth` file it.
- The icon (0.8.0, skein-mandala 0.9.0; BRC-162 draft BRCs#308): embedded in
  the payload, `icon: {mediaType, bytes}` (the template writes
  `[mediaType, bytes]`), an uploaded image or a picked ordinal's bytes, at
  most `MAX_INSCRIPTION_BYTES`. One output: no icon output 1, no `icon` in
  customInstructions. (Before 0.8.0: output 1 carried an uploaded image as
  a 1Sat ordinal or a B file and the payload pointed at it, `icon` = vout 1;
  a picked ordinal was its 36-byte outpoint.)

After the deploy the page shows the txid and token id and reloads the
inventory from the wallet.

## Pools page

`src/pages/Pools.tsx` over `src/lp/{validators,poolDeploy,poolRelay,deployFlow,myPools,removeLiquidity,addLiquidity,liquidityRelay}.ts`
(pure where possible, tested in `test/pools.test.ts`). Replaces the old
textual pools section. Every key and signature comes from the wallet; the
instance is `VITE_AMM_OVERLAY`.

**Validator picker** (`validators.ts`). Rows from `GET /live` (identity key,
peer ID, last seen, live / offline). A text field takes a raw identity key
(66 hex, compressed) or a BRC-169 handle `name@domain[:port]`, resolved in the
page with plain fetches as skein's docs/MESSAGES.md "BRC-169 is discovery"
describes: `GET <origin>/manifest.json` → `metanet.handles.resolve` (default
`/.well-known/metanet-handles/resolve`) → `GET <resolve>?handle=<name>@<host>`
→ `{identityKey, messagebox, …}`. The origin is `https://<domain>`, plain
`http` for localhost / `*.localhost` / 127.0.0.1. The port is where the domain
is served, not part of the handle (the router answers `amm2` and
`amm2@localhost`, and refuses `amm2@localhost:8300`). The key is matched
against the live list; an unmatched key can still be chosen ("not seen live").
The choice is `{identityKey, peerId?, handle?}`.

Checked against the running instances (2026-10-01): skein's router serves
the manifest and the resolve endpoint on the bare host (`localhost:8300`,
`localhost:8400`), not on an instance's own host (`amm2.localhost:8300/manifest.json`
is 404). `localhost:8300/manifest.json` = `{"metanet":{"handles":{"resolve":"http://127.0.0.1:8300/.well-known/metanet-handles/resolve"}}}`;
`amm2@localhost:8300` → `{handle: "amm2", domain: "localhost", identityKey:
"02f2607898feca297bec05cc510475ff896fb3e9a1d3c0528f6ce2c4382eff472a",
messagebox: "http://amm2.localhost:8300"}` (amm2's own validator: "not seen
live" on amm2, live with its peer ID on amm3); `amm3@localhost:8400` →
`03cdee31…e0d0`, messagebox `http://amm3.localhost:8400`, live on amm2 with
peer `16Uiu2HAm6mP7…GwGqq`. Each router resolves only its own instances
(`amm3` on :8300 is 404).

**Create a pool** (`poolDeploy.ts`).

- Tokens: Mandala outputs of the token rows (`bsv21` and the `mandala <txid> <vout>` baskets) with a 32-byte id whose
  customInstructions name the wallet key — value outputs, and a fixed-supply
  deploy output (amm-topic's fixture pool deploy spends the deploy output
  itself). Legacy tokens (BRC-161 deploy: 36-byte id or JSON form) are hidden
  with a note: the Pool contract hard-codes a 32-byte asset id.
- Form: token, tokens to deposit, sats to deposit, LP fee bps, validator fee
  bps, commission bps (default 0: no commission output on any swap; the
  constructor's param 7, CommissionBps, fixed at deploy; markets filter pools
  by it; "my pools" shows it from the pool's script) (fees start at 30 / 5, the fixture pool's; the validator's terms,
  `ammValidator {minValidatorFeeBps, maxLpFeeBps}` in its instance's config,
  are not exposed by any route, and the validator refuses a deploy outside
  them), the validator.
- Deposit inputs: an exact subset when one exists, else the largest outputs
  until covered, with **token change** back to the wallet. The deploy is not a
  contract call (Pool.runar.go has no constructor method), so the deploy
  transaction is a plain token transfer into output 0 plus change; the
  exact-sum limitation of a swap does not apply.
- Keys. LP key: a BRC-29 key, `getPublicKey({protocolID: [2,
  "3241645161d8"], keyID: "<base64('amm-lp')> <base64('<txid>_<vout>')>",
  counterparty: "self", forSelf: true})`, keyed by input 0 of the transaction
  that sets it — the first deposit input here, the spent pool outpoint on
  RemoveLiquidity (swaps keep it). The same rule as the validator's key, so
  "my pools" re-derives it from a pool's history. BRC-29 so that the sats
  RemoveLiquidity pays to it are a wallet payment ("BRC-29 payouts").
  Validator key: the anyone-child of the chosen identity for `1-amm
  pool-<first deposit input>` (src/lib/keys.ts), computed in the page; this is
  what amm-validator's `deploy` checks (`wrong_validator_key` otherwise).
- Shown: initial price (sats per token), asset id, fees, token reserve, BSV
  reserve, LP key (+ keyID), validator key (+ key ID), identity, script size,
  topic — `PoolTemplate.lockDeploy(args, state)`. Test: the fixture's inputs
  (deploy:0, 5,000,000 tokens, 1,000,000 sats, 30/5, lpKey, identity) give
  the fixture's pool output byte for byte.

**The deploy's wallet sequence** (`preparePoolDeploy`; docs/notes.md "Swap
funding and signing" applied to the deploy, which needs the validator's
consent and so is gated like a swap):

1. `getPublicKey` (LP key, BRC-29, for the first deposit input),
   `getPublicKey` (token change key, only with change: BRC-29 like the LP
   key, derivationPrefix base64("amm-change"), derivationSuffix
   base64("<txid>_<vout>") of the first deposit input, so the wallet can
   re-derive it from the deploy alone), `listOutputs({basket: "mandala
   <txid> 0", include: "entire transactions"})` and
   `listOutputs({basket: "bsv21", tags: ["bsv21:<tokenId>",
   "bsv21:deploy"], tagQueryMode: "any", include: "entire transactions"})`
   for the token inputs' source transactions, BEEFs merged.
2. **Funding** (`createFunding`, shared with the swap):
   `getPublicKey({protocolID: [0, "onesat"], keyID: "amm-funding-<hex>",
   counterparty: "self", forSelf: true})`; `createAction({description: "AMM
   pool deploy funding: <sym>", labels: ["amm-pool-deploy"], outputs: [{P2PKH
   to that key, satoshis: exact, basket: "1sat-deposit", tags:
   ["amm-funding", "hold:<expires>"], customInstructions: {protocolID,
   keyID, counterparty: "self", amm: {deploy: <tokenId>, expires}}}],
   options: {signAndProcess: false, randomizeOutputs: false, noSend:
   true}})`; `signAction({reference, spends: {}, options: {noSend: true}})`.
   Exact amount (`deployFunding`): Σ deploy outputs − Σ token inputs' sats
   (the sats deposit, + 1 for a token change output, − 1 per 1-sat token
   input) + ceil(size × `VITE_FEE_RATE` / 1000). `expires` = now + 2 min.
3. **Deploy**, built by the page: inputs the deposit's token outputs in
   order (input 0 keys the LP key and the validator key; amm-validator
   checks the first *token* input), then the funding output; outputs 0 the
   pool (`lockDeploy`), 1 the token change if any; no sats change. Every
   input signed with `createSignature({hashToDirectlySign})` (BIP-143
   ALL|FORKID) + `getPublicKey`, and checked with `Spend`; any failure
   aborts the funding.
4. **Relay** (`deployFlow.ts`, `poolRelay.ts`): `POST <VITE_AMM_OVERLAY>/call`
   `{fn: "amm.pool.submit", args: {funding: bytes(funding AtomicBEEF),
   deploy: bytes(deploy AtomicBEEF: the funding and the token inputs'
   sources with it), validator: bytes(33), expires}}` (DAG-JSON bytes,
   through the wallet's AuthFetch), then `amm.pool.status {id}` while
   `pending`. Record: `{id, status: pending | accepted | refused | timeout |
   failed, tx?, txid?, reason?, detail?}`; on `accepted` a `tx`/`txid`, if
   sent, must be ours (the validator does not sign a deploy).
5. Accepted: `internalizeAction({tx: the deploy's AtomicBEEF, outputs: [{0,
   basket insertion into bsv21, tags [bsv21:<tokenId>, amm-pool], the pool
   customInstructions}, {1, basket insertion, token change}], labels:
   ["amm-pool-deploy"]})`, then `relinquishOutput` of the funding
   (`1sat-deposit`) and each token input (`bsv21`). Refused, timed out, or an
   error answer to submit: `abortAction({reference})`. No answer (network,
   the relay's `failed`, pending past expiry + 30 s): left alone, "Check
   again" / "Abandon".

Filing: the pool output goes to `bsv21`, tags `bsv21:<tokenId>` + `amm-pool`,
customInstructions `{id, op: "amm-pool", sym, dec, protocolID, keyID,
counterparty: "self", amm: {role: "lp", validatorIdentity, lpFeeBps,
validatorFeeBps, commissionBps}}` with **no `amt`**: 1sat-sdk's `sendBsv21` selection and
its balances skip rows without an amount (with `amt: "0"` sendBsv21 would
still select it), so the pool is never spent as an ordinary token. The
script starts with a Mandala value prefix, so this page's own inventory,
`tokenInputsOf` (Swap) and the pool form skip `amm-pool` rows explicitly
(`src/lp/poolRows.ts`). Token change: `bsv21`, `bsv21:<tokenId>`, transfer
customInstructions (as 1sat-sdk's transferBsv21 files a self output).

**My pools** (`myPools.ts`). For each native token topic, `POST lookup {}`,
then each pool's `{outpoint, beef: true}`, decoded. A pool is the wallet's
when its outpoint is an `amm-pool` row of the basket, or its LpPubKey is a
wallet key: a keyID recorded in such a row (still listed after a taker spent
the output), or the LP key for each input-0 outpoint along the pool's
history in the BEEF — the BRC-29 one and the pre-BRC-29 `amm-lp-<outpoint>`
under `P1SAT_PROTOCOL` (`getPublicKey` per candidate). Shown with reserves,
price, fees, validator liveness and the matched key.

**Remove liquidity** (`removeLiquidity.ts`), LP-only: no third party gates
it, so the funding is broadcast at once (no nosend):

1. With sats to withdraw: `getPublicKey({identityKey: true})` (the
   remittance's sender), refused before any wallet call if the LP key is a
   pre-BRC-29 one. `getPublicKey` (the matched LP key; refused unless it is
   the pool's LpPubKey), `getPublicKey` (next LP key: BRC-29, for the spent
   pool outpoint).
2. `PoolTemplate.planRemoveLiquidity`: continuation (unless closing), BSV
   withdrawal and token withdrawal to Hash160 of the current LP key.
3. **Funding** (`createFunding`): `getPublicKey` (`amm-funding-<hex>`),
   `createAction({description: "AMM remove-liquidity funding: <sym>",
   labels: ["amm-remove-liquidity"], outputs: [{P2PKH, exact, basket
   "1sat-deposit", tags ["amm-funding", "hold:<expires>"],
   customInstructions {protocolID, keyID, counterparty, amm: {remove:
   <pool outpoint>, expires}}}], options: {randomizeOutputs: false,
   acceptDelayedBroadcast: false}})`: the wallet signs and broadcasts it.
   Exact amount (`swapFunding` over the plan): Σ contract outputs − pool
   sats (1 per Mandala token withdrawal) + the remove's fee at the rate.
4. **Remove**, built by the page: inputs pool (`callUnlock`, `_changeAmount
   = 0`; LP slot via `createSignature` under the LP key, `signPoolInput`),
   funding (`createSignature` + `getPublicKey`); outputs exactly the
   contract's. Both inputs checked with `Spend`. The sats withdrawal is
   recorded under Pending payouts before submitting.
5. `POST <base>/submit`, body the remove's AtomicBEEF (the funding as its
   unproven parent, the pool's ancestry), `x-topics: tm_mandala_<txid>_0`; plain
   `fetch`, unsigned (0.6.3: AuthFetch refuses `x-topics`; the front door
   takes the submit unsigned).
6. `internalizeAction({tx: that BEEF, outputs: [continuation (basket
   insertion, bsv21, amm-pool, next LP key)?, sats withdrawal (wallet
   payment, the LP key's remittance)?, token withdrawal (basket insertion,
   bsv21)?], labels: ["amm-remove-liquidity"]})`, then `relinquishOutput`
   of the funding (`1sat-deposit`) and the spent pool (`bsv21`; fails
   harmlessly when the wallet had no row for it). If the remove never
   lands, the funding output stays in `1sat-deposit`; `sweepDeposit`
   reclaims it after the hold. "Submit again" retries step 5.

Tests (`test/pools.test.ts`, a fake wallet with a real KeyDeriver for the
funding and BRC-29 keys): the deploy's call sequence, funding shape and
exact amount, the pool output equal to the fixture's byte for byte, every
deploy input valid under `Spend`, the fee paid exactly; the relay's body,
polling, accepted → internalize + relinquish, refused / timeout / error
answer → abort, no answer → nothing aborted and "Check again". RemoveLiquidity
on the fixture pool (swap_tokens_in:0, 10,000 sats and 100,000 tokens):
funding shape and amount, both inputs valid, the contract's three outputs as
the fixture's, the submit body; on a pool with an honestly derived BRC-29 LP
key: internalize (checked as `setupWalletPaymentForOutput` does) and
relinquish, after a "reload" too, and closing.

**Add liquidity** (`addLiquidity.ts`, `liquidityRelay.ts`; docs/notes.md
"Swap funding and signing" with the LP as the caller). Pool.runar.go
`AddLiquidity(lpSig, validatorSig, nextLpPubKey, nextValidatorPubKey,
addBsv, addTokens)` needs the LP's signature AND the validator's (it vouches
for the token inputs the script cannot see), rotates both keys, and has one
output: the continuation at pool sats + addBsv, TokenReserve + addTokens. It
does **not** fix the ratio (the LP owns the pool): the form takes sats and
tokens freely, offers "Tokens / Sats at the current price"
(`tokensAtRatio` / `satsAtRatio`, rounded down) and shows the price before
and after.

1. `getPublicKey` (the matched LP key; refused unless it is the pool's
   LpPubKey), `getPublicKey({protocolID: [2, "3241645161d8"], keyID:
   lpKeyId(<spent pool outpoint>), counterparty: "self", forSelf: true})`
   (the next LP key, as RemoveLiquidity rotates it), with tokens
   `listOutputs({basket: "mandala <txid> 0", include: "entire transactions",
   limit: 10000})` and `listOutputs({basket: "bsv21", tags:
   ["bsv21:<tokenId>"], include: "entire transactions", limit: 10000})`. Token inputs: an exact-sum subset
   of the token's `bsv21` outputs (`selectAddTokenInputs`), else "not built:
   token split".
2. `PoolTemplate.planAddLiquidity` (the call without its funding, as
   `planSwap` / `planRemoveLiquidity`): the continuation, args with both
   signature slots `OP_0`; next validator key = the anyone-child of
   ValidatorIdentity for the spent pool outpoint.
3. **Funding** (`createFunding`, nosend): `getPublicKey`
   (`amm-funding-<hex>`, P1SAT), `createAction({description: "AMM
   add-liquidity funding: <sym>", labels: ["amm-add-liquidity"], outputs:
   [{P2PKH, exact, basket "1sat-deposit", tags ["amm-funding",
   "hold:<expires>"], customInstructions {protocolID, keyID, counterparty:
   "self", amm: {add: <pool txid_vout>, expires}}}], options:
   {signAndProcess: false, randomizeOutputs: false, noSend: true}})`,
   `signAction({reference, spends: {}, options: {noSend: true}})`. Exact
   amount (`swapFunding` over the plan): addBsv − the token inputs' sats (no
   Mandala output besides the pool, so their 1 sat each goes to the miner) +
   ceil(size × `VITE_FEE_RATE` / 1000), the size with the validator's
   signature in. `expires` = now + 2 min.
4. **Add**, built by the page: inputs pool (`callUnlock`, `_changeAmount =
   0`; the LP's slot `createSignature({…LP key, hashToDirectlySign})` via
   `signPoolInput`; the validator's slot `OP_0`), the funding output, the
   token inputs; outputs exactly the contract's (no change). Funding and
   token inputs signed with `createSignature` + `getPublicKey` (BIP-143
   ALL|FORKID) and checked with `Spend`; any failure aborts the funding.
5. **Relay**: `POST <VITE_AMM_OVERLAY>/call` `{fn: "amm.liquidity.submit",
   args: {funding: bytes(funding AtomicBEEF), add: bytes(add AtomicBEEF: the
   funding, the token inputs' and the pool's sources with it), pool:
   "<txid>_<vout>", validator: bytes(33), expires}}` (DAG-JSON bytes, the
   wallet's AuthFetch), then `amm.liquidity.status {id}` while `pending`.
   Record: the swap's (`{id, status, tx?, txid?, reason?, detail?,
   poolState?}`).
6. Accepted: the validator's transaction is checked against ours (only the
   pool input's unlocking script may differ), then `internalizeAction({tx:
   its AtomicBEEF, outputs: [{0, basket insertion, bsv21, tags
   [bsv21:<tokenId>, amm-pool], the pool customInstructions under the next
   LP key}], description: "AMM liquidity deposit", labels:
   ["amm-add-liquidity"]})`, `relinquishOutput` of the funding
   (`1sat-deposit`), the spent pool row and each token input (`bsv21`).
   Refused, timed out, or an error answer to submit: `abortAction({reference})`;
   a refusal's pool state is shown and "my pools" reloads to plan again. No
   answer: "Check again" / "Abandon".

Tests (`test/addLiquidity.test.ts`, the fixture pool after swap_bsv_in, LP
key(10), 10,000 sats + 50,000 tokens from pool_deploy:1): the wallet call
sequence and the funding's exact args and amount; the add's inputs and one
output (both keys rotated); every input but the pool's valid under `Spend`,
and, with the validator's slot signed in-test by the fixture validator key,
the pool input too, with the fee paid exactly; sats-only; refusals; the
relay's body and polling; accepted → internalize + relinquish; a foreign
transaction refused; refused (pool state returned) / timeout / error answer
→ abort; no answer → nothing aborted, "Check again".

### Not built, and why (pools)

- **`amm.pool.submit` / `amm.pool.status`**: no program provides them yet
  (the Zig side is next); the page codes against the shape above. On v2/amm3
  the deploy gets `unknown-fn` and aborts its funding.
- **`amm.liquidity.submit` / `amm.liquidity.status`**: not provided by any
  program yet; on v2/amm3 an add gets `unknown-fn` and aborts its funding.
- **AddLiquidity token split**: tokens to add must be an exact sum of wallet
  token outputs (no token change on a contract call).
- **A real wallet against v2/amm3.** Not run: the sequences are tested with a
  fake wallet only. The instances run a fake header feed, so a mainnet
  wallet's pools and BEEFs are not on their chain.
- **No pool of the wallet's on v2/amm3.** The instances hold one pool,
  `dbc9baa6…8795_0` (validator identity `03142715…5ad9`, which neither
  instance lists as live; LP key `03f76a39…de6e`); "my pools" finds nothing
  for a real wallet there.
- **Recovering an LP key the wallet lost** beyond the BEEF's reach: if the
  basket row is gone and the BEEF stops before the transaction that set the
  key, the pool is not matched.
- **Fee terms** of the validator are not readable from the instance.

## Validator page

`src/pages/Validator.tsx` over `src/validator/{instance,control}.ts` (pure
where possible, tested in `test/validator.test.ts`) and
`src/wallet/authFetch.ts` (`@bsv/sdk`'s `AuthFetch` over the connected
BRC-100 wallet: every signature of the handshake and the requests is the
wallet's; no page key). The owner's view of their own instance, the one at
`VITE_AMM_OVERLAY`'s origin.

**This instance.** Origin; handle from the origin's first host label
(`amm2.localhost:8300` → `amm2@localhost:8300`, or the `/@<handle>/` dev
prefix); identity key from BRC-169 (`localhost:8300/manifest.json` →
resolve, as the validator picker does); peer ID and "last heartbeat seen by
amm3.localhost:8400: 12 s ago (live)" from the peer's `GET /amm/live`
(`VITE_AMM_PEER_OVERLAY`). A node never hears its own heartbeat (GossipSub
`emitSelf: false`), so until a peer lists us the peer ID reads "unknown
until a peer sees us".

**Register / heartbeat.** "Start heartbeat" / "Stop heartbeat" send the
amm-p2p start / stop message as the connected wallet, through the stock
BRC-33 messagebox route, BRC-104-signed by `AuthFetch`:

```
POST <origin>/sendMessage
content-type: application/json
{"message": {"recipient": "<the instance's identity key>",
             "messageBox": "amm-p2p",
             "body": {"kind": "amm-p2p-start"}}}                          start (heartbeat + catch-up, = the by-hand body)
             "body": {"kind": "amm-p2p-stop", "jobs": ["heartbeat"]}}}   stop (the heartbeat only)
→ 200 {"status": "success", "message": …, "results": [{recipient, messageId}], "id": <mail record CID>}
```

The recipient is the instance's own key (skein programs/messagebox: a
message for the instance's own box is admitted when the subscription table
has an entry for (sender, box), else 403 `ERR_NOT_SUBSCRIBED`). v2's genesis
subscribes `{box: "amm-p2p", handler: "amm-p2p"}` with **no sender**
(anyone: it also carries peers' heartbeats and the cron ticks), so the
messagebox admits anyone's message, and amm-p2p itself accepts start/stop
only from `in.owner` or the cron provider (else its step errors,
`NotTheOwner`). Tried headless on 2026-10-01 with a fresh random key (not
the owner) against amm2: `sendMessage` answered `200 {"status":"success",
…, "id":"bafyrei…"}` (admitted), the explorer `403 {"code":"ERR_FORBIDDEN",
"description":"this identity may not read here"}`; amm2's heartbeat on
amm3's `/amm/live` was unchanged. The page says that a 200 is "admitted",
not "started", and points at the peer's liveness (Refresh).

Root (0.7.0, shruggr/skein#143): there is no owner any more. The explorer
and the engine's `register` box (the switches) are gated by the role
`root`; the genesis names no owner, so the page no longer reads one or
compares the wallet with it (`VITE_AMM_OWNER_IDENTITY` is gone). A wallet
that does not hold root gets the explorer's 403.

**Policy.** Min validator fee bps, max LP fee bps (genesis
`defaults.ammValidator`), heartbeat interval and offline threshold
(`defaults.ammP2p`): "not readable from the instance" by default. "Read
through the explorer (root only)" does `GET <origin>/explore/log?before=1&limit=1`
through AuthFetch (log entry 0, the genesis record as DAG-JSON; a record
that links the genesis is followed through `/explore/record/<cid>`) and
shows the policy (0.7.0: no owner key, the genesis names none); a key
without root gets the 403. Not run
against v2 as the owner (no wallet holds v2's owner key), so the genesis
shape is from skein's sources (`kernel-zig/src/log.zig` `isGenesis`,
`programs/frontdoor/explore.zig`) and tested against a constructed answer.
Editing: not built (above).

**Pools served.** Every token topic's `POST lookup {}`, filtered to pools
whose `validatorIdentityKey` is this instance's identity, with reserves,
price, fees and this instance's liveness. On v2 today: none (the seeded
pool `dbc9baa6…8795_0` names the fixture validator `03142715…5ad9`); the
page says so with the lookup's pool count.

**Peers.** The validators this node sees on its own `/amm/live`, the
validator picker's table (`src/pages/LiveTable.tsx`, shared).

## Mandala from the local 1sat-sdk checkout

`Mandala` (BRC-162) was not in a published `@1sat/templates` when amm-poc
was written (draft PR b-open-io/1sat-sdk#82). Like
runar-sdk, it is bundled from the checkout's sources: `vite.config.ts`
aliases `@1sat/templates/mandala` to
`$ONESAT_SDK_DIR/packages/templates/src/mandala/mandala.ts` (default
`../../../../bsv/1sat-sdk` from here, i.e. `~/Work/bsv/1sat-sdk`), and `tsconfig.json`
`paths` mirror it. The committed `www/` (0.8.0) was built against the
unpublished embedded icon, b-open-io/1sat-sdk#92 (branch
`feat/mandala-embedded-icon`, aff025c3, its worktree
`~/Work/bsv/1sat-sdk-embedded-icon`): `ONESAT_SDK_DIR` at that worktree for
`vite build` and the tests, and the typecheck with `paths` pointed there
(a temporary tsconfig extending this one; `tsconfig.json` itself still names
`~/Work/bsv/1sat-sdk`). Before 0.8.0, with its master at 183c0ce3. Its DAG-CBOR payload code imports `cbor2`, a dependency
here, deduped with `@bsv/sdk` so the checkout needs no `node_modules`.
`src/pool/mandala.ts` adapts it for the pool template; there is no second
decoder. Once published, drop the alias and import from `@1sat/templates`.

The other 1sat-sdk packages come from npm: `@1sat/actions` (the
customInstructions builders and the createAction pipeline), `@1sat/templates`
(Inscription, BSV21, B), `@1sat/types` (baskets, tags). `@1sat/connect` /
`@1sat/react` were bumped so all of them share one `@1sat/wallet`.
`@1sat/actions` lazily imports `xdelta3-wasm`, whose `package.json` names a
missing `module` file; `vite.config.ts` aliases it to the file that exists.

## runar-sdk from the local checkout

`runar-sdk` is bundled straight from the Rúnar checkout's TypeScript sources,
`../../../../bsv/runar` from here (`~/Work/bsv/runar`; the committed `www/`
was built with d207ee8e, the commit go.mod pins for the Go side); set
`RUNAR_DIR` to point elsewhere. Nothing is copied and
nothing needs building: no `pnpm`, no `dist/`. The wiring:

- `vite.config.ts` aliases `runar-sdk` to
  `$RUNAR_DIR/packages/runar-sdk/src/index.ts`, and `@runar-src/*` to
  `$RUNAR_DIR/packages/*`; `resolve.dedupe: ["@bsv/sdk"]` resolves the SDK's
  own `@bsv/sdk` imports from this package (the checkout has no
  `node_modules`). vitest uses the same config.
- `runar-ir-schema` is aliased to `src/pool/runar-ir-schema.ts`, which
  re-exports that package's sources except `validators.ts`: its barrel
  imports `ajv` and reads JSON schemas from disk at import time
  (`node:fs`, `fileURLToPath(import.meta.url)`), which cannot run in a
  browser. runar-sdk never calls the validators.
- `tsconfig.json` `paths` mirror the aliases for `tsc` (with the fixed
  relative path), and map `@bsv/sdk` to this package's copy. The checkout's
  sources use `Buffer`, so `@types/node` is a dev dependency.

Why not a `file:` dependency: runar-sdk's `package.json` depends on
`runar-ir-schema` with pnpm's `workspace:*`, which npm cannot install, and
the built `dist/` would still pull in the same node-only validators.
Packaging as an SDK is a later cleanup.

Checked: `npm run build`, `npm test`, `npm run typecheck`, and a library-mode
`vite build` of `src/pool/index.ts` alone (a self-contained ES bundle with no
`node:` imports, whose `PoolTemplate.decode`/`lockDeploy` run against the
fixtures). The app does not import `PoolTemplate` yet, so today's `dist/`
tree-shakes it out.

## `src/pool`: the Pool script template

`PoolTemplate` (src/pool/template.ts), independent of React:

- `decode(script)`: the Mandala value prefix (32-byte id, no payload), the
  artifact match with its constructor slots (runar-sdk `matchesArtifact`,
  `extractConstructorArgs`), the state (`extractStateFromScript`); requires
  prefix id == assetId and prefix amount == TokenReserve. Null otherwise.
- `lockDeploy(args, state)`: the prefix plus runar-sdk's locking script.
- `swap`, `addLiquidity`, `removeLiquidity`: the whole transaction the
  contract enforces (pool at output 0; payouts; LP / validator fees and the
  commission to `commissionPkh` on swap, each only when nonzero; change), the pool input's unlocking
  script (`_codePart args… _changePKH _changeAmount txPreimage methodIndex`,
  preimage from runar-sdk's `computeOpPushTxWithCodeSep`), the builder's own
  inputs signed. The validator's slot stays `OP_0`; the LP's is signed when
  `lpKey` is given. Fee: `{sats}` or `{satsPerKb}`. Refusals throw
  `PoolBuildError` (`stale_pool`, `fee_mismatch`, `quote_mismatch`,
  `slippage`, `token_mismatch`, `insufficient_funds`, ...).
- `signPoolInput(call, "validator" | "lp", key)`: recomputes the preimage
  from the transaction, checks it against the pushed one and the key against
  the pool's, and fills the slot. BIP-143 covers no unlocking script, so
  nothing else changes: the taker builds and signs first, the validator signs
  last (pool/pool_test.go, programs/amm-topic/gen).

`RunarContract.prepareCall` is not used: it needs a Provider to pick funding,
sets the fee from a rate, and builds the continuation without the Mandala
prefix. `mandala.ts` adapts 1sat-sdk's `Mandala` (above, "Mandala from the
local 1sat-sdk checkout").

## `pool.artifact.json`

Current: regenerated at amm-poc f4ce6d3 (CommissionBps, param 7; 11
constructor slots; 3761-byte template) the same way, with the throwaway test
removed afterwards; its `script` and `constructorSlots` equal
`programs/amm-topic/src/fixtures/pool_artifact.zig`'s template and slots.
`test/fixtures/amm-topic-vectors.json` is re-copied from that commit's
`vectors.zig` (plus `commissionBps`, `commissionPkh`). The recorded
`test/fixtures/instance-v2/` answers predate the commission (their pool is
the old template, which no longer decodes); the swap tests use the current
`pool_deploy` as the lookup's AtomicBEEF.

Originally:

Dumped by adding a throwaway test to `pool/dump_test.go`
(`go test -run TestDumpArtifactFull`) that JSON-marshals the *whole*
`compiler.Artifact` struct (not just the ABI the existing `TestDumpArtifact`
logs) — its field names (`version`, `abi`, `script`, `stateFields`,
`codeSeparatorIndex`, `anf`, ...) are the canonical cross-SDK artifact
schema the runar-sdk README describes (`conformance/sdk-output/`), so it's
taken as-is. `programs/amm-topic/src/fixtures` (mentioned in the task as a
possible source for a pinned test vector) doesn't exist yet in this
worktree, so the LP key-derivation vector in `test/keys.test.ts` was
computed directly with `@bsv/sdk` instead, and pinned.

## Assumptions

- **Lookup answer shape.** `POST /lookup` answers freeform (confirmed
  against the running instance): `{type: "freeform", result: PoolState[]}`
  for `{}`, and `{type: "freeform", result: {hops, current: PoolState}}`
  for `{outpoint}`; `{outpoint, beef: true}` answers the output-list form
  `{type: "output-list", outputs: [{beef: number[], outputIndex}]}` (the
  pool's AtomicBEEF, `parseOutputList`; confirmed on the v2 instance). `src/lib/overlay.ts`'s
  `parseLookupAnswer` normalizes both shapes (and a bare array) to
  `PoolState[]` — `{outpoint}` becomes a single-element array, `hops` is
  dropped (not part of the engine's `PoolState`). The wire answer's
  reserve/fee fields are JSON numbers; `parseLookupAnswer` converts them to
  `bigint` (`toPoolState`), since the engine's arithmetic
  (`web/engine/src/pricing.ts`) throws if a real `bigint` is mixed with a
  plain `number`.
- **Lookup `commissionBps`.** The lookup's pool record is read with a
  `commissionBps` field (the engine's name, next to `liquidityFeeBps` /
  `validationFeeBps`); a record without it (a lookup that predates the
  commission, e.g. the recorded instance-v2 answers) reads as 0. A leg
  priced that way against a pool with a nonzero rate is refused by
  `planSwap` (`fee_mismatch`) before anything is signed.
- **Liveness.** Both pages take liveness from the instance's `GET /live`
  (`live` within its `thresholdMs`); the old LP page's 5-minute window from
  pool `lastSeen` is gone with the old pools section.
- **Round budget.** `executeSwap`'s default `maxRounds` (10) is a PoC
  safety valve against an unbounded rejection/replan loop, not a value
  taken from docs/notes.md (which doesn't specify one).
