# The default image

One genesis for everyone, with no owner in it (#89). It has the front door,
the messagebox, the static app serving `www/` at `/`, and one row to the
kernel: `claim`, from anyone. The first claim names the owner: the kernel
writes the owner's admin rows and removes the claim row. Nothing else: the
owner installs the rest. docs/BOOTSTRAP.md, "The default image".

- `bin/frontdoor.cid`, `bin/messagebox.cid`: the kernel's pinned modules
  (`wasm/`), by CID; `scripts/pin-programs.sh` keeps them current.
- `bin/static.wasm`: shruggr/skein-static v0.2.0's module.
- `etc/dispatch.json`: the claim row, the messagebox's box and http rows,
  static at `/`. `etc/routes.json` and `etc/reads.json` are empty: no
  explorer route (no owner to give it to at genesis).
- `www/`: the management site (#92); a placeholder page until it exists.
