// The browser helpers the browser scenarios share (browser-live.ts, libp2p.ts, site.ts): Playwright
// and Chromium, a server for the wasm kernel's files, a store as a bundle and back.
//
// Needs Playwright (mise: `playwright` on PATH, or SKEIN_PLAYWRIGHT=<its package
// dir>) and Chromium (SKEIN_CHROMIUM, default /usr/bin/chromium). (The corpus
// replayed in Chrome against the native replay is gone: the wasm kernel is
// compared with the native one once, by wasm-host.ts.)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const kz = join(here, "..");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json", ".map": "application/json", ".css": "text/css" };

// ---------------------------------------------------------------- shared with equiv/browser-live.ts

/** The Playwright package: SKEIN_PLAYWRIGHT, else the one `playwright` on PATH belongs to. */
export async function playwright(): Promise<typeof import("playwright")> {
  let dir = process.env.SKEIN_PLAYWRIGHT;
  if (!dir) {
    const bin = execFileSync("sh", ["-c", "command -v playwright"], { encoding: "utf8" }).trim();
    dir = join(dirname(realpathSync(bin)), "../playwright");
  }
  return await import(pathToFileURL(join(dir, "index.mjs")).href);
}

export const chromium = () => process.env.SKEIN_CHROMIUM ?? "/usr/bin/chromium";

/** A server for the kernel's files: /web/* (kernel-zig/web), /kernel/skein-kernel.wasm, plus `routes`; cross-origin isolated. */
export function serveKernel(routes: (req: IncomingMessage, res: ServerResponse, path: string) => boolean | Promise<boolean>, extra: Record<string, string> = {}): Promise<Server> {
  const server = createServer(async (req, res) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    try {
      if (await routes(req, res, path)) return;
      let file: string | undefined;
      if (path === "/kernel/skein-kernel.wasm") file = join(kz, "zig-out/web/skein-kernel.wasm");
      else if (path.startsWith("/web/")) file = join(kz, "web", normalize(path.slice(5)).replace(/^(\.\.\/)+/, ""));
      else for (const [prefix, dir] of Object.entries(extra)) if (path.startsWith(prefix)) file = join(dir, normalize(path.slice(prefix.length)).replace(/^(\.\.\/)+/, ""));
      if (!file || !existsSync(file)) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

export function body(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- stores as bundles (kernel.js readBundle/writeBundle)

/** A SQLite store (format 2: blocks + pointers) as a bundle. */
export function bundleOf(db: string): Uint8Array {
  const d = new DatabaseSync(db, { readOnly: true });
  const parts: Uint8Array[] = [];
  const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  for (const r of d.prepare("SELECT cid, bytes FROM blocks").all() as Array<{ cid: Uint8Array; bytes: Uint8Array }>) parts.push(u32(r.cid.length), r.cid, u32(r.bytes.length), r.bytes);
  parts.push(u32(0));
  for (const r of d.prepare("SELECT name, cid FROM pointers").all() as Array<{ name: string; cid: Uint8Array }>) {
    const n = new TextEncoder().encode(r.name);
    parts.push(u32(n.length), n, u32(r.cid.length), r.cid);
  }
  d.close();
  return new Uint8Array(Buffer.concat(parts));
}

/** A bundle written out as a SQLite store (sqlite_store.zig's DDL), for `skein-kernel dump`. */
export function writeStore(bundle: Uint8Array, db: string): void {
  rmSync(db, { force: true });
  const d = new DatabaseSync(db);
  d.exec("CREATE TABLE blocks (cid BLOB PRIMARY KEY, bytes BLOB NOT NULL) WITHOUT ROWID; CREATE TABLE pointers (name TEXT PRIMARY KEY, cid BLOB NOT NULL) WITHOUT ROWID;");
  const dv = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  let i = 0;
  const u32 = () => { const v = dv.getUint32(i, true); i += 4; return v; };
  const put = d.prepare("INSERT INTO blocks (cid, bytes) VALUES (?, ?)");
  d.exec("BEGIN");
  for (;;) {
    const cn = u32();
    if (!cn) break;
    const cid = bundle.subarray(i, i + cn); i += cn;
    const bn = u32();
    put.run(cid, bundle.subarray(i, i + bn)); i += bn;
  }
  const pp = d.prepare("INSERT INTO pointers (name, cid) VALUES (?, ?)");
  while (i < bundle.length) {
    const nn = u32();
    const name = new TextDecoder().decode(bundle.subarray(i, i + nn)); i += nn;
    const cn = u32();
    pp.run(name, bundle.subarray(i, i + cn)); i += cn;
  }
  d.exec("COMMIT");
  d.close();
}
