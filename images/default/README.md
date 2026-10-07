# The default image

One genesis for everyone, with no root in it (#89, #143). It has the front
door, the messagebox, the wallet (#116, #130) and its funding route, the
admin routes (root's: nobody holds root yet) and the claim route, open:
the first claim's sender is granted root (#127: never a key in its body) —
the claimant's own message, or a claim signed before the instance existed,
which the host forwards into it — and the claim route is removed. **Three
apps are installed at birth** (#141): chain, git and site — as apps, each
with its record under `<app>/app` and its routes, so root upgrades them like
any other and their state stays their own. A new skein answers its
management page at `/`. docs/BOOTSTRAP.md, "The default image".

- `bin/frontdoor.cid`, `bin/messagebox.cid`: the kernel's pinned modules
  (`wasm/`), by CID; `scripts/pin-programs.sh` keeps them current.
- `bin/wallet.cid`, `bin/wallet.json` (#116, #130): the wallet — core, in
  every skein — the same program record as src/runtime/programs.ts
  `WALLET`: a skein made from the image pays its host from it (docs/VM.md
  "Billing").
- `etc/dispatch.json` (#143: routes, no senders): the claim route, `:ack`
  (an event route), the handshake route, the messagebox's http routes and
  the explorer behind `kernel.brc104` (the explorer gated by root: every
  genesis's `roles`), and the funding route `{http, /wallet/fund,
  filters: ["kernel.beef"], wallet, fund}`: a payment to the skein's wallet —
  an Atomic BEEF with the header `x-skein-outputs` — validated at the door,
  internalized; the host hands one in there (`POST /fund/<handle>`) even
  while the skein is asleep.
- `etc/apps.json` (#141, #143): the apps installed at birth — `apps/chain`,
  `apps/git`, `apps/site`, in that order — and root's own route `/`
  (prefix): the read route `{filters: ["site.get"], root: "www"}`. The
  loader plans each app with src/host/plan.ts (`readStoredApp` over its tree
  here, `planInstall`, `planRootRoute`) and the genesis carries the result:
  the records in the store, the routes (each app's with `app`) in
  `dispatch`, and the heads `<app>/app` in `heads`. The same CIDs as an
  install by messages. Nothing waits for the claim: an app's functions that
  were "from `$owner`" are gated by root in its manifest's `roles` (git's
  `call`), and the claim grants root. The host skein boots from the host
  image (`images/host` merged over this one, with the onboarding app), its
  genesis's `root` the operator's key (docs/BOOTSTRAP.md, "The host image
  and the host skein").
- `apps/chain/`, `apps/git/`, `apps/site/`: shruggr/skein-chain v0.4.0
  (e8d2102), shruggr/skein-git v0.1.3 (3726730), shruggr/skein-site v0.7.7
  (52a7534) — each the same git tree as that tag's commit.
- `chain/` (#132): **not in the repo** — the host adds it. The image a
  host boots skeins from is this directory with the whole header chain at
  `chain/headers/<first>` (2016 raw headers a block) and `chain/tip`, grown
  with every header the host receives (src/host/image-chain.ts; host.db
  `image`, `image_chain`, `image_blocks`), so a skein is born with the
  chain up to the current tip, and its chain app installed to read it. The
  host subscribes it to its headers feed from its creation (its table has
  the chain app's event row), pushing first the headers between its tip and
  the host's. docs/BOOTSTRAP.md, "The image's chain part".
