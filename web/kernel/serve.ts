// Build and serve the kernel proof page (issue #35): web/kernel/app.ts →
// web/kernel/dist/app.js, then a static server, cross-origin isolated (the
// kernel's Worker waits on a SharedArrayBuffer), for:
//   /                           web/kernel/index.html
//   /dist/*                     the bundle
//   /web/*                      kernel-zig/web (the shim, the worker)
//   /kernel/skein-kernel.wasm   kernel-zig/zig-out/web (cd kernel-zig && zig build web)
//   /wasm/*                     the pinned modules (installed into IndexedDB once)
//
//   node --experimental-strip-types web/kernel/serve.ts [port]      (default 4401, 127.0.0.1)

import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOptions } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
/**
 * The bundle's options (from the page client web/build.ts, removed in skein next): the node modules the
 * shared code imports (node:crypto, node:fs/path, Buffer) mapped to web/kernel/shims.
 */
export function browserOptions(entry: string, outfile: string): BuildOptions {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    sourcemap: true,
    logLevel: "warning",
    alias: {
      "node:crypto": join(HERE, "shims/crypto.ts"),
      "node:fs": join(HERE, "shims/node-stub.ts"),
      "node:path": join(HERE, "shims/node-stub.ts"),
    },
    inject: [join(HERE, "shims/buffer.ts")],
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  };
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".map": "application/json", ".json": "application/json" };

export async function buildPage(): Promise<void> {
  const { build } = await import("esbuild");
  await build(browserOptions(join(HERE, "app.ts"), join(HERE, "dist/app.js")));
}

export function servePage(port = 4401, host = "127.0.0.1"): Promise<Server> {
  const roots: Array<[string, string]> = [
    ["/dist/", join(HERE, "dist")],
    ["/web/", join(ROOT, "kernel-zig/web")],
    ["/kernel/", join(ROOT, "kernel-zig/zig-out/web")],
    ["/wasm/", join(ROOT, "wasm")],
  ];
  const server = createServer((req, res) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cache-Control", "no-store");
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file: string | undefined = path === "/" ? join(HERE, "index.html") : undefined;
    for (const [prefix, dir] of roots) if (path.startsWith(prefix)) file = join(dir, normalize(path.slice(prefix.length)).replace(/^(\.\.\/)+/, ""));
    if (!file || !existsSync(file)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.main) {
  await buildPage();
  const port = Number(process.argv[2] ?? 4401);
  await servePage(port, process.env.SKEIN_WEB_HOST ?? "127.0.0.1");
  console.log(`skein kernel page: http://localhost:${port}/?messagebox=http://127.0.0.1:8100/messagebox`);
}
