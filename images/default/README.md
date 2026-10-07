# The default image

One genesis for everyone, with no owner in it (#89). It has the front door,
the messagebox, the wallet (#116, #130) and its funding row, and one row to
the kernel: `claim`, from anyone. The first claim's sender is the owner
(#127: never a key in its body) — the owner's own message, or a claim the
owner signed before the instance existed, which the host forwards into it:
the kernel writes the owner's admin rows and the explorer row and removes
the claim row. **Three apps are installed at birth** (#141): chain, git and
site — as apps, each with its record under `<app>/app`, its rows and its
reads, so the owner upgrades them like any other and their state stays
their own. A new skein answers its management page at `/`.
docs/BOOTSTRAP.md, "The default image".

- `bin/frontdoor.cid`, `bin/messagebox.cid`: the kernel's pinned modules
  (`wasm/`), by CID; `scripts/pin-programs.sh` keeps them current.
- `bin/wallet.cid`, `bin/wallet.json` (#116, #130): the wallet — core, in
  every skein — the same program record as src/runtime/programs.ts
  `WALLET`: a skein made from the image pays its host from it (docs/VM.md
  "Billing").
- `etc/dispatch.json`: the claim row, the messagebox's box and http rows, and
  the funding row (#130) `{http, /wallet/fund, *, wallet, fund, filter:
  "beef"}`: a payment to the skein's wallet — an Atomic BEEF with the
  header `x-skein-outputs` — validated at the door, internalized; the host
  hands one in there (`POST /fund/<handle>`) even while the skein is asleep.
  The explorer row (`/explore`) is the claim's: the kernel writes it with
  the owner's key (#121).
- `etc/apps.json` (#141): the apps installed at birth — `apps/chain`,
  `apps/git`, `apps/site`, in that order — and the owner's read `/` (prefix)
  → `site.site`'s `get`, root `www`. The loader plans each one with
  src/host/plan.ts (`readStoredApp` over its tree here, `planInstall`,
  `planOwnerRead`) and the genesis carries the result: the records in the
  store, the rows (each with `app`) in `dispatch`, and the heads
  `<app>/app` and `reads` in `heads`. The same CIDs as an install by
  messages, except that no row whose manifest sender is `$owner` is written
  (an image has no owner): chain's `chain` row from the owner and git's
  only row. The owner adds those after the claim: `skein plan install
  <the app's tree>` again sends the head (unchanged) and just those rows,
  as the install writes them (with `app`; chain's with `filter: beef`).
  `skein plan dispatch add` also adds a row, but without `app`, and a
  mailbox row there takes no settings.
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
