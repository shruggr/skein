# The default image

One genesis for everyone, with no owner in it (#89). It has the front door,
the messagebox, the static app serving the management site, the explorer
route for whoever claims it, the git app's tree (not installed), and one row
to the kernel: `claim`, from anyone. The first claim names the owner: the
kernel writes the owner's admin rows and removes the claim row. Nothing else
is installed: the owner installs the rest, from the management page.
docs/BOOTSTRAP.md, "The default image".

- `bin/frontdoor.cid`, `bin/messagebox.cid`: the kernel's pinned modules
  (`wasm/`), by CID; `scripts/pin-programs.sh` keeps them current.
- `bin/static.wasm`: shruggr/skein-static v0.2.0's module.
- `etc/dispatch.json`: the claim row, the messagebox's box and http rows, the
  explorer at `/explore` (a session, read op `explore`), static at `/`
  (`www/index.html`) and under `/site/` (`www/`).
- `etc/reads.json`: `{op: "explore", owner: true}` — the explorer answers
  the instance's owner as the front door sees it at the request (the claim's
  key), and nobody before the claim (#92).
- `www/`: the management site, a copy of shruggr/skein-site v0.4.0's tree
  (the same git tree, `4d31151…`): the management page, with the Inbox (#99),
  handles (#103) and their profiles and search (#104).
- `apps/git/`: shruggr/skein-git v0.1.0's tree (the same git tree as that
  tag's commit). Not wired: the management page installs it from here as the
  owner (objects for its module and records, head, dispatch, start), and
  every other app through it, by hash.
