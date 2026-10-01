# Apps: install, configuration, interfaces

The specification for applications on a skein instance (issue #72, decided
2026-10-01). Status of each part is marked **built** or **spec** (to be
implemented — issue #72's build list). Authors of apps, topic managers,
lookup services and management UIs build against this document; the
contracts that are already built are cited where they live.

Vocabulary: an **instance** is one skein (its log, heads, store); a
**head** is a named root (`main` is the shell's file system; an app owns
one of its own); a **box** is a message destination inside the instance,
routed by the subscription table; the **owner** is the identity the genesis
subscribes to the administrative boxes (`objects`, `head`, `subscribe`).

## 1. An app is a tree under its own head

An app ships as a tree — a directory, a git repository, a packet:

```
bin/<name>.wasm          the program (a WASI preview1 module or a WASI 0.2 component)
bin/<name>.cid           or: the CID of a module the instance already has (a pinned stock module)
etc/app.json             the manifest (§2)
www/, …                  whatever it serves or needs
```

At install (§3) the app's head — named after the app, `overlay`, `amm`,
… — is advanced to that tree. The app's handler is the only writer of its
head and keeps its state and configuration there: records it puts and
keeps, maps it maintains, its configuration (§2, §6). The shell sees the `main` head's
tree and nothing else: app heads are outside its file system.

**Reads cross heads; writes do not.** Any program can read any head
(`head(name)` then walk the tree; `get` any CID another program handed it).
Heads decide who may advance a root and where an app's things are found;
they do not fence reads. Data meant to be private is encrypted. (Built:
heads, `head`/`advance`/`get` — docs/VM.md "Heads".)

## 2. The manifest — `etc/app.json`

dag-json. At install it becomes the head's root record (`kind: "app"`), so
"what does this head provide" is one read.

```json
{
  "kind": "app",
  "name": "amm",
  "version": "0.3.0",
  "programs": {
    "overlay":   "bin/overlay.cid",
    "topic":     "bin/amm-topic.wasm",
    "lookup":    "bin/amm-lookup.wasm",
    "p2p":       "bin/amm-p2p.wasm",
    "validator": "bin/amm-validator.wasm"
  },
  "handler": "validator",
  "config": {
    "overlay": {
      "topics":  {"tm_amm_1": "topic"},
      "lookups": {"ls_amm_1": {"program": "lookup", "topics": ["tm_amm_1"]}},
      "status":  "$status",
      "gossip":  {"tm_amm_1": true}
    },
    "amm": {"feeBps": 30, "tokens": ["1"]}
  },
  "provides": [
    {
      "interface": "amm.pool/1",
      "functions": {
        "quote":  {"writes": false, "args": {"token": "string", "in": "int"},  "answer": {"out": "int", "fee": "int"}},
        "config": {"writes": true,  "args": {"feeBps?": "int", "tokens?": ["string"]}, "answer": {"feeBps": "int", "tokens": ["string"]}}
      }
    }
  ],
  "requires": ["wallet.records/1"],
  "boxes": [{"box": "amm", "senders": ["*", "$cron"]}, "submit", "chain"],
  "start": {"body": {"kind": "amm-p2p-start"}},
  "stop":  {"body": {"kind": "amm-p2p-stop"}},
  "routes": [
    {"path": "/submit", "program": "overlay", "fn": "submit", "auth": "none"},   // served at /amm/submit
    {"path": "/lookup", "program": "overlay", "fn": "lookup", "auth": "none"},   // served at /amm/lookup
    {"path": "libp2p:amm-proofs", "program": "p2p", "fn": "proof"},
    {"path": "libp2p:/amm-validator/1/swap", "program": "validator", "fn": "swap"}
  ],
  "heads": ["amm", "ls:ls_amm_1"],
  "description": "An AMM: its own overlay (one topic manager, one lookup service), a validator, and a market UI."
}
```

| field | meaning |
|---|---|
| `name` | the app's name: its box (§4) and its head |
| `version` | semver; shown by the site, compared by `requires` |
| `programs` | the app's programs by role name, relative to the tree (`bin/*.wasm`, or `bin/*.cid` for a pinned stock module such as the overlay engine); `routes[].program` and `config` refer to these names |
| `handler` | which program handles the app's box (§4): a `programs` role name, or a map `{<box>: <role>}` when the app handles several boxes with different programs (the workbench: `run`, `objects`, `head`, `subscribe`, `chat`) |
| `config` | per-program configuration the programs read from the manifest at the head's root (the overlay engine reads `config.overlay`: its topics and lookup services, §6; the app's own program reads `config.<name>`). Replaces genesis `defaults` for apps. Changing it is a new manifest and a head advance (owner), or a `writes: true` function the app offers (§4) |
| `provides[]` | interfaces this app implements: `interface` is `<name>/<major>`; `functions` maps each function to `writes` (true: the function may put records, move heads, emit; false: it reads only — logged like every request, but a site may call it freely, a pruner may drop its entries, and a validator flags a read-only function that writes), `args` and `answer` shapes (dag-json schema: `string`, `int`, `bytes`, `cid`, `ms`, `bool`, arrays, maps; `?` suffix = optional) |
| `requires[]` | interfaces this app calls on others, bound by name at install (§3 step 0) |
| `boxes[]` | the boxes it asks to handle: its own name, plus any protocol boxes (`submit`, `chain`). An entry is a name, or `{box, senders: [...]}` naming who may send into it: `"*"` (anyone — the app's public face), a provider name (`$cron`, `$status`, `$waker`: resolved through the address book), or an identity key. The install handler derives one `subscribe` per sender; a bare name means the owner only. The site shows every sender. (#76) |
| `start` | optional: a message the owner sends into the app's box as the **fourth install message**, after `subscribe`, so a program whose first act is to schedule something (a heartbeat tick from `$cron`) actually runs; nothing else starts an app. Sending it again is the restart after a reconfiguration (a new manifest + head advance). (#76) |
| `stop` | optional: a message the owner sends into the app's box at uninstall, before its subscriptions are removed, so the app can cancel what it scheduled. (#76) |
| `routes[]` | the routes it asks for, in the routes-table shape (docs/MESSAGES.md "Routes": `path | prefix`, `program` (a `programs` role), `fn`, `auth?`, `read?`, handler-specific settings); libp2p topics and stream protocols are routes too (`libp2p:<topic>`, `libp2p:<protocol>`) |
| `heads[]` | the heads it will own: its own name, and patterns for heads it creates (`ls:*` for lookup services) |

**Routes are namespaced under `/<app>/`, enforced.** Every route an app
asks for lives under its own prefix: the AMM's routes are `/amm/submit`,
`/amm/lookup`, `/amm/…`; `routes[].path` in the manifest is relative to
that prefix and the install handler refuses anything else. No top-level
grants exist for apps. The protocol endpoints are unaffected: BRC-22's
`/submit` and BRC-24's `/lookup` are relative to the overlay's **base
URL**, which BRC-23's advertisement carries (a host base URL, not a bare
domain), so an overlay app advertises `https://<host>/<handle>/amm` and the
stock clients call `${baseUrl}/submit`. The root belongs to skein's
boundary programs (the messagebox routes, the BRC-103 well-known path),
which are not apps. libp2p topic names are global by nature and are not
namespaced. Boxes follow the same rule: an app's box is its name; the
protocol boxes it handles (`submit`, `chain`) are explicit requests.

**The app declares; it never installs.** Everything in `boxes`, `routes`
and `heads` is a request the owner approves (§3). A manifest asking for a
box, route or head the owner did not approve is refused at install.

The same `provides` contract is what a WASI 0.2 component's WIT gives the
compiler; the manifest is the graph's copy of it, so a head is defined by
what it provides and one app can replace another behind the same
interface. (Spec.)

## 3. Install: three owner messages, plus a start

Nothing else. (A manifest with `start` adds a fourth: the start message into
the app's box, sent last — #76.) Each is an existing box with its existing body (built since
#54; the boxes are the stock handlers). A management site is the permission
prompt: it reads the manifest, shows what the app asks for, and has the
owner's wallet sign the messages — one click sends all three; steps are
fine.

0. **Check** (site or `skein-host install`, spec): every `requires`
   interface is provided by some installed head (read each head's root
   record); every box/route/head requested is on the owner's approval.
1. **`objects`** — the records. Body (dag-cbor, ≤ 1 MiB per message; the
   client chunks larger sets, the last one names the root):
   ```
   {records: [{cid, bytes}], root?: <tree CID>}
   ```
   Each record is stored under its CID (git-raw/sha1 trees and blobs, raw
   or dag-cbor/sha2-256). `root` here is the app tree's root (it makes the
   `main` head only if the instance has none yet — an app never replaces
   `main`). (Built: objects-handler.)
2. **`head`** — the advance. Body `{name: "<app name>", tree: <tree CID>}`.
   The handler advances the app's head to the tree; the tree must be in the
   store. The manifest at `etc/app.json` becomes the head's root record
   (spec: today the head is the tree; the install handler adds the record).
   (Built: head-handler.)
3. **`subscribe`** — one per box the manifest asked for, and the routes.
   Body `{op: "add" | "remove", sender?: <key>, box, handler: <program record CID>}`;
   no `sender` = any sender. The owner scopes each: any sender, or only
   these senders. Routes are written the same way into the routes table
   (spec: a `routes` op, or the routes table as a record under the front
   door's head — build decides, same shape as `etc/routes.json`).
   (Built: subscribe-handler.)

Who can install is who the subscription table admits to `objects`, `head`
and `subscribe`: the owner, by the stock genesis. An untrusted app cannot
tie itself to anything — the worst it can do is ask. Reconfiguration is
the same messages again (change or revoke a subscription, advance the head
to a new version, swap the app behind an interface), all in the log.
Deploy-by-message with a payment (#11) is the same `objects` message with a
toll.

4. **`start`** (if the manifest has one) — the owner sends the declared body
   into the app's box. The app's handler runs its first step: scheduling
   ticks with `$cron`, announcing itself, whatever it declared. (Spec, #76.)

Uninstall: the `stop` message if declared, then `subscribe` remove for each
box; the head is left (prunable) or advanced to an empty tree.

## 4. Calling an app: one box, the function in the body

One box per app, named after it. The body names the function, dotted
`<interface-name>.<function>`, with its arguments:

```
box:  overlay
body: {fn: "overlay.topics.add", args: {topic: "tm_amm", program: <cid>}}
```

The handler dispatches on `fn`, checks `args` against the manifest, and
answers with a message to the sender's box:

```
{fn: "overlay.topics.add", request: <the request message's CID>, result: {…}}
{fn: "overlay.topics.add", request: <cid>, error: {code, message}}
```

The same function is reachable three ways with one definition:

- **A message** to the box, as above (any transport the sender has: a
  peer's mailbox, libp2p, a local provider). Asynchronous: the answer is a
  message.
- **An HTTP route** `{"path": "/overlay", "fn": "call"}` on the app: the
  request body is `{fn, args}`; the route handler turns it into the same
  call and the client gets the answer on the connection, signed on the
  session, when the request's thread finishes (docs/MESSAGES.md "Route
  handlers", "A synchronous client waits on the thread"). Synchronous.
- **In-VM**: another program calls `call(<app program>, "<function>", args)`
  with the same shapes (docs/VM.md `call`). The SDK's dispatch helper
  (spec, the SDK's `lib/`, shruggr/skein-sdk) maps `fn` to the exported function.

`writes: false` functions answer from the app's head as it stands; their
request is still an entry (§2).

## 5. Security model, in one place

- **Only signed messages change anything.** Every package is appended and
  verified inside (docs/MESSAGES.md): a message routes only where the
  subscription table says its sender may go.
- **The owner is the only writer** of `objects`, `head` and `subscribe`
  (stock genesis). Granting another identity the right to install or
  reconfigure is a `subscribe` by the owner — explicit, logged.
- **An app's head is written only by its handler**, on messages to its box
  from senders the owner admitted. Two apps cannot write each other's
  heads; they read each other's freely.
- **The shell cannot reach app heads.** A shell tool that needs an app's
  data asks the app (a call), or a later shell feature mounts heads as
  directories — a shell concern, not an app's.
- **A manifest is a request.** Boxes, routes and heads are granted by the
  owner at install; a function marked `writes: false` that writes is a
  validator error (spec) and, in a step, a bug the log shows.
- **Private data is encrypted data.** Nothing in the store is unreadable
  to a program that can name its CID.

## 6. Worked example: an overlay is an app

An overlay (BRC-22: topic managers and lookup services; docs/OVERLAY.md) is
not a service other apps register with. **It is an app**: the overlay
engine (shruggr/skein-overlay's `bin/overlay.wasm`, or `bin/overlay.cid`
when the instance already holds that module) plus the app's own topic
managers and lookup services, in one tree under one head, with
`config.overlay` naming which topics and services it runs:

```json
"programs": {"overlay": "bin/overlay.cid", "topic": "bin/amm-topic.wasm", "lookup": "bin/amm-lookup.wasm"},
"config":   {"overlay": {"topics": {"tm_amm_1": "topic"},
                         "lookups": {"ls_amm_1": {"program": "lookup", "topics": ["tm_amm_1"]}}}}
```

The engine reads that from the manifest at its head's root (spec: today it
reads the genesis defaults `overlayTopics`/`overlayLookups`; #72 moves it to
the manifest). Install is the three messages (§3); nothing registers with
anything.

**The wiring is derived from `config.overlay`, and shown.** For every
overlay topic the app runs, the install handler expands the config into the
concrete requests the owner approves (spec):

- inbound routes `libp2p:<topic>` (raw submissions), `libp2p:<topic>-admit`,
  `libp2p:<topic>-proof` (#74), plus `/<app>/submit` and `/<app>/lookup`
  (the app's base URL is what it advertises);
- boxes `submit` and `chain`;
- a subscription of `$status` (or the remote status provider's key) to the
  overlay's `status` box if `config.overlay.status` names one — the same
  box-sender rule as `boxes[].senders` (#76); none = admit at the proof (#73);
- heads `ls:<service>` for each lookup service.

The site shows that list as the permission prompt, next to the manifest's
own `boxes`/`routes`/`heads`. What the app **publishes** (`<topic>`,
`<topic>-admit`, `<topic>-proof`, on by default, `config.overlay.gossip`
per topic to turn off) needs no grant: emitting is the app acting as the
instance, like any message it sends; the site lists it for information.
The message shapes and the receiving rules are docs/OVERLAY.md "Gossip"
(built, #74): `<topic>` carries the BEEF as received; `<topic>-admit`
`{txid, topics: {<topic>: {outputsToAdmit, coinsToRetain}}}` (no BEEF;
received → fn `peerAdmit`, recorded as `peer-admit` records under the head
`overlay:gossip`, never admitting); `<topic>-proof` `{txid, blockHash,
blockHeight, bump}` (received → fn `peerProof`, checked against the
instance's own chain and admitted as the `chain` proof event, else
`ignore`). Today `config.overlay.gossip` is genesis
`defaults.overlayGossip` (`{"<topic>": false}`), the same mapping.
Explicit `routes[]` entries in the manifest override the derived ones. The AMM app ships exactly this: the engine, `amm-topic`,
`amm-lookup`, its validator and p2p programs, and its UI, one tree.

**Several overlays on one instance coexist**: two heads, two apps, each
with its own boxes and routes (`/submit` on one, `/amm/submit` on another,
or two instances). They share the wallet's transaction records through the
wallet library, as the engine does today; lookup state stays under each
service's own head `ls:<service>` (§1).

**The topic and lookup program contracts are unchanged and built**:
`identify` for a topic manager; `admitted`/`spent`/`rejected`/`lookup` for a
service (docs/OVERLAY.md). Authors of topic managers and lookup services
build those now, and ship them inside their own overlay app.

**The engine's repo is itself an overlay app**:
[shruggr/skein-overlay](https://github.com/shruggr/skein-overlay) (#71)
ships the engine with its example topic manager and lookup service, and its
`etc/app.json` is this section's wiring written out for `tm_demo`/`ls_demo`:

```json
"programs": {"overlay": "bin/overlay.wasm", "topic-demo": "bin/topic-demo.wasm", "lookup-demo": "bin/lookup-demo.wasm"},
"handler":  "overlay",
"config":   {"overlay": {"topics": {"tm_demo": "topic-demo"},
                         "lookups": {"ls_demo": {"program": "lookup-demo", "topics": ["tm_demo"]}},
                         "status": "$status", "gossip": {"tm_demo": true}}},
"boxes":    [{"box": "submit", "senders": ["*"]}, "chain", {"box": "status", "senders": ["$status"]}],
"routes":   [{"path": "/submit", "program": "overlay", "fn": "submit", "auth": "none"},
             {"path": "/lookup", "program": "overlay", "fn": "lookup", "auth": "none"},
             {"path": "libp2p:tm_demo", "program": "overlay", "fn": "submit"},
             {"path": "libp2p:tm_demo-admit", "program": "overlay", "fn": "peerAdmit"},
             {"path": "libp2p:tm_demo-proof", "program": "overlay", "fn": "peerProof"}],
"heads":    ["overlay", "overlay:gossip", "ls:*"]
```

An overlay app of your own takes the engine's module from there and ships
it beside its own topic managers and lookup services.

**A multi-tenant overlay is a choice, not core.** An overlay app that wants
to accept topic managers from outside may offer `overlay.topics/1`
(`add`/`remove`/`list`, `writes` as expected) and `overlay.lookups/1` on its
box and keep a registry under its head; the engine would consult both the
manifest and the registry. Nothing requires it, and the stock overlay app
does not offer it.

## 7. What is built, what is spec

| part | status |
|---|---|
| heads; `head`/`advance`/`get`; objects, head, subscribe boxes and bodies | built |
| routes table shape; route handler contract; synchronous answer on thread completion | built (#68/#66) |
| topic contract (`identify`); lookup contract (hooks + `lookup`); lookup state under `ls:<service>` | built (#50) |
| manifest schema (`programs`, `handler`, `config`, `provides`/`requires`, `boxes`, `routes`, `heads`); the head's root record; `requires` check; `writes` validation | spec (#72 build 1–2) |
| install handler (manifest → objects + head + subscribe, approvals); `skein-host install <repo|dir>` | spec (#72 build 1, 4) |
| one box per app, `{fn, args}` dispatch, answer message; SDK dispatch helper; the `/call` route | spec (#72 build 2) |
| the overlay engine reads `config.overlay` from its app's manifest (replacing genesis `overlayTopics`/`overlayLookups`) | spec (#72 build 3) |
| a multi-tenant overlay's `overlay.topics/1` / `overlay.lookups/1` | optional, not planned |
| apps in their own repos; the SDK as a Zig package | built (#71, #75): shruggr/skein-sdk (a sibling repo, consumed by URL+hash, not a submodule), shruggr/skein-workbench, shruggr/skein-static, shruggr/skein-overlay (the engine and its demo topic/lookup, with `etc/app.json`; equiv/overlay.ts clones it) |
