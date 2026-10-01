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
keeps, maps it maintains, a registry (§6). The shell sees the `main` head's
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
  "name": "overlay",
  "version": "1.2.0",
  "program": "bin/overlay.wasm",
  "provides": [
    {
      "interface": "overlay.topics/1",
      "functions": {
        "add":    {"writes": true,  "args": {"topic": "string", "program": "cid"},          "answer": {"topic": "string", "program": "cid"}},
        "remove": {"writes": true,  "args": {"topic": "string"},                            "answer": {"topic": "string"}},
        "list":   {"writes": false, "args": {},                                             "answer": {"topics": [{"topic": "string", "program": "cid", "since": "ms"}]}}
      }
    }
  ],
  "requires": ["wallet.records/1"],
  "boxes": ["overlay", "submit", "chain"],
  "routes": [
    {"path": "/submit", "fn": "submit", "auth": "none"},
    {"path": "/lookup", "fn": "lookup", "auth": "none"}
  ],
  "heads": ["overlay", "ls:*"],
  "description": "BRC-22 overlay services: topic managers and lookup services."
}
```

| field | meaning |
|---|---|
| `name` | the app's name: its box (§4) and its head |
| `version` | semver; shown by the site, compared by `requires` |
| `program` | the handler, relative to the tree (`bin/*.wasm` or `bin/*.cid`) |
| `provides[]` | interfaces this app implements: `interface` is `<name>/<major>`; `functions` maps each function to `writes` (true: the function may put records, move heads, emit; false: it reads only — logged like every request, but a site may call it freely, a pruner may drop its entries, and a validator flags a read-only function that writes), `args` and `answer` shapes (dag-json schema: `string`, `int`, `bytes`, `cid`, `ms`, `bool`, arrays, maps; `?` suffix = optional) |
| `requires[]` | interfaces this app calls on others, bound by name at install (§3 step 0) |
| `boxes[]` | the boxes it asks to handle: its own name, plus any protocol boxes (`submit`, `chain`) |
| `routes[]` | the routes it asks for, in the routes-table shape (docs/MESSAGES.md "Routes": `path | prefix`, `fn`, `auth?`, `read?`, handler-specific settings) — `program` is implied (this app) |
| `heads[]` | the heads it will own: its own name, and patterns for heads it creates (`ls:*` for lookup services) |

**The app declares; it never installs.** Everything in `boxes`, `routes`
and `heads` is a request the owner approves (§3). A manifest asking for a
box, route or head the owner did not approve is refused at install.

The same `provides` contract is what a WASI 0.2 component's WIT gives the
compiler; the manifest is the graph's copy of it, so a head is defined by
what it provides and one app can replace another behind the same
interface. (Spec.)

## 3. Install: three owner messages

Nothing else. Each is an existing box with its existing body (built since
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

Uninstall: `subscribe` remove for each box; the head is left (prunable) or
advanced to an empty tree.

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
  (spec, `programs/lib`) maps `fn` to the exported function.

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

## 6. Worked example: the overlay app's registry

The overlay services app (BRC-22: topic managers and lookup services;
docs/OVERLAY.md) is the first app to use this model. Its registry lives
under head `overlay` and replaces the genesis defaults `overlayTopics` /
`overlayLookups` as the source of truth (the defaults become the initial
registry records at install — spec).

Interface `overlay.topics/1` (box `overlay`):

| fn | writes | args | answer |
|---|---|---|---|
| `overlay.topics.add` | yes | `{topic, program: <cid>}` — the topic manager's program record must be in the store (`objects` first) and export `identify` (docs/OVERLAY.md "The topic contract") | `{topic, program}` |
| `overlay.topics.remove` | yes | `{topic}` — existing admittances stay; the topic judges nothing new | `{topic}` |
| `overlay.topics.list` | no | `{}` | `{topics: [{topic, program, since}]}` |

Interface `overlay.lookups/1` (box `overlay`):

| fn | writes | args | answer |
|---|---|---|---|
| `overlay.lookups.add` | yes | `{service, program: <cid>, topics: [topic] | "*"}` — exports `admitted`/`spent`/`rejected`/`lookup` (docs/OVERLAY.md "The lookup contract"); its own head `ls:<service>` is created on first hook | `{service, program, topics}` |
| `overlay.lookups.remove` | yes | `{service}` — its head is left (prunable) | `{service}` |
| `overlay.lookups.list` | no | `{}` | `{lookups: [{service, program, topics, since}]}` |

Registry record under head `overlay`:
`{kind: "overlay-registry", topics: {<topic>: {program, since}}, lookups: {<service>: {program, topics, since}}}`.

Installing a topic manager from outside, end to end: `objects` with the
topic program's records (owner, or an identity the owner subscribed to
`objects`) → a message to box `overlay` `{fn: "overlay.topics.add", args:
{topic, program}}` from a sender the owner subscribed to `overlay`. The
topic and lookup **program contracts are unchanged and built**: `identify`
for a topic; the three hooks and `lookup` for a service (docs/OVERLAY.md).
Authors of topic managers and lookup services can build now.

## 7. What is built, what is spec

| part | status |
|---|---|
| heads; `head`/`advance`/`get`; objects, head, subscribe boxes and bodies | built |
| routes table shape; route handler contract; synchronous answer on thread completion | built (#68/#66) |
| topic contract (`identify`); lookup contract (hooks + `lookup`); lookup state under `ls:<service>` | built (#50) |
| manifest schema; the head's root record; `requires` check; `writes` validation | spec (#72 build 1–2) |
| install handler (manifest → objects + head + subscribe, approvals); `skein-host install <repo|dir>` | spec (#72 build 1, 4) |
| one box per app, `{fn, args}` dispatch, answer message; SDK dispatch helper; the `/call` route | spec (#72 build 2) |
| overlay registry under head `overlay`; `overlay.topics.*`, `overlay.lookups.*`; defaults → records | spec (#72 build 3) |
| apps in their own repos; the SDK as a Zig package | #71 (after #70/#67) |
