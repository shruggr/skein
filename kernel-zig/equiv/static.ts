// The static file handler (#52) end to end: an instance booted from a system
// tree (#4) that carries the static app's module (bin/static.wasm from
// shruggr/skein-static, #71) and names the kernel's pinned `frontdoor` by CID, and whose etc/routes.json puts static on the
// prefix `/site` (root `www`, open), on the exact path `/favicon.ico` (a
// file root) and on `/` (a directory root: its index). Through the router, at the instance's own origin: the index
// for the prefix and for a directory, nested files with their content types,
// a directory without its `/` redirected, 404 for a missing file, a file
// outside the root, a prefix that ends mid-segment and every `..` form, 405
// for a POST, HEAD with no body, and the ETag (the blob's CID) answered 304
// on If-None-Match. Every request is one entry, recorded (#68), and none
// moves a head; the store replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/static.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { dirSource } from "../../src/host/boot.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Router } from "../../src/host/router.ts";
import { rawCid } from "../../src/runtime/programs.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

// The app under test (#71): SKEIN_STATIC_DIR names a checkout, else this commit is cloned.
const STATIC_REPO = "https://github.com/shruggr/skein-static";
const STATIC_REV = "a6ea46e069487bee2ebe891953bda0e9eaefd488";
const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const wasm = join(here, "../../wasm");
const home = mkdtempSync(join(tmpdir(), "skein-kz-static-"));
const db = join(home, "instances/site/runtime.db");
const key = (h: string) => new PrivateKey(h, 16);
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- the system tree

const sys = join(home, "system");
const files: Record<string, string> = {
  "www/index.html": "<!doctype html><title>market</title><script src=\"js/app.js\"></script>\n",
  "www/js/app.js": "console.log(\"the market\");\n",
  "www/css/app.css": "body { margin: 0 }\n",
  "www/img/logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n",
  "www/docs/index.html": "<p>docs</p>\n",
  "www/my file.txt": "spaces\n",
  "www/favicon.ico": "\x00\x00\x01\x00",
  "secret.txt": "outside the root\n",
  "README.md": "A site served by the static handler.\n",
};
for (const [p, s] of Object.entries(files)) {
  mkdirSync(dirname(join(sys, p)), { recursive: true });
  writeFileSync(join(sys, p), s, "latin1");
}
mkdirSync(join(sys, "bin"), { recursive: true });
mkdirSync(join(sys, "etc"), { recursive: true });
// The app (#71): static is shruggr/skein-static, not pinned here; the tree
// carries its module (bin/static.wasm from that repo's tree). The front door
// is the kernel's pinned module, by CID: the kernel installs it into every store.
const staticDir = process.env.SKEIN_STATIC_DIR ?? cloneStatic();
const staticWasm = readFileSync(join(staticDir, "bin/static.wasm"));
writeFileSync(join(sys, "bin/static.wasm"), staticWasm);
writeFileSync(join(sys, "bin/frontdoor.cid"), `${rawCid(readFileSync(join(wasm, "frontdoor.wasm")))}\n`);
writeFileSync(join(sys, "bin/static.json"), JSON.stringify({ inputs: {}, description: "Files from the main tree through the routes table (#52)." }));
writeFileSync(join(sys, "bin/frontdoor.json"), JSON.stringify({ inputs: {}, description: "The front door." }));
writeFileSync(join(sys, "etc/subscriptions.json"), "[]");
writeFileSync(join(sys, "etc/routes.json"), JSON.stringify([
  { prefix: "/site", program: "static", fn: "get", auth: "none", root: "www" },
  { path: "/favicon.ico", program: "static", fn: "get", auth: "none", root: "www/favicon.ico" },
  { path: "/", program: "static", fn: "get", auth: "none", root: "www" },
]));

/** shruggr/skein-static at the commit this test was written against, cloned into the scratch home. */
function cloneStatic(): string {
  const dir = join(home, "skein-static");
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
  };
  git("clone", "-q", STATIC_REPO, dir);
  git("-C", dir, "checkout", "-q", STATIC_REV);
  return dir;
}

/** A blob's git CID (git-raw, sha1): what the ETag names. */
const blobCid = (s: string) => {
  const b = Buffer.from(s, "latin1");
  const sha1 = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest();
  return CID.createV1(0x78, Digest.create(0x11, sha1)).toString();
};

// ---------------------------------------------------------------- the router

const hostDb = new HostDb(join(home, "host.db"));
hostDb.add("site", { store: db });
const router = new Router({
  db: hostDb, walletFor: () => ephemeralWallet(key("1111")), home, owner: key("2222").toPublicKey().toString(), idleMs: 0,
  kernel: { command: kernel, env: { SKEIN_HOME: home } },
  log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});

type Got = { status: number; type: string; etag: string; location: string; allow: string; body: string };
/** A raw request (node:http: the path goes as written, no client-side dot-segment removal). */
let requests = 0;
function get(path: string, method = "GET", headers: Record<string, string> = {}): Promise<Got> {
  requests++;
  const u = new URL(router.originOf("site"));
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: u.port, path, method, headers: { host: u.host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), etag: String(res.headers.etag ?? ""),
        location: String(res.headers.location ?? ""), allow: String(res.headers.allow ?? ""), body: Buffer.concat(chunks).toString("latin1"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}
// #68: every request is an entry (the site's access log); none moves a head.
const entries = async () => { const k = (await router.hydrate("site")).kernel; return (await k.store.get((await k.tip())!) as unknown as { n: number }).n + 1; };
const heads = async () => { const k = (await router.hydrate("site")).kernel; return [String(await k.call("head", "main")), String(await k.call("head", "sessions"))]; };

try {
  await router.listen(0);
  const src = await dirSource(sys);
  await router.bootRow("site", { kind: "tree", root: src.root, objects: src.objects });
  await get("/site/"); // hydrated
  await router.settled();
  const n0 = await entries(), r0 = requests, h0 = await heads();

  const html = "text/html; charset=utf-8";
  let r = await get("/site");
  check(r.status === 301 && r.location === "/site/", `the prefix without its /: 301 to /site/ (${r.status} ${r.location})`);
  r = await get("/site/");
  check(r.status === 200 && r.type === html && r.body === files["www/index.html"], `/site/: www/index.html, ${html} (${r.status} ${r.type})`);
  check(r.etag === `"${blobCid(files["www/index.html"]!)}"`, `its ETag is the blob's CID (${r.etag})`);
  const etag = r.etag;
  r = await get("/site/", "GET", { "if-none-match": etag });
  check(r.status === 304 && r.body === "" && r.etag === etag, `If-None-Match with the ETag: 304, no body (${r.status})`);
  r = await get("/site/index.html", "GET", { "if-none-match": `"other", W/${etag}` });
  check(r.status === 304, `a list naming the ETag (weak): 304 (${r.status})`);
  r = await get("/site/index.html", "GET", { "if-none-match": `"${blobCid("something else")}"` });
  check(r.status === 200 && r.body === files["www/index.html"], `another ETag: 200 with the file (${r.status})`);

  for (const [path, file, type] of [
    ["/site/js/app.js", "www/js/app.js", "text/javascript; charset=utf-8"],
    ["/site/css/app.css", "www/css/app.css", "text/css; charset=utf-8"],
    ["/site/img/logo.svg", "www/img/logo.svg", "image/svg+xml"],
    ["/site/my%20file.txt", "www/my file.txt", "text/plain; charset=utf-8"],
    ["/site/docs/", "www/docs/index.html", html],
    ["/site//css/./app.css", "www/css/app.css", "text/css; charset=utf-8"],
    ["/favicon.ico", "www/favicon.ico", "image/x-icon"],
    ["/", "www/index.html", html],
  ] as const) {
    r = await get(path);
    check(r.status === 200 && r.type === type && r.body === files[file] && r.etag === `"${blobCid(files[file]!)}"`, `${path}: ${file}, ${type} (${r.status} ${r.type})`);
  }
  r = await get("/site/docs?x=1");
  check(r.status === 301 && r.location === "/site/docs/?x=1", `a directory without its /: 301 to it with the / (${r.status} ${r.location})`);
  r = await get("/site/js/app.js", "HEAD");
  check(r.status === 200 && r.type === "text/javascript; charset=utf-8" && r.etag === `"${blobCid(files["www/js/app.js"]!)}"` && r.body === "", `HEAD: the type and ETag, no body (${r.status})`);
  r = await get("/site/js/app.js", "POST");
  check(r.status === 405 && r.allow === "GET, HEAD", `POST: 405, Allow: GET, HEAD (${r.status} ${r.allow})`);

  for (const path of ["/site/missing.html", "/site/js/", "/site/js/app.js/", "/site/secret.txt", "/sitemap.xml"]) {
    r = await get(path);
    check(r.status === 404, `${path}: 404 (${r.status})`);
  }
  // Escapes: the handler refuses what reaches it (an encoded `/` hides a `..` from the router's URL parsing) ...
  for (const path of ["/site/..%2fsecret.txt", "/site/..%2F..%2Fsecret.txt", "/site/a%00b", "/site/%zz"]) {
    r = await get(path);
    check(r.status === 404 && r.body === "not found\n", `${path}: 404 from the handler (${r.status})`);
  }
  // ... and a plain or %2e `..` is resolved away before routing: outside /site, no route.
  for (const path of ["/site/../secret.txt", "/site/%2e%2e/secret.txt", "/site/css/../../secret.txt"]) {
    r = await get(path);
    check(r.status === 404 && !r.body.includes("outside the root"), `${path}: 404, the file outside the root not served (${r.status})`);
  }

  await router.settled();
  const n1 = await entries(), h1 = await heads();
  check(n1 - n0 === requests - r0 && h1.join() === h0.join(), `each request one entry (${requests - r0} requests, ${n1 - n0} entries), and no head moved (main, sessions: ${h1.join(", ")})`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await router.stop();
}

const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), db], { encoding: "utf8" });
process.stdout.write(rp.stdout);
if (rp.status !== 0) process.stdout.write(rp.stderr);
check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "the store replays to itself exactly");

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `static: ${failures} FAILED\n` : "static: all ok\n");
process.exit(failures ? 1 : 0);
