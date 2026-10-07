# skein-onboard

The onboarding app for a [skein](https://github.com/shruggr/skein) host:
installed in the **host skein** (the operator's own instance on a host), it
gives anyone with a wallet a place on the host, and it is the host's
**BRC-169 server**. A page with a BRC-104 session gets a skein of its own; a
wallet that signs a registration gets a mailbox instance and a handle
certificate. Every handle the host certifies is recorded here; resolve,
search and the manifest are answered from those records. The app asks the
host's **instance manager** for every instance and the host's **certifier**
for every signature; it holds no key. It finds both in its address book by
transport and address (`local` `manager`, `local` `certifier`). Version **0.3.4**.

## What it is

One program, `bin/onboard.wasm`, on three rows and four reads (installed
under `/onboard/`). A row is a message route: the request is signed (a
BRC-104 session) and is an entry in the log. A read (shruggr/skein#135) is
served by a call over the current state: anyone, signed or not, any method,
nothing logged.

| route | | sender | body / query | answer |
|---|---|---|---|---|
| `POST /onboard/call` | row | `session` | `{fn: "onboard.create", args: {handle, image?, claim}}` | `{fn, result: {handle, identity, url}}` |
| `POST /onboard/register` | row | `session` | `{username, identityKey, signature}` | `{handle, domain, identityKey, messagebox, certificate, keyringForSubject}` |
| `POST /onboard/profile` | row | `*` (any key, signed) | `{handle, record, signature}` | `{handle, profile, displayName?, avatarURL?}` |
| `GET /onboard/resolve` | read | | `?handle=<handle>[@<domain>]` | BRC-169 §5.2 |
| `GET /onboard/search` | read | | `?q=&limit=` | BRC-169 §5.6 |
| `GET /onboard/manifest.json` | read | | | BRC-169 §5.1 |
| `GET /onboard/bsvalias/id/<handle>[@<domain>]` | read (prefix) | | | the paymail PKI |

The profile writes (it keeps the holder's signed record), so it is a row:
a signed request, over any key's session, as registration is.

The host's router maps its own origin onto these (skein
`docs/MESSAGES.md`, "BRC-169 is discovery"): `/manifest.json`,
`/.well-known/metanet-handles/resolve` and `/search` and
`/bsvalias/id/…` reach the reads, `POST /account/register` and `POST
/account/profile` the rows, in the host skein.

### Configuration

`config.onboard` in the installed manifest, written at install
(`skein-host install … --config '{"onboard": {…}}'`):

| key | meaning |
|---|---|
| `domain` | the one domain this host's handles are at, `<handle>@<domain>` (default `localhost`) |
| `origin` | the host's own origin, where the manifest says resolve and search are (default `https://<domain>`) |
| `name`, `note`, `icon` | the host's presentation in `metanet.trust` (each optional) |
| `ordfs` | the ORDFS content route an avatar's URL is derived under (default `https://api.1sat.app/content`; empty: none) |

### Registering (`POST /onboard/register`)

A registration is a write, so it is a signed request (shruggr/skein#135):
it comes over the registrant's BRC-104 session (the stock `AuthFetch`; the
router carries the handshake at the host's own origin to the host skein),
and the registrant is the session's identity. The body: `username` (a host name label), `identityKey` (hex), and
`signature` (hex DER): the key's `createSignature` under
`[2, "skein register"]`, key ID the username, counterparty `anyone`, over
the UTF-8 text `register <username>@<domain>` — the domain is this host's
(`config.onboard.domain`, which the router also answers at
`/.well-known/skein-host`), so a registration signed for one host is not
good at another.

1. The route handler checks the session (401: none), the body (400), that
   `identityKey` is the session's (403), the signature (401), the name
   (409: reserved — `id`, `host` — or another key's), and that the key holds
   no other handle here (409: one key, one handle). It records the request
   and launches a thread; the client's connection is held until the thread
   comes to rest.
2. The thread emits `create {handle, owner: <the key>, image: "mailbox",
   domain}` to the instance manager (unless the key holds this handle
   already) and rests. The manager creates the mailbox instance and answers
   `{handle, identity, url}` (or `{error}`: the handle is an instance's,
   409). The answer is recorded under `onboard/instances/<handle>`.
3. The thread puts the **issuance record** `{kind: "handle-issuance",
   handle, domain, subject, messagebox, issuedAt, request, prev?}` and emits
   `issue {handle, domain, subject, serialNumber, issuance}` to the
   certifier. The serial number is base64 of the issuance record's SHA-256
   (the digest its CID names): every issue has its own, a re-registration
   included.
4. The certifier answers `{certificate, holder: {certificate,
   keyringForSubject}, serialNumber, issuance}`: the plaintext certificate a
   resolver checks and the holder's copy (BRC-52 encrypted fields and the
   keyring a wallet's `acquireCertificate` takes). The thread writes the
   **certificate record** `{kind: "handle-certificate", handle, domain,
   subject, messagebox, issuedAt, serialNumber, issuance, prev?,
   certificate, holder}`, moves `onboard/handles/<handle>` to it (its `prev`
   the record before: the trail of every issue) and the index
   `onboard/index` (`handles`: handle → record; `keys`: key → handle), and
   answers the page the holder's copy.

The same key and name again: the mailbox stands, a new certificate is
issued under a new serial (a wallet that removed the old one can take it).

`onboard.create` goes the same way with the default image, and the new
instance's handle is certified for the instance's own identity. Its owner
is whoever signed its claim (shruggr/skein#127), and the page signs it:

- `args.claim` is `{message, body}`: `message` a mail record `{kind:
  "mail", op: "put", sender: <the wallet's identity key>, box: "claim",
  body: <the CID of body>, nonce, signature}` naming **no recipient** (the
  instance does not exist yet), signed as every skein message is —
  `createSignature` under `[2, "metanet handles envelope"]`, key ID `send`,
  counterparty `anyone`, over the dag-cbor of the record without
  `signature`; `body` the dag-cbor bytes of `{messagebox?, handle?,
  domain?}` (the owner's mailbox entry, if any). Sent as dag-json
  (`{"/": {"bytes": …}}` for bytes, `{"/": "<cid>"}` for the CID).
- This app passes it to the instance manager untouched (`create {handle,
  owner, image?, domain, claim}`); the manager checks that its sender is
  the session's key and forwards it into the new instance as its first
  entry, before the hostname is published. The instance's front door checks
  the signature, and the kernel writes the signer's admin rows and removes
  the claim row. The host signs nothing for the owner.
- No claim: 400 `bad-args` (`args.claim: missing`). Another key's claim,
  or one whose signature does not hold: 409 `refused`, and the instance is
  left unpublished.

### The profile (`POST /onboard/profile`)

`record`: base64 of the DAG-CBOR `{domain, name?, avatar?}` (`@1sat/utils`
`encodeProfile`; `avatar` a 36-byte outpoint); `signature`: hex DER by the
handle's key under `[1, "metanet handles profile"]`, key ID `1`,
counterparty `anyone`, over those bytes. Checked (401 another key; 400 not
this domain or not the shape; 404 no such handle) and kept under
`onboard/profiles/<handle>`; resolve and search serve it with
`displayName` and `avatarURL`.

### Error codes of `/onboard/call`

`bad-request` 400, `bad-args` 400, `not-admitted` 403 (no session),
`unknown-fn` 404, `refused` 409 (the instance manager said no), `failed`
500 (the thread failed: for one, no instance manager or certifier in this
skein's address book, because the app is not in the host skein). The
routes answer `{error}` (register, profile) or §5.3's `{metanetHandles,
error: {code, message}}` (resolve).

`src/main.zig` documents the contract in full.

## Use it

`skein-host init` creates the host skein (the instance manager and the
certifier in its address book); then the operator installs this app into
it:

```
skein-host install https://github.com/shruggr/skein-onboard#v0.3.4 --instance host \
  --config '{"onboard": {"domain": "skein.nexus"}}'
```

A host skein made before the certifier was in the host skein's address
book needs its entry, sent by the owner: `skein plan peers add <certifier
key> certifier --transport local …` (the key: what the host's manifest
published as `metanet.trust.publicKey` before this app served it — the
master secret's child under `[2, "skein provider"]`, key ID `certifier`).

## Build and test

Zig 0.16.0 (`mise.toml`).

```
zig build          # zig-out/bin/onboard.wasm
zig build bin      # the same, into bin/onboard.wasm (committed; the build is reproducible)
zig build test     # the bodies, the signatures (vectors from @bsv/sdk), the queries, the answers (natively)
```

skein runs this app end to end: `src/host/router.test.ts` and
`src/host/handles.test.ts` (registration, the certificate records,
resolve, search, the profile) and `kernel-zig/equiv/host.ts` (`skein-host
init`, the app installed, a client creating a skein, it resolving with its
certificate), at the commit pinned in `src/testapps.ts`.

## Docs

| what | where |
|---|---|
| the program's contract | `src/main.zig` |
| the host skein, the instance manager, the certifier | skein `docs/ARCH.md`, `docs/MESSAGES.md` "The providers" |
| registration and BRC-169 | skein `docs/MESSAGES.md` "Mailbox instances", "BRC-169 is discovery" |
| apps, manifests, install | skein `docs/APPS.md` |

## Versions

| | |
|---|---|
| this app | 0.3.4 (tag `v0.3.4`): resolve, search, the manifest and the paymail PKI are reads (`reads[]`, shruggr/skein#135: served by a call, nothing logged); `/profile` stays a row and takes a signed request; 0.3.3: `/register` takes a session, the registrant its identity (shruggr/skein#135); 0.3.2: skein-sdk v0.7.1; 0.3.1: the manager and the certifier found by `sk.peerAt("local", …)` (the address book has no roles, shruggr/skein#126); 0.3.0: `onboard.create` takes the caller's signed claim (shruggr/skein#127) |
| skein-sdk | v0.7.1, by tag tarball and hash in `build.zig.zon` (`cbor`, `sk`, `app`, `dagjson`, `secp`; no wallet) |
| skein | log format 8; skein's tests pin this repo by commit |

## Contributing

Work is tracked in shruggr/skein; start at issue
[#31](https://github.com/shruggr/skein/issues/31). MIT, as skein.
