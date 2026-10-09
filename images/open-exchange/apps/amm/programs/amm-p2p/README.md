# amm-p2p

The AMM overlay's **marketplace relay** (the app's box handler: interfaces `amm.swap/1`, `amm.pool/1` and `amm.liquidity/1`, docs/notes.md 2026-10-02 "Marketplace relay") and the app's pages, with the proofs-by-block direct call and the catch-up pass as utilities nothing routes or schedules (#2, the pull half of proof sync), as one [skein](https://github.com/shruggr/skein) program (Zig 0.16.0, wasm32-wasi), the `amm-p2p` program of the `amm` app (`etc/app.json`). The design notes cited below are amm-poc's docs/notes.md.

```
zig build test-amm-p2p   # from the repo root: the direct call's request and reply, the catch-up plan, the names,
                         # the catch-up tick, the libp2p
                         # providers' bodies and answers; the relay: a pair's checks, the BEEF and the signed
                         # package, the record's lifecycle (dialled, or local), the validator named, the dispatch;
                         # the same for a pool deploy and an AddLiquidity; the manifest's role settings, natively
```

## 0.7.0 (skein's routes, filters and roles, shruggr/skein#143)

This section supersedes what the rest of this file says where they differ.

- **The message path is this program's box `amm/amm-p2p`** (`names.own_box`), not the app's box `amm`: a box has one route now (no sender to tell two apart), and `amm` is the overlay engine's (its derived mailbox route: its own watch, resume and wait). A `{fn, args}` message in `amm/amm-p2p` is the call, answered to the sender in that same box (`answerSender`; was `amm`); the cron ticks share the box as before. Read "box `amm`" below as `amm/amm-p2p` for the relay's interfaces.
- **`/call`**: the route lists `kernel.brc104`, so the caller is the signed request's key; `app.admitted` (the dispatch rows' senders) is no longer consulted (there are none): who may call is the kernel's gate, and `call` is gated by no role.
- **The pages**: the read route `/` (prefix, `root: "www"`, `index: "index.html"`) with the filter `page` → `amm-p2p.serve`; called as a filter (the input's `filter: true`) `serve` answers `{answer: <the page>}`, otherwise the same.
- No `owner` was read here; the manifest's `"amm-p2p"` route is `{"address": "amm-p2p", "handler": "amm-p2p"}`.

## 0.6.0 (market and validator are the engine's, shruggr/skein#120)

This section supersedes what the rest of this file says where they differ: every section below on liveness, the beacon, validation, the market role, start / stop and the heartbeat describes what is gone. Decided by David, 2026-10-06 evening: "a skein runs as a market and/or a validator by two settings in the engine's configuration (`config.overlay.market: {window}`, `config.overlay.validator: {every}`), and registering a token's topic is the one act that drives both." The engine (skein-overlay 0.9.0) emits `liveness` / `beacon` on `tm_mandala_<txid>_0-live` at `register` and `unliveness` / `unbeacon` at `deregister`; the beat has no body (the frame carries the instance's identity key, the gossip message its peer ID).

- **Gone from this program:** `validate` / `unvalidate` (and `names.mayValidate`, the box `amm/validate`), the validated set, the `beacon` / `unbeacon` and `liveness` / `unliveness` / 0.3.x `unsubscribe` emits and their bookkeeping (the maps `beacons`, `subscriptions`, the record's `validated` and `liveness`), the start / stop messages `{kind: "amm-p2p-start" | "amm-p2p-stop"}` (the manifest has no `start` / `stop`; such a message now errors `BadMessage`), the cron fallback's scheduling and its heartbeat job, and `src/liveness.zig`. Config: `ammP2p.market`, `heartbeatSeconds`, `offlineSeconds` and `catchupSeconds` are not read (the manifest has no `ammP2p`; `validator.every` is the beat, `market.window` the offline threshold, both `config.overlay`).
- **What remains:** the relay (box `amm`, `/call`, the relay thread, this node's own validator in-VM), the pages (`serve`), and two utilities nothing routes or schedules: `proofsByBlock` and the catch-up pass, still run by a cron provider's tick `{kind: "amm-p2p-tick", job: "catchup"}` in box `amm/amm-p2p` (its sender must be the cron provider) and its thread; `ammP2p.topics`, `peers`, `window`, `batch` and `replyTimeoutMs` configure it.
- **State.** `amm/p2p` is `{kind: "amm-p2p-state", maps: {cursor}}` (the catch-up cursor). A record 0.5.0 or earlier wrote loads (its other fields are not read) and is rewritten without them at the next commit.
- **The validator's signing** follows the engine's settings and registered set (programs/amm-validator/README.md "0.6.0").

## Port

Ported from amm-poc `programs/amm-p2p` (skein-overlay 0.2.0, skein-sdk 0.3.0) onto skein-overlay 0.6.0 and skein-mandala 0.4.0:

- **State reads.** The chain state is the chain app's (`chain/state`, read only) and the overlay's is the app's (`<app>/state`), loaded as the engine loads them (`engine_vm.load`); amm-poc read both from the wallet library's head `wallet`.
- **Topics.** `ammP2p.topics` defaults to every `tm_mandala_<txid>_0` the overlay serves, as the engine reads its configuration (`engine_vm.configured`: `config.overlay.topics` and the topics registered with the engine under `<app>/topics`); amm-poc read genesis `overlayTopics`.
- **The token library.** `mandala` (skein-mandala 0.4.0) for the parser and the rules, `pool` (`src/pool.zig`) for the pool.
- **The signer.** Unchanged: the `wallet` import.
- **STOP: catch-up cannot record a proof.** amm-poc's pass applied each BUMP it fetched to the chain core under the head `wallet` (the transitional `wallet` grant), called the `rejected` hooks and advanced that head. The chain state is the chain app's alone since skein #79, and this program writes only `amm/…`. `takeReply` (src/main.zig) errors `CatchupCannotRecordProofs` when a reply proves a held unproven transaction, and `finishCatchup` records nothing. How a fetched proof reaches the chain app is not decided.
- **STOP: the heartbeat topic is not routed.** The heartbeat is still published on `tm_mandala_<txid>_0-live` for each served token topic, and `validateLive` still judges it, but no row in the app routes `tm_mandala_<txid>_0-live` to it: amm-poc's manifest had one libp2p row per token (`tm_{{TXID}}-live`), templated per instance, and a dynamic overlay's manifest names no token. How validator liveness per token is addressed is not decided (`liveVerdict`, src/main.zig).
- **The peer ID.** amm-poc filled `ammP2p.peerId` per instance (`{{PEER_ID}}`). skein gives a program no way to learn its own peer ID (a step's input has `self.identity`, no peer ID; the host derives the libp2p key from the master secret, `[2, "skein instance"]`, key ID `libp2p:<handle>`), so the manifest carries none; without it `amm-p2p-start` schedules no heartbeat (catch-up only).

## 0.5.0 (reads, shruggr/skein#135)

- **The pages are a read.** fn `serve` is the manifest's read `/` (prefix, `root: "www"`, `index: "index.html"`; was the http row `/`): the host serves it by a call over the current state, any method, signed or not, no entry. It reads only (the head `amm/app`, the tree's blobs), so nothing changed in it.
- **fn `live` is gone**, and its http row `/live` with it (0.4.0 answered 410 there). The validators live on a token are the runtime's read, `GET /<app>/.live/tm_mandala_<txid>_0-live`.

## 0.4.0 (liveness is the runtime's; the caller names the validator)

This section supersedes what the rest of this file says where they differ (0.3.0's market role, 0.2.1's `liveness.judge` and `amm-live` entry, "Liveness — `tm_mandala_<txid>_0-live`" below, the relay's `validator_offline`, and the catch-up's peers from the live map). Decided with David 2026-10-06 (shruggr/skein#120, last comment; the host side is shruggr/skein#138, skein main f45c887).

- **The market asks the runtime.** On a market host (`ammP2p.market`) a start emits, once per served token topic, `{event: "liveness", topic: "tm_mandala_<txid>_0-live", window: offlineSeconds × 1000}` (`liveness.livenessEvent`), and `{event: "unliveness", topic}` for a topic asked before and no longer served; a stop, or a start with the role off, ends every one. Only a topic in the standing set is ended. The set is the map `subscriptions` in `amm/p2p`, now the topics with a standing liveness; the record carries `liveness: true`. The step's result lists `market`, `liveness` and `unliveness`. `offlineSeconds` defaults to 40 (`heartbeatSeconds` 30): a margin over the beat, both config.
- **The runtime keeps it.** The liveness tool subscribes the topic at the node without admitting its messages, verifies each beat's signature against `sender`, keeps the beats newer than the window (the latest per sender, the node's own included) in memory, and serves them at `GET /<app>/.live/<topic>` → `[{sender, at, body: <base64>, from: <peer ID>}]` newest first; 404 when no liveness is kept (skein docs/MESSAGES.md "Liveness (#138)"). Nothing of it is in the log or this program's state.
- **Gone from this program:** `validateLive`, the `amm-live` entries and their step, the last-seen map `live` (dropped from `amm/p2p` at the next commit), `liveness.judge` / `apply` / `live`, the consumer API `live`, and the relay's validator selection. `liveness.zig` keeps the beacon's body `{identityKey, peerId}`, the frame and its signature: the validator side, and what the page decodes. fn `live` (the http row `/live`, kept until the manifest's `reads[]` entries arrive, #135) answers 410.
- **Upgrade from 0.3.x.** A state without `liveness: true` held `subscribe`s to `validateLive`: the first start or stop emits `unsubscribe` for each (a refused one is passed over), clears the set, then asks liveness as above (the result lists `unsubscribed`).
- **The caller names the validator.** `amm.swap.submit`, `amm.pool.submit` and `amm.liquidity.submit` take `peerId` (text, the validator's libp2p peer ID) beside `validator` (`provides` in etc/app.json); missing, it is refused by the declared shape (`bad-args`); not a peer ID's text (empty, a space, a `/`), `bad_peer`. The relay looks at no liveness: the record keeps `peer` as given, and the relay thread dials it. `validator_offline` is gone.
- **This node's own validator** (`local`). When `peerId` is this node's own (`selfPeerId`, the signer's `[2, "skein instance"]` / `libp2p:<handle>` key), the record is `local` and the relay does not dial (a node does not dial itself). It does what the front door does with a frame on `/amm-validator/1/<call>` (skein programs/frontdoor libp2p.zig `stepped`): it calls the route's handler, amm-validator's fn `swap` / `deploy` / `addLiquidity` (the app record's `programs["amm-validator"]`), in-VM from the relay thread's step, with `{transport: "local", protocol, body: <the same signed package>, match: {program, fn, app}}` (`callValidator`). `{verdict, body}` settles the record from the reply frame; `{wait: true}` means the handler sent its submission and awaited it in this step, so the thread rests on that (and on `expires`); stepped again by the engine's answer (`reply`) or the awaited thread at rest (`resolved`), the relay calls the handler again with it, as the front door does; a failed call is `failed` `validator_failed` (retryable); woken at `expires`, `timeout`. `relay.advanceLocal` / `localAnswer` are the pure steps (tested natively). amm-validator takes `transport: "local"` beside `libp2p`.
- **Catch-up peers** are the configured `ammP2p.peers` only (no map to add the validators heard from).

## 0.3.2 (one setting; validate gated by a row)

This section supersedes what the rest of this file says where they differ.

- **One setting** (David 2026-10-06): "If I'm validating, I'm pinging, I'm taking on new liquidity, and I'm validating." The validated set (`validated` under `amm/p2p`) is the one switch: for a topic in it the node beacons `tm_mandala_<txid>_0-live`, and amm-validator signs its swaps and takes on its new liquidity (signs an LP's `addLiquidity`, consents to an LP's pool `deploy`: liquidity received, not the node's own funds); for any other token amm-validator refuses all three calls `not_validating`. amm-validator reads this program's record for it; nothing else writes the set.
- **Gated by a row, not by code.** `validate` / `unvalidate` are taken in box `amm/validate` only (`names.mayValidate`; in any other box, `amm/amm-p2p` included, the step errors `NotTakenHere`), which the manifest's row `{"address": "validate", "sender": "$owner", "program": "amm-p2p"}` admits the owner into: the row is the permission, as the engine's `register` in `amm/register`. The `in.owner` check is gone for them. The answer still goes to the sender's box `amm`. Start / stop are unchanged (box `amm` or `amm/amm-p2p`, the owner or the cron provider, `NotTheOwner` otherwise).
- **The 0.3.1 STOP is gone**: amm-validator's signing is gated on the set (programs/amm-validator/README.md "0.3.2").

## 0.3.1 (validation per topic)

This section supersedes what the rest of this file says where they differ.

- **Beaconing is not a role** (David 2026-10-06): a node beacons `tm_mandala_<txid>_0-live` for the topics its owner has set up validation for, set up per topic like a registration. In box `amm/amm-p2p`: `{fn: "validate", args: {topic: "tm_mandala_<txid>_0"}}` adds the topic to the validated set and, when it is not already beaconed, emits `{event: "beacon", topic: "tm_mandala_<txid>_0-live", every, body}`; `{fn: "unvalidate", args: {topic}}` removes it and emits `{event: "unbeacon", topic}` when it is beaconed. Both are idempotent and answered `{fn, request, replyTo, result: {topic, validating}}` to the sender's box `amm` (`answerSender`, when the address book reaches it); the step's result lists `validated`, `beacons`, `unbeacons`, `answer`, `sent`. The topic must be a token topic `tm_mandala_<txid>_0` (`BadTopic`).
- **Gated by the sender.** Row 5 (`amm-p2p` from `*`) admits anyone; amm-p2p acts only when the message's sender is `in.owner` (the step errors `NotTheOwner`, as for start/stop; the cron provider is not admitted here).
- **Start / stop.** A start (without `jobs`) beacons every validated topic and unbeacons any beacon outside the set (0.3.0's beacons on every served topic end at the first start); a stop unbeacons every one and keeps the set, so the next start beacons it again. The cron fallback's heartbeat publishes on the validated topics. `liveness.validation` is the plan (tested natively); `ammP2p.topics` no longer decides the beacons.
- **State.** `amm/p2p` is `{kind: "amm-p2p-state", maps: {live, cursor, beacons, subscriptions}, validated: ["tm_mandala_<txid>_0", …]}`: the set inline, so the owner's Validator page reads it with the explorer (`/explore/head/amm/p2p`, then the record), as the token topics page reads `amm/topics`.
- **The market role** (0.3.0) is untouched and independent: a node may validate, host a market, or both.
- **STOP: amm-validator has no per-topic switch.** It signs for any topic its overlay admits and reads nothing of amm-p2p's state; gating its signatures on the validated set is not built (not decided how: a read of `amm/p2p`, or a set of its own).

## 0.3.0 (the market role)

This section supersedes what the rest of this file says where they differ (the Port STOP "the heartbeat topic is not routed" and 0.2.0's "Not routed: `tm_mandala_<txid>_0-live`" included).

- **Validator liveness by role** (shruggr/skein#120, David 2026-10-06). `ammP2p.market` (boolean, default `false`). On a market host a start — with or without `jobs` — emits, for every served token topic not yet subscribed (`ammP2p.topics`, else every registered or declared `tm_mandala_<txid>_0`), `{event: "subscribe", topic: "tm_mandala_<txid>_0-live", program: "amm-p2p", fn: "validateLive"}` (shruggr/skein#119; `liveness.subscribeEvent`), and `{event: "unsubscribe", topic}` for one subscribed before and no longer served; a stop, or a start with the role off, unsubscribes every one. The standing set is the map `subscriptions` in `amm/p2p` (`{kind: "amm-p2p-state", maps: {live, cursor, beacons, subscriptions}}`); the step's result lists `market`, `subscribed` and `unsubscribed`. The kernel delivers each beat to `validateLive` through the door, as a row's handler; an accepted beat's `amm-live` entry is stepped into the map `live` as before, and the relay picks the validator's peer from it (unchanged). Off a market host nothing is subscribed, the map stays empty and the relay refuses `validator_offline`.
- **Registrations are not seen.** The owner's `register` / `deregister` goes to the engine (box `amm/register`); nothing steps amm-p2p then. The set is reconciled at each start (the manifest's `start`, which the owner sends again after a register or deregister, as for the beacons).

## 0.2.1 (skein-overlay 0.7.5; skein 387e057)

This section supersedes what the rest of this file says where they differ.

- **The beat is the host's signed frame** (skein docs/MESSAGES.md "Beacons"). The declared body is `{identityKey, peerId}` (no `at`, no `sig`); the host publishes dag-cbor `{body, at, sender, signature}` every beat — `at` the beat's time, `sender` the instance's identity key, `signature` the instance's under `[2, "metanet handles envelope"]`, key ID `send`, counterparty anyone, over sha2-256 of dag-cbor `{kind: "beacon", topic, body, at, sender}`. `liveness.judge(topic, frame, from, now, offline)` decodes the frame, checks the signature (the anyone-derived child of `sender`, over the topic it was heard on) and `at`, then the body: `identityKey` must be `sender` (`WrongIdentity`) and `peerId` the GossipSub publisher (`WrongPeer`). The `amm-live` entry is `{kind: "amm-live", topic, body, at, sender, signature}`, re-verified when applied. The cron fallback signs the same frame itself, through the signer. The 0.2.0 STOP on freshness is gone: each beat is fresh.
- **The peer ID is the node's.** The host derives the node's key from the instance's root (`[2, "skein instance"]`, `libp2p:<handle>`, self; signer.ts `peerKey`), the key `selfPeerId` asks the signer for. The 0.2.0 STOP is gone.

## 0.2.0 (skein-overlay 0.7.4, skein-sdk 0.7.1)

This section supersedes what the rest of this file says where they differ.

- **The beacon** (shruggr/skein#126). A start without `jobs` — the manifest's `start`, `{kind: "amm-p2p-start"}` in box `amm`, or the same in box `amm/amm-p2p` — emits one `{event: "beacon", topic: "tm_mandala_<txid>_0-live", every: heartbeatSeconds × 1000, body}` per served token topic (the host publishes `body` every `every` ms; no tick, no step per beat) and `{event: "unbeacon", topic}` for a topic beaconed before and no longer served; a stop without `jobs` unbeacons every one. The standing set is the map `beacons` in `amm/p2p` (`{kind: "amm-p2p-state", maps: {live, cursor, beacons}}`). A start or stop naming `jobs` is the cron fallback (`schedule.zig`, the cron provider at `local` `cron`). **STOP:** the body is the start's (`at` and signature); the host re-sends it unchanged, so receivers ignore it once older than the offline threshold. How a beat carries freshness is David's call.
- **The peer ID** (`selfPeerId`, src/main.zig): the signer's public key for `[2, "skein instance"]`, key ID `libp2p:<handle>` (the step's `self.handle`), counterparty self, as the identity multihash of the compressed key (`libp2p.peerIdOf`, checked against js-libp2p's). `ammP2p.peerId` is gone. **STOP:** skein's host derives the node's key from the master secret (src/host/signer.ts `peerKey`), not from the instance root the signer holds, so this is not the node's peer ID until one side changes.
- **Not routed:** `tm_mandala_<txid>_0-live` (the node never subscribes `-live`; matchmaking is the client's), and `/amm/proofs/1.0.0` (its row is gone; sync is shruggr/skein#112's `want`). `validateLive`, `proofsByBlock` and the catch-up pass stay as code, scheduled by nothing.
- **Providers by address** (skein-sdk 0.7: no roles): the libp2p and cron providers are the address book's entries at (`local`, `libp2p`) and (`local`, `cron`) (`sk.peerAt`).
- **Boxes** (shruggr/skein#128): this program's own box is `amm/amm-p2p` (the manifest's `"amm-p2p"`); heartbeat admits and cron ticks name it.
- **The pages**: fn `serve`, the manifest's http row `/` (prefix, `root: "www"`, `index: "index.html"`), answers from the installed app record's `tree` with skein-sdk's `files.serve` (shruggr/skein#125).

## What moved into skein's overlay engine (skein #74)

Per overlay topic `tm_mandala_<txid>_0` the engine now runs the standard gossip itself: it publishes the raw submission on `<topic>` after admission (unless it arrived there), the STEAK on `<topic>-admit` and proofs (BUMPs, reorg re-proofs included) on `<topic>-proof`, and subscribes to all three; the install handler derives those routes from `config.overlay` (docs/APPS.md §6). So this program no longer publishes submissions (the `admitted` lookup hook, its echo check and the outbound BEEF are gone), no longer runs a proof topic (the republish job, the proof verdict and its marker are gone), and is no longer a lookup service (`ls_amm_p2p` and its `admitted`/`spent`/`rejected`/`lookup` hooks are gone).

What is left:

- **the liveness heartbeat**: a validator publishes "I am validator X, my peer ID is Y" on `<topic>-live`, and every node judges what arrives there and keeps a last-seen map (the consumer API `live`);
- **proofs by block**, a direct call (`/amm/proofs/1.0.0`): it serves a block's BUMP to a peer that asks, and a periodic catch-up pass asks peers for the blocks it is missing proofs for;
- **the marketplace relay** (below): `amm.swap.submit`, `amm.swap.status` and `amm.swap.terms`, the pool deploy's `amm.pool.submit` and `amm.pool.status`, and AddLiquidity's `amm.liquidity.submit` and `amm.liquidity.status`, on the app's box `amm` and route `/amm/call`.

**Deferred: the pull half of sync.** #74 defers catch-up (a node that was offline recovering proofs and transactions) to a walk-through with David. The proofs-by-block direct call is a **placeholder** for it, kept as it was (ported to the provider contract, not extended); GASP-style transaction catch-up is not built.

## Layout

| file | what |
|---|---|
| `src/names.zig` | Topic, protocol, box and schedule names; parses `tm_mandala_<txid>_0` and `tm_mandala_<txid>_0-live` itself. |
| `src/libp2p.zig` | The libp2p shapes: the handler's argument, the topic answer (verdict and `admit` entries), the direct-call answer, the libp2p provider's bodies and its answers to a dial. |
| `src/schedule.zig` | The catch-up tick's kind and job (0.6.0: nothing schedules it). Pure. |
| `src/proofs.zig` | Proofs by block: one BUMP per block (merge), the request and reply, the catch-up plan. Pure. |
| `src/views.zig` | The views over the chain state (`chain/state`) and the app's overlay state (`<app>/state`). No VM imports. |
| `src/relay.zig` | The marketplace relay: a pair's checks (the Pool contract's call and outputs, `pool` and Mandala's `brc162`), a deploy's checks (`checkDeploy`: the pool, its key, Mandala's `bsv21.tokenOf` for the first token input), the record of either kind and the app's state (`Book`: `swaps`, `pools`), the request BEEFs and the signed package, the relay thread's steps (`advance`), `submit`/`submitDeploy`/`status`/`statusOf`/`terms`. Pure. |
| `src/main.zig` | The program: the route handlers, the steps (the catch-up tick, the app's box, the relay thread), the app dispatch (skein-sdk `app`), the signer (`wallet`), `emit`, `launch`, `await` and `deadline` imports. |
| `test.zig` | Tests. |

Dependencies (`build.zig`): skein-overlay 0.6.0 by URL + hash (its `sk` VM helpers, and its engine sources as the module `skein_overlay`, as amm-validator takes them), skein-sdk 0.5.1 through it (`chain`, `wallet`, `app`, `sk`, `cbor`, `dagjson`, `message`), skein-mandala 0.4.0 (`mandala`) and `pool`. The tests read `etc/app.json` (the functions' declarations).

## Routes and protocols

| route (libp2p) | program fn | what |
|---|---|---|
| `libp2p:tm_mandala_<txid>_0-live` (GossipSub topic) | none (0.4.0) | the runtime's liveness tool on a market host (`liveness`), read at `GET /amm/.live/tm_mandala_<txid>_0-live`; this program judges no beat |
| `libp2p:/amm/proofs/1.0.0` (direct call) | `proofsByBlock` | answer one request frame with one reply frame |
| `/amm/` (a read route, prefix, its filter `page`, shruggr/skein#143) | `serve` | the pages, `www/` of the app's tree; a filter's answer, anyone, signed or not, nothing logged |
| `/amm/call` (HTTP row, APPS.md §4: a signed request) | `call` | `{fn, args}` → `{fn, result}` / `{fn, error}`; `amm.swap.submit`, `amm.pool.submit` and `amm.liquidity.submit` wait on their relay |

`<txid>` is the token's deploy txid, 64 lowercase hex characters in display order; the topic name is `tm_mandala_<txid>_0` (skein-mandala 0.8.2: `tm_mandala_<assetId>`, `_0` included; until skein-amm 0.7.1 it had no suffix), and the liveness topic adds `-live`, in skein's `-admit`/`-proof` style. Bodies are dag-cbor; hashes and txids are 32 bytes in internal byte order.

### Liveness — `tm_mandala_<txid>_0-live`

```
frame: {body: bytes, at: uint, sender: bytes(33), signature: bytes}      (the host's beat, 0.2.1)
body:  {identityKey: bytes(33), peerId: bytes}
```

"I am validator `identityKey` and my peer ID is `peerId`." `at` is milliseconds since the Unix epoch, the beat's time on the publishing host. `signature` is a DER ECDSA signature by the instance — BRC-100 `createSignature` under `[2, "metanet handles envelope"]`, key ID `send`, counterparty `anyone` (invoice `2-metanet handles envelope-send`), which anyone can derive from `sender` — over sha256 of dag-cbor `{kind: "beacon", topic, body, at, sender}` (the topic is signed, not carried).

| case | verdict |
|---|---|
| the frame or the body does not decode | reject `Malformed` |
| `identityKey` is not the frame's `sender` | reject `WrongIdentity` |
| the signature does not verify against `sender`'s derived key, over this topic | reject `BadSignature` |
| `peerId` is not the GossipSub sender (`from`) | reject `WrongPeer` |
| `at` more than 60 s ahead of this node's clock | ignore `FromTheFuture` |
| `at` older than the offline threshold | ignore `Stale` |
| our own failure to evaluate (bad config, not a `-live` topic) | ignore `<error>` |
| otherwise | accept |

On accept the handler answers with one `admit` entry, which the front door admits after the message's own `p2p` entry (docs/MESSAGES.md "libp2p (#51)"):

```
{event: {kind: "amm-live", topic, body, at, sender, signature}, box: "amm-p2p"}
```

Stepped on it, the program re-verifies the signature and records it in its last-seen map `live` (identity key → `at` ‖ peer ID) under its head `amm/p2p`; a later `at` replaces an earlier one, never the reverse. Staleness is the consumer's question, so a log replayed later records the same map.

**Consumer API.** Gone in 0.4.0 (above): the runtime's `GET /amm/.live/tm_mandala_<txid>_0-live` replaces it, and fn `live` answers 410.

**Publisher (job `heartbeat`).** On each heartbeat tick a validator signs through the `wallet` import (getPublicKey identity; createSignature with the digest above, protocol `[1, "amm live"]`, key ID `1`, counterparty anyone) and emits `{topic: "<topic>-live", body}` to the libp2p provider (box `publish`) for each topic; the provider's answer is recorded and nothing awaits it. The peer ID is configuration (`ammP2p.peerId`, what `skein-host identity <handle> --peer` prints): skein gives a program no way to learn its own (known limitation, recorded).

### Proofs by block — direct call `/amm/proofs/1.0.0`

```
request  {blockHash: bytes(32), topic?: text}
reply    {bump: bytes} | {missing: true}
```

**Serving.** The front door calls `proofsByBlock` with the request frame; it answers `{verdict: "accept", body}` and the front door writes the body back as one frame. The reply's BUMP merges every proof this node holds in that block (only the topic's transactions when `topic` is given); `missing` when the block is not on its best chain, it holds nothing there, or the request does not decode.

**Requesting (job `catchup`).** While a topic has unsettled transactions (the wallet's `unproven` index joined to the topic's `applied`), a pass asks for the blocks after a per-topic cursor (starting `window` below the tip), `batch` at a time, from the configured `peers`, then the validators live in the last-seen map (up to three per block). Outbound is the libp2p provider (docs/MESSAGES.md "The providers"), so the pass is a thread resting on the provider's answers to its dial:

```
tick step    emit dial {peer, protocol: "/amm/proofs/1.0.0"}; await it; deadline replyTimeoutMs
answer       {stream} (box dial)       → emit send {stream, body: request}; rest again
answer       {stream, body} (box frame) → emit close; check the BUMP's root against our header; one that
                                         proves a held unproven transaction errors the pass (Port, STOP: amm-poc
                                         applied it to the head `wallet`); next block, emit the next dial
answer       {stream, closed} | {error}; or the deadline → the next peer
```

The pass is carried from step to step in the thread's result record (`catchup: {topic, height, to, peers, peer, dial, stream, until}`). At the batch's end the cursor moves; with nothing unsettled the cursor follows the tip. It is not exercised natively (it needs the kernel and the provider); the plan, the bodies and the answers are.

## The marketplace relay (`amm.swap/1`)

The taker's own skein relays the swap so the browser never needs libp2p (docs/notes.md 2026-10-02, "Swap funding and signing", "Marketplace relay"). The page builds the **funding transaction** (BRC-100 `createAction` with `noSend`: one exact output, the swap's input) and the **swap** (the pool input with the contract pushes and the validator's slot empty, the funding output as its other input, signed by the page), and hands both to its skein, which checks them, records the swap in flight under the app's head, dials the pool's validator and waits on the answer.

### The functions

Declared in `etc/app.json` (`provides`, interface `amm.swap/1`), dispatched with skein-sdk's `app` helper (args checked against the shapes, `writes` enforced), reachable three ways (APPS.md §4): a message `{fn, args}` in box `amm` (answered with a message to the sender, `{fn, request, replyTo, result | error}`, when the address book reaches it), the route `/amm/call` (POST `{fn, args}`, JSON/dag-json or dag-cbor; bytes in JSON are dag-json `{"/": {"bytes": "<base64>"}}`), an in-VM `call`.

```
amm.swap.submit   writes: true
  args    {funding: bytes, swap: bytes, pool: string, validator: bytes, peerId: string, expires: ms}
  answer  the record (below)
amm.swap.status   writes: false
  args    {id: string}
  answer  the record                      error `not_found`
amm.swap.terms    writes: false
  args    {}
  answer  {commissionPkh?: bytes}         the relay's commission pkh (20 bytes; null when none is set),
                                          for the page to name as Swap's commissionPkh before it builds the swap
record    {id: string, status: string, funding: bytes, swap: bytes, pool: string, validator: bytes,
           expires: ms, created: ms, updated: ms, tx?: bytes, txid?: string, reason?: string,
           detail?: string, poolState?: map}
status    pending | accepted (tx: the validator's signed swap, txid) | refused (the validator's reason,
          detail, poolState: its `pool`) | timeout (no answer by `expires`) | failed (the dial or the
          stream failed, or the answer did not decode)
```

- `funding`: the funding transaction, raw or a BEEF (V1, V2, Atomic: `createAction`'s `tx`) whose subject it is. **Send the BEEF**: the validator's overlay verifies every unproven transaction's inputs against a parent in the BEEF or one it holds, so a raw funding transaction is refused there (`submit_refused`, `MissingInput`) unless the validator holds its parents.
- `swap`: the raw swap. `id` is sha256 of these bytes (hex): the swap with the validator's slot empty.
- `pool`: the pool outpoint `<txid>_<vout>`; `validator`: the pool's ValidatorIdentity (33 bytes); `expires`: ms since the epoch.

**Checks** (`relay.checkPair`; a refusal is the function's error, `failed`, message `<reason>[: <detail>]`, and nothing is written): `bad_validator`, `expired`, `bad_funding`, `bad_swap`, `bad_pool`; `pool_not_input_0` (input 0 spends `pool`); `funding_not_spent` (another input spends an output of the funding transaction); `funding_unsigned`, `swap_unsigned` (an input with no unlocking script; the validator verifies the signatures); `not_a_swap`, `bad_call` (the pool call is Rúnar's `Swap(validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh, commissionPkh)`, 11 pushes, 20-byte pkhs), `signature_slot_not_empty`; `bad_outputs` (output 0 a pool, then the payout, the LP and validator fees when nonzero, the commission when the pool's CommissionBps of amountIn is nonzero: in the input asset — sats, or a 1-sat BRC-162 value output — to the call's commissionPkh, then at most one change output when `_changeAmount > 0`), `wrong_validator` (the continuation's ValidatorIdentity is not `validator`); `commission_missing` (config `commission.pkh` set, the pool charges a commission, and the call's commissionPkh is not ours; a pool whose CommissionBps is 0 has no commission output and passes); then `bad_peer` (0.4.0: `peerId` is not a peer ID's text; the relay dials it, or calls its own validator when it is this node's).

**Submit** records `{status: "pending", …}` under the app's head and launches the relay thread (this program, args `{kind: "amm-swap-relay", id}`). Over `/amm/call` the request waits on that thread (`{wait: true}`) and answers the settled record when it comes to rest; a message caller is answered by the relay thread with the settled record; an in-VM call gets the pending record. The same swap again answers its record (a `/call` waits on the relay while it is pending); one that timed out or failed is relayed again.

### The relay thread

```
launched              emit dial {peer: the validator's peer ID (as the caller named it), protocol: "/amm-validator/1/swap"}
                      to the libp2p provider; await it; deadline `expires`
{stream} (box dial)   emit send {stream, body: the package}; rest again
{stream, body} (frame) the validator's answer: {ok: true, tx, txid} → accepted; {ok: false, reason, detail?, pool?}
                      → refused; emit close; answer the message caller
{stream, closed} | {error}   failed (reason `unreachable`)
woke at `expires`     timeout (close the stream if open); before it, rest again
```

**The package** (the frame): the signed-message package amm-validator opens (its README, "A direct call"): `{message, body}`, the mail record `{kind: "mail", op: "put", sender: this instance's identity, recipient: validator, box: "swap", body: <cid>, nonce: sha256("amm-swap-relay" ‖ id)[0..16], signature}` signed BRC-169's way through the `wallet` import (`createSignature`, `[2, "metanet handles envelope"]`, key ID `send`, counterparty anyone, over sha256 of the record without `signature`), and the body `{tx: <one V2 BEEF: the funding transaction's ancestry from its BEEF, the funding transaction (unproven), the swap>, pool}`. The pool's own ancestry is not sent: the validator holds the pool (it is its overlay).

## The pool deploy through the relay (`amm.pool/1`)

The LP's own skein carries a pool deploy to the pool's validator the same way (web/ui src/lp/poolDeploy.ts and poolRelay.ts; docs/notes.md 2026-10-02 "Swap funding and signing" applied to the deploy). The page builds the **funding transaction** (`createAction` with `noSend`: one exact output, the pool's sats + the deploy's miner fee) and the **deploy** (the LP's token inputs, then the funding output; output 0 the pool, ValidatorPubKey the validator identity's anyone-child for the first token input; every input signed by the LP), and hands both to its skein. Nobody signs a deploy but the LP: the validator consents and submits it to its own overlay, whose chain app broadcasts the funding parent with it.

```
amm.pool.submit   writes: true
  args    {funding: bytes, deploy: bytes, validator: bytes, peerId: string, expires: ms}
  answer  the record (below)
amm.pool.status   writes: false
  args    {id: string}
  answer  the record                      error `not_found`
record    {id: string, status: string, funding: bytes, deploy: bytes, pool: string, validator: bytes,
           expires: ms, created: ms, updated: ms, tx?: bytes, txid?: string, reason?: string, detail?: string}
status    pending | accepted (tx: the deploy itself, txid: its txid) | refused (the validator's reason, detail)
          | timeout | failed
```

- `funding`: the funding transaction, raw or a BEEF (the wallet's AtomicBEEF) whose subject it is.
- `deploy`: the deploy as a BEEF (AtomicBEEF, V1, V2) whose subject it is, carrying the funding transaction and the token inputs' source transactions. `id` is sha256 of the deploy's raw bytes (hex); `pool` in the record is `<deploy txid>_0`.
- `validator`: the pool's ValidatorIdentity (33 bytes); `expires`: ms since the epoch.

**Checks** (`relay.checkDeploy`; a refusal is the function's error, `failed`, message `<reason>[: <detail>]`, nothing written): `bad_validator`, `expired`, `bad_funding`, `bad_deploy` (not a BEEF whose subject is a transaction; a raw deploy; a pool at an output other than 0); `not_a_pool` (output 0 is not a pool as the pool checks see one (`pool.check`): a BRC-162 value output whose lock parses as the Pool, its prefix id the 32-byte AssetId and its amount the TokenReserve; detail which); `wrong_validator` (ValidatorIdentity is not `validator`); `funding_not_spent` (no input spends an output of the funding transaction); `funding_unsigned`, `deploy_unsigned` (an input with no unlocking script); `missing_parent` (an input other than the funding's whose source transaction is not in the deploy's BEEF, or is there by txid only); `no_token_input` (no input spends an output of the pool's token, Mandala's `bsv21.tokenOf`); `wrong_validator_key` (ValidatorPubKey is not the identity's anyone-child for the first token input's outpoint, `pool.validatorKey`: the derivation amm-validator checks, refused here before dialling); then `bad_peer`.

**Submit** records `{kind: "amm-pool", status: "pending", …}` in the app's state map `pools` and launches the relay thread (`{kind: "amm-pool-relay", id}`), which runs the swap's steps (above) on `/amm-validator/1/deploy`. **The package**: box `deploy`, nonce sha256("amm-pool-relay" ‖ id)[0..16], body `{tx: <one V2 BEEF>, pool: 0}`: the deploy's BEEF as received (its entries and BUMPs, the deploy last as its subject), with the funding transaction's BEEF (its ancestry) merged in first when the deploy's does not carry the funding transaction (`relay.deployBeef`). **The answer**: `{ok: true, txid}` (the deploy admitted in the validator's overlay) → `accepted`, `tx` the deploy's raw bytes and `txid` its txid; an answer naming another txid, or a `tx` other than the deploy, is `failed` (`bad_reply`). `{ok: false, reason, detail?}` → `refused`. The same deploy again answers its record (a `/call` waits while it is pending); one that timed out or failed is relayed again. Declared in `etc/app.json` as a second `provides` entry, interface `amm.pool/1`.

## AddLiquidity through the relay (`amm.liquidity/1`)

The LP's own skein carries an AddLiquidity to the pool's validator (docs/notes.md 2026-10-02 "Swap funding and signing" applied to AddLiquidity). The page builds the **funding transaction** (`createAction` with `noSend`: one exact output, the sats added + the add's miner fee - the token inputs' sats) and the **add** (input 0 the pool with `AddLiquidity(lpSig, validatorSig, nextLpPubKey, nextValidatorPubKey, addBsv, addTokens)`, the LP's slot signed by the pool's LpPubKey and the validator's `OP_0`; the LP's token inputs and the funding output, each signed; output 0 the continuation, no change), and hands both to its skein. The validator signs last and submits the add to its overlay, whose chain app broadcasts the funding parent with it.

```
amm.liquidity.submit   writes: true
  args    {funding: bytes, add: bytes, pool: string, validator: bytes, peerId: string, expires: ms}
  answer  the record (below)
amm.liquidity.status   writes: false
  args    {id: string}
  answer  the record                      error `not_found`
record    {id: string, status: string, funding: bytes, add: bytes, pool: string, validator: bytes,
           expires: ms, created: ms, updated: ms, tx?: bytes, txid?: string, reason?: string, detail?: string, poolState?: map}
status    pending | accepted (tx: the validator-signed add, txid: its txid) | refused (the validator's reason, detail,
          poolState) | timeout | failed
```

- `funding`: the funding transaction, raw or a BEEF (the wallet's AtomicBEEF) whose subject it is.
- `add`: the add as a BEEF (AtomicBEEF, V1, V2) whose subject it is, carrying the funding transaction and the token inputs' source transactions (the pool's source may be there too; it is read from there, else from this instance's own overlay). `id` is sha256 of the add's raw bytes (the validator's slot empty), hex.
- `pool`: the outpoint input 0 spends, `<txid>_<vout>`; `validator`: the pool's ValidatorIdentity (33 bytes); `expires`: ms since the epoch.

**Checks** (`relay.checkAdd`, against pool/Pool.runar.go's `AddLiquidity`; a refusal is the function's error, `failed`, message `<reason>[: <detail>]`, nothing written): `bad_validator`, `expired`, `bad_funding`, `bad_add` (not a BEEF whose subject is a transaction; a raw add; fewer than two inputs), `bad_pool`; `pool_not_input_0`; `funding_not_spent`; `funding_unsigned`, `add_unsigned` (an input other than the pool's with no unlocking script); `not_add_liquidity` (the pool call's method index is not AddLiquidity, 1); `bad_call` (not Rúnar's 11 pushes; nextLpPubKey / nextValidatorPubKey not a compressed key; addBsv + addTokens = 0; a change amount without a 20-byte `_changePKH`); `signature_slot_not_empty` (the validator's slot); `lp_unsigned` (the LP's slot empty: the LP signs before the relay); `missing_parent` (an input other than the pool's and the funding's whose source is not in the add's BEEF or there by txid only; or the pool's source neither in the BEEF nor held here); `not_a_pool` (input 0 does not spend a pool as the pool checks see one (`pool.check`)); `wrong_validator` (the spent pool's ValidatorIdentity is not `validator`); `wrong_validator_key` (nextValidatorPubKey is not the identity's anyone-child for the pool outpoint: the validator's convention, refused before dialling); `bad_outputs` (output 0 the continuation: the pool's code and readonly fields, satoshis = the pool's + addBsv, TokenReserve = the pool's + addTokens, LpPubKey = nextLpPubKey, ValidatorPubKey = nextValidatorPubKey; then Rúnar's P2PKH change only when `_changeAmount > 0`; nothing else: the contract has no fee and no commission on AddLiquidity; detail which); then `bad_peer`.

**Submit** records `{kind: "amm-liquidity", status: "pending", …}` in the app's state map `liquidity` and launches the relay thread (`{kind: "amm-liquidity-relay", id}`), which runs the swap's steps (above) on `/amm-validator/1/addLiquidity`. **The package**: box `addLiquidity`, nonce sha256("amm-liquidity-relay" ‖ id)[0..16], body `{tx: <one V2 BEEF>, pool}`: the add's BEEF as received, the funding transaction's merged in first when the add's does not carry it (`relay.deployBeef`). **The answer**: `{ok: true, tx, txid}` → `accepted`, but only if `tx` is the add with the validator's signature in its slot and every other byte as the LP sent it (`relay.signedAdd`) and `txid` (when given) is its txid; else `failed` (`bad_reply`). `{ok: false, reason, detail?, txid?, pool?}` → `refused`, `poolState` the validator's `pool`. The same add again answers its record (a `/call` waits while it is pending); one that timed out or failed is relayed again. Declared in `etc/app.json` as a third `provides` entry, interface `amm.liquidity/1`.

### The app's head

The app's state is `{kind: "amm-app-state", swaps: <MST: id → swap record>, pools: <MST: id → deploy record>, liquidity: <MST: id → AddLiquidity record>}` under the app's root head `amm/app` (an app's heads are `<app>/…`; `relay.app_head`, checked against skein-sdk's `app.headOf`): the installed app record's `state` (APPS.md §1: the head's root with `state` replaced), or, on an instance wired by its genesis (no app record at `amm/app`), the head's root itself. The record kept there adds the relay's own fields (`peer`, `dial`, `stream`, `thread`, `request`), which the answer leaves out.

### Configuration

```
config.amm.commission (app record)  |  genesis defaults.ammCommission (JSON text):  {pkh?: <40 hex> | null}
config.amm.ammP2p (app record)  |  genesis defaults.ammP2p (JSON text)        (as below)
the functions' declarations:  the app record's `provides`  |  genesis defaults.ammProvides (JSON text: the manifest's `provides`)
box amm      {address: "amm", sender: "*", program: "amm-p2p"} (manifest; after the owner's, the events' and $self's rows to the engine)
http /call   {transport: "http", address: "/call", sender: "*", program: "amm-p2p", fn: "call"} (manifest)
```

The `/call` route admits the caller as a message would be (skein-sdk 0.3.0 `app.admitted`: a `mailbox` row in the call input's `dispatch` for (caller, `amm`) or (anyone, `amm`)); an open row (sender `*`) has no caller, so the box must be open to anyone.

## Scheduling (skein #69)

Genesis `jobs` are gone; a schedule is a message to the cron provider, emitted from a step (docs/MESSAGES.md "Scheduling: the waker and the cron provider (#69)"). The program asks for one schedule per job, named so a repeat replaces it:

```
to the cron provider (address book role "cron"), box "cron":
  {fn: "tick", every: heartbeatSeconds·1000, box: "amm-p2p", body: {kind: "amm-p2p-tick", job: "heartbeat"}, name: "amm-p2p-heartbeat"}
  {fn: "tick", every: catchupSeconds·1000,   box: "amm-p2p", body: {kind: "amm-p2p-tick", job: "catchup"},   name: "amm-p2p-catchup"}
each tick, from the cron provider into box "amm-p2p":
  {kind: "amm-p2p-tick", job, name, due}
```

A tick launches a thread of this program (its sender must be the cron provider's key). The provider's answers to the requests (`{replyTo, name, next}` or `{replyTo, error}`) land in box `cron` and are recorded; nothing awaits them. The reference host keeps schedules in host.db and ticks each `every` schedule once at a host start, so a schedule survives restarts.

**The first request.** The schedule must originate in a step, and nothing in skein steps a program at install or at instance start (APPS.md §3: install is three owner messages, none addressed to the app; #69 removed the genesis jobs). So the program asks when it receives, in any box (`amm-p2p`; the manifest's `start` goes into box `amm`, where the owner's row is the engine's: README "Calls"),

```
{kind: "amm-p2p-start", jobs?: ["heartbeat" | "catchup"]}      (default: catchup, plus heartbeat when ammP2p.peerId is set)
{kind: "amm-p2p-stop",  jobs?: […]}                              emits {fn: "stop", name} for each
```

from the owner (`in.owner`) or the cron provider — the latter so `skein-host event <agent> amm-p2p '{"kind":"amm-p2p-start"}'` works. Anything else in the box from another sender errors the step. Until someone sends it once, no heartbeat and no catch-up run.

## Configuration (a genesis-wired node)

The program also runs wired by a genesis, with no app record (amm-poc's deploy). Installed as an app, its configuration is the manifest's `config.amm`.

```
etc/config.json  defaults:
  "overlayTopics":  "{\"tm_mandala_<txid>_0\": \"mandala-topic\"}"
  "ammP2p":         "{\"heartbeatSeconds\": 30, \"offlineSeconds\": 90, \"catchupSeconds\": 600, \"window\": 12, \"batch\": 6,
                      \"peers\": [\"16Uiu2…\" | \"/ip4/…/p2p/16Uiu2…\"], \"topics\": [\"tm_mandala_<txid>_0\"],
                      \"peerId\": \"16Uiu2…\", \"replyTimeoutMs\": 30000}"
  "scopes":         {"amm-p2p": ["amm/p2p", "amm/app"]}     (the heads this genesis-wired program may advance)
etc/dispatch.json  {transport: "libp2p", address: "tm_mandala_<txid>_0-live",    sender: "*", program: "amm-p2p", fn: "validateLive"}
                   {transport: "libp2p", address: "/amm/proofs/1.0.0", sender: "*", program: "amm-p2p", fn: "proofsByBlock"}
                   {address: "amm-p2p", sender: "*", program: "amm-p2p"}   (the admitted heartbeats, the ticks, the start message)
                   {address: "amm", sender: "*", program: "amm-p2p"}       (the app's box, amm.swap/1; the relay above)
address book     the `libp2p` and `cron` providers (the node host seeds them)
```

The write scope: `amm/p2p` (this state) and `amm/app` (the relay); an installed app advances only heads named `amm/…`. The state head is `amm/p2p` (`relay.p2p_head`). `ammP2p.topics` defaults to every served `tm_mandala_<txid>_0` topic. `peerId` is needed only for the heartbeat (a validator); a mistyped value makes every heartbeat `WrongPeer` at the receivers. State under the head `amm/p2p`: `{kind: "amm-p2p-state", maps: {live, cursor}}`.

## Open

The end-to-end runs below are amm-poc's (its deploy/README.md); this port is tested natively only.

- **The pool deploy, end to end (deploy/README.md "Pool deploy through the relay"):** amm2 relayed a deploy of a pool amm3 validates; `amm.pool.submit` answered `accepted` in one `/amm/call` (279 ms), the relay thread's three steps each advancing `amm/app`; amm3 broadcast the funding then the deploy and both instances index the pool. Not exercised: the message path (box `amm`) for `amm.pool.submit`, a refusal or a timeout from a live validator (natively only).
- **AddLiquidity, end to end (deploy/README.md "AddLiquidity through the relay"):** amm2 relayed an AddLiquidity of the pool amm3 validates; `amm.liquidity.submit` answered `accepted` with the validator-signed add in one `/amm/call` (401 ms), the relay thread's three steps each advancing `amm/app`; amm3 broadcast the funding then the add, both instances admitted it (amm2 by gossip) and index the increased reserves. Not exercised live: the message path (box `amm`), the held-pool fallback (the page's AtomicBEEF carries the pool's source), a refusal or a timeout from a live validator (natively only).
- **Run end to end once (2026-10-02, deploy/README.md "The relay round trip"):** amm2 relayed a swap against a pool amm3 validates; the record went pending → accepted in one `/amm/call` (456 ms), every advance under `amm/app`, amm3 broadcast the funding parent then the swap, both instances admitted it. Natively: the checks over pairs built from the fixtures, the BEEF, the package (verified with skein-sdk's `message.problem`, as the validator does), the record's lifecycle over faked provider answers, the dispatch by app.json. The VM path (the route's `{wait: true}` and `resolved`, the launched thread, the dial by peer ID, the `wallet` import signing under `[2, "metanet handles envelope"]`, advancing the head `amm/app`) needs a running instance.
- **The SDK's dispatch helper answers in the step** (`app.serve`: the `/call` route answers at once, a message is answered at the end of its step). A function whose answer depends on later steps (a peer's reply) is outside it, so this program runs its own `/call` and message wrappers around `app.run` (the same checks, codes and answer shapes) with one addition: `amm.swap.submit` waits on its relay thread.
- **No app record under a genesis-wired node**: the declarations come from `defaults.ammProvides` and the state is the head `amm/app`'s root itself (above).
- **A timeout is not a refusal**: the validator may still answer (and submit) after `expires`; the record says `timeout`, and the late answer runs nothing.

- **No first step.** The schedule cannot start itself (above): an install-time or start-time step for an app is not in skein's contract.
- **Overlapping passes.** Each catch-up tick launches its own thread; a pass still resting when the next tick comes runs beside it (both ask, the first answer proves, the second finds nothing new). With the defaults a pass is bounded by `batch` × 3 peers × `replyTimeoutMs` = 9 min < `catchupSeconds`.
- **Interval and threshold** default to 30 s / 90 s, configurable.
