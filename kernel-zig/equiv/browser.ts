// The browser build's replay proof (issue #35): each store's log replayed by
// the wasm kernel (zig-out/web/skein-kernel.wasm) in headless Chrome — in a
// Worker, programs on V8 with fuel by instrumentation, the destination an
// IndexedDB database — against `skein-kernel replay` natively. Required
// identical: the replay report (log lines, emits, log tip, index costs, state
// record CID) and everything `skein-kernel dump` derives from the store
// IndexedDB kept (read back by a fresh worker and written out as SQLite):
// entries, chains, every update with its fuel, the state CID.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/browser.ts <store.db>…
//
// Needs Playwright (mise: `playwright` on PATH, or SKEIN_PLAYWRIGHT=<its package
// dir>) and Chromium (SKEIN_CHROMIUM, default /usr/bin/chromium).
//
// A store larger than SKEIN_BROWSER_MAX_MB (default 256) is skipped, with a
// note: a tab holds the store's bundle, its blocks and the wasm kernel's
// memory at once, and Chrome crashes on one of hundreds of MB. Since #83 every
// store with the shell app installed is that large (its install messages carry
// the shell's ~50 MB of modules, and the log records each several times over),
// so the corpus's shell runs (gen-run, gen-chat, gen-fuel) are replayed
// natively only.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const kz = join(here, "..");
const kernelBin = process.env.SKEIN_KERNEL ?? join(kz, "zig-out/bin/skein-kernel");
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

// ---------------------------------------------------------------- the proof

function run(args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync(kernelBin, args, { maxBuffer: 1 << 30, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`skein-kernel ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
}

function firstDiff(a: string, b: string, what: string): string {
  const x = JSON.parse(a), y = JSON.parse(b);
  for (const k of Object.keys({ ...x, ...y })) {
    const p = JSON.stringify(x[k]), q = JSON.stringify(y[k]);
    if (p === q) continue;
    if (Array.isArray(x[k]) && Array.isArray(y[k])) {
      const at = (x[k] as unknown[]).findIndex((v, i) => JSON.stringify(v) !== JSON.stringify(y[k][i]));
      return `${what} ${k}: first difference at ${at}\n    browser ${JSON.stringify(x[k][at])}\n    native  ${JSON.stringify(y[k][at])}`;
    }
    return `${what} ${k}: browser ${p.slice(0, 200)} vs native ${q.slice(0, 200)}`;
  }
  return `${what}: differs`;
}

const MAX_MB = Number(process.env.SKEIN_BROWSER_MAX_MB ?? 256);

async function main(sources: string[]): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), "skein-kz-browser-"));
  const results = new Map<string, Uint8Array>();
  const bundles = new Map<string, Uint8Array>();
  const server = await serveKernel(async (req, res, path) => {
    if (path === "/") { res.writeHead(200, { "content-type": TYPES[".html"] }).end(readFileSync(join(here, "browser.html"))); return true; }
    const b = /^\/bundle\/(.+)$/.exec(path);
    if (b) { res.writeHead(200, { "content-type": "application/octet-stream" }).end(bundles.get(b[1]!)); return true; }
    const r = /^\/result\/(.+)$/.exec(path);
    if (r && req.method === "POST") { results.set(r[1]!, await body(req)); res.writeHead(200).end("ok"); return true; }
    return false;
  });
  const port = (server.address() as { port: number }).port;
  const pw = await playwright();
  const browser = await pw.chromium.launch({ executablePath: chromium(), headless: true });
  let status = 0;
  try {
    const page = await (await browser.newContext()).newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log(`  | ${m.text()}`); });
    page.on("pageerror", (e) => console.log(`  | page error: ${e.message}`));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
    let shown = false;
    for (const src of sources) {
      const name = basename(src, ".db");
      const mb = (statSync(src).size + (existsSync(`${src}-wal`) ? statSync(`${src}-wal`).size : 0)) / 2 ** 20;
      if (mb > MAX_MB) { console.log(`skip ${name}: ${Math.round(mb)} MB, more than the browser build replays in one tab (SKEIN_BROWSER_MAX_MB ${MAX_MB}; #83: the shell app's install)`); continue; }
      // Copy the source (with its -wal) first; never open it in place.
      const copy = join(work, `${name}.src.db`);
      copyFileSync(src, copy);
      if (existsSync(`${src}-wal`)) copyFileSync(`${src}-wal`, `${copy}-wal`);
      // Native: `skein-kernel replay` into a fresh store, and its dump.
      const nativeDb = join(work, `${name}.native.db`);
      const native = run(["replay", copy, nativeDb]);
      const nativeDump = run(["dump", nativeDb]);
      // The browser: the same log replayed in Chrome, into IndexedDB.
      bundles.set(name, bundleOf(copy));
      const t = Date.now();
      const r = await page.evaluate(async (n) => await (window as unknown as { replayOne(n: string): Promise<{ report: string; ms: number; stats: unknown; blocks: number; isolated: boolean; agent: string }> }).replayOne(n), name);
      if (!shown) { console.log(`  (${r.agent.replace(/^.*(HeadlessChrome\/[^ ]+).*$/, "$1")}, cross-origin isolated: ${r.isolated})`); shown = true; }
      const webDb = join(work, `${name}.web.db`);
      writeStore(results.get(name)!, webDb);
      const webDump = run(["dump", webDb]);
      const problems: string[] = [];
      if (r.report !== native) problems.push(firstDiff(r.report, native, "replay report"));
      if (webDump !== nativeDump) problems.push(firstDiff(webDump, nativeDump, "dump"));
      const state = JSON.parse(r.report).index.record as string;
      const d = JSON.parse(webDump) as { fuel: { total: number }; entries: unknown[] };
      if (problems.length) {
        status = 1;
        console.log(`FAIL ${name}`);
        for (const p of problems) console.log(`  ${p}`);
      } else {
        console.log(`ok   ${name}: identical — ${d.entries.length} entries, fuel ${d.fuel.total}, state ${state.slice(-12)} (${r.ms} ms in the worker, ${Date.now() - t} ms in all; ${JSON.stringify(r.stats)})`);
      }
    }
  } finally {
    await browser.close();
    server.close();
    if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
    else console.log(`kept ${work}`);
  }
  return status;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
