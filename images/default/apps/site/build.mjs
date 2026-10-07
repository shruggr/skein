// Build www/lib.js and www/webwallet.js (with their shared chunks) from lib/*.ts.
//
//   npm ci
//   SKEIN_DIR=../skein node build.mjs        a skein checkout at lib/SKEIN_REV
//
// The skein modules (the BRC-104 client, the install plan) are read from
// $SKEIN_DIR; every package they and lib/ import resolves from this
// directory's node_modules (package-lock.json), so the output depends on
// this tree, the skein commit and nothing else. node:crypto and Buffer
// are skein's browser shims (web/shims). The output is committed: the app
// serves www/ as it is in the tree.

import { build } from "esbuild";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = dirname(fileURLToPath(import.meta.url));
const WWW = join(SITE, "www");
const SKEIN = resolve(process.env.SKEIN_DIR ?? join(SITE, "../skein"));
const rev = readFileSync(join(SITE, "lib/SKEIN_REV"), "utf8").trim();
if (!existsSync(join(SKEIN, "src/client/raw.ts"))) throw new Error(`${SKEIN}: not a skein checkout (set SKEIN_DIR; lib/SKEIN_REV names the commit: ${rev})`);

/** `skein/…` is the checkout; any other bare import resolves from this directory. */
const resolveHere = {
  name: "resolve-here",
  setup(b) {
    b.onResolve({ filter: /^skein\// }, (a) => ({ path: join(SKEIN, a.path.slice("skein/".length)) }));
    b.onResolve({ filter: /^[^./]/ }, async (a) => {
      if (a.pluginData === "here" || a.path.startsWith("node:")) return undefined;
      const r = await b.resolve(a.path, { kind: a.kind, resolveDir: SITE, pluginData: "here" });
      return r.errors.length ? { errors: r.errors } : { path: r.path, sideEffects: r.sideEffects };
    });
  },
};

for (const f of readdirSync(WWW)) if (/^chunk-.*\.js$/.test(f)) rmSync(join(WWW, f)); // the last build's chunks

await build({
  entryPoints: { lib: join(SITE, "lib/entry.ts"), webwallet: join(SITE, "lib/webwallet.ts") },
  outdir: WWW,
  bundle: true,
  splitting: true,
  chunkNames: "chunk-[hash]",
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  plugins: [resolveHere],
  alias: {
    "node:crypto": join(SKEIN, "web/shims/crypto.ts"),
    "node:fs": join(SKEIN, "web/shims/node-stub.ts"),
    "node:path": join(SKEIN, "web/shims/node-stub.ts"),
  },
  inject: [join(SKEIN, "web/shims/buffer.ts")],
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
});
console.log(`www/lib.js, www/webwallet.js (skein ${rev} at ${SKEIN})`);
