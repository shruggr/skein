# Apps: install, configuration, interfaces

The specification for applications on a skein instance (issue #72, decided
2026-10-01; revised by #77, the kernel's four tables: an app's wiring is
dispatch rows, its writes are heads under its own name; and by #79: the
wallet and the overlay apps under their own names over the chain app, the
form before #77 gone; and by #83: the shell and the chat loop are apps,
shruggr/skein-shell and shruggr/skein-chat, and a genesis has no shell; and
by #91: deploy by hash, the git app cloning in the VM, §3; and by #92: the
management page, §3; and by #125: the management site an app, §3; and by
#141: chain, git and site installed at birth in the default image, §3; and
by #143: routes, filters and roles — §2 rewritten). Status of each
part is marked (Built, #…) or (Spec.) in the text, and in §7's table. Authors of apps, topic managers,
lookup services and management UIs build against this document; the
contracts that are already built are cited where they live.

Vocabulary: an **instance** is one skein (its log, its tables, its store);
the kernel's **tables** are objects (blocks by CID), heads (name → root),
the **route table** (the dispatch chain), the address book and the
**grants** (the head `grants`: roles → keys) (docs/VM.md "The dispatch
table"); a **head** is a named root (`main` is the shell's file system; an
app's are `<app>/…`); a **box** is a message destination inside the
instance, routed by the route table; a **filter** is a function run on a
request before anything is recorded; a **role** is a name that gates
functions; **root** is the role that passes every check (its holders: the
genesis's `root`, or the claimant of an image). There is no owner (#143).
The host is transports + providers + store + signer; it routes nothing.

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
"app"`), so "what does this head provide" is one read. (Built, #72, #77,
#143: the checks are src/host/manifest.ts, the record is written by
src/host/install.ts.)

David Case (2026-10-08): "permissions and routing might be two entirely
different things." A manifest says three things apart: **where requests
go** (`routes`), **what runs on a request before anything is recorded**
(`filters`, and each route's list of them), and **who may run a function**
(`roles`). No route names a sender.

```json
{
  "kind": "app",
  "name": "amm",
  "version": "0.4.0",
  "programs": {
    "overlay":   "bin/overlay.cid",
    "validator": "bin/amm-validator.wasm",
    "p2p":       "bin/amm-p2p.wasm"
  },
  "filters": {
    "quote": "validator.quote",
    "page":  "p2p.serve"
  },
  "roles": {
    "admin": ["config", "pause"],
    "user":  ["swap"]
  },
  "routes": [
    {"address": "",            "handler": "validator.message"},
    {"transport": "event", "address": "", "handler": "validator"},
    {"transport": "http",  "address": "/call",  "filters": ["kernel.brc104"], "handler": "validator.call"},
    {"transport": "http",  "address": "/swap",  "filters": ["kernel.brc104", "kernel.beef"], "handler": "validator.swap"},
    {"transport": "http",  "address": "/config", "filters": ["kernel.brc104"], "handler": "validator.config"},
    {"transport": "http",  "address": "/quote", "filters": ["quote"]},
    {"transport": "http",  "address": "/", "prefix": true, "filters": ["page"], "root": "www"},
    {"transport": "libp2p", "address": "amm-proofs", "handler": "p2p.proof"}
  ],
  "config":   {"amm": {"feeBps": 30}},
  "provides": [{"interface": "amm.pool/1", "functions": {"quote": {"writes": false}, "swap": {"writes": true}}}],
  "requires": ["chain/1"],
  "start": {"body": {"kind": "amm-start"}},
  "description": "An AMM: a validator, a market page."
}
```

### Routes

A route is a transport, an address, an ordered list of filters and a
handler. It is routing only: where a request goes and what it passes on the
way.

```json
{"transport": "http", "address": "/swap", "filters": ["kernel.brc104", "kernel.beef"], "handler": "validator.swap"}
```

| field | meaning |
|---|---|
| `transport` | `mailbox` (the default: a message in a box), `event` (the host's wiring into a box — a feed's header, a broadcaster's proof, what a libp2p route admits; never a message), `http`, `libp2p` |
| `address` | a box **relative to the app** for `mailbox` and `event` (#128: `""` or the app's name is the app's box `<name>`, `"x"` the box `<name>/x`; an empty, `.` or `..` segment, whitespace or a control character is refused, as is a box over 128 bytes); for `http` a path **relative to `/<name>/`** (`"/swap"` is `/amm/swap`, `"/"` is `/amm/`; a `.`/`..` segment, an encoded dot or slash, a backslash, a NUL, a query or a URL is refused); for `libp2p` a pubsub topic or `/<protocol>`, exact — global, not namespaced |
| `prefix` | `true`: the http address is a prefix (the exact path first, then the longest prefix) |
| `filters` | the filters run on the request, in order, before anything is recorded (below): `"kernel.brc104"`, `"kernel.beef"`, one of this app's (`"quote"`: a name its `filters` declares) or another app's (`"<app>.<filter>"`). None on an `event` route |
| `handler` | `"<role>.<fn>"`: a function of one of `programs` (the stored route names the role's program record and `fn`); for an app with one program, `"<fn>"`; a `mailbox` or `event` route may name just `"<role>"` (the program stepped, no function named — nothing can gate it). **No handler: a read route** (http only): its filters answer, the last one; nothing is logged |
| anything else | the handler's (or the filters') own settings, carried as `match` (`root`, `index`) |

Who may send is not a route's business: an `http` route lists only what it
names — possibly no filter at all, open to anyone signed or not; a `libp2p`
route starts with the transport's own check (the GossipSub signature: the
publisher's key is the principal); a `mailbox` route's principal is the
message's sender (its carrier proved it). The same key (transport, address
as served, prefix) twice is refused. An app's routes are under its own
addresses — boxes under `<app>`, http under `/<app>/` — and root may add
routes of its own anywhere (no `app`: an app's upgrade or uninstall leaves
them; the site at `/` is one, below).

A read route — the page, a lookup, a resolver:

```json
{"transport": "http", "address": "/", "prefix": true, "filters": ["page"], "root": "www"}
```

### Filters

David Case: a filter is "an unlogged handler for a request that determines
how it gets handled within the system." It runs before anything is
recorded, with the request and the current state only, in the kernel's
deterministic profile (the clock is the entry's time, randomness seeded by
the request, no network, no writes: a call's imports; the blocks it puts are
kept only if it passes them). It answers one of:

```json
{"reject": {"status": 403, "code": "ERR_X", "reason": "why"}}
{"answer": {"status": 200, "type": "application/json", "headers": {}, "body": "<bytes>"}}
{"pass":   {"request": {"…": "the package, rewritten"}, "principal": "<33 bytes>", "blocks": ["<cid it put>"]}}
```

`reject` and `answer` end the request: the transport answers with them
(signed on the request's session when it is signed) and **nothing is
logged**. `pass` hands the request on to the next filter, or to the handler:
optionally rewritten (a package of the same kind), optionally with a
**principal** (who it is from, a 33-byte key), optionally with blocks it
stored, which the entry then references (as `kernel.beef`'s pointer
records). A filter writes no heads.

An app declares the functions any route may list as filters — its own as
`"<filter>"`, any other app's as `"<app>.<filter>"` ("it really is just a
library at that point"):

```json
"filters": {"quote": "validator.quote", "page": "p2p.serve", "check": "validator"}
```

Each value is a handler: `"<role>.<fn>"`, `"<fn>"` (an app with one
program), or `"<role>"` (its function named as the filter: `check` above
calls `validator`'s `check`). The filter is called as a kernel call, `fn`
the function, its argument (dag-cbor):

```
{transport, request: <the package as it stands>, match: <the route>, principal?, caller?,
 method, path, route, query, headers, body, contentType}        (the last line: http only — the route
                                                                  handler contract's fields)
```

The kernel's own filters:

| filter | runs on | does | yields |
|---|---|---|---|
| `kernel.brc104` | http | the BRC-104 request check: the session (the front door's table, `frontdoor/sessions`, by the request's `yourNonce`; not past `defaults.sessionTtlMs`) and the signature over the request (SimplifiedFetchTransport's payload), through the signer. No x-bsv-auth-* headers, an unknown or expired session, a bad signature: reject 401 (a stock client shakes hands again); a malformed one: 400 | **principal**: the client's key; the session the answer is signed on |
| `kernel.beef` | any byte string in the package that starts with a BEEF pattern | decoded; every BUMP checked against the chain app's headers (`chain/state`); each transaction stored once as its `bitcoin-tx` block, each BUMP and its merkle nodes; the bytes replaced by the pointer record (docs/VM.md "The door"). A BUMP that does not check, or no chain state: reject 400. No BEEF at all and no principal from an earlier filter: reject 400 "nothing to validate" (#135: signed or validated) | **blocks**: the pointer records (`door.beefs`) |

`kernel.brc104` then `kernel.beef`: signed, and validated if it carries a
BEEF. `kernel.beef` alone: anyone, if the payload validates (an overlay's
`/submit`). No filter: anyone (a route whose handler judges for itself).
(The BRC-169 envelope filter is to come.)

### Roles

A role is a name that gates functions. The standard roles are `root` —
Unix semantics: it passes every check, any function, any route, any grant;
several keys may hold it — and `user`: any principal at all (a request that
came through an identity filter). An app's own roles are declared in its
manifest, each listing the functions it gates, and are granted as
`<app>.<role>`:

```json
"roles": {"admin": ["config", "pause"], "user": ["swap"], "root": ["wipe"]}
```

The **gate** is the dispatcher's: the route matched, its filters run; if the
handler's function is gated by a role, the principal the filters yielded
must hold one of those roles — root passes anything, `user` passes any
principal, no principal fails closed (401), the wrong one 403 — and only
then does the handler run as the logged step. A function no role lists is
open to whatever the route's filters let through. "An individual key is a
role with one holder": a function only one key may call is a role granted
to that key.

A **grant** maps a role to keys. The grants are kernel state, the head
`grants` (`{kind: "grants", roles: {<role>: [<key>…]}}`), changed only by
the kernel's admin operation `grant` — `{op: "add" | "remove", role,
principal}` in box `grant`, from root (v1: only root grants). The genesis's
`root` names the first root holders; an image has none, and its claim
grants root to the claimant. **The install grants nothing**: "the person
who's doing the deploying is root and doesn't need to grant themselves
anything."

### The other fields

| field | meaning |
|---|---|
| `name` | the app's name: its box (§4), the prefix of its paths and of every head it writes (`<name>/app` its root), and of its roles (`<name>.<role>`). Unique on the instance. Not a stock box, head, program or role (`objects`, `head`, `dispatch`, `peers`, `grant`, `grants`, `root`, `user`, `kernel`, `frontdoor`, `messagebox`, …) |
| `version` | semver; shown by the site, compared by `requires` |
| `programs` | the app's programs by role name, relative to the tree (`bin/*.wasm`, or `bin/*.cid` for a module the instance already holds; `bin/<x>.json` beside it gives the program record's `{inputs, services, description}`), a bare name: a program the instance already has by that name in its genesis, or a map `{code: "shell", modules, support?}`: a shell program whose modules are files of the tree (§6b; #83). Handlers and filters name these roles. The program record the install writes for each carries `app: <name>` — the kernel's write-scope rule reads it |
| `config` | per-program configuration the programs read from the app record (the overlay engine reads `config.overlay`, §6; the app's own program `config.<name>`). Changing it is a new manifest and a head advance (root), or a `writes: true` function the app offers (§4) |
| `provides[]` | interfaces this app implements: `interface` is `<name>/<major>`; `functions` maps each function to `writes` (true: it may put records, move heads, emit; false: it reads only), `args` and `answer` shapes (dag-json schema: `string`, `int`, `bytes`, `cid`, `ms`, `bool`, `map`, `any`, `[shape]`, `{key: shape}`; a `?` suffix on a key = optional). `writes` is required |
| `requires[]` | interfaces this app calls on others, bound by name at install (§3 step 0) |
| `start` | optional: a message root sends into the app's box (a `mailbox` route at it) as the last install message; sending it again is the restart. (#76) |
| `stop` | optional: a message root sends into the app's box at uninstall, before its routes are removed. (#76) |

**Gone** (#143): `dispatch` (now `routes`), `reads` (a read is a route with
filters and no handler), `sender` and every `$owner`/`$self`/`$<provider>`
placeholder, `optional`, a route's `filter` (now `filters`, a list); the form
before #77 (`handler`, `boxes`, `heads`) since #79. Each is refused by name.

**The app declares; it never installs.** Every route is a request root
approves (§3): the install prompt is the routes, filters and roles read
aloud.

**The app record** — the root of `<name>/app`, written by the install
(built):

```
{kind: "app", name, version,
 programs: {<role>: <program record CID>},       the manifest's paths resolved
 routes: [<route as the manifest wrote it: relative addresses, handlers, filters as written,
          `transport` filled in>],               with what config.overlay derives (§6)
 filters?: {<filter>: <handler>},                with the overlay's derived `lookup` (§6)
 roles?: {<role>: [<fn>…]},
 config?, provides, requires, start?, stop?, description?,
 tree: <the app's git tree CID>,                  etc/app.json as shipped, bin/, www/, …
 state?: <the app's own state record>}            the handler's (§1); kept across installs
```

The kernel reads `filters` (to run `<app>.<filter>`) and `roles` (to gate
the app's routes' functions) from this record. Each route the install
sends is the kernel's shape: `{transport, address: <as served>, prefix?,
filters?: [<in full: an own filter as "<app>.<filter>">], program?: <the
handler's role's program record>, fn?, app, …settings}` — a read route has
no `program`.

So "list apps, read their manifests" is one read per `*/app` head:
`head("<name>/app")`, `get` — a root of `kind: "app"` is an installed app.

## 3. Install: root's messages to the kernel's admin boxes

Each is a message at one of the kernel's admin boxes — the kernel's own
operation on one of its tables, no program stepped (docs/VM.md "The
dispatch table"), gated by root (#143: every admin operation is root's).
An install writes objects, a head and routes, and **no key** (#143: "the
person who's doing the deploying is root and doesn't need to grant
themselves anything"); who else may run the app's functions is root's
`grant`, separately. (Read "the owner" below as root: #143 renamed it, and
it is a role now — several keys may hold it.) A management site is the
permission prompt: it reads the manifest, shows what the app asks for, and
has root's wallet sign the messages — one click sends them all; steps are
fine. Building the messages is a library; signing them is root's key's
(#124: the same messages from any BRC-100 wallet). The reference client is `skein install
<catalog-name | url#commit | dir> (--instance <handle> | <origin>)
[--config <file.json>] [--dry-run]` (src/client/admin-cli.ts over
src/client/admin.ts and src/host/plan.ts; built, #72/#76/#77/#124/#142): it
prints the prompt (the lines below), signs each message in its own process
with the operator's key (`SKEIN_OPERATOR_KEY`, default
`$SKEIN_HOME/operator.key`) and sends them in order — on the host machine
over the host's control socket (`--instance`), anywhere else on one BRC-104
session with the instance's origin. `--dry-run` prints the messages
(`{"message": {"recipient": <the instance's key>, "messageBox": <box>,
"body": <DAG-JSON>}}`, one a line) and sends nothing (docs/BOOTSTRAP.md
"Installing an app").

0. **Check.** The manifest (§2). Every `requires` interface is provided by
   some installed app (each `*/app` head's root record, `kind: "app"`, its
   `provides`). The name is free (no `<name>/app` head, or one whose root is
   this app's earlier record). No route takes a key the genesis's routes,
   root's own or another app's have. Another app's filter a route lists is
   one that app's installed record declares (#143). Then the prompt: the
   head, each route (`route <transport> <address>[ prefix] [<filters>] →
   <role>.<fn> | (a read: its filters answer, nothing logged)`), each
   filter it declares, each role and what it gates, `start`/`stop`,
   `requires`/`provides`, what an overlay publishes (for information), and
   the messages to be sent. Nothing is sent unless the
   owner sends it: the page's "Approve and send", or `skein install`
   without `--dry-run`.
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
   head's root is the app record, which links the tree; its name's app is
   the app. (#143: there is no reads head — a read is a route.)
3. **`dispatch`** — one per route: `{op: "add", row: {transport, address:
   <as served>, prefix?, filters?: [<in full>], program?: <the handler's
   role's program record>, fn?, …settings, app: "<name>"}}` — no sender
   (#143); a read route has no program. The kernel adds it to its table
   (replacing the route with the same key).
   (Built, #77, #143.)
4. **`start`** (if the manifest has one) — the owner sends the declared body
   into the app's box. The app's handler runs its first step: scheduling
   ticks with `$cron`, announcing itself, whatever it declared. (Built, #76.)

**Two paths to the tree** (#91). Step 1 is how the tree reaches the
instance, and there are two ways:

- **A directory on the client's machine.** `skein install <dir>` reads it
  and sends what the instance lacks as `objects` (≤ 1 MiB a message; a
  larger record, a module, alone in its own). For a tree the instance holds
  already (an image's app) that is nothing: the head and the rows.
- **The git app clones in the VM, by hash** (built, #91; the client's path
  for a repository, #142: `skein install <url>#<commit>` or a name from the
  instance's catalog). With
  [shruggr/skein-git](https://github.com/shruggr/skein-git) installed (name
  `git`, box `git`, its `call` gated by root, interface `git/1`), a page
  needs two root-signed steps and no `objects`:
  1. `{fn: "git.clone", args: {url, hash}}` to box `git` — `hash` a commit
     id, the user's intent. The git app records `fetch` intentions (#126:
     the host's HTTP proxy, signed by the instance's key, docs/MESSAGES.md
     "Intentions") for the repository's
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
site is an app, shruggr/skein-site (name `site`): one function serving
its own tree's `www` (the head `site/app`'s record, its `tree`, through
skein-sdk's `files`) as one read (#135), `/site/*`; the page is the installer
(there is no installer program). The default image installs it at birth
(#141, docs/BOOTSTRAP.md "The default image"), with root's read route at
`/`: a new skein answers its page at its root. **The path `/` is root's**:
an app's paths are under its name, and root may add a route of its own —
the read route `{transport: "http", address: "/", prefix: true, filters:
["site.get"], root: "www"}` (#143: the site's filter `get`, which its
manifest declares) — to serve the page at `/` (and its `manifest.json`,
the wallet's grouped request, at the origin's `/manifest.json`). A
manifest has no field for it: the install shows the app's own routes only,
and the site's README says how. The route carries no `app`, so the site's
upgrade or uninstall leaves it; as a prefix at `/` it takes every path no
exact route, or longer prefix, takes. Connected to the owner's wallet, it reads the
skein through its explorer (`/explore`, the owner's message route, docs/MESSAGES.md),
which gives it what the plan needs: the heads (the reads head among them), the genesis, the claim, the
address book, the dispatch table (the chain `{kind: "dispatch"}`) and any
record by CID. It plans with the same code as `skein install`
(src/host/plan.ts, bundled into the site) and shows the plan as the prompt;
on approval it sends the messages, signed by the wallet on a BRC-104
session. The page and the client `skein` are two ways to the same
messages: none of it is the host's (#124).

- **The git app is there.** The default image installs it at birth (#141)
  with its route — box `git`, its `call` gated by root (#143: what `$owner`
  was is a role now) — so after the claim root may use it at once. The host
  skein (#142) is born with it and with the operator's key as root.
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
  `/manifest.json` of the skein's own origin by the owner's root read (#125, #135), asks a BRC-100 wallet once for
  the page's protocols and its basket, and declares the counterparty
  protocols (one prompt per new skein or certifier).

Who can install is root (#143): every admin operation (`objects`, `head`,
`dispatch`, `peers`, `grant`) is gated by root, and root's holders are the
genesis's `root` and whoever root grants it to. An untrusted app cannot tie
itself to anything — the worst it can do is ask.

**Install after the claim** (#89, #143). A skein started from the default
image (docs/BOOTSTRAP.md "The default image") has no root until it is
claimed: an install into it is refused (the gate: no one holds root). The
claim — the claimant's own message in box `claim` (#127: `skein claim
<where>`; or, for a hosted registration, signed by the claimant's wallet
before the instance existed and forwarded by the host's instance manager) —
grants root to its sender; from then on root installs exactly as above. The
apps the image installed at birth (#141: chain, git, site) are there
already, with their routes.

**Reconfiguration** is the same messages again. Installing an app that is
installed (its `<name>/app` head's root is an app record) is the upgrade:
the new app record keeps `state`; routes the old record had and the new one
does not are removed (removes first), rows the table already holds as asked
are not sent again; `start` is sent again (the restart). Change or revoke a
single route with a `dispatch` message (`skein routes`). All in the log. Deploy-by-message
with a payment (#11) is the same `objects` message with a toll.

**Uninstall** (`skein uninstall <app> <where>`, or the page; built):
the `stop` message if declared, into the app's box while its rows still
stand; then a `dispatch` remove for every row the table holds with `app:
<name>`. The heads are left (prunable), the app record and state with them.

## 4. Calling an app: one box, the function in the body

One box per app for its calls, named after it (its other boxes, `<app>/x`, are
its own wiring, §2). The body names the function, dotted
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
  message. Who may run it is the gate's (#143: the route's function, its
  roles, the sender's grants).
- **An HTTP route** `{"transport": "http", "address": "/call", "filters":
  ["kernel.brc104"], "handler": "<role>.call"}` (served at `/<app>/call`):
  the request body is `{fn, args}` (JSON, or dag-cbor as
  `application/cbor`), POST; the route handler turns it into the same
  call, and the client gets `{fn, result}` (200) or `{fn, error}` (400
  `bad-request`/`bad-args`, 403 `not-admitted`, 404 `unknown-fn`, 409
  `read-only`, 500 `failed`) on the connection, signed on the session, when
  the request's thread finishes (docs/MESSAGES.md "Route handlers", "A
  synchronous client waits on the thread"). Synchronous. The caller is the
  principal kernel.brc104 yielded; the route's function `call` is gated as
  any is (#143: `roles`), and the app's helper may check `args.fn` against
  the caller itself.
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
`launch`, `deadline`, `awaitRecord`; `sk.fetch` / `sk.authfetch` for HTTP
(#126). (There is no `subscribe` import: the dispatch table is the
kernel's; an app takes a libp2p topic, or beats a beacon, by emitting the
event.)

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
example: its own `/onboard/call` (behind `kernel.brc104`) takes `{fn:
"onboard.create", args}` in the same shape, launches a thread that asks the
instance manager, and answers `{fn, result | error}` from that thread's
result.

## 5. Security model, in one place

- **Routing and permission are apart** (#143). A route says where a request
  goes and which filters it passes, never who sent it. Who may run a
  function is the gate's: the roles that gate it (the app's `roles`; the
  standard `root` and `user`), the principal the route's filters yielded,
  and the grants (the head `grants`). Root passes every check. No principal
  fails closed at a gated function.
- **What a skein decides from is logged.** Filters run before anything is
  recorded, over the request and the state as it stands, in the
  deterministic profile; what they reject or answer writes nothing; what
  they pass is the entry (with its principal and the blocks they stored),
  and the handler runs as its logged step. Every other requirement —
  signing, the host's boundaries — is product policy layered on top: a
  route that names `kernel.brc104` takes signed requests only.
- **The admin operations are the kernel's.** `objects`, `head`, `dispatch`,
  `peers` and `grant` are kernel operations on admin messages, gated by
  root — no program, elevated or otherwise. Every program emits as the
  instance, and the instance's own key holds no role unless root grants it
  one (#87): a program's admin message is gated away — recorded, nothing
  runs. Granting another key the right to install or reconfigure is a
  `grant` of root by root — explicit, logged.
- **An app writes only heads under its own name.** That is the whole
  write-scope rule, enforced by the kernel: `advance` is allowed when the
  head's name is `<app>/…` for the stepping program's app (its record's
  `app`). Two apps cannot write each other's heads; they read each other's
  freely, by CID. A genesis-wired program writes only what its genesis
  `scopes` name. No exceptions (#79). The scope comes only from a record
  root installed — a genesis program, a dispatch row's program, or one
  listed in the app record at `<app>/app` (K1): a record a program puts
  itself, claiming another app (`app: "chain"`) or a genesis-wired name,
  runs when launched or called and writes no head (docs/VM.md "Heads").
- **Reads are global.** Holding a CID is the permission. Data meant to be
  private is encrypted; nothing in the store is unreadable to a program
  that can name its CID.
- **The shell cannot reach app heads.** A shell tool that needs an app's
  data asks the app (a call), or a later shell feature mounts heads as
  directories (the shell app's `mount`, shruggr/skein-shell#1) — a shell concern, not an app's.
- **A manifest is a request.** Routes are approved by root at install, and
  the install grants no key;
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
unknown field, as is any field other than `topics`, `lookups`, `gossip`,
`market` and `validator` (and, in a lookup service's object form,
`program`, `topics`). `market: {window: <ms>}` and `validator: {every:
<ms>}` (skein-overlay 0.9.0, #120) are the engine's own settings, read from
the app record as `topics` is; the install checks their shape (a positive
integer of milliseconds) and derives no rows from them.

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
it into the concrete routes root approves, all to the role `overlay`,
marked "(derived: config.overlay)" in the prompt (#143):

- the app's own box `<app>` twice: an `event` route (what its libp2p routes
  admit: a gossiped submission, a peer's admit) and a `mailbox` route (its
  own watch, by the host's loopback — #143: no `$self`; the engine judges
  the sender);
- the http route `/<app>/submit` (`filters: ["kernel.beef"]`, #121, #135:
  a plain request whose BEEF validates, so the stock TopicBroadcaster's POST
  is admitted) and the **read route** `/<app>/lookup` (`filters:
  ["<app>.lookup"]`, BRC-24's POST answered by the engine's `lookup` as a
  filter — anyone, signed or not, nothing logged; the filter `lookup` →
  `overlay.lookup` derived into the record's `filters` unless the manifest
  declares its own). The app's base URL is what it advertises;
- libp2p routes `<topic>` (raw submissions, `overlay.submit`, `filters:
  ["kernel.beef"]`), `<topic>-admit` (`overlay.peerAdmit`) and
  `<topic>-proof` (`overlay.peerProof`) per topic (#74).

No `chain`, `chain/status` or `submit` box (the chain app's, and the app's own
box), no grants. The engine's three boxes (skein-overlay 0.7.7, #128; 0.9.2 current):
`<app>/submit` takes submissions, by message and by POST `/<app>/submit`,
from anyone (`filter: "beef"`; the manifest's own row, address `"submit"`);
`<app>/register` takes register / deregister from the owner (the manifest's
row, address `"register"`); `<app>` takes only the derived rows above, events and `$self`. An explicit row in the manifest with the same key
overrides the derived one, as an explicit read at `/lookup` overrides the
derived read. The listings and the documentation (`/listTopicManagers`,
`/listLookupServiceProviders`, `/getDocumentationForTopicManager`,
`/getDocumentationForLookupServiceProvider`) are reads the manifest
declares itself (`reads[]`, #135). The stock TopicBroadcaster's plain POST
`/submit` is a 401 (#135): a submission is a signed request — the stock
AuthFetch does not carry BRC-22's `X-Topics` header (it signs only
content-type, authorization and `x-bsv-*`), so a signed HTTP submission
names its topics beside the signed headers, or goes by message into
`<app>/submit`. The host's libp2p node subscribes the derived
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

(#143: the manifest below is the chain app's as it stood before routes,
filters and roles; its #143 form is its own repository's — and the default
image's copy, `images/default/apps/chain/etc/app.json`.)

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
- The `status` row (the box `chain/status`, #128: relative to the app, §2)
  takes the status provider's messages; `optional`, so a
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

Installed: `skein install https://github.com/shruggr/skein-chain#<commit>
<the instance's origin>` (the default image installs it at birth, #141); at boot: `bin/chain.wasm` in the system tree and its
rows in `etc/dispatch.json` (its program, named `chain`, writes `chain/…`
under its default scope). kernel-zig/equiv/chain.ts does both.

## 6b. Worked example: the shell app and the chat app (#83)

(#143: "from `$owner`" below is a function gated by root in the apps' own
#143 manifests.)

A skein has no userland of its own: the genesis wires the boundary
programs (front door, messagebox, resolve) and nothing else. The shell and
the chat loop are two apps, each installed when an instance wants it: an
agent's skein needs the chat loop and no shell, a developer's the shell and
no chat loop, an overlay's neither.

**The shell app** ([shruggr/skein-shell](https://github.com/shruggr/skein-shell),
name `shell`, heads `shell/…`) is the whole userland: `run` (the box `shell/run`,
written `"run"` in its manifest, from `$owner`: a command over a tree, the answer in the sender's `results`)
and the shell itself — brush, uutils coreutils, the toolset (find, xargs,
diff, cmp, jq, which, grep, tree, awk, sed, git, qjs as `node`, python as
`python3`) and python's standard library, all files of its tree. Interface
`shell/1`.

**The chat app** ([shruggr/skein-chat](https://github.com/shruggr/skein-chat),
name `chat`, heads `chat/…`) is the turn loop: box `chat`
(who may chat: the app's roles and the grants, #143). Interface `chat/1`.
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
| no message admitted as the host's word: `admit` takes no `mail` entry; the browser page sends its own messages on its session with its instance (#126 step 4: `http` requests) and admits nothing from its mailbox instance; `append` writes only the genesis entry | built, enforced (K2, K24: src/host/admission.test.ts) |
| heads with owners; `head`/`advance`/`get`; the write scope by name; the kernel's `objects`, `head`, `dispatch`, `peers` operations | built (#77) |
| the dispatch table (routes, boxes, libp2p topics as rows); route handler contract; synchronous answer on thread completion | built (#68/#66, #77; #115: the kernel matches every transport, kernel-zig/src/dispatch.zig, and the front door verifies). The `/<app>/` prefix of an app's http rows is checked by the install client (src/host/manifest.ts), not by the kernel's `dispatch` operation |
| topic contract (`identify`); lookup contract (hooks + `lookup`); lookup state under `<app>/ls_<service>`; the contract as a Zig module | built (#50, #79: skein-overlay 0.3.0) |
| manifest schema (`programs`, `routes`, `filters`, `roles`, `config`, `provides`/`requires`, `start`/`stop`); the app record at `<app>/app`; `requires` check; `writes` validation; `dispatch`, `reads`, senders refused | built (#72, #77, #79, #143: src/host/manifest.ts, install.ts; the SDK's `app`; the forms before #77 and #143 refused) |
| the kernel's door: a route's filters before anything is recorded (`kernel.brc104`, `kernel.beef`, an app's own in the deterministic profile); reject and answer write nothing; read routes; the gate (root, `user`, app roles) and the grants head with the `grant` operation; `genesis.root`; the claim grants root | built (#143: kernel-zig/src/dispatch.zig, door.zig, grants.zig, scheduler.zig `door`) |
| install client (manifest → objects + head + dispatch + start, the prompt; no key, #143); `skein install <catalog-name|url#commit|dir>` / `uninstall`, signed in the client with the operator's key, sent over the host's control socket or one BRC-104 session (a repository cloned in the VM by the git app); `--dry-run`; `start`/`stop` | built (#72, #76, #77, #124, #142, #143) |
| deploy by hash: the git app (shruggr/skein-git) clones one commit in the VM through the fetch provider and answers the app record; the client rebuilds it from the stored tree and sends `head`, `dispatch`, `start` | built (#91: §3; src/host/install.ts `readStoredApp`) |
| the management page: an app (shruggr/skein-site, its page at `/site/`, its own tree's `www` served by skein-sdk's `files`; the owner's `/` read); install, uninstall and the address book from a browser, planned with src/host/plan.ts over the explorer's reads; chain, git and site installed at birth in the default image (#141) | built (#92, #125: §3; shruggr/skein-site 0.7.3, with the Inbox, #99, handles, #103, profiles, #104, and the grouped permission request, #97) |
| root's own http route to an app's handler (`skein routes add --transport http`; no `app`: an upgrade or uninstall of the app leaves it) | built (#125, #143: src/client/admin.ts `planRoute`) |
| libp2p rows installed by apps; the host's libp2p node follows the dispatch table (subscribe/unsubscribe, handle/unhandle, live) | built (#72, #77: src/host/p2p.ts `libp2pConfig`, router.ts `syncDispatch`) |
| an overlay app's wiring derived from `config.overlay` and shown in the prompt | built (#72, #77, #79: src/host/manifest.ts `overlayWiring`) |
| one box per app, `{fn, args}` dispatch, answer message; SDK dispatch helper; the `/call` row | built (#72: skein-sdk `app`; 0.3.0 reads `<app>/app`) |
| the overlay engine reads `config.overlay` from its app record `<app>/app`, at every step (the genesis `overlayTopics`/`overlayLookups`/`overlayGossip` only without one); a program finds its app from its program record's `app` | built (#72, #79: skein-overlay 0.3.0 `src/config.zig`) |
| the chain under `chain/` (one chain module, shruggr/skein-chain: ingest, broadcast, answers on each state change); `optional` rows; no open box (`event`, `$self`, `$owner`) | built (#78, #79, #121: §6a; skein-chain 0.3.0; skein-sdk 0.5.0 `chain`) |
| the wallet and each overlay under their own names, reading `chain/…`, ingesting by message (the wallet is a genesis-wired program the kernel pins, with scope `wallet/`, not an installable app: it has no `etc/app.json` and `wallet` is a reserved app name); two overlay apps on one instance; the sibling apps' manifests in the #77 shape | built (#79: programs/wallet, skein-overlay 0.3.0, skein-static 0.2.0; skein-shell and skein-chat 0.1.0 since #83) |
| the shell and the chat loop as apps (shruggr/skein-shell, shruggr/skein-chat); a shell program declared in a manifest, its modules files of the tree; no shell in a genesis | built (#83: §6b) |
| a multi-tenant overlay's `overlay.topics/1` / `overlay.lookups/1` | optional, not planned |
| apps in their own repos; the SDK as a Zig package | built (#71, #75): shruggr/skein-sdk (a sibling repo, consumed by URL+hash, not a submodule; 0.4.0 since #78: the `chain` module split out of `wallet`), shruggr/skein-shell, shruggr/skein-chat, shruggr/skein-site, shruggr/skein-overlay (the engine and its demo topic/lookup, with `etc/app.json`; equiv/overlay.ts clones it) |
