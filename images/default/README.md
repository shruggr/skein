# The default image

One genesis for everyone, with no owner in it (#89). It has the front door,
the messagebox, the static app serving the management site, the explorer
route for whoever claims it, the git app's tree (not installed), and one row
to the kernel: `claim`, from anyone. The first claim's sender is the owner
(#127: never a key in its body) — the owner's own message, or a claim the
owner signed before the instance existed, which the host forwards into it:
the kernel writes the owner's admin rows and removes the claim row. Nothing else
is installed: the owner installs the rest, from the management page.
docs/BOOTSTRAP.md, "The default image".

- `bin/frontdoor.cid`, `bin/messagebox.cid`: the kernel's pinned modules
  (`wasm/`), by CID; `scripts/pin-programs.sh` keeps them current.
- `bin/static.wasm`: shruggr/skein-static v0.2.1's module.
- `etc/dispatch.json`: the claim row, the messagebox's box and http rows, the
  explorer at `/explore` (sender `"owner"`, #115: the instance's owner as
  the kernel sees it at the request — the claim's key — and nobody before
  the claim, #92), static at `/`
  (`www/index.html`), at `/manifest.json` (`www/manifest.json`, the
  wallet's grouped permission request for the page at the instance's own
  origin, #97) and under `/site/` (`www/`).
- `www/`: the management site, a copy of shruggr/skein-site v0.5.2's tree
  (the same git tree, `b6423d2…`): the management page, with the Inbox (#99),
  handles (#103) and their profiles and search (#104), and its
  `manifest.json` (#97).
- `apps/git/`: shruggr/skein-git v0.1.0's tree (the same git tree as that
  tag's commit). Not wired: the management page installs it from here as the
  owner (objects for its module and records, head, dispatch, start), and
  every other app through it, by hash.
