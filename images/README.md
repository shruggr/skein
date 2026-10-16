# Images

An image is a system tree a skein is born from (docs/BOOTSTRAP.md, "The
system tree"), with no root in its genesis and a claim route. It is the
boundary programs and, optionally, a list of apps to install at birth.

- `default/`: the default image — the front door, the messagebox, the
  wallet and the claim route; no apps. `skein-host add <h> --image default`,
  and every skein the instance manager creates.
- `host/`: the host image's own part, merged over `default/` (src/host/boot.ts
  `mergeImages`): the host skein's image, with skein-onboard. `skein-host
  add <h> --image host` boots an unclaimed skein from it.

`skein-host add <h> --image <dir>` boots from any image directory.

## An image's form

```
bin/<name>.wasm | bin/<name>.cid   a program's module, or its CID (the kernel's pinned modules: wasm/)
bin/<name>.json                    the program record's inputs, services and description
etc/dispatch.json                  the routes; an image's carry the claim route
etc/config.json                    optional: defaults, peers, names, collect, feeds, roles
etc/apps.json                      optional: the apps installed at birth, and root's own routes
```

`etc/apps.json`:

```json
{
  "install": [
    "apps/one",
    "..",
    { "url": "https://github.com/shruggr/skein-onboard/archive/refs/tags/v0.4.0.tar.gz",
      "hash": "ba29f99adb0d2d1849aa7f0cf72ceeefde88c5ae" }
  ],
  "routes": [{ "transport": "http", "address": "/", "prefix": true, "filters": ["site.get"], "root": "www" }]
}
```

Each `install` entry is one app, installed in order:

- **a directory**, relative to the image: a directory of the image's tree
  (`apps/one`), or one beside it (`..`, `../<dir>`), read from disk when the
  image is booted from its directory, as `skein install <dir>` reads it
  (`zig-out`, `.zig-cache`, `zig-pkg`, `.git` and `node_modules` left
  out). An app repository can carry its image as `image/`, listing `..`;
- **a release tarball** `{url, hash}`: `hash` is the git id of the app's
  tree (`git rev-parse <tag>^{tree}`). The host fetches it (gzip or plain
  tar; a tarball holding one directory, as a tag's archive does, is that
  directory), scans it as a directory, and refuses it unless its tree is
  `hash`. A source that already holds the tree is not fetched.

Each is installed as a directory install by message would install it — the
app's objects, its record under `<app>/app`, its routes — and the genesis
carries the result, so root upgrades it later by installing a newer version
the same way, keeping its state. An app with a `start` message is refused
at birth (a genesis carries no message): install it after the claim.
`routes` are root's own routes, added after the apps (a handler may be
`<app>.<role>` of an app above).

Two images merge (`mergeImages`): their `install` lists are joined (an app
in both is refused), and a route of the second at the same transport,
address and prefix as one of the first replaces it.
