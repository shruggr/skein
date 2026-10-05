# Audit: identity / handle / certificate / messagebox flows

Read-only, 2026-10-04. Repos at their local checkouts: skein (`~/Work/agent-env/skein`), skein-site 6086f3c, 1sat-accounts fd2df60, 1sat-sdk 183c0ce3, yours-wallet 7558d45 (with uncommitted changes: `src/services/handleProfile.ts` untracked, `Settings.tsx`/`BsvWallet.tsx` modified), ts-stack wallet-toolbox, BRCs. Abbreviations: `skein:` = ~/Work/agent-env/skein, `site:` = ~/Work/agent-env/skein-site, `acc:` = ~/Work/bsv/1sat-accounts, `sdk:` = ~/Work/bsv/1sat-sdk/packages, `yours:` = ~/Work/bsv/yours-wallet, `tbx:` = ~/Work/bsv/ts-stack/packages/wallet/wallet-toolbox/src, `169` = BRCs/peer-to-peer/0169.md.

## Map (who talks to whom)

| Function | Server(s) | Clients |
|---|---|---|
| Register a handle | skein router `POST /account/register` (signature body; makes a mailbox instance; domain = request host, `id.skein.nexus` in prod) · wallet-server `POST /account/register` (BRC-104 session; `accounts` table; cert for `userDomain`) | → router: acc `host.ts:145`, site `app.js:504-520`, skein `scripts/host/register.ts:24`, skein `web/kernel/host.ts:231` · → wallet-server shape: skein `web/core.ts:76-84` (+ `web/app.ts:96`, `web/envelope.test.ts:176`), sdk CLI `help.ts:903` (`wallet.1sat.app`) |
| Resolve | router `/.well-known/metanet-handles/resolve` (only server) | skein `programs/resolve` (in instances), sdk `client/src/handles.ts` (used by Yours + actions), acc `host.ts:125`, site `app.js:400` |
| Issue cert | router `handles.ts` (resolve: plaintext; register: encrypted), no record · wallet-server `issueCert.ts` (stored in `handle_certs`) | — |
| Keep / list / relinquish cert | wallet (toolbox) | acc, site (no relinquish), Yours (`Settings.tsx:631`), CLI generic `wallet` commands |
| Messagebox | skein mailbox instance per handle (`<handle>.skein.nexus`) · wallet-server `/messagebox` + root · `messagebox.1sat.app` (SDK default) | sdk `relay.ts` (CBOR), `@bsv/message-box-client` (JSON: syncMessages, site Inbox list), site `RawBox`, acc/Yours hand-rolled AuthFetch |
| Profile | instance head `profile` (signed) read by router · wallet-server `PUT /account/profile` (unsigned) · OpNS bind `profile` field (PushDrop) | writers: site, acc, Yours · readers: router, site, acc, Yours |

---

### I1 · Re-registering after "Remove from wallet" fails: same serial, soft-deleted row, unique index
- **Kind:** defect
- **What:** The router's serial is `SHA-256("<handle>@<domain> <identityKey>")`, so every issue for one binding has the same serial, and a second register for the same key and name answers 200 with a fresh certificate under that serial. `relinquishCertificate` in the toolbox only sets `isDeleted: true`; `listCertificates` filters `isDeleted: false`, so the pages' "already held?" check misses the row, call `acquireCertificate` (direct), which inserts a new row and hits the unique index on (userId, type, certifier, serialNumber) — surfaced in Yours as "internal error". The pages tell the user to do exactly this ("register again to get its certificate back").
- **Evidence:** skein `src/host/handles.ts:135-138` (serialOf), `:155-158` (issueSubjectCertificate passes serialOf); `src/host/router.ts:886-889` (same owner → returns the existing row), `:1123-1126` (issue again, 200); tbx `storage/StorageProvider.ts:1354-1368` (isDeleted: true), `storage/methods/listCertificates.ts:18` (isDeleted: false), `signer/methods/acquireDirectCertificate.ts:40` (plain insert), `storage/idbHelpers.ts:358` (unique index), `storage/schema/KnexMigrations.ts:691` (same unique on Knex storage, i.e. remote storage too); acc `src/wallet.ts:279-291` (list then acquire), `src/app.ts:245` ("Register again to get its certificate back"), `:394` (confirm text: "register the same name again … to get the certificate back"); site `app.js:514-518`; Yours `src/pages/Settings.tsx:625` (speed bump) and `:631-636` (relinquish). sdk wallet-server `accounts/issueCert.ts:15-22` returns the stored cert on re-register, so the same serial comes back there too.
- **Design says:** 169 §4.6 rule 3: "When a handle is released or reassigned … the holder MUST `relinquishCertificate` for the retired binding." #103 build comment: "It skips the call if `listCertificates` already holds that serial number: the wallet's storage is unique on (type, certifier, serial)." docs/MESSAGES.md "Mailbox instances": "The same key and name again: the same handle, the certificate issued again."
- **Options:**
  - New serial per issue (random or counter), so re-issue never collides.
  - Toolbox: acquire of a soft-deleted (type, certifier, serial) revives/replaces the row (ts-stack change).
  - Host refuses re-issue for a key that already holds the binding; recovery goes through another path (see I22).
  - Pages detect the collision and explain it instead of the toolbox's internal error.

### I2 · Two `POST /account/register` servers with incompatible contracts
- **Kind:** duplicate
- **What:** The skein router and the 1sat wallet-server both serve `POST /account/register`, with different proofs (signed body vs BRC-104 session), bodies, stores, answers and name rules. Clients are split between them, and the CLI documents the wallet-server one at `wallet.1sat.app`. Both enforce one name per identity.
- **Evidence:** skein `src/host/router.ts:1090`, `:1101-1131` (`{username, identityKey, signature}`; answer `{handle, domain, identityKey, messagebox, certificate, keyringForSubject}`), `:205` HANDLE 1–63 chars, `:208` reserved `{id, host}`; sdk `wallet-server/src/accounts/registrationRoutes.ts:120-164` (BRC-104 `req.auth.identityKey`; body `{username, displayName?, avatarOrigin?}`; answer `{identityKey, username, …, certificate: toDirectAcquireArgs}` with `keyringForSubject` inside `certificate`, `certs.ts:177-190`), `store.ts:17` USERNAME_RE 3–63 chars, `store.ts:171-184` one per identity; `createHostServer.ts:134-170`; sdk `cli/src/help.ts:903` (`1sat authfetch POST https://wallet.1sat.app/account/register`).
- **Design says:** memory 2026-10-04 (Yours handles/profile): "wallet-server → storage only, rest → skein (accounts.1sat.app)". #40 build 2: "`1sat`-style register = create a mailbox instance".
- **Options:**
  - Remove register/profile/certify from wallet-server.
  - Keep both, with distinct paths.
  - The router also accepts the BRC-104 form.

### I3 · No client checks a resolution's certificate per §4.1
- **Kind:** miswired
- **What:** Every resolve client reads `identityKey`/`messagebox` without verifying the certificate's signature, its certifier against the domain's `metanet.trust.publicKey`, or its fields; the SDK checks only `subject === identityKey`. For certificates the wallet holds, acc and site verify signature and certifier, while Yours decrypts the fields and checks nothing.
- **Evidence:** sdk `client/src/handles.ts:8-12` ("Out of scope here … verifying the BRC-52 certificate"), `:162-166`; skein `programs/resolve/main.zig:34-35` ("The BRC-52 certificate is not checked here"), `:216-230`; acc `src/host.ts:125-129` (no check at all); site `app.js:400-405` (none; `:391` checks only identityKey === me); held certs: acc `src/wallet.ts:246-250`, site `app.js:384-388` (verify + certifier), Yours `src/services/handles.ts:24-41` (decrypt only, any certifier).
- **Design says:** 169 §4.1: "A verifier MUST check all of the following, and MUST treat failure of any one as a resolution failure"; §5.7 step 5; §5.8 path 1: "verify each result per section 4.1, including that `subject` equals the proven key."
- **Options:**
  - Verify in the SDK `resolveHandle` (one place; Yours and actions inherit it).
  - Verify in each client.
  - Leave as is, documented as the ecosystem's current level.

### I4 · No revocation, no release: a removed or reassigned handle's certificate stays valid
- **Kind:** short-sighted
- **What:** Certificates carry the disabled sentinel; there is no user-facing release route and no `410`. `skein-host remove` deletes the row, so resolve answers 404 and the name is free for another key, while the earlier holder's certificate still verifies everywhere. "Remove" in acc and Yours only relinquishes in the wallet; the host keeps the binding.
- **Evidence:** skein `src/host/handles.ts:43-46`, `:59`; `src/host/instances.ts:198-199` (remove = DELETE row); `src/host/router.ts:1076-1078` (404 only; `resolutionError` has no `handle-revoked`, `handles.ts:168`); no unregister route in `router.ts:1056-1092`; acc `src/app.ts:394`, `:406-407`; Yours `Settings.tsx:625`. Contrast: sdk wallet-server `/account/certify` issues with the OpNS bind outpoint as `revocationOutpoint` (`registrationRoutes.ts:226-243`) — the only real revocation outpoint in these repos.
- **Design says:** 169 §4.3: "the host MUST spend the old certificate's revocation outpoint before, or atomically with, issuing a certificate for a new binding"; §5.3 `410 handle-revoked`. #100 comment (David, 2026-10-04): "revocation isn't implemented anywhere in the ecosystem — the disabled-sentinel outpoint is not a gap to review".
- **Options:**
  - Keep names permanent (never free a name once issued) until revocation exists.
  - Revocation outpoint from a host wallet (#11/#98 territory).
  - OpNS-backed bindings (the wallet-server certify pattern) as the revocable form.
  - Answer `410` for removed names (a tombstone instead of DELETE).

### I5 · One handle per key, one row per handle, handle unique across domains
- **Kind:** short-sighted
- **What:** A key may hold one mailbox handle per host (409 "already registered as …"); `mailboxOf` ignores domain, and `handle` is the table's primary key, so one name cannot exist at two domains a host serves. The in-instance resolver keeps one record per key, so a key's second handle overwrites the first. Yours syncs only the first held handle per domain.
- **Evidence:** skein `src/host/router.ts:887-888`; `src/host/instances.ts:24` (`handle TEXT PRIMARY KEY`), `:203-205` (`mailboxOf` by owner only), `:176-179` (identityOf by handle+domain); #103 call 4; `programs/resolve/main.zig:66-100` (replace by key); sdk wallet-server `store.ts:177-181` (same one-per-identity rule); Yours `src/services/handles.ts:70-73` (byDomain keeps the first).
- **Design says:** 169 §5.9: "A key may hold several bindings: one per ecosystem, or several within one, and section 2.5 contemplates organisations, machines and agents that will hold many." §5.8: "an organisation or agent holding several will need."
- **Options:**
  - Allow several mailbox handles per key (several instances, or several handles on one instance).
  - Key the in-instance records by (handle, domain).
  - Keep one-per-key and say so in docs/MESSAGES.md.

### I6 · No issuance record; resolve signs a new certificate object on every request
- **Kind:** short-sighted
- **What:** host.db has no certificate table; resolve calls `issueHandleCertificate` per request and register calls `issueSubjectCertificate` per request (new ciphertexts each time). Nothing records what was issued, to whom, when. wallet-server, by contrast, stores issued certificates. Each resolve and each search result also opens the instance's store file.
- **Evidence:** skein `src/host/handles.ts:161-165`, `:155-158`; `src/host/router.ts:1079`, `:1125`; `src/host/instances.ts:23-38` (DDL, no certificate table); `router.ts:643-657`, `:665-680` (store opened per profile read; #104 call 10 "No cache"); sdk `wallet-server/src/accounts/certs.ts:107-124` (`handle_certs`, PK (domain, handle)), `issueCert.ts:15-22`.
- **Design says:** #100 build: "`serialNumber` deterministic per (handle, domain, identity) or stored in host.db so repeated resolves return the same certificate — say which." §4.3 needs the issued certificate to be known to revoke it.
- **Options:**
  - An issuance table in host.db (serial, subject, handle, domain, issued_at, form).
  - Keep deterministic re-signing; add a cache only.
  - Leave as is.

### I7 · The register signature carries no domain: replayable at another host
- **Kind:** short-sighted
- **What:** The signed text is `register <username>` under `[2, "skein register"]`, key ID the name; it names no host or domain and has no nonce. A captured body registers the same key+name at any other host running this router (two hosts).
- **Evidence:** skein `src/host/router.ts:206`, `:1116`; clients acc `src/wallet.ts:268-273`, site `app.js:507`, skein `scripts/host/register.ts:21-23`, `web/kernel/host.ts:232`; #103 call 1.
- **Design says:** #103 build 1: "over the user's BRC-104 session so the key is proven".
- **Options:**
  - Sign `register <name>@<domain>` (and a timestamp).
  - BRC-104 session on the route.
  - Accept as is (the effect is a mailbox for the signer's own key).

### I8 · Messagebox location: SDK/Yours/CLI default to messagebox.1sat.app; skein publishes a per-handle origin
- **Kind:** miswired
- **What:** The SDK's inbox actions and `syncMessages` default to `https://messagebox.1sat.app`; Yours runs paymail `payment_inbox` there and `metanet_inbox` at each held handle's resolved messagebox; the CLI uses the default unless `--url`. A skein handle's messagebox is its instance origin (`https://<handle>.skein.nexus`). wallet-server runs a third messagebox at `/messagebox` (and root), gated on an account.
- **Evidence:** sdk `actions/src/metanet/inbox.ts:22`, `:88-93`; `actions/src/sync/syncMessages.ts:71-73`; `actions/src/metanet/receive.ts:35-36`; `actions/src/mandala/receive.ts:49-50`; `cli/src/commands/messagebox.ts:46-52`, `help.ts:685`; Yours `src/utils/constants.ts:14`, `src/initWallet.ts:386-402`, `src/services/handles.ts:65-96`; skein `router.ts:1079` (messagebox = `originOf(handle)`); sdk `wallet-server/src/createHostServer.ts:182-220`.
- **Design says:** #40: "There is no messagebox host: Every identity's messagebox is its own instance at its own URL, and 169 publishes that URL." 169 §5.2: per-handle `messagebox`; §5.1: the manifest's `messagebox` is a default that per-handle values override.
- **Options:**
  - SDK receive actions take the messagebox from the wallet's handle certificates (resolve), as Yours does, instead of a fixed default.
  - Keep the default for legacy paymail only.
  - Retire wallet-server's messagebox (memory: wallet-server → storage only).

### I9 · CBOR (BRC-231) vs JSON messagebox wire: one URL handed to two clients
- **Kind:** miswired
- **What:** The SDK's metanet/mandala inbox syncs speak only DAG-CBOR over AuthFetch; `syncMessages` uses `@bsv/message-box-client` (JSON). The CLI passes the same `--url` to both. skein's messagebox answers either; the `@bopen-io/messagebox-server` 1.3.2 in the SDK tree (wallet-server's messagebox) has no CBOR handling in its source. Whether the deployed `messagebox.1sat.app` speaks CBOR was not checked.
- **Evidence:** sdk `actions/src/metanet/relay.ts:1-11`, `:26-40`; `actions/src/sync/syncMessages.ts:10`, `:77-84`; `cli/src/commands/messagebox.ts:46-52`; `node_modules/@bopen-io/messagebox-server/src` (grep "cbor": none); skein docs/MESSAGES.md "The messagebox" (JSON or `application/cbor`).
- **Design says:** memory 2026-10-04 metanet delivery format (BRC-231 framing for envelopes); #40 "raw BRC-33 on the 104 session".
- **Options:**
  - One client per wire, chosen per server.
  - CBOR support in messagebox-server.
  - The CLI takes separate URLs per box.

### I10 · Box names are conventions spread over five repos; `mandala_inbox` has no running reader
- **Kind:** duplicate
- **What:** `metanet_inbox`, `mandala_inbox`, `payment_inbox` and `dm_inbox` are string conventions. Constants exist in `@1sat/types` for two of them; other places use literals. No wallet, CLI or page calls `syncMandalaInbox`. A skein mailbox instance accepts every box name (`*`).
- **Evidence:** `metanet_inbox`: sdk `types/src/constants.ts:806`, `actions/src/payments/index.ts:216`, `actions/src/metanet/receive.ts:137`, `cli/src/commands/messagebox.ts:50-61`, Yours `src/services/handles.ts:87`, site `app.js:924` (literal). `mandala_inbox`: `types/src/constants.ts:799`, `actions/src/mandala/send.ts:267`, `actions/src/mandala/receive.ts:215-241` (no caller in Yours, CLI, site, wallet-desktop). `payment_inbox`: `actions/src/sync/syncMessages.ts:71` (literal), `wallet-server/src/paymail/messagebox.ts:93` (literal), Yours `initWallet.ts:387`. `dm_inbox`: sdk `wallet-desktop/src/mainview/views/dm/index.tsx:12`, `:214`. skein `src/host/genesis.ts:189-192` (`MAILBOX_DISPATCH` `*`).
- **Design says:** memory 2026-10-04 (metanet delivery format): "MIME itself = convention; mailbox = convention (`mandala_inbox` for Mandala)". `types/src/constants.ts:801-805`.
- **Options:**
  - One registry of box names (types constants) used everywhere.
  - Fold Mandala deliveries into `metanet_inbox` (the receive already hands BRC-232 deliveries over, `metanet/receive.ts:15`).
  - Add `syncMandalaInbox` to the wallets' pollers.

### I11 · Pollers: desktop has none; Yours polls `metanet_inbox` only
- **Kind:** short-sighted
- **What:** wallet-desktop has no `syncMessages`/`syncMetanetInbox` call (only a DM view listing `dm_inbox`). Yours polls paymail `payment_inbox` at messagebox.1sat.app once at init and `metanet_inbox` per handle domain on a timer, no `mandala_inbox`.
- **Evidence:** sdk `wallet-desktop/src` (grep: only `mainview/views/dm/index.tsx`); Yours `src/initWallet.ts:386-402`, `src/services/handles.ts:50-103`.
- **Design says:** memory (BRC-169 payments in 1sat-sdk): "gap: desktop has no messagebox poller". #99: "a wallet syncing its own mailbox needs no page (the SDK's sync does it)".
- **Options:**
  - A shared poller in `@1sat/wallet` that both wallets run.
  - Per-wallet pollers.

### I12 · Three copies of the profile writer and four profile verifiers
- **Kind:** duplicate
- **What:** The signed-profile write (encode, sign, `objects` + `head` admin messages, re-resolve until served) exists in site, acc and Yours; acc and Yours are nearly identical, and both learn the instance's key by a signed `GET /explore`. The verify logic exists in the router and in all three clients, with the protocol, key ID, head name and ORDFS base repeated as constants.
- **Evidence:** writers: site `app.js:409-435` (RawBox, `identityAt` `:293-296` via `/explore`), acc `src/wallet.ts:354-395` (`/explore` probe `:365-368`), Yours `src/services/handleProfile.ts:74-132` (untracked in the working tree; probe `:100-103`). Verifiers: skein `src/host/handles.ts:111-133`, site `app.js:326-340`, acc `src/wallet.ts:317-333`, Yours `handleProfile.ts:40-64`. Constants: skein `handles.ts:89-94`, acc `wallet.ts:176-181`, site `app.js:46-48`, Yours `handleProfile.ts:17-19`. acc `wallet.ts:156-160`: "The profile logic is the Yours wallet's … and skein-site's".
- **Design says:** memory (no extra code over libraries): spec-vs-library gaps go to David, no bridge layers.
- **Options:**
  - One implementation in a `@1sat/*` package (writer + verifier), used by all three.
  - A skein client export the pages and Yours import.
  - Leave the copies.

### I13 · Three profile shapes for display name and avatar
- **Kind:** duplicate
- **What:** skein serves a holder-signed DAG-CBOR `{domain, name?, avatar}` signed under `[1, "metanet handles profile"]`, key ID `1`. OpNS bind carries the same DAG-CBOR bytes as a PushDrop field, signed by the PushDrop lock under `P1SAT_PROTOCOL`, key ID `opnsRegisterKeyId(outpoint)`, so its signature does not verify as skein's. The router never reads OpNS. wallet-server keeps unsigned `{displayName ≤64, avatarOrigin txid_vout}` per account, editable at `PUT /account/profile` and served by paymail public-profile.
- **Evidence:** skein `src/host/handles.ts:27-41`, `:88-92`; sdk `actions/src/opns/index.ts:85-101`, `:474-480`, `types/src/constants.ts:208`, `:240-242`; sdk `wallet-server/src/accounts/registrationRoutes.ts:92-111`, `:166-192`, `store.ts:1-11`, `:19-21`.
- **Design says:** #104 revised: "the OpNS name coin's `profile` pair `{domain, name?, avatar?}` with its signature … or the record the owner signs on their mailbox instance in the same shape when no OpNS name is involved."
- **Options:**
  - Router also reads an OpNS-bound profile for the identity (and verifies the PushDrop signature).
  - One signing form for both (OpNS profile signed separately under the profile protocol).
  - Drop wallet-server's profile.

### I14 · The profile lives in the instance, but the host reads the instance's store file directly
- **Kind:** belongs-in-instance
- **What:** The router opens each instance's `runtime.db` read-only and walks head `profile` itself, then verifies the signature on the host; search does this for every enabled row on every query. No kernel call, front-door read route or cache is involved.
- **Evidence:** skein `src/host/router.ts:643-657` (`openStoreFile(row.store, { readOnly: true })`, `headTree`), `:665-680` (search loop); `src/host/handles.ts:111-133`; #104 call 10.
- **Design says:** #104 build 2: "results from host.db handles + each instance's `profile` head (read by CID through the kernel's read path; cache per ttl)". #40: reads are front-door handlers on the instance.
- **Options:**
  - A front-door read (`call`) on the mailbox instance that answers its profile.
  - A host cache keyed by the head's CID.
  - Leave as is.

### I15 · The in-instance resolver ignores ttl, key change, the manifest version and URL encoding
- **Kind:** stale-doc
- **What:** `programs/resolve` keeps a resolution under `resolve/peers` with `since` and no expiry, replacing it per key with no key-change check; it does not check `metanet.handles.version` and builds `?handle=<raw>` without encoding. The host's comment says the 5-minute ttl is "the only bound on how long a resolver keeps a binding", which holds for no client here except Yours' inbox cache.
- **Evidence:** skein `programs/resolve/main.zig:66-100`, `:202-214`, `:212` (`{s}?handle={s}`); `src/host/handles.ts:64-69`; docs/MESSAGES.md "BRC-169 is discovery" ("the five-minute `ttl` is all that bounds a resolver's copy"); compare sdk `client/src/handles.ts:136-146` (version check, encodeURIComponent); Yours `src/services/handles.ts:43-63` (ttl cache, inbox only; `handleProfile.ts` uncached).
- **Design says:** 169 §5.4 rule 1: "a client MUST NOT cache a resolution for longer than `ttl`"; §4.4: "On each fresh resolution, a client MUST compare the returned `identityKey` with the one it holds"; §5.1 rule 2 (reject unknown major version).
- **Options:**
  - Store `ttl`/expiry in the record and re-resolve past it.
  - Key-change: keep a record per (handle, domain) and flag a changed key.
  - Correct the comments/docs to describe what the resolver does.

### I16 · Five resolve clients, one server
- **Kind:** duplicate
- **What:** Resolution and manifest fetching are implemented separately in Zig (programs/resolve), the SDK client, acc, and site; Yours uses the SDK. Each fetches `manifest.json` its own way (acc caches per page load; site per call; site's `manifestOf` checks neither `version` nor `handles`).
- **Evidence:** skein `programs/resolve/main.zig:160-166`; sdk `client/src/handles.ts:114-168`; acc `src/host.ts:62-93`, `:125-129`; site `app.js:303-316`, `:361-366`, `:400-405`; Yours `src/services/handles.ts:3`, `handleProfile.ts:5`.
- **Design says:** docs/MESSAGES.md "BRC-169 is discovery": "It is a program, not the core". Memory (no extra code over libraries).
- **Options:**
  - Pages use the SDK client.
  - Leave per-runtime implementations (Zig in the VM is separate by design).

### I17 · wallet-server issues handle certificates for a domain whose manifest offers no resolution
- **Kind:** miswired
- **What:** wallet-server's `/manifest.json` publishes `metanet.trust` only, no `metanet.handles`, yet `POST /account/register` issues a handle certificate for `userDomain`. Per §5.1, clients treat such handles as unresolvable; the SDK throws "does not offer handle resolution". Yours lists certificates from any certifier, so such a certificate is listed and then fails resolution (logged; that inbox skipped).
- **Evidence:** sdk `wallet-server/src/paymail/routes.ts:363-386`; `accounts/registrationRoutes.ts:144-152`, `:258-272`; sdk `client/src/handles.ts:131-135`; Yours `src/services/handles.ts:25`, `:80-82`.
- **Design says:** 169 §5.1 rule 1: "A domain that publishes `metanet.trust` but no `metanet.handles` … Clients MUST treat handles at that domain as unresolvable".
- **Options:**
  - Stop issuing there (memory: wallet-server → storage only).
  - Publish `metanet.handles` on that domain.

### I18 · `accounts.1sat.app` names two different services; `wallet.1sat.app` a third
- **Kind:** miswired
- **What:** Yours uses `https://accounts.1sat.app` both as the handle sign-up page (the 1sat-accounts site's planned home) and as the storage provider's account service for `GET /account/status` (a wallet-server route). The CLI documents account routes at `wallet.1sat.app`. 1sat-accounts registers at `id.skein.nexus` by default.
- **Evidence:** Yours `src/utils/constants.ts:48`, `:52`, `:55`, `src/components/ProviderPicker.tsx:30`, `:94`, `src/hooks/useRemoteStatus.ts:63`, `src/pages/Settings.tsx:1446`; acc `README.md` ("Later it will be served from a skein at `accounts.1sat.app`"), `src/host.ts:8`; sdk `cli/src/help.ts:145`, `:903`.
- **Design says:** memory 2026-10-04: "wallet-server → storage only, rest → skein (accounts.1sat.app)".
- **Options:**
  - `/account/status` moves to the storage host (`wallet.1sat.app`), accounts.1sat.app = the skein page.
  - A skein at accounts.1sat.app also answers `/account/status`.

### I19 · skein's own web client registers with the wallet-server shape
- **Kind:** miswired
- **What:** `web/core.ts` `register` POSTs `{username}` over BRC-104, the wallet-server contract; the skein router wants `{username, identityKey, signature}` and answers 400 to that. Its live test targets a server with `/exchange-rate` and `/messagebox` (wallet-server) at `127.0.0.1:8100`, the same default port the skein router's scripts use; `web/build.ts` defaults `hostUrl` to the instance's origin (a skein). `scripts/host/register.ts` says 409 for a repeat by the same key; the router now answers 200.
- **Evidence:** skein `web/core.ts:25`, `:76-84`; `web/app.ts:96`; `web/envelope.test.ts:165-180`; `web/build.ts:48`; `scripts/host/register.ts:5-6`, `:10`; `src/host/router.ts:1102-1108`.
- **Design says:** docs/MESSAGES.md "Mailbox instances" (the router's contract); #103 call 7 (callers in this repo read only `messagebox`).
- **Options:**
  - Point `web/core.ts` at the router contract.
  - Delete the wallet-server path from skein's web client.
  - Fix the register.ts comment.

### I20 · Two sites cover the same handle functions and diverge
- **Kind:** duplicate
- **What:** skein-site (served by every skein; finds its host via `/.well-known/skein-host`) and 1sat-accounts (`?host=`, default `id.skein.nexus`) both register, list held handles, edit profiles and search. They differ: site lists only this host's certifier, acc any certifier; acc can relinquish, site cannot (and its manifest lacks the relinquishment permission); site searches on an explicit button, acc on debounced keystrokes; site has the Inbox, acc not. acc copies the router's HANDLE regex, RESERVED_HANDLES and domainOf.
- **Evidence:** site `app.js:1-21` (routes), `:311-314`, `:378`, `:463-490`, `:504-520`, `:946-1018`; site `manifest.json` (no `certificate relinquishment`); acc `src/app.ts:1-9`, `:240-248`, `:394-407`, `src/wallet.ts:238`, `:297-299`, `public/manifest.json:43`; acc `src/host.ts:10-13`, `:47-50` vs skein `src/host/router.ts:205-213`.
- **Design says:** memory (1sat accounts site): built 2026-10-05, David to review 11 calls; memory 2026-10-04: "rest → skein (accounts.1sat.app)"; #92 (the management site).
- **Options:**
  - accounts = the site's handle section served at accounts.1sat.app (one codebase).
  - Keep both; share one handles module.
  - Drop the handle section from skein-site.

### I21 · Name availability by search-as-you-type
- **Kind:** short-sighted
- **What:** acc checks availability by querying the host's search endpoint 350 ms after each keystroke and looking for an exact handle in up to 100 substring/profile-name matches; "truncated" gives "unknown". Search covers enabled rows only and is a hint by spec. site asks search only on an explicit button press.
- **Evidence:** acc `src/app.ts:232-252`; skein `src/host/router.ts:665-680`; site `app.js:463-490`.
- **Design says:** 169 §5.6 rule 1: "Search results are a hint, not an attestation"; rule 5: "A client MUST NOT broadcast keystrokes to foreign domains, SHOULD debounce and require an explicit action before querying a domain the user has not previously transacted with".
- **Options:**
  - Check with resolve (exact; 404 = free) on an explicit action.
  - Let register's 409 be the check.
  - Keep search with explicit action.

### I22 · No way to get a held handle's certificate back except re-register (which fails, I1); no reverse resolution
- **Kind:** short-sighted
- **What:** The only path for a key that already has a handle to obtain its certificate is to register the same name again; no `metanet.handles.reverse` endpoint is offered.
- **Evidence:** skein `src/host/handles.ts:82-86` (manifest: version, resolve, search only); #103 closing comment ("a 'Get certificate' path … wants the reverse lookup, §5.10"); #104 call 11; acc `src/app.ts:245`.
- **Design says:** 169 §5.10 (reverse resolution; "Every result MUST carry its certificate"; rule 4: not for the connected user's own handle when path 1 works).
- **Options:**
  - A BRC-104-authenticated "issue my certificate" route (key proven by session).
  - Reverse endpoint per §5.10.
  - Fix I1 so re-register works.

### I23 · Two certificate forms per binding (plaintext in resolve, encrypted in register)
- **Kind:** short-sighted
- **What:** Resolve answers a certificate with base64-plaintext fields; register answers one with BRC-52-encrypted fields and a keyring, same type, serial and certifier, different fields and signature. The certificate a wallet holds is never byte-equal to the one resolution returns.
- **Evidence:** skein `src/host/handles.ts:10-26`, `:141-147`, `:155-158`; #103 call 2.
- **Design says:** 169 §A.3 (plaintext base64 fields in the worked example); BRC-52 (0052.md:143): "The certifier signs only the encrypted `fields` map."
- **Options:**
  - Keep both (as decided in #103, David to review).
  - Resolution returns the encrypted form plus a keyring revealing `handle`/`domain` to anyone.

### I24 · Moving a handle or running two hosts: nothing carries a binding across
- **Kind:** short-sighted
- **What:** The domain is the request's host name, the certifier is each host's own derived key, the mailbox instance's store is a host-local path, and there are no forwarding records or export. A user moving hosts gets a new handle at a new domain with no link from the old one; two hosts cannot serve one domain (one trust key per domain).
- **Evidence:** skein `src/host/router.ts:209-213` (domainOf), `:1090`, `:891` (store under `<home>/instances/<name>`); docs/MESSAGES.md "BRC-169 is discovery" (certifier = the master's child, key ID `certifier`); acc `src/host.ts:47-50` (its own domainOf); site `app.js:361-366`.
- **Design says:** 169 §4.3 (forwarding record signed by the departing subject); §4.1 rule 2 (certifier = the domain's trust key). #40: "A later resolve/169 for the same key replaces the record (that is how a party moves hosts; the key is the identity)."
- **Options:**
  - Forwarding records served with `410` (§4.3).
  - Store export/import between hosts for a mailbox instance.
  - Rely on #40's key-based records (peers follow the key) and accept handle loss.

### I25 · Grouped-permission manifests duplicated and incomplete (#97 open)
- **Kind:** duplicate
- **What:** site and acc each ship a `manifest.json` with overlapping protocol sets; acc adds `certificate relinquishment`, site adds locators and the basket. Both omit calls their pages make (site's Inbox: `message encryption` per sender, `[1, "action label metanet payment"]`). #97 is still open.
- **Evidence:** site `manifest.json`; acc `public/manifest.json:10-69`; #97 comment 2026-10-04T08:22 ("Calls the page makes that the manifest does not cover").
- **Design says:** #97 body: "one grouped permission request … instead of a prompt per call".
- **Options:**
  - One manifest per page family, generated from the calls each page makes.
  - Close #97 with the known gaps listed.

### I26 · Docs and in-page text describe re-registration as safe
- **Kind:** stale-doc
- **What:** Several places state that registering again re-delivers the certificate; after a relinquish it fails (I1).
- **Evidence:** skein docs/MESSAGES.md "Mailbox instances" ("The same key and name again: the same handle, the certificate issued again"); `src/host/router.ts:1105-1107`; acc `src/app.ts:245`, `:394`; acc `README.md` (Manage: "The host keeps the registration"); #103 build comment (uniqueness note).
- **Design says:** 169 §4.6 rule 3.
- **Options:**
  - Correct the texts once I1 is decided.

### I27 · Paymail PKI route ignores the request's domain
- **Kind:** defect
- **What:** `/bsvalias/id/<handle>` without `@domain` looks up `localhost`, while resolve and register take the domain from the request's host name; in production `/bsvalias/id/david` answers 404 although `david@id.skein.nexus` exists. No `/.well-known/bsvalias` capability document is served.
- **Evidence:** skein `src/host/router.ts:1083-1088` vs `:1071-1074`, `:1090`.
- **Design says:** docs/MESSAGES.md "BRC-169 is discovery": "The host also answers the paymail PKI (`/bsvalias/id`)."
- **Options:**
  - Default to `domainOf(url.hostname)`.
  - Drop the route.
