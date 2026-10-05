# Kernel + TS runtime mirror audit — skein @ 6658a45

Read-only. Paths are relative to `/home/shruggr/Work/agent-env/skein` unless they name a sibling repo. Nothing was run except `git`, `grep`, `gh issue view` and `diff`. Findings that depend on code reading only, with no test run, are labelled "not exercised".

---

### K1 · Write scope comes from a self-declared field in a record any program can put
- **Kind:** short-sighted
- **What:** `advance` is allowed when the stepping program's record has `app: X` and the head is `X/…`, or, when there is no `app`, when the genesis `scopes` lists the record's `name`. `launch` and in-VM `call` accept any CID whose record passes `isProgram` (shape only), and the callee's or launched record becomes the scope. A step can `put` a dag-cbor record and `putBlock` a raw module, so a program can write `{kind:"program", name, app:"chain", code:{wasm:<its own module>}}` and then call or launch it to write `chain/state`. It can do the same with `name:"wallet"` or `name:"messagebox"` and no `app`, which gives that genesis scope. Not exercised: no test found for this.
- **Evidence:** kernel-zig/src/scheduler.zig:1607-1616 (hPut/hPutBlock, no check), :1622-1640 (hLaunch: `isProgram` only), :1863-1870 + :1890-1899 (hCall/loadCallee push the callee record as scope), :1662-1691 (hAdvance/inScope read `app`, else genesis `scopes[name]`); kernel-zig/src/programs.zig:84-102 (isProgram checks shape only).
- **Design says:** ARCH.md "The kernel": "An app's programs `advance` only heads under the app's name"; VM.md "Heads": "an app's program (its record's `app`, written by the install) writes `<app>/…` and nothing else".
- **Options:** bind scope to program-record CIDs the owner registered (dispatch rows, `<app>/app`.programs, genesis `programs`) and refuse others at launch/call · refuse step `put` of `kind:"program"` records · leave as is and document that scope is cooperative.

### K2 · The kernel's `admit` frame takes a host-asserted `mail` sender; the browser host admits unsigned mail
- **Kind:** miswired
- **What:** `admit` accepts a `mail` entry whose record has only a shape check (`isMail`). It does not check the signature, and routing uses the record's `sender` (forMail, admin rows included). The browser host builds `{kind:"mail", sender, recipient, box, body}` with no signature for each message it polls from its mailbox instance, and admits it "as the host's word". It also picks which boxes to poll from the kernel's `boxes` frame. The node host admits only `request` and `event` entries.
- **Evidence:** kernel-zig/src/scheduler.zig:430-466 (admit; mail branch :454-465); kernel-zig/src/log.zig:100-120; web/kernel/host.ts:282-296 (poll by `kernel.boxes()`), :298-316 (`admitMessage`: "admitted as the host's word (the mailbox verified its session)").
- **Design says:** ARCH.md "The host": "It verifies nothing and routes nothing: transports append whole packages as received, the instance's front door verifies them"; MESSAGES.md:27 "The host verifies nothing".
- **Options:** the browser host appends the mailbox's signed package as a `request` (transport `mailbox`/`local`) and the front door verifies it · the kernel refuses `mail` entries from the admit frame (only steps' `admit` answers create them) · document mail-admit as a trusted-host frame.

### K3 · Replay is not "the log alone": modules, the genesis tree and genesis programs come from the source store
- **Kind:** short-sighted
- **What:** `skein-kernel replay` first installs the current kernel's pinned modules from `wasm/`, then every raw block in the source store (`blocksOfCodec RAW`). `copyLog` copies the genesis `programs`, the programs named by genesis dispatch rows, and the whole genesis `tree` from the source store, "not carried by any entry". Steps read the store unrestricted (`get`, `await`, and `advance` all check `store.has`). The replayed store holds every raw block from the start, while the live store held only what had arrived by then, so a `get` probe can answer differently. Not exercised.
- **Evidence:** kernel-zig/src/replay.zig:1-10, :41-60 (install pinned), :76-93 (copyLog: programs, dispatch programs, tree "pre-filled, not carried by any entry"), :129 (all RAW blocks); scheduler.zig:1641-1643 (hAwait `store.has`), :1676 (advance `store.has`).
- **Design says:** ARCH.md intro: "every step is recorded, and the log is the only input"; VM.md "Heads": "Replay writes the same chain".
- **Options:** genesis/boot packets carry the tree and modules as entries (an `objects` entry) · replay limits a step's reads to blocks reachable at that point · narrow the claim to "log + the genesis tree's blocks".

### K4 · HTTP and libp2p routing and sender permission are in the front-door program, not the kernel
- **Kind:** miswired
- **What:** The kernel matches only `mailbox` rows (`forMail`, `forEvent`). For http and libp2p it passes the whole table (and the genesis `reads`) into the front door's input. The front door program does the matching (exact path first, then longest prefix), the `session`/key sender check and the `read`-op permission. `reads` is a genesis-only permission table that no admin operation changes. The front door's `senderOf` also maps an absent or unknown sender string to `session`.
- **Evidence:** kernel-zig/src/dispatch.zig:251-274; scheduler.zig:1420-1421 (`dispatch`, `reads` into the step input); programs/frontdoor/main.zig:221-262 (http), :267-271 (senderOf), :347-366 (findRoute), :373-385 (mayRead); programs/frontdoor/libp2p.zig:176.
- **Design says:** ARCH.md "The host": "the kernel's dispatch table routes"; VM.md "The dispatch table": "First match wins, in table order"; "four tables … a row is the permission".
- **Options:** move http/libp2p matching into dispatch.zig and hand the front door the matched row · document that the front door is the router for those transports · fold `reads` into dispatch rows or make it a fifth admin-managed table.

### K5 · The host makes decisions with a TS copy of the kernel's dispatch rules, and no equivalence test covers it
- **Kind:** duplicate
- **What:** The router decides whether to hydrate a stopped instance for a cron tick (`subscribes`, which uses `takesMail`/`takesEvent` over `currentDispatch` read straight from the store file) and whether to subscribe an instance to the host headers feed (`takesEvent` plus `address === "chain"`). Zig is authoritative. The two copies differ: TS `fold` keeps rows Zig's `rowOf` drops as invalid; TS `rowKey` is a concatenated string (`"/x*"` with no prefix collides with `"/x"` with prefix), while Zig compares fields. TS `forMail` has no caller. The management site bundles `fold`/`rowKey` from this file. The only cross-check is indirect: deploy.test.ts reads a kernel-written chain through `currentDispatch`. No test compares `takesMail`/`takesEvent` with forMail/forEvent.
- **Evidence:** src/runtime/dispatch.ts:52, :55-63, :80-95; kernel-zig/src/dispatch.zig:148-207, :254-274; src/host/router.ts:324-329, :627-635, :928-940; images/default/www/lib/entry.ts:17; src/host/deploy.test.ts:243-254.
- **Design says:** VM.md "The dispatch table": "`src/runtime/dispatch.ts` reads it"; ARCH.md: the host "routes nothing".
- **Options:** ask the kernel (a `takes(box, sender?)` frame) instead of re-implementing · add a table-driven equivalence test over forMail/forEvent/fold · delete `forMail` and keep only the reader.

### K6 · The kernel carries app programs and app-specific wiring
- **Kind:** stale-doc
- **What:** The kernel pins four modules (wallet, messagebox, frontdoor, resolve) and installs them into every store on `serve`. It also writes program records for messagebox, frontdoor and resolve through the `programs` frame. The scheduler hard-wires genesis program names: `frontdoor` is the middleware for http, libp2p and local, and `messagebox` is the delivery middleware for mailbox emits. Separately, the kernel runs shell programs (`code: {ts: "shell"}`) natively, with its own spawn, sleep and re-execution path.
- **Evidence:** kernel-zig/src/programs.zig:20-29, :54-64; replay.zig:41-58; serve.zig:250-262, :418; scheduler.zig:574-588, :1724, :2122-2160; shell.zig:1-20.
- **Design says:** ARCH.md "Three layers": "The kernel: the machine, its four tables, and the `wallet` import"; "Everything outside the kernel is an app under its own name: the front door …, the messagebox, resolve, the wallet".
- **Options:** move pins and middleware names into the genesis/image (genesis `middleware` already exists) · amend ARCH to list what the kernel pins and special-cases.

### K7 · The kernel's host surface is about 21 frames, not five; the host writes store and log outside `admit`
- **Kind:** stale-doc
- **What:** `serve` answers say, fatal, tip, get, put, has, putblock, restore, append, programs, head, genesis, dispatch, boxes, byEnvelope, admit, call, answer, idle, start and running. The host uses `put` (request and event records before admit), `putblock`/`restore` (boot), and `append` (the genesis entry, through `log.append`, which skips admit's validation). The `head` frame's comment says the router reads the `mailbox` head, but no host code calls it.
- **Evidence:** kernel-zig/src/serve.zig:214-340 (:263-266 head comment); src/host/kernel.ts:5, :170-186; src/host/genesis.ts:533-536; src/host/frontdoor.ts:70-72; src/host/router.ts:485-490; src/host/boot.ts:218-238.
- **Design says:** ARCH.md "The host": "The kernel's surface is five frames: in, admit …, answer …, call …; out, wallet … and emit".
- **Options:** document the read and boot frames as a separate class · route genesis and boot blocks through `admit`-validated entries · drop unused frames (`head`).

### K8 · The front door's BRC-103/104 nonces come from the step's public random stream
- **Kind:** short-sighted
- **What:** Inside a step, WASI `random_get` is SHA-256(entry CID ‖ thread CID) in counter mode. The front door's handshake nonce (`createNonce`: 16 bytes from `randomSecure` plus a wallet HMAC) and each response nonce (`random64`) run inside the request's step, so they come from that stream. Anyone who holds the log can recompute them. The kernel's own comment on `realRandom` says a session nonce "must not be guessable" and gives only calls real entropy.
- **Evidence:** kernel-zig/src/syscalls.zig:55-66; scheduler.zig:1438 (`Entropy.init(ctx.cid, origin)`), :1591-1594, :2534-2547; skein-sdk/lib/brc104.zig:119-135; programs/frontdoor/main.zig:483, :518.
- **Design says:** ARCH.md "Time and randomness": "Random bytes are a stream keyed by the entry's and the thread's CIDs; nothing may use them for secrets, which the signer makes".
- **Options:** derive nonces from the signer (an HMAC over the entry/thread through `wallet`, which is recorded) · accept public nonces and say so in MESSAGES.md.

### K9 · The host's own checks, decisions and rewrites, classified
- **Kind:** miswired
- **What:** (a) `POST /account/register` checks a signature, creates a mailbox instance and issues a certificate: verification by the host (documented in MESSAGES.md, but it contradicts the headline). (b) `profileOf` opens the instance's store file directly, reads head `profile` and checks its signature before resolve and search serve it: verification by the host, done outside the kernel. (c) `forward()` charges the ledger to `x-bsv-auth-identity-key` taken from the raw request headers, not the identity the front door verified: an unverified attribution. (d) Picking the instance from the hostname label or `/@handle`, and handing a stripped `route` beside the signed `path`: transport, though the front door routes on the host-computed `route` (frontdoor main.zig:222). (e) Arcade statuses go to instances whose store holds the tx (`kernel.hasBlock`): a transport filter. (f) The headers-feed subscription and cron wake: transport decisions, but made by the K5 mirror.
- **Evidence:** src/host/router.ts:1090, :1110-1131 (register), :640-658 (profileOf), :1139-1147 (forward/charge), :1011-1020 (target), :342 (holds), :324-329, :928-940; src/host/handles.ts:92; programs/frontdoor/main.zig:222, :468.
- **Design says:** ARCH.md "The host": "It verifies nothing and routes nothing"; MESSAGES.md:406-417 documents register.
- **Options:** charge the identity from the thread's verified answer · move register and profile serving into the host skein (an app) · amend ARCH to list the host's discovery and certifier checks as exceptions.

### K10 · The messagebox's write scope breaks the by-name rule, and other kernel or host heads are bare names
- **Kind:** short-sighted
- **What:** The genesis-wired messagebox writes heads `mailbox` and `outbound`, whose owners by `ownerOf` are "mailbox" and "outbound", not "messagebox". Bare heads `profile` (the router reads it, #104) and `claim` (written by the kernel's claim op) also exist. `RESERVED_NAMES` in the manifest blocks neither `mailbox`, `outbound` nor `profile` as app names.
- **Evidence:** src/host/genesis.ts:204-212 (STOCK_SCOPES); kernel-zig/src/heads.zig:50-53; src/host/handles.ts:92; src/host/manifest.ts:93; docs/VM.md "Heads" lists `messagebox: ["mailbox", "outbound"]`.
- **Design says:** ARCH.md: "An app's programs `advance` only heads under the app's name (`chain/state`, `wallet/state`…)".
- **Options:** rename to `messagebox/…` (format change) · add these names to RESERVED_NAMES · document the stock exceptions.

### K11 · The wallet program is built, pinned, tested and documented as an app, but it is not installable as one
- **Kind:** stale-doc
- **What:** `wasm/wallet.wasm` is pinned (programs.zig, src/runtime/programs.ts), installed into every store, given scope `wallet/` in STOCK_SCOPES, and exercised by equiv/wallet.ts and equiv/boot.ts (wired there by a system tree's `bin/wallet.wasm`). It has no `etc/app.json`, and `wallet` is in the manifest's RESERVED_NAMES, so no app named `wallet` can be installed. It is in neither the default image nor catalog.json. Skein #86 (gib app) and #87 (revert self-delegate row) say nothing about removing it; #86 depends on it via #93 (open), and #29 is open. The 2026-10-03 "NO wallet module" decision concerns a `p mandala` wallet-toolbox module and 1sat-sdk PRs #86/#87, not this program.
- **Evidence:** kernel-zig/src/programs.zig:22; src/runtime/programs.ts:25-38; wasm/README.md; src/host/genesis.ts:208; src/host/manifest.ts:93; kernel-zig/equiv/run.sh:76-81; equiv/boot.ts:132-166; docs/ARCH.md:102; docs/APPS.md §7 row "the wallet and each overlay under their own names … built (#79: programs/wallet …)"; docs/WALLET.md:1-40; `gh issue view 86/87/93`.
- **Design says:** ARCH.md table: "wallet | programs/wallet | coins, actions, drafts under `wallet/state`"; ARCH "Everything outside the kernel is an app under its own name".
- **Options:** give it an `etc/app.json` and unreserve the name · keep it genesis-wired and document it as a stock program · unpin it and move it to its own repo like the other apps.

### K12 · TS `log.ts` describes format 1 and still builds every entry the host appends
- **Kind:** duplicate
- **What:** The header and `isLogEntry` describe signed entries with `envelope`, `wake` and `outcome`; `isLogEntry` requires `sig` and would reject every format-8 entry. `EntryBody` is the format-1 union. `nextEntry` (prev, n, time) is how genesis.ts builds the genesis entry and every admitted entry, cast `as never`. The kernel's log.zig (format 8: genesis | request+transport | mail | event+box, no sig) is authoritative and rejects anything malformed or out of order.
- **Evidence:** src/runtime/log.ts:1-27, isLogEntry, EntryBody, nextEntry; src/host/genesis.ts:533-549; web/kernel/host.ts:263, :308; kernel-zig/src/log.zig:100-120.
- **Design says:** VM.md and MESSAGES.md describe format 8; log.ts says "The kernel writes format 3 … src/host/genesis.ts builds them over nextEntry".
- **Options:** update log.ts to the format-8 shape · have the kernel stamp prev/n (the host sends body + time only).

### K13 · Eight `programs/` directories are dead build output
- **Kind:** dead
- **What:** programs/{head-handler, loop, objects-handler, overlay, run-handler, static, subscribe-handler, wire-probe} contain only `zig-out/` (gitignored) or nothing, with no source; `git ls-files programs` lists none of them. `git grep "programs/<name>"` returns nothing for six of them. `loop` and `static` appear only in docs (MESSAGES.md:160, :1107, :1187, :1210, which point at sibling repos, except :160). Their sources live in skein-chat (loop), skein-shell (run-handler), skein-static, skein-overlay and programs/test/wire-probe. The handlers went with #77.
- **Evidence:** `git ls-files programs`; .gitignore `programs/*/zig-out/`; `ls programs/*/zig-out/bin`; kernel-zig/src/programs.zig:11-19.
- **Design says:** wasm/README.md "Built here": only messagebox, frontdoor, resolve, wallet, and wire-probe (test).
- **Options:** delete the directories locally · leave them (untracked, harmless).

### K14 · App repos are copied into the default image, and versions drift
- **Kind:** duplicate
- **What:** images/default/apps/git is skein-git v0.1.0's source tree, byte-identical to it (`diff -rq` clean). images/default/www is skein-site 0.5.2's tree. images/default/bin/static.wasm is skein-static **0.2.1**, wired as a genesis program named `static`. catalog.json offers static **0.2.0** (1d6f7d3) as an installable app, and equiv/static.ts tests 0.2.0, so the module the image ships is not exercised. `static` is not in RESERVED_NAMES, so an instance can hold the genesis program and an installed app of the same name.
- **Evidence:** images/default/README.md; images/default/bin/static.json; images/default/www/catalog.json; kernel-zig/equiv/static.ts:33; src/host/manifest.ts:93; `git -C ../skein-static tag` (v0.2.0, v0.2.1).
- **Design says:** APPS.md §3 "The management page"; ARCH table "static | shruggr/skein-static".
- **Options:** have the image reference the app trees by hash and fetch them at build time · bump the catalog and equiv pin to 0.2.1 · reserve `static` or install it as an app in the image.

### K15 · The default image has no resolve program, but the messagebox and the chat app depend on one
- **Kind:** miswired
- **What:** The default image's `bin/` holds frontdoor, messagebox and static only. Code-genesis instances get resolve from the kernel's `programs` frame. In an image instance, the messagebox's delivery reads `resolve/peers`, which nothing writes. The chat app's `message` tool calls `sk.launchResolve`, which fails with "no resolve program in the genesis". Resolve is not in catalog.json either. The messagebox also reads another app's head by name, which agent call 2 on #87 already noted.
- **Evidence:** images/default/bin/; kernel-zig/src/programs.zig:64; programs/messagebox/deliver.zig:4-5, :49-50, :300; skein-chat/programs/loop/main.zig:616, :792, :1113; skein-sdk/lib/sk.zig:377-378; router.ts:597 (code genesis on an empty store) vs :793 (manager create = image).
- **Design says:** ARCH.md "Everything outside is a peer": "a message to a key the address book does not name goes to the messagebox's delivery thread, which reads that record".
- **Options:** add resolve to the image (bin/resolve.cid + scope) · ship resolve as a catalog app · document that image instances reach only address-book peers.

### K16 · Calls read the real clock and OS entropy, and the explorer's answer is signed in an unrecorded call
- **Kind:** stale-doc
- **What:** The `call` frame defaults `now` to the process's real clock, and the call stream is seeded from OS entropy. The kernel's comments state that "a call is not deterministic and nothing replays it". The explorer's HTTP answer is the front door's `read` function run as a call after the request thread ends, signed with an unrecorded wallet call, so the answer a client got cannot be reproduced from the log.
- **Evidence:** kernel-zig/src/serve.zig:309; scheduler.zig:1944-1960, :2537-2547, :2088-2096 (cWallet); src/host/frontdoor.ts:99-105; programs/frontdoor/main.zig:53-58, :410-433.
- **Design says:** ARCH.md: "The kernel has no disk, network, clock or process table"; "Every request is an entry; a read moves nothing"; "everything is replayable" (brief).
- **Options:** the host always passes `now` (no kernel clock) · record the read's answer on the request thread · amend ARCH to say that calls are outside replay.

### K17 · The app-record builder exists twice (TS plan.ts and Zig skein-git), with a parity test
- **Kind:** duplicate
- **What:** Deploy by hash needs the app record from skein-git (record.zig) and from plan.ts `planInstall` over the stored tree to have the same CID; the install refuses on a mismatch. equiv/git-clone.ts checks that the CIDs are equal. The management site bundles plan.ts at SKEIN_REV c5c7dec; `git diff c5c7dec HEAD` over the bundled files is empty today.
- **Evidence:** src/host/plan.ts:212; ../skein-git/src/record.zig:6, :157, :209, :345; kernel-zig/equiv/git-clone.ts:16, :178-180, :219; images/default/www/lib/entry.ts:16; images/default/www/lib/SKEIN_REV.
- **Design says:** APPS.md §3: "byte for byte the record step 1 above would send".
- **Options:** keep both with the equiv check · have the git app's answer be authoritative and drop the client rebuild · generate one from the other's spec.

### K18 · The TS heads mirror lacks `owner` and keeps a writer that only its own test uses
- **Kind:** duplicate
- **What:** Zig head updates are `{tree, owner, thread, input, at}`; the TS `HeadUpdate` type has no `owner`. TS `advanceHead` writes head chains, and only src/runtime/heads.test.ts calls it. The host uses only `headTree` (a read) from it, in deploy.ts, install.ts, router.ts and cli.ts.
- **Evidence:** src/runtime/heads.ts:18, :43-50; kernel-zig/src/heads.zig:58-71; `grep advanceHead src` → heads.test.ts only.
- **Design says:** VM.md "Heads": "every head update carries `owner`".
- **Options:** delete the TS writer and add `owner` to the type · leave as is.

### K19 · The host reads instance stores directly through a TS copy of the store and index
- **Kind:** duplicate
- **What:** index-store.ts (578 lines) reads the Zig store's SQLite file and MSTs; sqlite.ts (620 lines) is a full older TS store (chains, edges, messages tables) that remains the `openStoreFile` fallback for files with no state pointer. The router and CLI open live instance stores read-only, outside the kernel (`subscribes`, `profileOf`, cli inspection). index-store.ts's header says index-store.test.ts and equiv/overlay.ts check its derived roots against the kernel's.
- **Evidence:** src/runtime/index-store.ts:1-20, :364-368, :382; src/runtime/sqlite.ts:1-30, :118; src/host/router.ts:630, :647; src/host/cli.ts:767, :886, :953, :979.
- **Design says:** ARCH.md "The host": "The store: one SQLite file per instance …, written by the kernel process".
- **Options:** answer these reads through kernel frames (`dispatch`, `head`) · drop sqlite.ts's writer half · keep with the existing index parity tests.

### K20 · The kernel's envelope.zig is test-only, the third copy of the BRC-169 envelope checks
- **Kind:** dead
- **What:** In the kernel, only tests.zig imports `envelope.zig`. Envelope and message verification live in the SDK (lib/message.zig, used by the front door and the messagebox) and in TS (src/runtime/envelope.ts, src/envelope.ts, src/envelope-cbor.ts, used by client, peers and brc231).
- **Evidence:** `grep '@import("envelope.zig")' kernel-zig/src` → tests.zig only; kernel-zig/src/envelope.zig:1; skein-sdk/lib/message.zig:1-8; src/runtime/envelope.ts:1-6.
- **Design says:** ARCH.md: the front door verifies; the kernel is the machine and its tables.
- **Options:** delete kernel envelope.zig and move its vectors to the SDK's tests · keep it as a vector check.

### K21 · Stale descriptions and comments in records and code
- **Kind:** stale-doc
- **What:** (a) The messagebox program record's `description` (kernel-pinned and in the image) says "`send` delivers over http (recorded)". Steps have no http import (program.Host: input, get, put, putBlock, keep, launch, await, head, advance, wallet, emit, deadline, call, edges), and #70 moved delivery to emit. The description is part of the record, so it is part of the program CID. (b) src/host/frontdoor.ts:16 says sessions live under head `sessions`; the code uses `frontdoor/sessions`. (c) MESSAGES.md:160 says "Static files (#52, `programs/static`)"; there is no source there. (d) serve.zig's `head` frame comment names a router caller that does not exist.
- **Evidence:** kernel-zig/src/programs.zig:57; images/default/bin/messagebox.json:7; scheduler.zig:1457-1473; programs/frontdoor/sessions.zig:24; docs/MESSAGES.md:160; serve.zig:264.
- **Design says:** MESSAGES.md / VM.md "emit: the one way out (#70)".
- **Options:** fix the text (the record change re-pins the messagebox) · leave the record and fix the docs only.

### K22 · Ten "built" claims checked against code: five are wrong or overstated
- **Kind:** stale-doc
- **What:** Wrong or overstated: (1) ARCH "kernel's surface is five frames" (K7). (2) ARCH "The kernel has no … clock" (K16). (3) ARCH/VM "the kernel's dispatch table routes … first match wins", for http and libp2p (K4). (4) ARCH table and APPS §7 "the wallet … under its own name … built (programs/wallet)" as an app (K11). (5) ARCH "An app's programs advance only heads under the app's name", as an enforced rule (K1, K10). Correct as checked: (6) ARCH "Sessions … under `frontdoor/sessions`" (sessions.zig:24). (7) VM "every head update carries `owner`" (heads.zig:67). (8) APPS §3 "http rows namespaced under /<app>/, enforced": enforced by the install client (manifest.ts:26) and not by the kernel's `dispatch` op (scheduler.zig:977-990), which matches "the install refuses". (9) APPS §3 git app record byte-identical to the client's (equiv/git-clone.ts:180). (10) Image README "apps/git: skein-git v0.1.0's tree" (`diff -rq` clean). (11) APPS §2 `writes` validation: the manifest check requires the field (manifest.ts:230) and the SDK refuses writes in `writes:false` functions (skein-sdk lib/app.zig:51-57), so this is cooperative and not enforced by the kernel.
- **Evidence:** as cited per item.
- **Design says:** APPS.md:11 "Status of each part is marked built or spec".
- **Options:** correct the five statements · add a "where enforced" column (kernel / client / SDK) to APPS §7.

### K23 · App configuration sits in the host's default genesis
- **Kind:** short-sighted
- **What:** `DEFAULTS` in src/runtime/log.ts is `{model: "ripper/qwen38", thinking: "off", fuelPerStep}`. The model and thinking settings are the chat loop's. Every code genesis copies them into `defaults` (merged with SESSION_DEFAULTS and the host facts), even though chat is an app since #83 and APPS.md says `config` "replaces genesis `defaults` for apps".
- **Evidence:** src/runtime/log.ts (DEFAULTS); src/host/genesis.ts:489-494, :512; src/host/router.ts:735, :861.
- **Design says:** APPS.md §2 `config`: "Replaces genesis `defaults` for apps".
- **Options:** keep only `fuelPerStep` (and session TTL) in the genesis defaults · leave it until the chat app reads its own config.

### K24 · `append` and `put` let the host write the log and store without admit's checks
- **Kind:** miswired
- **What:** The `append` frame calls `store.logAppend` directly. It checks only that the entry extends the tip, not admit's `isRequest`/`isMail`/event-in-store checks. It is used for the genesis entry. `put` and `putblock` let the host add any block at any time, and those blocks become visible to later steps' `get`, which relates to K3.
- **Evidence:** kernel-zig/src/serve.zig:226-249; scheduler.zig:430-466 (the checks that `append` skips); src/host/genesis.ts:533-536; src/host/kernel.ts:170-182.
- **Design says:** ARCH.md: "**admit** (append an entry and run the steps it drives)" is the one way in.
- **Options:** genesis through a dedicated `genesis` frame that validates · restrict `put`/`putblock` to boot (before `start`).
