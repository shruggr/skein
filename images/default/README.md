# The default image

One genesis for everyone, with no owner in it (#89). It has the front door,
the messagebox, the explorer route for whoever claims it, the git app's
tree (not installed), and one row
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
- `etc/dispatch.json`: the claim row and the messagebox's box and http rows.
  The explorer row (`/explore`) is the claim's: the kernel writes it with
  the owner's key (#121).
- `apps/git/`: shruggr/skein-git v0.1.1's tree (the same git tree as that
  tag's commit; its fetch is the SDK's `fetch` intention, #126). Not wired: the management page installs it from here as the
  owner (objects for its module and records, head, dispatch, start), and
  every other app through it, by hash.
