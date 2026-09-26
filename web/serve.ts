// A tiny static server for the page: web/index.html and web/dist/* only.
//   node --experimental-strip-types web/serve.ts [port]     (default 4400, 127.0.0.1)
// The Yours extension keys its grants by origin, so keep http://localhost:<port> fixed.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WEB } from "./build.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".map": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

export function serve(port: number, host = "127.0.0.1") {
  return createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const rel = path === "/" ? "index.html" : normalize(path).replace(/^\/+/, "");
    if (rel !== "index.html" && !rel.startsWith("dist/")) { res.writeHead(404).end("not found"); return; }
    try {
      const body = await readFile(join(WEB, rel));
      res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  }).listen(port, host);
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 4400);
  serve(port, process.env.SKEIN_WEB_HOST ?? "127.0.0.1").on("listening", () => console.log(`skein web: http://localhost:${port}`));
}
