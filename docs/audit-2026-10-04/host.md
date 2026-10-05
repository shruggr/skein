# Host process audit against ARCH.md / MESSAGES.md / VM.md (skein @ 6658a45)

Scope: src/host/*.ts, bin/skein-host, scripts/host/. Read-only. Line numbers are at 6658a45.

### H1 · POST /account/register: a second instance-creation path, outside the manager and the host skein
- **Kind:** duplicate
- **What:** `POST /account/register` is answered by the router itself. It verifies the caller's signature, then `addMailbox()` inserts a `kind='mailbox'` row straight into host.db `instances` (status defaults to `enabled`, so the hostname is published at once). The store and genesis are only written later, at first hydration, by code genesis with the owner baked in. There is no image and no claim, no message to the instance manager, no session, and no entry in any log (the host skein's included). The answer's handle certificate is issued on the fly (`issueSubjectCertificate`) and stored nowhere. Its serial is recomputed from handle+domain+key (`serialOf`), so the only record of the binding is the host.db row.
- **Evidence:** src/host/router.ts:1090 (route), 1110-1130 (`register`: JSON parse, `verifySignature` at 1119, `addMailbox` at 1124, `issueSubjectCertificate` at 1125); router.ts:881-894 (`addMailbox`: `db.add(name, {domain, kind:"mailbox", owner, store})` at 891); src/host/instances.ts:34 (status default `enabled`); router.ts:847-851 (mailbox genesisConfig: owner in the genesis, no claim); src/host/handles.ts:136-138 (`serialOf`), 155-158 (`issueSubjectCertificate`); scripts/host/register.ts (client).
- **Design says:** ARCH.md "The host skein (#90)": "The instance manager … creates, starts and stops this host's instances. It acts only for the host skein" and "What about the host is state or conversation belongs in it". ARCH.md "The host": "It verifies nothing and routes nothing". MESSAGES.md "The persistence rule": "Every package a transport carries in is appended as received". MESSAGES.md "The address book": "Registration is application wiring, not core: nothing registers itself".
- **Options:** Move registration into an app on the host skein (an onboarding function) that asks the manager to `create` a mailbox, so it becomes an entry and a record. · Keep the router route but have it only append a request into the host skein. · Keep as is and document it as a sanctioned exception in ARCH.md. · Drop it and make mailbox creation go through `onboard.create` with an image variant.

### H2 · The router's own origin is an app with no instance: manifest, resolve, search, paymail, profile
- **Kind:** belongs-in-instance
- **What:** At the router origin the host answers `/manifest.json`, `/.well-known/metanet-handles/resolve`, `/.well-known/metanet-handles/search`, `/bsvalias/id/…` and `/account/register` from host.db and the master-derived certifier. None of these requests is an entry anywhere. To build its answers the host opens each instance's SQLite store read-only and reads the head `profile`, verifies the profile signature, and derives `displayName`/`avatarURL`. Search does this for every enabled row on every request.
- **Evidence:** router.ts:1050-1092 (`dispatch`: router-level routes after `target()` misses); router.ts:643-657 (`profileOf`: `openStoreFile(row.store, {readOnly:true})`, `headTree(s, PROFILE_HEAD)`); router.ts:665-681 (`search`: loops `db.list("enabled")`, `profileOf` per row); handles.ts:111-133 (`verifiedProfile`, `profileFields`: signature verification in the host); handles.ts:82-86 (manifest); instances.ts:176-180 (`identityOf` is the resolver's source of truth).
- **Design says:** ARCH.md "The host": "A host is transports + providers + store + oracle. It verifies nothing and routes nothing". ARCH.md "Discovery" lists these routes as host functions, but MESSAGES.md "Calls" says host-side reads go through a kernel `call`, and ARCH.md intro says "every package a transport carries in is appended to the log". MESSAGES.md "BRC-169 is discovery": "It is a program, not the core".
- **Options:** Make the BRC-169 server (manifest/resolve/search/profile) an app in the host skein, with the router origin mapped to the host skein. · Keep it in the host but have it read through a kernel `call` on the owning instance rather than opening store files. · Keep as is and narrow the ARCH.md wording ("verifies nothing", "every request is an entry") to instance origins only.

### H3 · The manager can create an instance named `id`, which then takes over the router's origin
- **Kind:** miswired
- **What:** `RESERVED_HANDLES` (`id`, `host`) is checked only in `register()`. `createInstance()` (the manager's `create`, and `init`) checks only the hostname grammar and whether the handle is taken. `dispatch()` tries `target()` before the router routes, and `target()` routes any hostname whose first label is an enabled handle. So an instance created as `id` would get every request to `id.<domain>`, including the production manifest, resolve and register origin (memory: id.skein.nexus).
- **Evidence:** router.ts:208 (`RESERVED_HANDLES`), 1122 (used only in `register`); router.ts:783-790 (`createInstance` checks: HANDLE, KEY, image, taken, store exists; no reserved check); router.ts:1012-1020 (`target`: first hostname label); router.ts:1056-1061 (target before router routes).
- **Design says:** ARCH.md "Discovery": "on the router's own origin — a hostname whose first label is no instance". MESSAGES.md "Mailbox instances": 409 for "`id` or `host`".
- **Options:** Check `RESERVED_HANDLES` (plus the router origin's own first label) in `createInstance`. · Have `target()` exclude the router origin's hostname explicitly. · Leave reservation as the onboarding app's policy.

### H4 · Instances the manager creates get domain `localhost`, whatever the host's domain is
- **Kind:** miswired
- **What:** `createInstance` inserts the row without a `domain`, so the column default `localhost` applies. That domain goes into the image genesis (`imageConfig` uses `row.domain`) and into host.db. Resolve looks up `(handle, domainOf(request hostname))`. On a deployed host, an onboarded skein is therefore unresolvable at the host's real domain, while a registered mailbox gets the request's hostname as its domain. `Router.claim` also defaults a claim's `domain` to `localhost`.
- **Evidence:** router.ts:790 (`db.add(handle, {store, status:"disabled"})`); instances.ts:26 (`domain … DEFAULT 'localhost'`); router.ts:730-737 (`imageConfig` domain from row); router.ts:1074-1080 (resolve keyed by request hostname); router.ts:1090 (register uses `domainOf(url.hostname)`); router.ts:756 (claim `domain ?? "localhost"`); cli.ts:432-433.
- **Design says:** ARCH.md "Discovery": `SKEIN_ROUTER_ORIGIN` "is what the manifest publishes … and what geneses record as `resolveOrigin`". MESSAGES.md "BRC-169 is discovery": resolve without a domain uses "the request's hostname".
- **Options:** Derive a created instance's domain from `SKEIN_ROUTER_ORIGIN` (as `/.well-known/skein-host` does). · Make `domain` a `create` argument from the host skein. · Make the domain a host-wide setting in host_settings.

### H5 · Six ways to create an instance and three ways to start or stop one
- **Kind:** duplicate
- **What:** Instances can be created by: (1) the manager's `create` (`createInstance`, image + claim); (2) `skein-host init` (`createInstance` through a one-shot router, then `db.setStatus` by hand); (3) `skein-host add <h>` (a bare row; code genesis at first hydrate with `SKEIN_OWNER` as owner); (4) `add --boot/--packet/--image` (`bootRow`, no claim unless `skein-host claim` follows); (5) `add --mailbox`; (6) `POST /account/register`. Instances can be started or stopped by the manager's `start`/`stop`, by `skein-host enable|disable|remove` (direct host.db writes), and by idle reaping. Only (1) leaves a record in any instance.
- **Evidence:** router.ts:783-806, 819-844 (manager); cli.ts:493-518 (init; `db.setStatus` at 515); cli.ts:197-240 (add; `db.add` at 223; mailbox at 209-216); router.ts:595-598 (code genesis on an empty store at hydrate); cli.ts:268-274 (enable/disable/remove: `db.setStatus`/`db.remove`); router.ts:881-894 (addMailbox).
- **Design says:** ARCH.md "The host skein (#90)": "The instance manager … creates, starts and stops this host's instances. It acts only for the host skein".
- **Options:** Route every CLI create/enable/disable through the host skein (the operator's client sends to the host skein, which messages the manager). · Keep the CLI as the operator's out-of-band path and say so in ARCH.md. · Remove the code-genesis and `add` creation paths now that images exist.

### H6 · Two certificate issuers, no issuance record, no revocation, the same serial on reissue
- **Kind:** duplicate
- **What:** The host issues the handle certificate twice over. Resolve issues a plaintext-field certificate on every resolution (`issueHandleCertificate`). Register issues an encrypted-field one with a keyring (`issueSubjectCertificate`). Both use the same deterministic serial `sha256(handle@domain key)`. Neither is recorded. Revocation is the disabled sentinel, so deleting or changing a row cannot invalidate a certificate already in a wallet, and re-registering the same binding later gives the same serial. Instances made by `create` get no holder certificate at all.
- **Evidence:** handles.ts:59 (`NO_REVOCATION_OUTPOINT`), 136-147, 155-158, 161-165; router.ts:1081 (resolve issues), 1125 (register issues); router.ts:819-826 (manager `create` issues none).
- **Design says:** MESSAGES.md "BRC-169 is discovery": "Revocation is not implemented: the host has no wallet … the five-minute ttl is all that bounds a resolver's copy". ARCH.md "The host skein": "What about the host is state … belongs in it".
- **Options:** Make certificate issuance a host-skein app function that records each issue (serial, subject, handle, time), with the certifier key used through the oracle. · Give the certifier a wallet-backed revocation outpoint (needs a host wallet). · Keep as is; record the limitation in OPEN.md as a decision.

### H7 · Handle namespace: one handle per key, a global primary key, and two meanings of "the handle's key"
- **Kind:** short-sighted
- **What:** `instances.handle` is the primary key across all domains, but resolve, paymail and search are keyed by `(handle, domain)`, and `target()` ignores the domain. `mailboxOf(owner)` allows one mailbox per key, so register refuses a second handle for the same key (409), and `add --mailbox` does too. For a mailbox row, resolve answers the owner's key. For an agent or image row (including onboarded ones), it answers the instance's own key. The same person can hold a mailbox handle and an onboarded skein under different keys in one namespace.
- **Evidence:** instances.ts:25-26 (PK handle; domain column), 176-180 (`identityOf` mailbox→owner, else identity), 203-206 (`mailboxOf`: one per owner); router.ts:886-888 (409 `already registered as`); cli.ts:212-213; router.ts:1012-1020.
- **Design says:** MESSAGES.md "Mailbox instances": "409: … or the key already has another handle here". The memory brief lists "several handles per key" as a next step. VM.md "Identity": "People … are known by their identity key".
- **Options:** Make `(handle, domain)` the key and allow several handles per owner. · Keep one handle per key per host as policy, owned by the registering app. · Split handle bindings (handle@domain → key) from instance rows into their own table or a host-skein head.

### H8 · The manager is not idempotent across a restart, and a failed create blocks the handle for good
- **Kind:** short-sighted
- **What:** The providers' "act once" set (`taken`) is in memory only. After a host restart the kernel hands every awaited emitted message over again, so a `create` that had completed (or half-completed) runs again. It then answers `{error: "handle … is taken"}` or "a store is at … already" to the onboarding thread. A refused or crashed create leaves a disabled row and its store on disk. The only cleanup is CLI `remove`, which keeps the store, and a later create still fails on `existsSync(store)`.
- **Evidence:** providers.ts:151-152, 192-196 (`taken` Set, capped at 100k); router.ts:787-789 (taken / store-exists refusals); router.ts:798 (refused claim leaves the row disabled, "its store kept"); cli.ts:271 (`remove` leaves the store).
- **Design says:** MESSAGES.md "emit": "At a start the kernel hands over again every emitted message a waiting thread still awaits; a host acts on a message once."
- **Options:** Persist the providers' taken set (or the manager's answers by request CID) in host.db. · Make `create` idempotent: the same handle+owner returns the existing answer. · Add a manager `remove` that also deletes the store.

### H9 · The manager acts for senders other than the host skein, and on rows it did not create
- **Kind:** miswired
- **What:** `skein-host claim` (via the control socket or a one-shot router) makes the manager send a claim on the operator's CLI request, with no host-skein message behind it. `start`/`stop` act on any host.db row except the host skein itself, including mailbox instances made by register and agents made by the CLI. No ownership check is possible, because host.db records no owner or creator for agent/image rows (`owner` is only filled for mailboxes).
- **Evidence:** router.ts:750-760 (`claim` sends as `manager`), 427-436 (control-socket `claim`); control.ts:10-16; cli.ts:531-571; router.ts:827-844 (start/stop on any row; only the host skein refused at 830); instances.ts:37 (`owner` is a mailbox column).
- **Design says:** ARCH.md "The host skein (#90)": "It acts only for the host skein … a message from any other sender is not acted on". MESSAGES.md "The providers" adds "It also speaks first: the claim … (`create`'s own, and `skein-host claim`)".
- **Options:** Limit start/stop to rows the manager created (record a creator in host.db or the manager's answer). · Retire `skein-host claim` now that `create` exists, or route it through the host skein. · Keep it, and amend ARCH.md "acts only for the host skein" to name the exceptions.

### H10 · Two profile readers: the head `profile` (resolve/search) and IDENTITY.md (roster, host page)
- **Kind:** duplicate
- **What:** Resolve and search read a signed `profile` head from the store (#104). The roster (`/roster.json` and the operator page on SKEIN_HOST_PORT) reads `- Name:`, `- Emoji:` and the other display lines from `IDENTITY.md` in the tree host.db's `tree` column names. That column is set by `skein-host deploy`, not taken from the instance's `main` head. So the same handle can show two different display names, from two sources, on two HTTP servers.
- **Evidence:** router.ts:643-657 (`profileOf`); roster.ts:1-14, 37-60 (`parseIdentity`, `rosterEntry` reads `row.tree`); cli.ts:1025-1036 (host page + roster server); cli.ts:802 (`db.add(row.handle, {tree, source})` after deploy); instances.ts:31-32 (`tree`, `source` columns).
- **Design says:** MESSAGES.md "BRC-169 is discovery", "The profile (#104)": the profile is the record under the head `profile`. ARCH.md "The host" lists no roster or host page.
- **Options:** Have the roster read the `profile` head (or drop displayName from the roster). · Retire `/roster.json` and the host page now that the management site exists. · Read `main` from the instance instead of host.db `tree`.

### H11 · Who knows whom (`knows`, ROSTER.md) is host.db state written into instances
- **Kind:** belongs-in-instance
- **What:** host.db `instances.knows` holds each agent's list of colleagues. `deploy` and `roster --deploy` turn it into a generated `ROSTER.md` at the tree root (moving `main`) and into address-book `peers` messages to every enabled agent, signed by the owner's wallet. The relationship graph between instances is kept in host.db, not in the instances.
- **Evidence:** instances.ts:33 (`knows`); deploy.ts:11-15 (host-generated ROSTER.md); roster.ts:12-14, 77-93 (`rosterFor` from `knows`); cli.ts:381-384 (`syncAgents` → `writeAddresses`); cli.ts:693-706 (`roster --deploy`); scripts/host/up.sh:119-123.
- **Design says:** ARCH.md "Everything outside is a peer": the address book "changes only through the kernel's `peers` operation, on a message signed by the owner". ARCH.md "The host skein": "What about the host is state … belongs in it".
- **Options:** Move `knows` into each instance (its address book is the source; ROSTER.md generated inside). · Move it into the host skein as the operator's record. · Retire `knows`/ROSTER.md (pre-#77 agent layout).

### H12 · The host decides with TS copies of kernel logic and reads store files around the kernel
- **Kind:** duplicate
- **What:** The router imports `takesMail`/`takesEvent`/`currentDispatch` from src/runtime/dispatch.ts, a TS copy of dispatch.zig's matching. It uses them to decide whether to hydrate an idle instance for a cron tick and whether to subscribe an instance to the host headers feed. For stopped instances it opens the SQLite store read-only and folds the dispatch chain itself; for running ones it asks the kernel's `dispatch` frame. Store files are also read directly for profiles (H2), roster, pack, deploy and install planning. If the TS matcher drifts from dispatch.zig, the host's decisions drift from the kernel's routing.
- **Evidence:** router.ts:97-98 (imports), 627-635 (`subscribes`: `openStoreFile` + `currentDispatch` + `takesMail`/`takesEvent`), 325-329 (cron wake), 934-941 (`followHeaders` uses `takesEvent`); src/runtime/dispatch.ts:20-24 ("Here it is only read — by the host"); cli.ts:353, 398, 590 (`openRow`).
- **Design says:** VM.md "The dispatch table": "The host (transports + providers + store + oracle) routes nothing: the dispatch table does". ARCH.md "The host": the store is "written by the kernel process"; reads are the kernel's `call` (MESSAGES.md "Calls").
- **Options:** Add a kernel frame "does any row take (sender, box)" and use it, hydrating if needed. · Have the kernel report its event/libp2p subscriptions on every dispatch change (emit-like), so the host only follows. · Keep the TS mirror and add a conformance test against dispatch.zig.

### H13 · The fuel ledger charges a caller named by an unverified header
- **Kind:** miswired
- **What:** A read call's fuel is charged to `req.headers["x-bsv-auth-identity-key"]`, taken as the client sent it. The front door verifies that header inside the instance, but the host charges against the raw value, so any client can put its read fuel on another key's account. The ledger is host.db state about callers of an instance.
- **Evidence:** router.ts:1145 (`charge(handle, req.headers["x-bsv-auth-identity-key"] ?? "", …)`), 980-994 (ledger); instances.ts:40-48 (`fuel_ledger`).
- **Design says:** ARCH.md "The host": "It verifies nothing … the instance's front door verifies them". ARCH.md "The fuel ledger": "the host's own kernel calls (the explorer's reads) are charged in host.db".
- **Options:** Charge the caller the front door's answer names (the request thread knows it). · Charge per instance only, with no caller. · Keep the per-caller ledger but label it unverified.

### H14 · The kernel's surface is about fifteen frames, not five, and the host writes the store directly
- **Kind:** stale-doc
- **What:** kernel.ts exposes tip, get, put, has, putblock, restore, append, genesis, boxes, byEnvelope, admit, answer, call, idle, start, running and dispatch, plus wallet and emit. The host uses `store.put` before admitting events (`admitEvent`) and requests (`appendRequest`). The boot loader pre-fills a store with blocks and writes the genesis "directly", and a checkpoint is restored with `restore`.
- **Evidence:** kernel.ts:1-17 (frame list), 180, 187; router.ts:485-493 (`store.put` then `admit2`); frontdoor.ts:70-73; boot.ts:12-26 ("written directly"), 215-247; genesis.ts:533-545.
- **Design says:** ARCH.md "The host": "The kernel's surface is five frames: in, admit …, answer …, call …; out, wallet … and emit". VM.md "Host": "Its surfaces into the machine are the kernel's frames: admit, answer and call in; wallet … and emit out."
- **Options:** Update ARCH.md/VM.md to list the real frames. · Reduce the frames (records carried inside `admit`, boot as an `objects` admin message). · Mark which frames are boot/test-only.

### H15 · `/.well-known/skein-host` is answered by the router on every instance's origin
- **Kind:** miswired
- **What:** `dispatch()` answers `GET /.well-known/skein-host` before it picks the target instance. Every instance origin therefore has one path the instance does not serve and cannot override, and that request is not an entry in the instance.
- **Evidence:** router.ts:1050-1055; router.ts:32-34 (header comment).
- **Design says:** MESSAGES.md "The instance as an HTTP server": "Each instance is an HTTP server at an origin of its own. Its front door … is the program that answers". MESSAGES.md "Mailbox instances" documents the route as answered "at every host name".
- **Options:** Serve it from the router origin only and have the site get the router origin another way (the instance's genesis `resolveOrigin`). · Have the instance answer it from its genesis facts (a static or front-door row). · Keep it, as documented.

### H16 · Created instances are recorded twice, and registrations once
- **Kind:** duplicate
- **What:** An onboarded instance is recorded in host.db `instances` (the manager) and in the host skein's `onboard/instances/<handle>` (the onboarding app). Nothing reconciles the two. Start, stop, CLI remove and enable change only host.db. Registrations through H1 exist only in host.db. The host skein's record therefore cannot say which instances exist or are running.
- **Evidence:** router.ts:790, 799-800, 832, 838 (host.db writes); ARCH.md:289-292 (`onboard/instances/<handle>` → the manager's answer); cli.ts:268-274.
- **Design says:** ARCH.md "The host skein": "What about the host is state or conversation belongs in it (today: the onboarding app and the instances it created) … host.db keeps its side tables (instances, …)".
- **Options:** Declare host.db the record and the onboard head a cache. · Declare the host skein the record and make host.db a projection rebuilt from it. · Have the manager speak first on every status change (a message to the host skein) so its record follows.

### H17 · The broadcaster's "who holds this tx" sweep hydrates every enabled instance; `status_seen` grows without bound
- **Kind:** short-sighted
- **What:** At a txid's first status since the router started, the broadcaster asks every enabled instance (mailboxes included) whether it holds the transaction, starting the kernel of each idle one. Later statuses ask the running ones. `status_seen` and the holder cache (100k) are never pruned in host.db. The host decides the routing here.
- **Evidence:** arc.ts:44-50, 221-228 (`all` vs `running` sweep); router.ts:341-342 (`instances`, `holds` hydrates); instances.ts:56-61 (`status_seen`), 230-236.
- **Design says:** MESSAGES.md "Broadcast out …": "into every instance whose state holds the transaction (a `has` read of its CID)". ARCH.md: "routes nothing".
- **Options:** Keep a txid → instance index fed by broadcast events and the chain app's ingests (no sweep). · Sweep only instances whose table takes `chain` events. · Prune `status_seen` by age.

### H18 · Instance identity is a function of (master secret, handle), and the host's origin is baked into each genesis
- **Kind:** short-sighted
- **What:** An instance's root key is the master's BRC-42 child with key ID equal to the handle, and its libp2p key uses `libp2p:<handle>`. Renaming a handle changes the identity, and moving an instance to another host needs the same master secret. Each genesis records the host's origin as `resolveOrigin`, the owner's messagebox URL, and the provider keys. Moving or splitting hosts means a new genesis.
- **Evidence:** oracle.ts:55-72 (`instanceKey(id)`, `peerKey`); router.ts:730-737, 847-873 (`resolveOrigin: this.origin()`, `ownerMessagebox`, providers in `addressBook`); router.ts:581-583 (row identity must equal the oracle's).
- **Design says:** ARCH.md "The oracle": "each instance's root key is a BRC-42 child of it (key ID = the handle)". The Monday goal (memory) is p2p across two hosts.
- **Options:** Key ID = a stable instance id (not the handle), with the handle a binding. · Per-instance secrets exportable with a backup. · Accept it; document a re-genesis as the move procedure.

### H19 · Code genesis with a host-wide owner is still a live path beside image + claim
- **Kind:** duplicate
- **What:** A row with an empty store is given the "stock system in code" at first hydrate. Its owner is `SKEIN_OWNER`, plus `infer`, `names` (default `david@localhost`), `ownerMessagebox` and host-supplied subscriptions/routes. The owner of every CLI-added agent is therefore a host-global setting, not a claim. Mailbox instances use the same code path.
- **Evidence:** router.ts:595-598, 846-873 (`genesisConfig`: `this.o.owner` required at 852); cli.ts:849-851 (`SKEIN_OWNER`, `SKEIN_OWNER_HANDLE` default `david@localhost`); genesis.ts:503-513 (`codeSystem`).
- **Design says:** ARCH.md "Genesis": "Without a tree the host writes its default system in code"; "The default image … carries the claim row instead". Memory "Storage hierarchy": "bare genesis + bundles".
- **Options:** Make every new agent an image + claim (drop code genesis except for tests). · Keep code genesis for mailbox instances only. · Keep both and document which is current.

### H20 · The host verifies in several places
- **Kind:** miswired
- **What:** Besides the register signature (H1) and the profile signature (H2), the host checks a few things itself. The header feed recomputes each chaintracks header's hash and drops mismatches. Providers verify each emitted message's signature and recipient before acting. The Arcade webhook checks a bearer token. GossipSub runs StrictSign. Some of this is documented (providers, StrictSign) and some is not (feed hash drop).
- **Evidence:** feeds.ts:84-99, 109-123; providers.ts:233-235, 258-265; arc.ts:391-393; p2p.ts:13-14, 321; router.ts:1119.
- **Design says:** ARCH.md "The host": "It verifies nothing"; "Feeds … The chain app validates". MESSAGES.md "The providers": "a provider does check that a message it is asked to act on is signed by its sender and is for it" (in providers.ts:30-32).
- **Options:** Amend ARCH.md "verifies nothing" to "verifies nothing it admits; providers check what they act on". · Remove the feed's hash check (the chain app validates). · Leave as is.

### H21 · Search opens every enabled store file on every request
- **Kind:** short-sighted
- **What:** `search` walks all enabled rows in order. For each row at the domain it opens the store, reads the `profile` head and verifies a signature, until `limit` matches. There is no index, so cost grows with the number of instances, not with the number of results.
- **Evidence:** router.ts:665-681, 643-657.
- **Design says:** MESSAGES.md "Search (§5.6, #104)": "the handles resolve answers at the request's domain (host.db's enabled instances)".
- **Options:** Keep a profile index (host.db column, or a host-skein head) refreshed when the `profile` head moves. · Move search into the app of H2. · Accept it for now.

### H22 · Three handle grammars
- **Kind:** duplicate
- **What:** `HANDLE` (a hostname label) governs `createInstance` and `register`. `addMailbox` (also used by `add --mailbox` through `db.add`) accepts `[a-z0-9][a-z0-9._-]{0,63}`, and `HostDb.add` accepts `[a-z0-9][a-z0-9._-]*` with no length limit. A CLI-added handle containing `.` or `_` is not a hostname label, so `target()` can only reach it by `/@<handle>`, and it never matches as a first label.
- **Evidence:** router.ts:205, 883; instances.ts:155; router.ts:1016-1018.
- **Design says:** ARCH.md "The host skein": "a handle that is not a hostname label" is refused.
- **Options:** Use `HANDLE` everywhere (in `HostDb.add`). · Keep the looser grammar for the `/@` form only.

### H23 · libp2p `/skein/message/1.0.0` is served on every node with no dispatch row
- **Kind:** miswired
- **What:** Every instance's libp2p node handles `/skein/message/1.0.0` no matter what its dispatch table says, and appends each frame as a request. That protocol is enabled by the transport, not by a row.
- **Evidence:** p2p.ts:32-34, 119; providers.ts:93 (`MESSAGE_STREAM`).
- **Design says:** ARCH.md "The kernel": the dispatch table holds "HTTP paths and libp2p topics alike, first match wins, a row is the permission".
- **Options:** Seed a row for it in genesis and follow the table like other protocols. · Keep it as the transport's built-in inbox, documented in MESSAGES.md "libp2p".

### H24 · Dead code and legacy surface still in the host
- **Kind:** stale-doc
- **What:** Several pieces are unused or legacy. `brc231.ts` (a CBOR messagebox client claiming "The router answers a CBOR request in CBOR") is imported nowhere. `Oracle.routerWallet`/`ROUTER_PROTOCOL` (the router's own BRC-104 identity) is never called. host.db still carries `wallet_url`/`wallet_originator`, and `skein-host list` prints `wallet_url`. scripts/host/instance.sh, messagebox.sh, messagebox-migrate.mjs and grants-legacy.sh are marked LEGACY, and wallets.sh still starts the legacy instance/host wallets. scripts/host/register.ts drives the H1 route.
- **Evidence:** src/host/brc231.ts:1-5 (no importers: grep `cborBoxClient` finds only itself); oracle.ts:30, 97-102 (no callers); instances.ts:28-29; cli.ts:265; scripts/host/instance.sh:1-4; messagebox.sh:1-3; messagebox-migrate.mjs:1; grants-legacy.sh:1-3; wallets.sh:1-20.
- **Design says:** ARCH.md "The host": no router identity, no messagebox host ("The host's HTTP transport … holds no mail and no sessions", MESSAGES.md).
- **Options:** Delete them. · Move them to an `attic/`. · Leave them.

### H25 · Stale comments that contradict the current design
- **Kind:** stale-doc
- **What:** Several file comments describe earlier layouts:
  - frontdoor.ts says sessions are kept under head `sessions` (now `frontdoor/sessions`);
  - providers.ts says loopback is used for "resolve to the kernel's `peers` operation" (#87: no program writes peers);
  - p2p.ts says the node redeclares "after a step moved the head `routes`" (no routes head since #77);
  - bin/skein-host says `run` is "the supervisor: one bin/skein-runtime process per enabled row" (now `skein-kernel serve`);
  - router.ts says the router "holds no auth state", but it holds the certifier and verifies register signatures;
  - cli.ts says kernels are "started on demand and stopped when idle" (the default is never stopped, and `start()` hydrates every enabled row).
- **Evidence:** frontdoor.ts:16-17; providers.ts:8-11; p2p.ts:35-36; bin/skein-host:2-3; router.ts:5-8, 284-285, 312; cli.ts:84-88 vs router.ts:141, 397-401.
- **Design says:** MESSAGES.md "Sessions are state": head `frontdoor/sessions`. MESSAGES.md "The address book": "no program writes it (#87)". VM.md: "no `routes` head".
- **Options:** Fix the comments. · Leave them.
