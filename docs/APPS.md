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
subscribes to the administrative boxes (`objects`, `head`, `subscribe`,
`routes`).

## 1. An app is a tree under its own head

An app ships as a tree — a directory, a git repository, a packet:

```
bin/<name>.wasm          the program (a WASI preview1 module or a WASI 0.2 component)
bin/<name>.cid           or: the CID of a module the instance already has (a pinned stock module)
etc/app.json             the manifest (§2)
www/, …                  whatever it serves or needs
```

At install (§3) the app's head — named after the app, `overlay`, `amm`,
… — is advanced to the **app record**: the manifest as installed, linking
that tree (§2). The app's handler is the only writer of its head and keeps
its state and configuration there: records it puts and keeps, maps it
maintains, its configuration (§2, §6). Its own state is the app record's
`state` link: the handler advances the head to the same record with `state`
replaced (the SDK's `app.Call.setState` / `app.putState`), and an install of
a new version keeps it. The shell sees the `main` head's tree and nothing
else: app heads are outside its file system. (Built, #72.)

**Reads cross heads; writes do not.** Any program can read any head
(`head(name)` then walk the tree; `get` any CID another program handed it).
Heads decide who may advance a root and where an app's things are found;
they do not fence reads. Data meant to be private is encrypted. (Built:
heads, `head`/`advance`/`get` — docs/VM.md "Heads".)

## 2. The manifest — `etc/app.json`

dag-json. At install it becomes the head's root record (`kind: "app"`), so
"what does this head provide" is one read. (Built, #72: the checks are
src/host/manifest.ts, the record is written by src/host/install.ts.)

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
| `programs` | the app's programs by role name, relative to the tree (`bin/*.wasm`, or `bin/*.cid` for a pinned stock module such as the overlay engine; `bin/<x>.json` beside it gives the program record's `{inputs, services, description}`), or a bare name: a program the instance already has by that name in its genesis (the workbench's `"shell": "shell"`); `routes[].program` and `config` refer to these names |
| `handler` | which program handles the app's box (§4): a `programs` role name, or a map `{<box>: <role>}` when the app handles several boxes with different programs (the workbench: `run`, `objects`, `head`, `subscribe`, `chat`) |
| `config` | per-program configuration the programs read from the manifest at the head's root (the overlay engine reads `config.overlay`: its topics and lookup services, §6; the app's own program reads `config.<name>`). Replaces genesis `defaults` for apps. Changing it is a new manifest and a head advance (owner), or a `writes: true` function the app offers (§4) |
| `provides[]` | interfaces this app implements: `interface` is `<name>/<major>`; `functions` maps each function to `writes` (true: the function may put records, move heads, emit; false: it reads only — logged like every request, but a site may call it freely, a pruner may drop its entries, and a validator flags a read-only function that writes), `args` and `answer` shapes (dag-json schema: `string`, `int`, `bytes`, `cid`, `ms`, `bool`, `map` (any map), `any`, an array `[shape]`, a nested map `{key: shape}`; a `?` suffix on a key = optional: absent or null; a key the shape does not name is refused). `writes` is required |
| `requires[]` | interfaces this app calls on others, bound by name at install (§3 step 0) |
| `boxes[]` | the boxes it asks to handle: its own name, plus any protocol boxes (`submit`, `chain`). An entry is a name, or `{box, senders: [...]}` naming who may send into it: `"*"` (anyone — the app's public face), a provider name (`$cron`, `$status`, `$waker`: resolved through the address book), or an identity key. The install handler derives one `subscribe` per sender (`"*"`: no sender; `$owner`: the genesis owner); a bare name means the owner only. The site shows every sender. (#76, built) |
| `start` | optional: a message the owner sends into the app's box as the **fourth install message**, after `subscribe`, so a program whose first act is to schedule something (a heartbeat tick from `$cron`) actually runs; nothing else starts an app. Sending it again is the restart after a reconfiguration (a new manifest + head advance): an install over an installed version sends it again. It needs the owner admitted to the app's box (`"$owner"` or `"*"` among its senders). (#76, built) |
| `stop` | optional: a message the owner sends into the app's box at uninstall, before its subscriptions are removed, so the app can cancel what it scheduled. (#76, built) |
| `routes[]` | the routes it asks for, in the routes-table shape (docs/MESSAGES.md "Routes": `path | prefix`, `program` (a `programs` role), `fn`, `auth?`, `read?`, handler-specific settings); libp2p topics and stream protocols are routes too (`libp2p:<topic>`, `libp2p:<protocol>`) — not installable yet: the host's libp2p node subscribes only the topics and protocols its instance's genesis declares, so `skein-host install` refuses them (a question on #72). The install adds `app: <name>` to each route it writes |
| `heads[]` | the heads it will own: its own name (always, listed or not), and patterns for heads it creates (`ls:*` for lookup services); the instance's own `peers`, `sessions`, `routes` are refused, and a head another installed app lists is refused; `main` is allowed and shown as the shell's |

**Routes are namespaced under `/<app>/`, enforced.** Every route an app
asks for lives under its own prefix: the AMM's routes are `/amm/submit`,
`/amm/lookup`, `/amm/…`; `routes[].path` in the manifest is relative to
that prefix (a leading `/` too: `"/submit"` is `/amm/submit`, `"/"` is
`/amm/`) and the install handler refuses anything else — a `.` or `..`
segment, an encoded dot or slash (`%2e`, `%2f`), a backslash, a NUL, a
query, a URL. No top-level
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

**The app record** — the head's root, written by the install (built):

```
{kind: "app", name, version,
 programs: {<role>: <program record CID>},       the manifest's paths resolved
 handler?, config?, provides, requires,
 boxes: [{box, senders}],                         normalised: a bare name → {box, senders: ["$owner"]}
 start?, stop?, routes (as the manifest wrote them, relative), heads (the app's own first),
 description?,
 tree: <the app's git tree CID>,                  etc/app.json as shipped, bin/, www/, …
 state?: <the app's own state record>}            the handler's (§1); kept across installs
```

So "list heads, read their manifests" is one read per head: `head(name)`,
`get` — a root of `kind: "app"` is an installed app. The tree is still there
for what the app serves or reads (`tree`).

The same `provides` contract is what a WASI 0.2 component's WIT gives the
compiler; the manifest is the graph's copy of it, so a head is defined by
what it provides and one app can replace another behind the same
interface. (Spec.)

## 3. Install: owner messages to the stock boxes

Each is an existing box with its existing body (built since #54; the boxes
are the stock handlers), plus the box `routes` (the front door, #72). A
management site is the permission prompt: it reads the manifest, shows what
the app asks for, and has the owner's wallet sign the messages — one click
sends them all; steps are fine. The reference client is `skein-host install
<repo-url[#rev] | dir> --instance <handle>` (src/host/install.ts; built,
#72/#76; docs/BOOTSTRAP.md "Installing an app").

0. **Check.** The manifest (§2). Every `requires` interface is provided by
   some installed app (each head's root record, `kind: "app"`, its
   `provides`). No route takes a path or prefix the genesis's routes or
   another app's have; no head is another app's. Every `$<provider>` sender
   is in the instance's address book (role = the name). Then the prompt:
   heads, boxes with their handlers and senders, routes under `/<app>/`,
   `start`/`stop`, `requires`/`provides`, what an overlay publishes (for
   information), and the messages to be sent. Nothing is sent unless the
   owner approves (`--approve-all`, or "y" at a terminal).
1. **`objects`** — the records. Body (dag-cbor, ≤ 1 MiB per message):
   ```
   {records: [{cid, bytes}]}
   ```
   The tree's git objects (blobs, then trees, the root last), the modules
   its `bin/*.wasm` carry (raw), a program record per program
   (`{kind: "program", name, code: {wasm: <module>}, inputs, services,
   description}`, as a boot writes them), and the app record (§2) last.
   Records the instance has are not sent. No bundle names a `root`: an app
   never becomes `main`. (objects-handler.)
2. **`head`** — `{name: "<app name>", tree: <the app record's CID>}`. The
   head's root is the app record, which links the tree. (head-handler.)
3. **`subscribe`** — one per (box, sender) the manifest asks for:
   `{op: "add", sender?: <key>, box, handler: <the box's role's program
   record>}`; `"*"` is no sender (anyone), `$owner` the owner, `$<provider>`
   the key the address book gives that role. (subscribe-handler.) Before
   them, if the app asks for routes and the instance has no owner's
   `routes` box (an instance from before #72), `{op: "add", sender: <owner>,
   box: "routes", handler: <the genesis's frontdoor>}`.
   **`routes`** — one per route: `{op: "add", route: {path | prefix:
   "/<app>/…", program: <program record CID>, fn, auth?, read?, …the
   handler's settings, app: "<app name>"}}`. The front door keeps the
   installed routes as the head `routes` and routes every request by the
   genesis's routes, then these (docs/MESSAGES.md "Routes"). (Built, #72.)
4. **`start`** (if the manifest has one) — the owner sends the declared body
   into the app's box. The app's handler runs its first step: scheduling
   ticks with `$cron`, announcing itself, whatever it declared. (Built, #76.)

Who can install is who the subscription table admits to `objects`, `head`,
`subscribe` and `routes`: the owner, by the stock genesis. An untrusted app
cannot tie itself to anything — the worst it can do is ask.

**Reconfiguration** is the same messages again. Installing an app that is
installed (its head's root is an app record) is the upgrade: the new app
record keeps `state`; subscriptions and routes the old record had and the
new one does not are removed (removes first), those it has already are not
sent again; `start` is sent again (the restart). Change or revoke a single
subscription with `skein-host subscribe`. All in the log. Deploy-by-message
with a payment (#11) is the same `objects` message with a toll.

**Uninstall** (`skein-host uninstall <app> --instance <handle>`, built):
the `stop` message if declared, into the app's box while its
subscriptions still stand; then a `subscribe` remove for each (box, sender)
and a `routes` remove for each of its routes. The head is left (prunable),
its app record and state with it.

## 4. Calling an app: one box, the function in the body

One box per app, named after it. The body names the function, dotted
`<interface-name>.<function>` (the interface without its `/<major>`), with
its arguments:

```
box:  amm
body: {fn: "amm.pool.quote", args: {token: "1", in: 1000}}
```

The handler dispatches on `fn`, checks `args` against the manifest's shape,
and answers with a message to the sender, in the same box:

```
{fn: "amm.pool.quote", request: <the request message's CID>, replyTo: <the same CID>, result: {…}}
{fn: "amm.pool.quote", request: <cid>, replyTo: <cid>, error: {code, message}}
```

`replyTo` makes the answer a reply: a program that emitted the call and
awaits the message is stepped with it (docs/MESSAGES.md "Awaiting the
answer"). The answer goes out only when the address book reaches the
sender (an `emit` needs a route); either way it is the step's result in
the log. Error codes: `bad-request` (no `fn`, not `{fn, args}`),
`unknown-fn` (not in `provides`, or not implemented), `bad-args`,
`read-only` (below), `failed` (the function's own error), and on the
route `not-admitted`. A body without `fn` is not a call: the app handles it
itself (a `start`, a tick).

The same function is reachable three ways with one definition:

- **A message** to the box, as above (any transport the sender has: a
  peer's mailbox, libp2p, a local provider). Asynchronous: the answer is a
  message. Who may send is the subscription table (the manifest's senders).
- **An HTTP route** `{"path": "/call", "program": <role>, "fn": "call"}` on
  the app (served at `/<app>/call`): the request body is `{fn, args}`
  (JSON, or dag-cbor as `application/cbor`), POST; the route handler turns
  it into the same call, and the client gets `{fn, result}` (200) or
  `{fn, error}` (400 `bad-request`/`bad-args`, 403 `not-admitted`, 404
  `unknown-fn`, 409 `read-only`, 500 `failed`) on the connection, signed on
  the session, when the request's thread finishes (docs/MESSAGES.md "Route
  handlers", "A synchronous client waits on the thread"). Synchronous. The
  caller (the BRC-104 session's key) must be admitted to the app's box as
  a message from it would be: a subscription on (caller, `<app>`) or on
  (anyone, `<app>`); an open route (`auth: "none"`) has no caller, so only
  a box open to anyone admits it.
- **In-VM**: another program calls `call(<app program>, "<interface>.<function>", args)`
  (dag-cbor) and gets the result, or the call's error (docs/VM.md `call`).

**The SDK's dispatch helper** (shruggr/skein-sdk ≥ 0.2.0, module `app`,
`lib/app.zig`; built, #72) is all of this: the program lists the functions
it implements (`app.Function{.name = "amm.pool.quote", .run = quote}`) and
hands every input to `app.serve(a, in, "<app>", &fns, other)`; the
manifest is read from the app's head. A function gets an `app.Call`: its
`args` (checked), `sender`, the app record, and the writes — `put`,
`putBlock`, `keep`, `advance`, `setState`, `emit`/`send`, `launch`,
`subscribe`, `deadline`, `awaitRecord`.

**`writes: false`** functions answer from the app's head as it stands;
their request is still an entry (§2). Each write through the `Call` is
refused for them, and the call answers `read-only` ("<fn> is writes:
false, and it called put"). A function that calls the raw imports itself
goes around the helper; the log shows what it did. A `writes: true`
function that fails is answered with its error, and what it wrote before
failing stands: check first, write last.

## 5. Security model, in one place

- **Only signed messages change anything.** Every package is appended and
  verified inside (docs/MESSAGES.md): a message routes only where the
  subscription table says its sender may go.
- **The owner is the only writer** of `objects`, `head`, `subscribe` and
  `routes` (stock genesis). Granting another identity the right to install or
  reconfigure is a `subscribe` by the owner — explicit, logged.
- **An app's head is written only by its handler**, on messages to its box
  from senders the owner admitted (and by the owner's install, through
  `head`). Two apps cannot write each other's
  heads; they read each other's freely.
- **The shell cannot reach app heads.** A shell tool that needs an app's
  data asks the app (a call), or a later shell feature mounts heads as
  directories — a shell concern, not an app's.
- **A manifest is a request.** Boxes, routes and heads are granted by the
  owner at install; routes are confined to `/<app>/`; a function marked
  `writes: false` that writes through the SDK's helper is refused
  (`read-only`, §4) and, written around it, a bug the log shows.
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
| manifest schema (`programs`, `handler`, `config`, `provides`/`requires`, `boxes`, `routes`, `heads`); the head's root record (the app record); `requires` check; `writes` validation | built (#72: src/host/manifest.ts, install.ts; the SDK's `app`) |
| install handler (manifest → objects + head + subscribe + routes + start, approvals); `skein-host install <repo|dir>` / `uninstall`; the `routes` box; `start`/`stop`, box senders | built (#72, #76) — libp2p routes not installable yet |
| one box per app, `{fn, args}` dispatch, answer message; SDK dispatch helper; the `/call` route | built (#72: skein-sdk v0.2.0 `app`) |
| the overlay engine reads `config.overlay` from its app's manifest (replacing genesis `overlayTopics`/`overlayLookups`) | spec (#72 build 3) |
| a multi-tenant overlay's `overlay.topics/1` / `overlay.lookups/1` | optional, not planned |
| apps in their own repos; the SDK as a Zig package | built (#71, #75): shruggr/skein-sdk (a sibling repo, consumed by URL+hash, not a submodule), shruggr/skein-workbench, shruggr/skein-static, shruggr/skein-overlay (the engine and its demo topic/lookup, with `etc/app.json`; equiv/overlay.ts clones it) |
