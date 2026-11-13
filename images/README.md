# Images

An image is a system tree a skein is born from (docs/BOOTSTRAP.md, "The system tree"): its starting
rows, its config, and the apps it installs at birth (skein next, SPEC.md sections 3 and 8: one
loader; everything about the starting point comes from the tree).

- `default/`: the default image — the kernel's operation rows (root's) and the claim row; no apps.
  `skein-host add <h> --image default`, and an instance a host creates by default.

`skein-host add <h> --image <dir>` boots from an image directory. One with `etc/routes.json` is a
complete image. One without it is merged over `default/` first (#152), so an app repository's
`image/` needs only `etc/apps.json`.

## An image's form

```
etc/routes.json    the starting rows, as the kernel takes them: {kind, path | name, role, checks?,
                   recheck?, handler, …settings}
etc/config.json    optional: {defaults?, grants?: {<role>: [<identity key, hex>]}}
etc/apps.json      optional: the apps installed at birth, and root's own rows
```

`etc/apps.json`:

```json
{
  "install": [
    "apps/one",
    "..",
    { "url": "https://github.com/shruggr/skein-chain/archive/refs/tags/v1.0.0.tar.gz",
      "hash": "<the tag's tree id, 40 hex>" }
  ],
  "routes": [{ "kind": "read", "path": "/", "prefix": true, "role": "anyone", "handler": "amm.www.page", "root": "www" }]
}
```

Each `install` entry is one app, installed in order: a directory relative to the image (one of its
tree, or one beside it: `..`, `../<dir>`, read from disk as `skein install <dir>` reads it), or a
release tarball `{url, hash}` (`hash` the git id of the app's tree), fetched and checked. Each is
installed as root's install requests would install it — the app's objects, its record under
`<app>/app`, its rows — and the genesis carries the result. `routes` are root's own rows, added after
the apps (a handler or check of an app above).

Two images merge (`mergeImages`): their `install` lists are joined (an app in both is refused), and a
row of the second at the same key as one of the first replaces it. Any other path in both is refused
unless it is the same file.
