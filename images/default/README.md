# The default image

One genesis for everyone, with no root in it (#89, #143). It has the front
door, the messagebox, the wallet (#116, #130), the admin routes (root's:
nobody holds root yet) and the claim route, open: the first claim's sender
is granted root (#127: never a key in its body) — the claimant's own
message, or a claim signed before the instance existed, which the host
forwards into it — and the claim route is removed. **It has no apps**
(#152): root installs them by message after the claim (`skein install
<dir>`), and a reinstall of a newer version keeps the app's state (docs/APPS.md,
"Reconfiguration"). Nothing is served at `/` until root routes it.
docs/BOOTSTRAP.md, "The default image".

- `bin/frontdoor.cid`, `bin/messagebox.cid`: the kernel's pinned modules
  (`wasm/`), by CID; `scripts/pin-programs.sh` keeps them current.
- `bin/wallet.cid`, `bin/wallet.json` (#116, #130): the wallet — core, in
  every skein — the same program record as src/runtime/programs.ts
  `WALLET`: a skein made from the image pays its host from it (docs/VM.md
  "Billing").
- `etc/dispatch.json` (#143: routes, no senders): the claim route, `:ack`
  (an event route), the handshake route, the messagebox's http routes and
  the explorer behind `kernel.brc104` (the explorer gated by root: every
  genesis's `roles`). No route to the wallet: root funds the skein by the
  wallet's `internalize` message on a route of its own (docs/WALLET.md).
- `etc/config.json`: `{collect: []}`.
- `chain/` (#132): **not in the repo** — the host adds it. The image a
  host boots skeins from is this directory with the whole header chain at
  `chain/headers/<first>` (2016 raw headers a block) and `chain/tip`, grown
  with every header the host receives (src/host/image-chain.ts; host.db
  `image`, `image_chain`, `image_blocks`), so a skein is born with the
  chain up to the current tip, for the chain app to read once root installs
  it. From then on the host pushes it its headers feed (the chain app's
  event row), first the headers between its tip and the host's.
  docs/BOOTSTRAP.md, "The image's chain part".

The host skein boots from the host image: `images/host` merged over this
one, its `etc/apps.json` naming shruggr/skein-onboard v0.4.0 by its release
tarball (images/README.md).
