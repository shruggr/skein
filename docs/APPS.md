# Apps: install, configuration, interfaces

The specification for applications on a skein instance (issue #72, decided
2026-10-01; revised by #77, the kernel's four tables: an app's wiring is
dispatch rows, its writes are heads under its own name; and by #79: the
wallet and the overlay apps under their own names over the chain app, the
form before #77 gone; and by #83: the shell and the chat loop are apps,
shruggr/skein-shell and shruggr/skein-chat, and a genesis has no shell; and
by #91: deploy by hash, the git app cloning in the VM, §3; and by #92: the
management page, §3; and by #125: the management site an app, not in the
default image, §3). Status of each
part is marked (Built, #…) or (Spec.) in the text, and in §7's table. Authors of apps, topic managers,
lookup services and management UIs build against this document; the
contracts that are already built are cited where they live.

Vocabulary: an **instance** is one skein (its log, its four tables, its
store); the kernel's **four tables** are objects (blocks by CID), heads
(name → root, with an owner), the dispatch table and the address book
(docs/VM.md "The dispatch table"); a **head** is a named root (`main` is
the shell's file system; an app's are `<app>/…`); a **box** is a message
destination inside the instance, routed by the dispatch table; the
**owner** is the identity whose admin rows every genesis carries (the
kernel's own operations `objects`, `head`, `dispatch`, `peers`). The host
is transports + providers + store + signer; it routes nothing.

## 1. An app is a tree under its own name

An app ships as a tree — a directory, a git repository, a packet:

```
bin/<name>.wasm          the program (a WASI preview1 module or a WASI 0.2 component)
bin/<name>.cid           or: the CID of a module the instance already has (a module the kernel pins)
etc/app.json             the manifest (§2)
www/, …                  whatever it serves or needs
```

At install (§3) the app's root head `<app>/app` — `overlay/app`,
`amm/app`, … — is advanced to the **app record**: the manifest as
installed, linking that tree (§2). **An app writes only heads under its own
name** (#77): `advance("<app>/<anything>")` from one of its programs
succeeds, anything else is refused by the kernel (`advance: … is outside
the write scope of …`). Its handler keeps its state and configuration
there: records it puts and keeps, maps it maintains (`<app>/ls_demo`,
`<app>/gossip`), its configuration (§2, §6). Its own state is the app
record's `state` link: the handler advances `<app>/app` to the same record
with `state` replaced (the SDK's `app.Call.setState` / `app.putState`,
skein-sdk ≥ 0.3.0), and an install of a new version keeps it. The shell
sees the `main` head's tree and nothing else: app heads are outside its
file system. (Built, #72, #77.)

**Reads are global by CID; writes are by name.** Any program can read any
head (`head(name)` then walk the tree; `get` any CID another program handed
it): holding a CID is the permission. A program that needs a pointer it
does not hold calls the owning app; calls hand back CIDs, not data — state
is one copy, referenced, never copied between heads. Data meant to be
private is encrypted. (Built: heads, `head`/`advance`/`get` — docs/VM.md
"Heads".)

## 2. The manifest — `etc/app.json`

dag-json. At install it becomes the root record of `<app>/app` (`kind:
"app"`), so "what does this head provide" is one read. (Built, #72, #77:
the checks are src/host/manifest.ts, the record is written by
src/host/install.ts.)

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
  "config": {
    "overlay": {
      "topics":  {"tm_amm_1": "topic"},
      "lookups": {"ls_amm_1": {"program": "lookup", "topics": ["tm_amm_1"]}},
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
  "requires": ["chain/1"],
  "dispatch": [
    {"address": "amm", "sender": "*",     "program": "validator"},
    {"address": "amm", "sender": "$cron", "program": "validator"},
    {"transport": "http",   "address": "/call",             "sender": "session", "program": "validator", "fn": "call"},
    {"transport": "libp2p", "address": "amm-proofs",        "sender": "*",       "program": "p2p",       "fn": "proof"},
    {"transport": "libp2p", "address": "/amm-validator/1/swap", "sender": "*",   "program": "validator", "fn": "swap"}
  ],
  "start": {"body": {"kind": "amm-p2p-start"}},
  "stop":  {"body": {"kind": "amm-p2p-stop"}},
  "description": "An AMM: its own overlay (one topic manager, one lookup service), a validator, and a market UI."
}
```

| field | meaning |
|---|---|
| `name` | the app's name: its box (§4), and the prefix of every head it writes (`<name>/app` its root). Unique on the instance: the name is the app's identity |
| `version` | semver; shown by the site, compared by `requires` |
| `programs` | the app's programs by role name, relative to the tree (`bin/*.wasm`, or `bin/*.cid` for a module the instance already holds; `bin/<x>.json` beside it gives the program record's `{inputs, services, description}`), a bare name: a program the instance already has by that name in its genesis, or a map `{code: "shell", modules, support?}`: a shell program whose modules are files of the tree (§6b, "A shell program"; #83); `dispatch[].program` and `config` refer to these names. The program record the install writes for each carries `app: <name>` — the kernel's write-scope rule reads it, and a program finds its app (its head `<name>/app`, the app record) from its own record (#72, #77, built) |
| `config` | per-program configuration the programs read from the manifest at the head's root (the overlay engine reads `config.overlay`: its topics and lookup services, §6; the app's own program reads `config.<name>`). Replaces genesis `defaults` for apps. Changing it is a new manifest and a head advance (owner), or a `writes: true` function the app offers (§4) |
| `provides[]` | interfaces this app implements: `interface` is `<name>/<major>`; `functions` maps each function to `writes` (true: the function may put records, move heads, emit; false: it reads only — logged like every request, but a site may call it freely, a pruner may drop its entries, and a validator flags a read-only function that writes), `args` and `answer` shapes (dag-json schema: `string`, `int`, `bytes`, `cid`, `ms`, `bool`, `map` (any map), `any`, an array `[shape]`, a nested map `{key: shape}`; a `?` suffix on a key = optional: absent or null; a key the shape does not name is refused). `writes` is required |
| `requires[]` | interfaces this app calls on others, bound by name at install (§3 step 0) |
| `dispatch[]` | **the rows it asks for** (#77): each `{transport?, address, prefix?, sender, program, fn?, …settings}` in the kernel's row shape (docs/VM.md "The dispatch table"). `transport` defaults to `mailbox`: the address is a box — the app's own name (its public face, §4), or another app's box it is wired into. An `http` row's address is a path **relative to `/<name>/`** (a leading `/` too: `"/submit"` is `/amm/submit`, `"/"` is `/amm/`; `prefix: true` for a prefix; `fn` the handler's function; the rest the handler's own settings, carried to it as `match`). A `libp2p` row's address is a pubsub topic or `/<protocol>`, exact — global, not namespaced; sender `*` (a topic the app takes at run time is not a row: its program emits a subscription, `subscribe {topic, program, fn}`, #119, docs/MESSAGES.md "libp2p (#51)"). `sender` says who the row admits: `"*"` anyone, `"event"` (mailbox only, #79) events and never a message (the host's wiring, a route's admits: a box that takes events need not be open), `"session"` (http only) any BRC-103/104 session, `"$owner"` the owner, `"$self"` (#79) the instance's own identity — its other programs, by the host's loopback (docs/VM.md "emit"), `"$cron"`/`"$status"`/`"$<provider>"` the key the instance's address book gives that role, or an identity key in hex. The install resolves each and sends it to the kernel's `dispatch` operation with `app: <name>` (§3). The same key (transport, address, prefix, sender) twice is refused. `optional: true` (only on a row from a `$<provider>`, #78): the install leaves the row out, with a note in the prompt, when the instance's address book has no such provider — as a genesis leaves out a row from a provider its host has not; it never reaches the kernel |
| `start` | optional: a message the owner sends into the app's box as the **last install message**, after the rows, so a program whose first act is to schedule something (a heartbeat tick from `$cron`) actually runs; nothing else starts an app. Sending it again is the restart after a reconfiguration (a new manifest + head advance): an install over an installed version sends it again. It needs a row admitting the owner to the app's box (`"$owner"` or `"*"`). (#76, built) |
| `stop` | optional: a message the owner sends into the app's box at uninstall, before its rows are removed, so the app can cancel what it scheduled. (#76, built) |

**http rows are namespaced under `/<app>/`, enforced.** Every path an app
asks for lives under its own prefix: the AMM's rows are `/amm/submit`,
`/amm/lookup`, `/amm/…`; the manifest's address is relative to that prefix
and the install refuses anything else — a `.` or `..` segment, an encoded
dot or slash (`%2e`, `%2f`), a backslash, a NUL, a query, a URL. No
top-level grants exist for apps. The protocol endpoints are unaffected:
BRC-22's `/submit` and BRC-24's `/lookup` are relative to the overlay's
**base URL**, which BRC-23's advertisement carries (a host base URL, not a
bare domain), so an overlay app advertises `https://<handle>.<host>/amm`
(the host's name is the skein's, one subdomain per handle; on a host
without wildcard DNS the router also serves `/@<handle>/amm` on its
origin) and standard clients call `${baseUrl}/submit`
(`POST https://alice.skein.nexus/amm/submit`). The root belongs to skein's
boundary programs (the messagebox rows, the BRC-103 well-known path), which
are not apps. libp2p topic names are global by nature and are not
namespaced. Boxes follow the same rule: an app's box is its name.

**The app declares; it never installs.** Every row is a request the owner
approves (§3): the install prompt is the rows read aloud. A manifest asking
for a row the owner did not approve is refused at install.

**The form before #77** (`handler`, `boxes`, `routes`, `heads`) is refused
(#79): skein-overlay 0.6.1, skein-shell and skein-chat 0.1.0 and
skein-site 0.6.1 are in this shape (skein-static, archived by #125, was). There are no grants: an app writes only `<name>/…`.

**The app record** — the root of `<name>/app`, written by the install
(built):

```
{kind: "app", name, version,
 programs: {<role>: <program record CID>},       the manifest's paths resolved
 config?, provides, requires,
 dispatch: [<row as the manifest wrote it: relative addresses, roles>],   with what config.overlay derives (§6)
 start?, stop?, description?,
 tree: <the app's git tree CID>,                  etc/app.json as shipped, bin/, www/, …
 state?: <the app's own state record>}            the handler's (§1); kept across installs
```

So "list apps, read their manifests" is one read per `*/app` head:
`head("<name>/app")`, `get` — a root of `kind: "app"` is an installed app.
The tree is still there for what the app serves or reads (`tree`).

The same `provides` contract is what a WASI 0.2 component's WIT gives the
compiler; the manifest is the graph's copy of it, so a head is defined by
what it provides and one app can replace another behind the same
interface. (Spec.)

## 3. Install: owner messages to the kernel's admin boxes

Each is a message at one of the kernel's admin boxes — the kernel's own
operation on one of its tables, no program stepped (docs/VM.md "The
dispatch table"). A management site is the permission prompt: it reads the
manifest, shows what the app asks for, and has the owner's wallet sign the
messages — one click sends them all; steps are fine. Building the messages
is a library; sending them is the owner's wallet's job (#124: the same
messages from any BRC-100 wallet). The reference client is `skein plan
install <repo-url#commit | dir> (--origin <url> | --store <runtime.db>)
[--config json] --out <dir>` (src/client/admin.ts over src/host/plan.ts;
built, #72/#76/#77/#124): it writes the prompt (`prompt.txt`, the lines
below) and one `/sendMessage` JSON body per message (`001-objects.json`,
`002-head.json`, …: `{"message": {"recipient": <the instance's key>,
"messageBox": <box>, "body": <DAG-JSON>}}`), which the owner's wallet POSTs
in order to the instance's `/sendMessage` on a BRC-104 session — `skein
send <origin> <dir>`, or by hand `for f in <dir>/[0-9]*.json; do 1sat
authfetch POST <origin>/sendMessage --body @"$f" || break; done`
(docs/BOOTSTRAP.md "Installing an app").

0. **Check.** The manifest (§2). Every `requires` interface is provided by
   some installed app (each `*/app` head's root record, `kind: "app"`, its
   `provides`). The name is free (no `<name>/app` head, or one whose root is
   this app's earlier record). No row takes a key the genesis's rows or
   another app's have. Every `$<provider>` sender is in the instance's
   address book (role = the name). Then the prompt: the head, each row (`row <transport> <address> from <who> → <role>.<fn>`),
   `start`/`stop`, `requires`/`provides`, what an overlay publishes (for
   information), and the messages to be sent. Nothing is sent unless the
   owner sends it: the page's "Approve and send", or `skein send` /
   the owner's own wallet with the plan's files.
1. **`objects`** — the records. Body (dag-cbor, ≤ 1 MiB per message):
   ```
   {records: [{cid, bytes}]}
   ```
   The tree's git objects (blobs, then trees, the root last), the modules
   its `bin/*.wasm` carry (raw), a program record per program
   (`{kind: "program", name, code: {wasm: <module>}, inputs, services,
   description, app: <name>}`), and the app record (§2)
   last. Records the instance has are not sent. No bundle names a `root`:
   an app never becomes `main`.
2. **`head`** — `{name: "<app>/app", tree: <the app record's CID>}`. The
   head's root is the app record, which links the tree; its owner is the
   app.
3. **`dispatch`** — one per row: `{op: "add", row: {transport, address,
   prefix?, sender, program: <the role's program record>, fn?, …settings,
   app: "<name>"}}`, the sender resolved (`"*"`, `"event"`, `"session"`, the
   owner's key, the instance's own key for `$self`, a provider's key, a key)
   and an http address under `/<name>/`.
   The kernel adds it to its table (replacing the row with the same key).
   (Built, #77.)
4. **`start`** (if the manifest has one) — the owner sends the declared body
   into the app's box. The app's handler runs its first step: scheduling
   ticks with `$cron`, announcing itself, whatever it declared. (Built, #76.)

**Two paths to the tree** (#91). Step 1 is how the tree reaches the
instance, and there are two ways:

- **The client clones on its machine.** `skein plan install <repo-url#commit
  | dir>` clones the repository (or reads the directory) on the machine it
  runs on and plans everything the instance lacks as `objects`; the owner's
  wallet sends it. A coding-session tool, not the user's path.
- **The git app clones in the VM, by hash** (built, #91). With
  [shruggr/skein-git](https://github.com/shruggr/skein-git) installed (name
  `git`, box `git` from `$owner`, interface `git/1`), a page needs two
  owner-signed steps and no `objects`:
  1. `{fn: "git.clone", args: {url, hash}}` to box `git` — `hash` a commit
     id, the user's intent. The git app asks the fetch provider (the host's
     HTTP transport, docs/MESSAGES.md "The providers") for the repository's
     advertisement and then one shallow pack of that commit (git smart HTTP,
     protocol version 2; at most 32 MiB, `maxBytes`), unpacks it (ofs- and
     ref-deltas), finds the commit by the id it computes and walks its tree —
     every object must be in the pack, so what is kept is what the hash
     commits to — puts the commit, trees and blobs as git-raw blocks, builds
     the **app record** from `etc/app.json` with its program records and
     modules, byte for byte the record step 1 above would send, and answers
     `{fn, request, replyTo, result: {tree, app}}` (or `error: {code,
     message}`: `bad-args`, `unreachable`, `not-git`, `not-found`,
     `too-large`, `mismatch`, `no-manifest`, `bad-manifest`). Blocks are
     content-addressed and unscoped: keeping them grants nothing and mounts
     nothing. It moves no head (it writes only `git/…`, and uses none) and
     never acts as the owner.
  2. The install as above from step 2: the page reads the manifest out of
     the stored tree by CID (reads are open), checks it and the instance as
     in step 0, rebuilds the app record (src/host/install.ts `readStoredApp`
     + `planInstall`) and compares its CID with the answer's `app`, shows the
     prompt, and the owner signs `head` (`<app>/app` → that record), the
     `dispatch` rows and `start`. Only that head message makes the tree an
     app.

  The pack is not stored, only the objects the commit reaches (the fetch
  provider's answer that carries it is an entry, as every provider answer
  is). Not yet: `push` (publishing from a skein), refs or tags as the
  `hash`, sha256 repositories.

**The management page** (built, #92; an app since #125). The management
site is an app, shruggr/skein-site (name `site`): one route handler serving
its own tree's `www` (the head `site/app`'s record, its `tree`, through
skein-sdk's `files`) on one row, `/site/*`; the page is the installer
(there is no installer program). The default image has no site and serves
nothing at `/`: the host's own skein carries the site, installed by the
host's owner, and a user manages their skeins from there, the page talking
to each one directly. **The root is the owner's**: an app's rows are under
its name, and the owner may send one more row of their own to the site's
handler, `{transport: "http", address: "/", prefix: true, sender: "*",
program: <the site's program record>, fn: "get", root: "www"}` — `skein
plan dispatch add --http --prefix --fn get --settings '{"root":"www"}' /
site.site <where>` (a handler `<app>.<role>` is that installed app's
program) — to serve the page at `/` (and its `manifest.json`, the wallet's
grouped request, at the origin's `/manifest.json`). A manifest has no field
for it: the install shows the app's own rows only, and the site's README
says how. The row carries no `app`, so the site's upgrade or uninstall
leaves it (`skein plan dispatch remove` with the same arguments removes it);
as a prefix at `/` it takes every path no exact row or longer prefix takes. Connected to the owner's wallet, it reads the
skein through its explorer (`/explore`, the owner's read, docs/MESSAGES.md),
which gives it what the plan needs: the heads, the genesis, the claim, the
address book, the dispatch table (the chain `{kind: "dispatch"}`) and any
record by CID. It plans with the same code as `skein plan`
(src/host/plan.ts, bundled into the site) and shows the plan as the prompt;
on approval it sends the messages, signed by the wallet on a BRC-104
session. The page, `skein plan` + `skein send`, and a raw `1sat authfetch`
loop are three ways to the same messages: none of it is the host's (#124).

- **The git app first.** The default image carries the git app's tree
  (`apps/git`, not wired). With no `git/app` head, the page plans the
  install over that subtree: `objects` carries what the store lacks (the
  module as a raw block, the program and app records), then `head`, the one
  `dispatch` row (box `git` from the owner) and `start`.
- **Every other app by hash.** The page sends `{fn: "git.clone", args: {url,
  hash}}` to box `git` and reads the answer from the thread that message
  launched: `/explore/edges/<message>?rel=launched-by` names it,
  `/explore/thread/<origin>` is read until its last update is `finished` or
  `errored`, and the result's stdout is the answer `{tree, app}`. The page
  then runs step 2 above in the browser and compares its record with `app`.
- **Uninstall** and the address book (a `peers` message per change) the
  same way: the change shown, then sent as the owner.
- **The Inbox** (#99, skein-site 0.2.1): a mailbox's box listed for your key
  (`@bsv/message-box-client`), and Sync — `@1sat/actions`' `syncMetanetInbox`
  (always `metanet_inbox`) with the wallet in the browser, against a mailbox
  URL you give it — by default the one your handle resolves to.
- **Handles** (#103, skein-site 0.3.0): "Register a handle" on the host
  (`/account/register`, signed by your wallet); the handle certificate kept
  in your wallet (`acquireCertificate`, direct); "Your handles" from
  `listCertificates`. #113: the host skein's onboarding app takes it now, and
  the signature covers the domain (`register <name>@<domain>`, the domain
  from `/.well-known/skein-host`): skein-site 0.5.2 signs `register <name>`
  and is refused until it follows docs/MESSAGES.md "Mailbox instances".
- **Profiles** (#104, skein-site 0.4.0): each handle's Profile form (a name,
  an avatar outpoint) signed by your wallet and written to your mailbox
  instance (`objects`, `head profile`); handles shown with their avatar or
  an identicon; "Find a handle" over the host's search endpoint. #113: the
  host serves the profile the onboarding app keeps, posted to
  `/account/profile` (docs/MESSAGES.md "Mailbox instances"); the mailbox
  instance's head is read no more, so the form has to post there.
- **One grouped permission request** (#97, skein-site 0.5.0; 0.5.2 without
  the spending allowance): the site's `manifest.json`, served at
  `/manifest.json` of the skein's own origin by the owner's root row (#125), asks a BRC-100 wallet once for
  the page's protocols and its basket, and declares the counterparty
  protocols (one prompt per new skein or certifier).

Who can install is whoever the kernel's admin rows admit to `objects`,
`head` and `dispatch`: the owner, by every genesis that names one; a
delegate, by a row the owner added. An untrusted app cannot tie itself to
anything — the worst it can do is ask.

**Install after the claim** (#89). A skein started from the default image
(docs/BOOTSTRAP.md "The default image") has no owner and no admin rows
until it is claimed: an install into it is refused (`$owner` cannot
resolve, and no row admits the messages). The claim — the owner's own
message in box `claim`, its sender the owner (#127: `skein plan claim`, then
`skein send`; or, for a hosted registration, signed by the owner's wallet
before the instance existed and forwarded by the host's instance manager) —
writes the owner's admin rows; from then on the
owner installs exactly as above — the wallet, the chain app, the shell app,
the chat app, whatever the catalog offers. `$owner` in a manifest resolves
to the claimed key (the head `claim`, read by the install).

**Reconfiguration** is the same messages again. Installing an app that is
installed (its `<name>/app` head's root is an app record) is the upgrade:
the new app record keeps `state`; rows the old record had and the new one
does not are removed (removes first), rows the table already holds as asked
are not sent again; `start` is sent again (the restart). Change or revoke a
single row with a `dispatch` message (`skein plan dispatch`). All in the log. Deploy-by-message
with a payment (#11) is the same `objects` message with a toll.

**Uninstall** (`skein plan uninstall <app>`, sent by the owner's wallet; built):
the `stop` message if declared, into the app's box while its rows still
stand; then a `dispatch` remove for every row the table holds with `app:
<name>`. The heads are left (prunable), the app record and state with them.

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
  message. Who may send is the dispatch table (the manifest's rows).
- **An HTTP row** `{"transport": "http", "address": "/call", "sender":
  "session", "program": <role>, "fn": "call"}` (served at `/<app>/call`):
  the request body is `{fn, args}` (JSON, or dag-cbor as
  `application/cbor`), POST; the route handler turns it into the same
  call, and the client gets `{fn, result}` (200) or `{fn, error}` (400
  `bad-request`/`bad-args`, 403 `not-admitted`, 404 `unknown-fn`, 409
  `read-only`, 500 `failed`) on the connection, signed on the session, when
  the request's thread finishes (docs/MESSAGES.md "Route handlers", "A
  synchronous client waits on the thread"). Synchronous. The caller (the
  BRC-104 session's key) must be admitted to the app's box as a message
  from it would be: a row for (caller, `<app>`) or (anyone, `<app>`); an
  open row (sender `*`) has no caller, so only a box open to anyone admits
  it.
- **In-VM**: another program calls `call(<app program>, "<interface>.<function>", args)`
  (dag-cbor) and gets the result, or the call's error (docs/VM.md `call`).
  The callee's writes are in its own scope (its heads), not the caller's.

**The SDK's dispatch helper** (shruggr/skein-sdk ≥ 0.3.0, module `app`,
`lib/app.zig`; built, #72, #77) is all of this: the program lists the
functions it implements (`app.Function{.name = "amm.pool.quote", .run =
quote}`) and hands every input to `app.serve(a, in, "<app>", &fns,
other)`; the manifest is read from `<app>/app`. A function gets an
`app.Call`: its `args` (checked), `sender`, the app record, and the writes
— `put`, `putBlock`, `keep`, `advance`, `setState`, `emit`/`send`,
`launch`, `deadline`, `awaitRecord`. (There is no `subscribe`: the dispatch
table is the kernel's.)

**`writes: false`** functions answer from the app's head as it stands;
their request is still an entry (§2). Each write through the `Call` is
refused for them, and the call answers `read-only` ("<fn> is writes:
false, and it called put"). A function that calls the raw imports itself
goes around the helper; the log shows what it did. A `writes: true`
function that fails is answered with its error, and what it wrote before
failing stands: check first, write last.

**A function whose answer needs another party** (a provider's answer, a
peer's reply) cannot be answered by the helper's `/call`, which answers in
the request's step. Its route handler launches a thread and answers
`{wait: true}`; the client waits on that thread (docs/MESSAGES.md, "A
synchronous client waits on the thread"), and the handler is called again
with `resolved`. The onboarding app (shruggr/skein-onboard, #90) is the
example: its own `/onboard/call` (sender `session`) takes `{fn:
"onboard.create", args}` in the same shape, launches a thread that asks the
instance manager, and answers `{fn, result | error}` from that thread's
result.

## 5. Security model, in one place

- **Only signed messages change anything.** Every package is appended and
  verified inside (docs/MESSAGES.md): a message routes only where the
  dispatch table says its sender may go.
- **The admin operations are the kernel's.** `objects`, `head`, `dispatch`
  and `peers` are kernel operations on admin messages from the owner (every
  genesis) or a delegate (a row the owner added) — no program, elevated or
  otherwise. Every program emits as the instance, and no default row
  admits the instance's own key to an admin box (#87), so a program's
  admin message finds no row: recorded, nothing runs. Granting another identity the right to install or reconfigure
  is a `dispatch` row by the owner — explicit, logged.
- **An app writes only heads under its own name.** That is the whole
  write-scope rule, enforced by the kernel: `advance` is allowed when the
  head's name is `<app>/…` for the stepping program's app (its record's
  `app`). Two apps cannot write each other's heads; they read each other's
  freely, by CID. A genesis-wired program writes only what its genesis
  `scopes` name. No exceptions (#79). The scope comes only from a record
  the owner installed — a genesis program, a dispatch row's program, or one
  listed in the app record at `<app>/app` (K1): a record a program puts
  itself, claiming another app (`app: "chain"`) or a genesis-wired name,
  runs when launched or called and writes no head (docs/VM.md "Heads").
- **Reads are global.** Holding a CID is the permission. Data meant to be
  private is encrypted; nothing in the store is unreadable to a program
  that can name its CID.
- **The shell cannot reach app heads.** A shell tool that needs an app's
  data asks the app (a call), or a later shell feature mounts heads as
  directories (the shell app's `mount`, shruggr/skein-shell#1) — a shell concern, not an app's.
- **A manifest is a request.** Rows are granted by the owner at install;
  http addresses are confined to `/<app>/`; a function marked `writes:
  false` that writes through the SDK's helper is refused (`read-only`,
  §4) and, written around it, a bug the log shows.

## 6. Worked example: an overlay is an app

An overlay (BRC-22: topic managers and lookup services; shruggr/skein-overlay
docs/OVERLAY.md) is not a service other apps register with. **It is an
app**: the overlay engine (shruggr/skein-overlay's `bin/overlay.wasm`, or
`bin/overlay.cid` when the instance already holds that module) plus the
app's own topic managers and lookup services, in one tree under one name,
with `config.overlay` naming which topics and services it runs:

```json
"programs": {"overlay": "bin/overlay.cid", "topic": "bin/amm-topic.wasm", "lookup": "bin/amm-lookup.wasm"},
"config":   {"overlay": {"topics": {"tm_amm_1": "topic"},
                         "lookups": {"ls_amm_1": {"program": "lookup", "topics": ["tm_amm_1"]}}}},
"requires": ["chain/1"]
```

The engine reads that from the app record at its head's root (`<app>/app`),
at every step and call (skein-overlay ≥ 0.2.0, `src/config.zig`): its
program record names the app (§2, `programs`). A reinstall with a changed
`config.overlay` is read at the next step; nothing restarts. An engine with
no app record — wired into a genesis by a system tree — reads the genesis
defaults `overlayTopics`/`overlayLookups`/`overlayGossip` instead, and
writes under its program's name (`overlay/…`, the tree's `scopes`).

**An overlay may list no topics** (#120): `topics` absent or `{}` is
accepted. A dynamic overlay (Mandala, an AMM) has no topics in its manifest:
its topics are registered and deregistered by a call at runtime, which
emits a subscription (`subscribe {topic, program, fn}`) or ends one
(`unsubscribe {topic}`, #119): the kernel delivers the topic's messages by
the subscription, and no row is added (docs/OVERLAY.md "How an overlay app
activates a token topic live"). The install derives the box
rows, `/submit` and `/lookup` as below, and no per-topic rows. A manifest
may still pre-configure topics (OpNS: one global topic). There are no prefix
declarations: `prefixes`, here or in a lookup service, is refused as an
unknown field, as is any field other than `topics`, `lookups`, `gossip`
(and, in a lookup service's object form, `program`, `topics`).

**Its state is under its own name** (#79, skein-overlay ≥ 0.3.0):
`<app>/state` (what its topics admitted and judged, and the submissions
pending at the chain app), `<app>/ls_<service>` (each lookup service's own
maps), `<app>/gossip` (peers' admits). **The chain is the chain app's**
(§6a): the overlay links no chain tracker and holds no headers, proofs or
settlement. A submission's BEEF is decoded at the kernel's door (#121: the submit rows name `filter: "beef"`; every BUMP checked against `chain/state` there, the handler given the pointer record's CID) and judged in the `/submit` call (SPV for the unproven against
`chain/state`, read by CID; the topics on the transaction's CID), then the
submission's thread sends the pointer record to the chain app (`{fn: "ingest", args:
{beef}}` to the instance itself, box `chain`) and waits on its answers:
**admitted on the first of `accepted` or `proven`** (#73), nothing on
`rejected`. Proof validation is the chain app's answer. A submission
admitted on `accepted` is watched on (a message to its own box from
`$self`): `proven` publishes `<topic>-proof`, `rejected` removes its
judgements. Lookups read the chain state for BEEFs and spent-ness. So
**two overlay apps on one instance coexist by construction**: two names,
two sets of heads, two boxes, one chain state (kernel-zig/equiv/install-overlay.ts
installs the same tree twice, as `overlay` and `overlay2`). Two overlays
running the same overlay topic would claim the same libp2p rows: one topic,
one overlay app per instance.

**The wiring is derived from `config.overlay`, and shown** (src/host/manifest.ts
`overlayWiring`; the engine is the role `overlay`). The install expands
it into the concrete rows the owner approves, all to the role `overlay`,
marked "(derived: config.overlay)" in the prompt:

- the app's own box `<app>` from `event` (what its libp2p routes admit: a
  gossiped submission, a peer's admit) and from `$self` (its own watch);
- the open http rows `/<app>/submit` (`filter: "beef"`, #121) and `/<app>/lookup` (the app's base
  URL is what it advertises);
- libp2p rows `<topic>` (raw submissions, fn `submit`, `filter: "beef"`), `<topic>-admit`
  (fn `peerAdmit`) and `<topic>-proof` (fn `peerProof`) per topic (#74).

No `chain`, `status` or `submit` box (the chain app's, and the app's own
box), no grants. An explicit row in the manifest with the same key
overrides the derived one. The host's libp2p node subscribes the derived
topics once their rows are in the table, and unsubscribes them when they
are removed. What the app **publishes** (`<topic>`, `<topic>-admit`,
`<topic>-proof`; on by default, `config.overlay.gossip` per topic to turn
off) needs no grant: emitting is the app acting as the instance. The
message shapes and the receiving rules are skein-overlay's docs/OVERLAY.md
"Gossip": `<topic>` carries the BEEF as received; `<topic>-admit`
`{txid, topics: {<topic>: {outputsToAdmit, coinsToRetain}}}` (received →
recorded under `<app>/gossip`, never admitting); `<topic>-proof` `{txid,
blockHash, blockHeight, bump}` (received → checked against the chain
state's headers and admitted as the chain app's `proof` event, with `via`,
else `ignore`). The AMM app ships exactly this: the engine, `amm-topic`,
`amm-lookup`, its validator and p2p programs, and its UI, one tree.

**The topic and lookup program contracts** (`identify` for a topic
manager; `admitted`/`spent`/`rejected`/`lookup` for a service) are
skein-overlay's, and since 0.3.0 a **Zig module** an app depends on by
URL+hash like the SDK (`b.dependency("skein_overlay", …).module("topic")`
/ `.module("lookup")`): authors of topic managers and lookup services build
against it and ship them inside their own overlay app.

**The engine's repo is itself an overlay app**:
[shruggr/skein-overlay](https://github.com/shruggr/skein-overlay) ships the
engine with its example topic manager and lookup service. Its
`etc/app.json` (0.3.0, the #77 shape) names the config, `requires:
["chain/1"]`, and only its listing rows; the rest is derived:

```json
"programs": {"overlay": "bin/overlay.wasm", "topic-demo": "bin/topic-demo.wasm", "lookup-demo": "bin/lookup-demo.wasm"},
"config":   {"overlay": {"topics": {"tm_demo": "topic-demo"},
                         "lookups": {"ls_demo": {"program": "lookup-demo", "topics": ["tm_demo"]}},
                         "gossip": {"tm_demo": true}}},
"requires": ["chain/1"],
"dispatch": [{"transport": "http", "address": "/listTopicManagers", "sender": "*", "program": "overlay", "fn": "listTopicManagers"}, …]
```

Installed (after the chain app; without it the install is refused,
`requires chain/1`), it asks for its listing rows and the derived ones:
mailbox `overlay` from `event` and `$self`, http `/overlay/submit` and
`/overlay/lookup`, libp2p `tm_demo`, `tm_demo-admit`, `tm_demo-proof`
(equiv/install-overlay.ts installs it from its repo and checks each).

**A multi-tenant overlay is a choice, not core.** An overlay app that wants
to accept topic managers from outside may offer `overlay.topics/1`
(`add`/`remove`/`list`, `writes` as expected) and `overlay.lookups/1` on its
box and keep a registry under its head; the engine would consult both the
manifest and the registry. Nothing requires it, and skein-overlay
does not offer it.

## 6a. Worked example: the chain module (#78)

The chain state — headers, transactions, proofs, spends, settlement,
broadcasts — is global to an instance and has one writer, the app
[shruggr/skein-chain](https://github.com/shruggr/skein-chain) (its
docs/CHAIN.md is the contract). Its manifest is the #77 shape and nothing
more: one program, two rows, one interface.

```json
{
  "kind": "app", "name": "chain", "version": "0.3.0",
  "programs": {"chain": "bin/chain.wasm"},
  "config":   {"chain": {}},
  "provides": [{"interface": "chain/1", "functions": {
    "ingest": {"writes": true,  "args": {"beef": "any"},     "answer": {"txid": "string", "tx": "cid", "state": "string", "…": "…"}},
    "status": {"writes": false, "args": {"txid": "string"}, "answer": {"txid": "string", "state": "string", "…": "…"}},
    "proof":  {"writes": false, "args": {"txid": "string"}, "answer": {"block": "cid", "height": "int", "depth": "int", "position": "int", "…": "…"}}}}],
  "dispatch": [
    {"address": "chain",  "sender": "event",   "program": "chain"},
    {"address": "chain",  "sender": "$self",   "program": "chain", "filter": "beef"},
    {"address": "chain",  "sender": "$owner",  "program": "chain", "filter": "beef"},
    {"address": "status", "sender": "$status", "program": "chain", "optional": true}
  ]
}
```

- The `chain` row from `event` takes the host's events (a feed's
  `header`, the broadcaster's `proof`, an overlay route's `-proof`) and
  never a message: specific wiring, not an open box (#65, #79).
- The `chain` rows from `$self` and `$owner` take the callers' `{fn,
  args}`: the instance's own apps (the wallet, the overlay apps, by the
  host's loopback) and the owner. A stranger's message routes nowhere.
  They name `filter: "beef"` (#121): before a caller's message is logged,
  the kernel's door decodes every BEEF in its body's fields — each
  transaction stored once as its `bitcoin-tx` block, each BUMP as its bytes'
  raw block, every BUMP checked against `chain/state` — and the body the
  chain app is stepped with carries the BEEF's pointer record (the message
  record itself untouched: its id is what the answers name). So `ingest`
  takes `{beef: <the pointer record's CID>}` — what an overlay's submit
  passes on, never the bytes — and reads the bytes back with skein-sdk's
  `chain.record.beefOf`; bytes still work from a caller no door stands in
  front of. A bad BUMP is a refusal entry: the message runs nothing.
- The `status` row takes the status provider's messages; `optional`, so a
  host with no status provider installs it without (statuses are optional,
  #65).
- Its only head is `chain/state` (the name rule; the app record is
  `chain/app`). Readers hold its CID: `head("chain/state")`, `get`, and the
  SDK's chain library (skein-sdk ≥ 0.4.0, `chain.state.State`) reads the
  maps. A reader that wants a pointer calls `status` / `proof` and gets
  CIDs back.
- `ingest` answers several times to one request (`accepted`, then
  `proven` or `rejected`), each `{fn, request, replyTo, result}` at the
  caller's address — the shape of §4 with more than one answer. A caller in
  the same instance awaits its ingest message, and each answer steps it.
- The wallet (docs/WALLET.md) and the overlay apps (§6) are such callers:
  they keep their own records under their own names and read
  `chain/state` by CID.

Installed: `skein plan install https://github.com/shruggr/skein-chain#<commit>
--origin <the instance's origin> --out plan`, then `skein send <origin> plan`; at boot: `bin/chain.wasm` in the system tree and its
rows in `etc/dispatch.json` (its program, named `chain`, writes `chain/…`
under its default scope). kernel-zig/equiv/chain.ts does both.

## 6b. Worked example: the shell app and the chat app (#83)

A skein has no userland of its own: the genesis wires the boundary
programs (front door, messagebox, resolve) and nothing else. The shell and
the chat loop are two apps, each installed when an instance wants it: an
agent's skein needs the chat loop and no shell, a developer's the shell and
no chat loop, an overlay's neither.

**The shell app** ([shruggr/skein-shell](https://github.com/shruggr/skein-shell),
name `shell`, heads `shell/…`) is the whole userland: `run` (the box `run`
from `$owner`: a command over a tree, the answer in the sender's `results`)
and the shell itself — brush, uutils coreutils, the toolset (find, xargs,
diff, cmp, jq, which, grep, tree, awk, sed, git, qjs as `node`, python as
`python3`) and python's standard library, all files of its tree. Interface
`shell/1`.

**The chat app** ([shruggr/skein-chat](https://github.com/shruggr/skein-chat),
name `chat`, heads `chat/…`) is the turn loop: box `chat` from `$owner`
and from anyone (another agent's `message`; remove that row with
a `dispatch` message, `skein plan dispatch remove`, to take chats from the owner only). Interface `chat/1`.
It requires nothing: a `bash` tool call runs the shell app's shell when the
instance has it — the loop reads the app record at the head `shell/app`
and launches its `programs.shell` as a thread, as `run` does — and
otherwise its result is exit 127, "the shell app is not installed". No
loopback row is involved: reading another app's head is open, and
launching a program record needs no grant.

### A shell program

The kernel runs a shell itself (a program record with `code: {ts:
"shell"}`; kernel-zig/src/shell.zig): it loads the modules the record
names and runs brush over coreutils and the other commands, each a WASI
preview1 module, over a tree. An app declares one in `programs` as a map:

```json
"shell": {
  "code": "shell",
  "modules": {"brush": "bin/brush.wasm", "coreutils": "bin/coreutils.wasm", "jq": "bin/jq.wasm",
              "qjs": "bin/qjs.wasm", "node": "bin/qjs.wasm", "python": "bin/python.wasm", "python3": "bin/python.wasm"},
  "support": {"python": {"mount": "/opt/skein/python",
                         "files": {"lib/python314.zip": "lib/python314.zip"},
                         "env": {"PYTHONHOME": "/opt/skein/python", "PYTHONDONTWRITEBYTECODE": "1"}}}
}
```

- `modules`: command name → `bin/<x>.wasm` in the tree; `brush` and
  `coreutils` are required, every other name is a command the shell runs
  (two names may share a module: qjs checks `argv[0]` for `node`).
- `support` (optional), per command of `modules`: files mounted read-only
  at the absolute `mount` for that command only (`files`: path under the
  mount → a file of the tree), and environment defaults the caller's env
  overrides.
- `description` (optional): the record's.

The install (src/host/install.ts `shellProgram`) sends each module and
support file as a raw block, and writes the record the kernel runs:

```
{kind: "program", name: <role>, code: {ts: "shell"},
 modules: {<command>: <raw CID>}, support: {<command>: {mount, files: {<path>: <raw CID>}, env}},
 inputs: {cmd: "string", tree: "cid", cwd: "string?", env: "map?"}, services: [], description, app}
```

A shell thread is launched with that record and `{cmd, tree, cwd?, env?}`;
the kernel loads its modules from the store by their CIDs (cached by the
record's CID). A module is sent whole: the shell app's install is
`objects` messages of up to ~10 MB (coreutils, the stdlib zip), each
carried on the owner's BRC-104 session (the client leaves the payload's
size to the transport) and stepped by the front door (its answer is
bounded at 64 MiB).

## 7. What is built, what is spec

| part | status |
|---|---|
| the write scope read only from installed program records (genesis programs, dispatch rows' programs, `<app>/app`'s `programs`); a record a program puts runs and writes no head | built, enforced (K1: kernel-zig/src/scheduler.zig `installedAs`; kernel-zig/equiv/install.ts, the forgery) |
| no message admitted as the host's word: `admit` takes no `mail` entry; the browser host appends signed messages as `local` requests; `append` writes only the genesis entry | built, enforced (K2, K24: src/host/admission.test.ts) |
| heads with owners; `head`/`advance`/`get`; the write scope by name; the kernel's `objects`, `head`, `dispatch`, `peers` operations | built (#77) |
| the dispatch table (routes, boxes, libp2p topics as rows); route handler contract; synchronous answer on thread completion | built (#68/#66, #77; #115: the kernel matches every transport, kernel-zig/src/dispatch.zig, and the front door verifies). The `/<app>/` prefix of an app's http rows is checked by the install client (src/host/manifest.ts), not by the kernel's `dispatch` operation |
| topic contract (`identify`); lookup contract (hooks + `lookup`); lookup state under `<app>/ls_<service>`; the contract as a Zig module | built (#50, #79: skein-overlay 0.3.0) |
| manifest schema (`programs`, `config`, `provides`/`requires`, `dispatch`, `start`/`stop`); the app record at `<app>/app`; `requires` check; `writes` validation; senders `event`, `$self` | built (#72, #77, #79: src/host/manifest.ts, install.ts; the SDK's `app`; the form before #77 refused) |
| install client (manifest → objects + head + dispatch + start, the prompt); `skein plan install <repo#commit|dir>` / `uninstall` writing the owner's `/sendMessage` bodies, `skein send` (any BRC-100 wallet: `1sat authfetch`); `start`/`stop`, row senders | built (#72, #76, #77, #124) |
| deploy by hash: the git app (shruggr/skein-git) clones one commit in the VM through the fetch provider and answers the app record; the client rebuilds it from the stored tree and sends `head`, `dispatch`, `start` | built (#91: §3; src/host/install.ts `readStoredApp`) |
| the management page: an app (shruggr/skein-site, its page at `/site/`, its own tree's `www` served by skein-sdk's `files`; the owner's optional `/` row); install, uninstall and the address book from a browser, planned with src/host/plan.ts over the explorer's reads; the git app installed from the image's tree | built (#92, #125: §3; shruggr/skein-site 0.6.1, with the Inbox, #99, handles, #103, profiles, #104, and the grouped permission request, #97) |
| the owner's own http row to an app's handler (`skein plan dispatch --http`; no `app`: an upgrade or uninstall of the app leaves it) | built (#125: src/client/admin.ts `planDispatch`) |
| libp2p rows installed by apps; the host's libp2p node follows the dispatch table (subscribe/unsubscribe, handle/unhandle, live) | built (#72, #77: src/host/p2p.ts `libp2pConfig`, router.ts `syncDispatch`) |
| an overlay app's wiring derived from `config.overlay` and shown in the prompt | built (#72, #77, #79: src/host/manifest.ts `overlayWiring`) |
| one box per app, `{fn, args}` dispatch, answer message; SDK dispatch helper; the `/call` row | built (#72: skein-sdk `app`; 0.3.0 reads `<app>/app`) |
| the overlay engine reads `config.overlay` from its app record `<app>/app`, at every step (the genesis `overlayTopics`/`overlayLookups`/`overlayGossip` only without one); a program finds its app from its program record's `app` | built (#72, #79: skein-overlay 0.3.0 `src/config.zig`) |
| the chain under `chain/` (one chain module, shruggr/skein-chain: ingest, broadcast, answers on each state change); `optional` rows; no open box (`event`, `$self`, `$owner`) | built (#78, #79, #121: §6a; skein-chain 0.3.0; skein-sdk 0.5.0 `chain`) |
| the wallet and each overlay under their own names, reading `chain/…`, ingesting by message (the wallet is a genesis-wired program the kernel pins, with scope `wallet/`, not an installable app: it has no `etc/app.json` and `wallet` is a reserved app name); two overlay apps on one instance; the sibling apps' manifests in the #77 shape | built (#79: programs/wallet, skein-overlay 0.3.0, skein-static 0.2.0; skein-shell and skein-chat 0.1.0 since #83) |
| the shell and the chat loop as apps (shruggr/skein-shell, shruggr/skein-chat); a shell program declared in a manifest, its modules files of the tree; no shell in a genesis | built (#83: §6b) |
| a multi-tenant overlay's `overlay.topics/1` / `overlay.lookups/1` | optional, not planned |
| apps in their own repos; the SDK as a Zig package | built (#71, #75): shruggr/skein-sdk (a sibling repo, consumed by URL+hash, not a submodule; 0.4.0 since #78: the `chain` module split out of `wallet`), shruggr/skein-shell, shruggr/skein-chat, shruggr/skein-site, shruggr/skein-overlay (the engine and its demo topic/lookup, with `etc/app.json`; equiv/overlay.ts clones it) |
