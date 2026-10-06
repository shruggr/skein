# The default image

One genesis for everyone, with no owner in it (#89). It has the front door,
the messagebox, the wallet (#116, #130) and its funding row, the explorer
route for whoever claims it, the git app's tree (not installed), and one row
to the kernel: `claim`, from anyone. The first claim's sender is the owner
(#127: never a key in its body) — the owner's own message, or a claim the
owner signed before the instance existed, which the host forwards into it:
the kernel writes the owner's admin rows and removes the claim row. Nothing else
is installed, and nothing is served at `/` (#125): the owner installs the
rest from a management page — the host's own skein carries the management
site (shruggr/skein-site, an app), and the page talks to each skein
directly.
docs/BOOTSTRAP.md, "The default image".

- `bin/frontdoor.cid`, `bin/messagebox.cid`: the kernel's pinned modules
  (`wasm/`), by CID; `scripts/pin-programs.sh` keeps them current.
- `bin/wallet.cid`, `bin/wallet.json` (#116, #130): the wallet — core, in
  every skein — the same program record as src/runtime/programs.ts
  `WALLET`: a skein made from the image pays its host from it (docs/VM.md
  "Billing").
- `etc/dispatch.json`: the claim row, the messagebox's box and http rows, and
  the funding row (#130) `{http, /wallet/fund, *, wallet, fund, filter:
  "beef"}`: a payment to the skein's wallet — an Atomic BEEF and nothing
  else, paying its funding key (BRC-29 by a pre-set rule, counterparty
  anyone) — validated at the door, internalized; the host hands one in there
  (`POST /fund/<handle>`, once Arcade accepted it) even while the skein is
  held unpaid.
  The explorer row (`/explore`) is the claim's: the kernel writes it with
  the owner's key (#121).
- `chain/` (#132): **not in the repo** — the host adds it. The image a
  host boots skeins from is this directory with the whole header chain at
  `chain/headers/<first>` (2016 raw headers a block) and `chain/tip`, grown
  with every header the host receives (src/host/image-chain.ts; host.db
  `image`, `image_chain`, `image_blocks`), so a skein is born with the
  chain up to the current tip. docs/BOOTSTRAP.md, "The image's chain part".
- `apps/git/`: shruggr/skein-git v0.1.2's tree (the same git tree as that
  tag's commit; its fetch is the SDK's `fetch` intention, #126; its manifest
  check is skein's checkManifest, rule for rule: an overlay may list no topics). Not wired: the management page installs it from here as the
  owner (objects for its module and records, head, dispatch, start), and
  every other app through it, by hash.
