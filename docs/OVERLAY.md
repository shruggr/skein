# Overlay services

The overlay engine is an app in its own repository,
[shruggr/skein-overlay](https://github.com/shruggr/skein-overlay) (0.7.0).
Its `docs/OVERLAY.md` is the reference: the submission flow, the overlay's
state and its split from the chain app, the engine's box and config, the
topic contract, the lookup contract, the wire, the gossip, and a system
tree for an overlay node. Links elsewhere in skein's docs to a section of
docs/OVERLAY.md ("Gossip", "The wire", …) name that document's sections.

An overlay app keeps what its topics admitted and judged, its lookup
services' maps and its gossip state under its own name (`<app>/state`,
`<app>/ls_<service>`, `<app>/gossip`). It holds no chain state: a
submission goes to the chain app (shruggr/skein-chain, `requires:
["chain/1"]`) as an `ingest` message and is admitted on the chain app's
first `accepted` or `proven` answer.

**A submission's BEEF is decoded at the kernel's door** (#121, docs/VM.md
"The door"). The submit rows — `/<app>/submit` and the libp2p `<topic>`,
derived from `config.overlay` (src/host/manifest.ts `overlayWiring`) — name
`filter: "beef"`: before the request's entry is written, the kernel stores
each transaction once as its `bitcoin-tx` block and each BUMP as its bytes'
raw block, checks every BUMP against `chain/state`, and puts the BEEF's
pointer record where the bytes were. The submit handler gets the record's
CID, reads it (skein-overlay ≥ its `beef-as-cid` commit, `decodeRecord`),
and does not prove the BUMPs again; the submit event and the `ingest`
message carry the CID; the gossip re-publishes the exact bytes received
(skein-sdk `chain.record.beefOf`). A bad BUMP is a refusal entry, 400 to an
HTTP client, `reject` on GossipSub; nothing runs. No BEEF bytes are logged
— but for a body framed with off-chain values (`VarInt(len) ‖ BEEF ‖
values`), which no BEEF pattern leads: the door passes it, and the overlay
decodes and checks it in its call as before. Two overlay apps on one instance run
over the one `chain/state` (docs/APPS.md §6). The topic and lookup
contracts are Zig modules (`topic`, `lookup`, and the `sk` helpers) an app
depends on by URL+hash. Next for the engine: skein-overlay#1 (submit walks
the whole BEEF oldest-first and judges every transaction of the topic).

The app's tree is `bin/overlay.wasm` (the engine), `bin/topic-demo.wasm`
(`tm_demo`), `bin/lookup-demo.wasm` (`ls_demo`) and `etc/app.json`. The
engine is not pinned here: a tree carries its modules.

`kernel-zig/equiv/overlay.ts` runs it end to end as part of
`kernel-zig/equiv/run.sh`: it clones skein-overlay and skein-chain at
pinned commits (or takes `$SKEIN_OVERLAY_DIR`, `$SKEIN_CHAIN_DIR`) and boots
instances from trees carrying their `bin/*.wasm`;
`kernel-zig/equiv/install-overlay.ts` installs both as apps, and two
overlay apps on one instance.

## How an overlay app activates a token topic live (#119)

A topic per token (`tm_<txid>`) is not known at install, so nothing about
it is in the manifest: no row, no declaration. The overlay app (Mandala, an
AMM) has calls for its users to **register** and **deregister** a topic.

- **Register** emits a subscription: `{event: "subscribe", topic:
  "tm_<txid>", program: <the engine's role>, fn: "submit"}` — and one each
  for `tm_<txid>-admit` (fn `peerAdmit`) and `tm_<txid>-proof` (fn
  `peerProof`); `filter: "beef"` where the handler takes BEEF, as the
  derived rows carry it. The kernel checks it (the program is the app's, the
  fn named, the topic not a `/<protocol>`) and records it on the step's
  update with the app's name.
- **Deregister** emits `{event: "unsubscribe", topic}` for each; the app
  ends only its own subscriptions.

After the commit the host's libp2p node subscribes the topic. A message
gossiped on it is handed to the kernel, which delivers it by the
subscription — that app's program at that fn, through the door as a row's
handler would run — with no dispatch row involved. If a row is at the same
topic (a manifest's pre-configured topic), the row wins. Another app's
subscription to the same topic is its own and does not take the topic from
the first. After a host restart the node and the kernel read the
subscriptions back from the log; the app does nothing.
docs/MESSAGES.md "libp2p (#51)", "Subscriptions".

## Installing an overlay

The steps below were run on skein main 9b06db6 with skein-chain v0.3.0
(61b03c6) and skein-overlay v0.4.1 (d5df94e), on regtest, with no Arcade;
the outputs are trimmed. `kernel-zig/equiv/install-overlay.ts` runs the same
install, submit and lookup in the equivalence suite.

**Prerequisites.** The overlay admits a submission on the chain app's
answer, and the chain app proves nothing without the host's headers feed
(`SKEIN_HEADERS_URL`) and broadcasts nothing without its broadcaster
(`SKEIN_ARC_URL`). shruggr/skein-chain's README, "Use it", says what the
host must provide. Without a broadcaster, only a transaction whose BEEF
proves it (a mined one) is admitted at once.

### A host and an instance

As README "Run a skein locally", with the headers feed set for the host:

```
bin/skein-host add ov1 --image default
SKEIN_HEADERS_URL=<an SSE stream of headers> bin/skein-host run
bin/skein plan claim --recipient <ov1's identity> --out claim && bin/skein send http://ov1.localhost:8100 claim   # #127: your wallet's claim; you own ov1
```

```
ov1: booted from the image baf4bcfb6esis6uqhtc6xoi4gtyvydibg24bfqva · 54 objects pre-filled · programs frontdoor, messagebox · … · no owner: claim it from your wallet (skein plan claim, skein send)
skein-host: router at http://127.0.0.1:8100 · an instance at http://<handle>.localhost:8100 (or /@<handle>)
skein-host: no Arcade (SKEIN_ARC_URL): a broadcast event is dropped; a new genesis names no status provider
```

The feed reaches an instance once the chain app is installed in it
(`[router] ov1: subscribed to the host's headers feed …`).

### The owner's wallet

Installing is the owner's messages (#124): `skein plan install` builds
them and the owner's BRC-100 wallet sends them to the instance's
`/sendMessage` (`skein send`, which runs `1sat authfetch`; any wallet with a
BRC-104 client does the same). The plan reads the instance through its
explorer with the same wallet (`--origin <the instance's origin>`), or, on
the host's machine, its store file (`--store
~/.skein/instances/<handle>/runtime.db`).

### The chain app, then the overlay

By repository URL, at a commit (`#<commit>`; without it, the default
branch's head). The chain app first: the overlay `requires: ["chain/1"]`,
and its install into an instance without it is refused (`requires chain/1:
no installed app provides it`).

```
bin/skein plan install https://github.com/shruggr/skein-chain#61b03c6bca1fee141a72be974eb211eeae06c0db --origin http://ov1.localhost:8100 --config '{"chain": {"network": "regtest"}}' --out chain
bin/skein send http://ov1.localhost:8100 chain
```

```
install chain 0.3.0 — The chain module …
  head      chain/app → the app record bafyreicqn4mjtom5wbydzcrkdtdtn7oiyiqbu3vosau5ib2iqhqxggtbxe (tree baf4bcfe6xw5sebgaa3is7njmhrju3xw7rbt5iqq)
  row       mailbox chain from event → chain
  row       mailbox chain from $self → chain
  row       mailbox chain from $owner → chain
  row       mailbox status from $status → chain
  provides  chain/1: ingest, status (read), proof (read)
  note      row mailbox status from $status: no status provider in the address book (optional; left out)
chain: prompt.txt and 6 messages to <ov1's key>
```

`--config` is merged over the manifest's `config`; on mainnet leave it out
(`config.chain.network` defaults to the genesis's `walletNetwork`, else
`main`). The prompt is also `chain/prompt.txt`; nothing is sent until
`skein send`.

```
bin/skein plan install https://github.com/shruggr/skein-overlay#d5df94e8a7f875314e385f7d053aea835de53f6f --origin http://ov1.localhost:8100 --out overlay
bin/skein send http://ov1.localhost:8100 overlay
```

```
install overlay 0.4.1 — Overlay services …
  head      overlay/app → the app record bafyreicmdz4tu7ergfn2ddozvagwrrlat6ivvfsdydfwutmnexld7fzg6e (tree baf4bcfez5gnvrnapt2lcsqkrjct6z2yqopa6ywi)
  row       http /overlay/listTopicManagers from anyone → overlay.listTopicManagers
  row       http /overlay/listLookupServiceProviders from anyone → overlay.listLookupServiceProviders
  row       http /overlay/getDocumentationForTopicManager from anyone → overlay.topicDocumentation
  row       http /overlay/getDocumentationForLookupServiceProvider from anyone → overlay.lookupDocumentation
  row       mailbox overlay from event → overlay (derived: config.overlay)
  row       mailbox overlay from $self → overlay (derived: config.overlay)
  row       http /overlay/submit from anyone → overlay.submit (derived: config.overlay)
  row       http /overlay/lookup from anyone → overlay.lookup (derived: config.overlay)
  row       libp2p tm_demo from anyone → overlay.submit (derived: config.overlay)
  row       libp2p tm_demo-admit from anyone → overlay.peerAdmit (derived: config.overlay)
  row       libp2p tm_demo-proof from anyone → overlay.peerProof (derived: config.overlay)
  requires  chain/1
  publishes tm_demo, tm_demo-admit, tm_demo-proof (for information: emitting needs no grant)
ov1: overlay 0.4.1 installed: 15 messages sent as the owner · head overlay/app → bafyreicmdz4tu7ergfn2ddozvagwrrlat6ivvfsdydfwutmnexld7fzg6e
```

### What `config.overlay` wires

skein-overlay's `etc/app.json` names its topic managers and lookup services
in `config.overlay` (`topics: {tm_demo: "topic-demo"}`, `lookups: {ls_demo:
{program: "lookup-demo", topics: ["tm_demo"]}}`, `gossip: {tm_demo:
true}`). The install derives these rows from it (src/host/manifest.ts
`overlayWiring`, docs/APPS.md §6), all to the engine, role `overlay`:

| row | from | fn |
|---|---|---|
| mailbox `overlay` | `event` (what its libp2p rows admit) | |
| mailbox `overlay` | `$self` (its own watch) | |
| http `/overlay/submit` | anyone | `submit`, `filter: "beef"` |
| http `/overlay/lookup` | anyone | `lookup` |
| libp2p `tm_demo` | anyone | `submit`, `filter: "beef"` |
| libp2p `tm_demo-admit` | anyone | `peerAdmit` |
| libp2p `tm_demo-proof` | anyone | `peerProof` |

The operator writes only the listing and documentation rows in
`etc/app.json` (the four http rows above the derived ones). The chain app's
four rows are its manifest's own; its `$status` row is left out on a host
with no status provider. The prompt does not show a row's `filter`.

### The base URL

An overlay app's BRC-23 base URL is `https://<handle>.<host>/<app>`: the
host's name is the skein's, one subdomain per handle. On a host without
wildcard DNS (local dev) the router also serves `/@<handle>/<app>` on its
origin. Here: `http://ov1.localhost:8100/overlay`, or
`http://127.0.0.1:8100/@ov1/overlay`. `/ov1/overlay/…` is not a route (404).

### Confirming it is live

The listing and documentation routes are answered by the topic manager's
and lookup service's own programs (fn `metadata`, fn `documentation`):

```
curl http://127.0.0.1:8100/@ov1/overlay/listTopicManagers
{"tm_demo":{"name":"tm_demo","shortDescription":"Example tokens: outputs starting <\"tm_demo\"> OP_DROP with at least 1 satoshi."}}
curl http://127.0.0.1:8100/@ov1/overlay/listLookupServiceProviders
{"ls_demo":{"name":"ls_demo","shortDescription":"Example index of tm_demo tokens: by topic, by script hash, or by outpoint."}}
curl 'http://127.0.0.1:8100/@ov1/overlay/getDocumentationForTopicManager?manager=tm_demo'
# tm_demo
…                                                         (text/markdown)
```

### Submit and look up

BRC-22: the BEEF as the body, the topics in `X-Topics`. Two mined tokens
(each BEEF carries its BUMP; their headers are in the chain state), the
second spending the first:

```
curl -X POST http://127.0.0.1:8100/@ov1/overlay/submit \
  -H 'content-type: application/octet-stream' -H 'X-Topics: tm_demo' --data-binary @token2.beef
{"tm_demo":{"outputsToAdmit":[0],"coinsToRetain":[],"coinsRemoved":[]}}
curl -X POST http://127.0.0.1:8100/@ov1/overlay/submit \
  -H 'content-type: application/octet-stream' -H 'X-Topics: tm_demo' --data-binary @token3.beef
{"tm_demo":{"outputsToAdmit":[0],"coinsToRetain":[0],"coinsRemoved":[]}}
```

The chain app answered `proven` from each BEEF and the overlay admitted
each on that answer. BRC-24, for the second:

```
curl -X POST http://127.0.0.1:8100/@ov1/overlay/lookup -H 'content-type: application/json' \
  -d '{"service":"ls_demo","query":{"txid":"c8e366e9…088e","outputIndex":0,"topic":"tm_demo"}}'
{"type":"output-list","outputs":[{"beef":[1,1,1,1,142,8,175,12,…],"outputIndex":0}]}
```

`ls_demo`'s queries are `{topic}`, `{scriptHash, topic?}` and `{txid,
outputIndex, topic}`, each with `includeSpent` (skein-overlay
docs/OVERLAY.md, "The lookup contract"). Each `beef` is built from the
chain app's records: a query that lists an output whose transaction's
parents the chain app does not hold fails as a whole (400 `lookup:
MissingAncestor`): here, a query that lists the first token, whose parent
was never submitted.

On a host with no broadcaster, an unproven transaction is recorded by the
chain app and not broadcast (`broadcast: this host has no Arcade
(SKEIN_ARC_URL): dropped` in the host's log); the submission stays pending
and the client gets the host's 503 at `SKEIN_ANSWER_WAIT_MS` (two minutes by
default):

```
HTTP/1.1 503 Service Unavailable
retry-after: 5
{"status":"error","code":"ERR_UNAVAILABLE","description":"not answered yet (its thread is waiting): try again"}
```

It is admitted at its proof, when the chain app gets one
(`kernel-zig/equiv/overlay.ts` feeds the proof to the chain app directly).

### Running it on a host

`tm_demo` is a test fixture, not a token: on a host it is for exercising
the wire — submit, lookup and the gossip between hosts — without on-chain
tokens, on test hosts stood up for that (two local hosts do), not on a
production skein. A real token's topic is `tm_<tokenId>`, from a topic
manager that judges that token (shruggr/skein-mandala, #120).

The same against host.skein.nexus, where instances are
`https://<handle>.skein.nexus` and the host has its headers feed and
Arcade. Install the chain app and the overlay into your instance from its
management page (`https://<handle>.skein.nexus/`: an app by repository URL
and commit id), or from any machine with your wallet:

```
bin/skein plan install https://github.com/shruggr/skein-chain#a4c91a4654ce8560ec7803c2254c7be1c55d5173 --origin https://<handle>.skein.nexus --out chain
bin/skein send https://<handle>.skein.nexus chain
bin/skein plan install https://github.com/shruggr/skein-overlay#f71692b95bc6e88161789b5e5b2f5259a465d1c6 --origin https://<handle>.skein.nexus --out overlay
bin/skein send https://<handle>.skein.nexus overlay
```

Then, from anywhere:

```
curl https://<handle>.skein.nexus/overlay/listTopicManagers
curl https://<handle>.skein.nexus/overlay/listLookupServiceProviders
curl -X POST https://<handle>.skein.nexus/overlay/submit \
  -H 'content-type: application/octet-stream' -H 'X-Topics: tm_demo' --data-binary @token.beef
curl -X POST https://<handle>.skein.nexus/overlay/lookup -H 'content-type: application/json' \
  -d '{"service":"ls_demo","query":{"txid":"<the token txid>","outputIndex":0,"topic":"tm_demo"}}'
```

`token.beef` is the BEEF of a mainnet transaction with a `tm_demo` output
(the locking script starting with the push `"tm_demo"` and `OP_DROP`, at
least one satoshi). With Arcade on the host an unproven one is broadcast by
the chain app and admitted on Arcade's first accepted status.
