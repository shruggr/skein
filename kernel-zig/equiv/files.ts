// Files from a git tree for an http handler (#52; #125: skein-sdk's `files`
// module, the static app gone) end to end, through the management site's
// handler: shruggr/skein-site (src/testapps.ts SITE_APP, or $SKEIN_SITE_DIR)
// with test files added to its tree, installed as the owner's messages (#124)
// into an instance on a router. The app's one row is `/site/*` (its `/`,
// namespaced by the install); the owner adds two rows of its own to the same
// handler (`skein plan dispatch --http`'s body): `/favicon.ico` exact (a file
// root) and `/` exact (a directory root: its index). The handler serves the
// app's own tree (the head site/app's record, its `tree`), under the row's
// root (`www`).
//
// Through the router, at the instance's own origin: the index for the prefix
// and for a directory, nested files with their content types, a directory
// without its `/` redirected, 404 for a missing file, a file outside the
// root, a prefix that ends mid-segment (and `/site` itself: the app's row is
// `/site/`) and every `..` form, 405 for a POST, HEAD with no body, and the
// ETag (the blob's CID) answered 304 on If-None-Match. Every request is one
// entry, recorded (#68), and none moves a head; the store replays to itself
// exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/files.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { planDispatch } from "../../src/client/admin.ts";
import { appCheckout, installApp, sendPlan, SITE_APP } from "../../src/testapps.ts";
import { testHost } from "../../src/host/testhost.ts";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- the app's tree, with the test's files

const work = mkdtempSync(join(tmpdir(), "skein-kz-files-"));
const app = join(work, "skein-site");
cpSync(appCheckout(SITE_APP), app, { recursive: true, filter: (p) => basename(p) !== ".git" });
const files: Record<string, string> = {
  "www/index.html": "<!doctype html><title>market</title><script src=\"js/app.js\"></script>\n",
  "www/js/app.js": "console.log(\"the market\");\n",
  "www/css/app.css": "body { margin: 0 }\n",
  "www/img/logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n",
  "www/docs/index.html": "<p>docs</p>\n",
  "www/my file.txt": "spaces\n",
  "www/favicon.ico": "\x00\x00\x01\x00",
  "secret.txt": "outside the root\n",
};
for (const [p, s] of Object.entries(files)) {
  mkdirSync(dirname(join(app, p)), { recursive: true });
  writeFileSync(join(app, p), s, "latin1");
}

/** A blob's git CID (git-raw, sha1): what the ETag names. */
const blobCid = (s: string) => {
  const b = Buffer.from(s, "latin1");
  const sha1 = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest();
  return CID.createV1(0x78, Digest.create(0x11, sha1)).toString();
};

// ---------------------------------------------------------------- the router

const afters: Array<() => unknown> = [];
const h = await testHost({ after: (f) => afters.push(f) });
const inst = h.instance("site");
const ih = { home: h.home, port: h.router.port!, owner: h.owner, settled: () => h.router.settled() };

type Got = { status: number; type: string; etag: string; location: string; allow: string; body: string };
/** A raw request (node:http: the path goes as written, no client-side dot-segment removal). */
let requests = 0;
function get(path: string, method = "GET", headers: Record<string, string> = {}): Promise<Got> {
  requests++;
  const u = new URL(h.router.originOf("site"));
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
const heads = async () => { const k = (await h.router.hydrate("site")).kernel; return Promise.all(["main", "frontdoor/sessions", "site/app"].map(async (n) => String(await k.call("head", n)))); };

let store = "";
try {
  await h.router.start();
  await h.router.hydrate("site");
  store = h.db.get("site")!.store;
  await installApp(ih, "site", app);
  const k = (await h.router.hydrate("site")).kernel;
  const rec = await k.store.get(await k.call("head", "site/app") as CID) as { programs: { site: CID } };
  // The owner's own rows to the same handler (#125; `skein plan dispatch add --http … site.site`).
  const programs = { "site.site": rec.programs.site };
  for (const [address, prefix, root] of [["/favicon.ico", false, "www/favicon.ico"], ["/", false, "www"]] as const) {
    await sendPlan(ih, "site", planDispatch(inst, { op: "add", box: address, handler: "site.site", http: { prefix, fn: "get", settings: { root } } }, programs));
  }
  await get("/site/");
  await h.router.settled();
  const n0 = await h.entries("site"), r0 = requests, h0 = await heads();

  const html = "text/html; charset=utf-8";
  let r = await get("/site/");
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

  for (const path of ["/site/missing.html", "/site/js/", "/site/js/app.js/", "/site/secret.txt", "/sitemap.xml", "/site", "/js/app.js"]) {
    r = await get(path);
    check(r.status === 404, `${path}: 404 (${r.status})`);
  }
  // Escapes: the handler refuses what reaches it (an encoded `/` hides a `..` from the router's URL parsing) ...
  for (const path of ["/site/..%2fsecret.txt", "/site/..%2F..%2Fsecret.txt", "/site/a%00b", "/site/%zz"]) {
    r = await get(path);
    check(r.status === 404 && r.body === "not found\n", `${path}: 404 from the handler (${r.status})`);
  }
  // ... and a plain or %2e `..` is resolved away before routing: outside /site/, no route.
  for (const path of ["/site/../secret.txt", "/site/%2e%2e/secret.txt", "/site/css/../../secret.txt"]) {
    r = await get(path);
    check(r.status === 404 && !r.body.includes("outside the root"), `${path}: 404, the file outside the root not served (${r.status})`);
  }

  await h.router.settled();
  const n1 = await h.entries("site"), h1 = await heads();
  check(n1 - n0 === requests - r0 && h1.join() === h0.join(), `each request one entry (${requests - r0} requests, ${n1 - n0} entries), and no head moved (main, sessions, site/app: ${h1.join(", ")})`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  // testhost's afters: [remove the home, stop the router]: the router first, the replay, then the home.
  const [removeHome, ...rest] = afters;
  for (const f of rest.reverse()) await f();
  if (store) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "the store replays to itself exactly");
  }
  if (!process.env.KEEP) await removeHome?.();
}
if (process.env.KEEP) process.stdout.write(`kept ${work}\n`); else rmSync(work, { recursive: true, force: true });
process.stdout.write(failures ? `files: ${failures} FAILED\n` : "files: all ok\n");
process.exit(failures ? 1 : 0);
