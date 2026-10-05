// Deploy by hash (#91): the git app (shruggr/skein-git at src/testapps.ts's
// pinned commit, or $SKEIN_GIT_DIR) clones one commit into an instance's store
// in the VM, and the owner installs it with the kernel's operations alone.
//
// A local git repository holding programs/test/app-demo (commit A) and a
// commit without its manifest (B) is served over git's smart HTTP by `git
// http-backend` under a small HTTP server; the router's fetch provider is the
// real network (fetchHttp). Then:
//
//   1. the owner sends {fn: "git.clone", args: {url, hash: A}} to box `git`;
//      the git app asks the fetch provider for the advertisement and for one
//      shallow pack (protocol version 2), checks it against A, keeps the
//      commit, its trees and blobs, builds the app record and answers {tree,
//      app} in the owner's mailbox. It moved no head;
//   2. the manifest is read out of the stored tree by CID; the install
//      client's planInstall over that tree rebuilds the record — the same CID
//      as the answer, and as `skein plan install` of the checkout would write
//      — with nothing to send but `head`, `dispatch` and `start`; sent, the
//      app runs (its start's cron tick, a {fn, args} call answered);
//   3. a hash the server does not hold (not-found), a server that answers
//      with another commit's pack (mismatch), a URL that is not one
//      (bad-args), a URL that is not a repository (not-git), a commit
//      without a manifest (no-manifest) are error answers; a stranger's clone
//      is not admitted; the same clone again, once the app is installed,
//      answers the same tree and the record with the app's state carried
//      over (as the client rebuilds it);
//   4. the instance's store replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/git-clone.ts

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { wasmDirObjects } from "../../src/host/boot.ts";
import { instanceView, planInstall, readApp, readStoredApp, sendInstall } from "../../src/host/install.ts";
import type { HttpRequest } from "../../src/host/providers.ts";
import { fetchHttp } from "../../src/host/router.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { encode } from "../../src/runtime/cid.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { gitCid, readBlob, lookup } from "../../src/runtime/tree.ts";
import { GIT_APP } from "../../src/testapps.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = join(here, "../../programs/test/app-demo");
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- the repository, served over smart HTTP

const work = mkdtempSync(join(tmpdir(), "skein-kz-git-clone-"));
const repos = join(work, "repos");
const repo = join(repos, "app-demo");
mkdirSync(repo, { recursive: true });
for (const f of ["etc", "bin", "main.zig", "build.zig", "build.zig.zon", "build.sh"]) cpSync(join(demoDir, f), join(repo, f), { recursive: true });
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "skein", GIT_AUTHOR_EMAIL: "skein@test", GIT_COMMITTER_NAME: "skein", GIT_COMMITTER_EMAIL: "skein@test", GIT_AUTHOR_DATE: "2026-10-03T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-03T12:00:00Z" };
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-qm", "app-demo");
const hashA = git("rev-parse", "HEAD"), treeA = git("rev-parse", "HEAD^{tree}");
const checkoutA = await readApp(repo); // the CLI's host-side path, over the same files
git("rm", "-q", "etc/app.json");
git("commit", "-qm", "no manifest");
const hashB = git("rev-parse", "HEAD");

/** `git http-backend` as a CGI under node:http. Under /liar/ the server swaps the wanted commit for B's: a pack of another commit. */
function backend(req: IncomingMessage, res: ServerResponse, body: Buffer, path: string): void {
  const u = new URL(req.url!, "http://x");
  const p = spawn("git", ["http-backend"], {
    env: {
      ...process.env, GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: path, QUERY_STRING: u.search.slice(1),
      REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length), REMOTE_ADDR: "127.0.0.1",
      ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
    },
  });
  p.stdin.end(body);
  const out: Buffer[] = [];
  p.stdout.on("data", (d: Buffer) => out.push(d));
  p.on("close", () => {
    const all = Buffer.concat(out);
    const i = all.indexOf("\r\n\r\n");
    let status = 200;
    for (const l of all.subarray(0, i).toString().split("\r\n")) {
      const [k, v] = l.split(/:\s*/, 2);
      if (k!.toLowerCase() === "status") status = parseInt(v!); else if (k) res.setHeader(k, v ?? "");
    }
    res.statusCode = status;
    res.end(all.subarray(i + 4));
  });
}
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    let path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
    if (path.startsWith("/liar/")) {
      path = path.slice("/liar".length);
      body = Buffer.from(body.toString("latin1").replace(`want ${hashA}`, `want ${hashB}`), "latin1");
    }
    backend(req, res, body, path);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const repoUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app-demo`;
const liarUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/liar/app-demo`;

// ---------------------------------------------------------------- the host: the fetch provider's network is real

const asked: HttpRequest[] = [];
const network = async (r: HttpRequest) => { asked.push(r); return await fetchHttp(r); };
const afters: Array<() => unknown> = [];
const h = await testHost({ after: (f) => afters.push(f) }, { http: network });
let store = "";
try {
  h.mailbox("david", h.ownerId);
  const inst = h.instance("inst");
  await h.router.start();
  await h.install("inst", [GIT_APP]);
  store = h.db.get("inst")!.store;
  const owner = new RawBox(h.owner, `${h.base}/@inst`);
  const mine = new RawBox(h.owner, h.origin("david"));
  const k = async () => (await h.router.hydrate("inst")).kernel;
  const record = async (name: string) => {
    const kk = await k();
    const root = await kk.call("head", name) as CID | null;
    return root ? await kk.store.get(root) as Record<string, unknown> : undefined;
  };
  type Answer = { fn?: string; replyTo?: unknown; result?: { tree?: CID; app?: CID; count?: number }; error?: { code: string; message: string } };
  const ask = async (box: string, body: Record<string, unknown>): Promise<Answer> => {
    const id = (await owner.send(inst, box, body)).id.toString();
    const m = await until(`the answer to ${JSON.stringify(body)}`, async () => {
      await h.router.settled();
      return (await mine.list(box)).find((x) => String((x.value as { request?: unknown }).request) === id);
    }, 60_000);
    return m.value as Answer;
  };
  const clone = (url: string, hash: string) => ask("git", { fn: "git.clone", args: { url, hash } });

  // ------------------------------------------------ 1. the clone
  const view = openStoreFile(store, { readOnly: true });
  const appHeads = () => view.heads().map((x) => x.name).filter((n) => n.startsWith("git/") || n.startsWith("app-demo/")).sort().join(",");
  const headsBefore = appHeads();
  const nAsked = asked.length;
  const a = await clone(repoUrl, hashA.toUpperCase());
  check(!a.error && !!a.result?.tree && !!a.result?.app && !!a.replyTo, `git.clone {url, hash: A}: answered {tree, app} in the owner's mailbox (${JSON.stringify(a.error ?? a.result)})`);
  const tree = a.result!.tree!, app = a.result!.app!;
  check(tree.equals(gitCid(treeA)), `the tree is commit A's tree as git has it (${tree} = ${treeA})`);
  const reqs = asked.slice(nAsked);
  check(reqs.length === 2 && reqs[0]!.method === "GET" && reqs[0]!.url === `${repoUrl}/info/refs?service=git-upload-pack` && reqs[1]!.method === "POST" && reqs[1]!.url === `${repoUrl}/git-upload-pack`
    && reqs.every((r) => r.headers?.["git-protocol"] === "version=2" && typeof r.maxBytes === "number"),
    `the fetch provider carried two requests: the advertisement, then the upload-pack, protocol version 2, each with maxBytes (${reqs.map((r) => `${r.method} ${r.url.slice(repoUrl.length)}`).join(", ")})`);
  const sent = Buffer.from(reqs[1]?.body ?? []).toString("latin1");
  check(sent.includes(`want ${hashA}\n`) && sent.includes("deepen 1\n") && sent.includes("command=fetch") && !sent.includes("thin-pack"), "the fetch wants commit A, depth 1, no thin pack");
  const kk = await k();
  check(await view.has(gitCid(hashA)) && await view.has(tree), "the store holds the commit and its tree (git-raw blocks under their git ids)");
  check(appHeads() === headsBefore && headsBefore === "git/app" && (await record("app-demo/app")) === undefined, `the git app moved no head: git/app alone, no app-demo/app until the owner's head message (${appHeads()})`);

  // ------------------------------------------------ 2. the manifest by CID, the record rebuilt, the install
  const leaf = await lookup(view, tree, "etc/app.json");
  const manifest = leaf ? JSON.parse(new TextDecoder().decode(await readBlob(view, leaf.cid))) as { name?: string } : undefined;
  check(manifest?.name === "app-demo", `the manifest is read out of the stored tree by CID (${manifest?.name})`);
  const iv = await instanceView(view);
  const stored = await readStoredApp(view, tree);
  const plan = await planInstall(stored, iv, { modules: wasmDirObjects(join(here, "../../wasm")) });
  check(plan.recordCid.equals(app), `planInstall over the stored tree rebuilds the git app's record: the same CID (${plan.recordCid} = ${app})`);
  check(plan.records.length === 0, `nothing to send by objects: the git app put every block (${plan.records.length} records)`);
  const fromDir = await planInstall(checkoutA, iv, { modules: wasmDirObjects(join(here, "../../wasm")) });
  check(fromDir.recordCid.equals(app) && stored.root.equals(fromDir.record.tree), "and skein plan install of the checkout would write the same record (the client's path, #124)");
  const rec = await kk.store.get(app) as { kind?: string; tree?: CID; programs?: Record<string, CID> };
  const prog = rec.programs?.demo ? await kk.store.get(rec.programs.demo) as { app?: string; code?: { wasm?: CID } } : undefined;
  check(rec.kind === "app" && !!rec.tree?.equals(tree) && prog?.app === "app-demo" && !!prog.code?.wasm && await view.has(prog.code.wasm), "the app record links the tree and a program record for bin/app-demo.wasm, its module a block of the store");
  const before = await h.entries("inst");
  const r = await sendInstall(plan, (box, body) => owner.send(inst, box, dagCbor.decode(body)));
  await h.router.settled();
  check(r.messages === 5, `the install: head, three dispatch rows, start (${r.messages} messages)`);
  // The head's root is the git app's record (its start may since have set `state`: the same record with state).
  const { state: _s, ...installed } = (await record("app-demo/app")) ?? {};
  check(encode(installed as never).cid.equals(app), "the head app-demo/app is the git app's record (state aside)");
  const state = async () => {
    const x = await record("app-demo/app");
    return x?.state ? await (await k()).store.get(x.state as CID) as { count: number; ticks: number } : undefined;
  };
  const ticked = await until("the first tick", async () => { await h.router.settled(); const s = await state(); return s && s.ticks >= 1 ? s : undefined; }, 20_000).catch(() => undefined);
  check(!!ticked, `the app runs: its start scheduled a heartbeat and the tick arrived (ticks ${ticked?.ticks})`);
  const added = await ask("app-demo", { fn: "demo.counter.add", args: { by: 3 } });
  check(added.result?.count === 3, `demo.counter.add {by: 3} → {count: 3} (${JSON.stringify(added.result ?? added.error)})`);
  check((await h.entries("inst")) > before, "every step of it is in the log");

  // ------------------------------------------------ 3. refusals
  let e = await clone(repoUrl, "1111111111111111111111111111111111111111");
  check(e.error?.code === "not-found" && /not our ref/.test(e.error.message), `a hash the server does not hold: not-found (${JSON.stringify(e.error)})`);
  e = await clone(liarUrl, hashA);
  check(e.error?.code === "mismatch" && e.error.message.includes(hashA), `a server that sends another commit's pack: mismatch (${JSON.stringify(e.error)})`);
  e = await clone("ftp://127.0.0.1/app-demo", hashA);
  check(e.error?.code === "bad-args", `a URL that is not http(s): bad-args (${JSON.stringify(e.error)})`);
  e = await clone(repoUrl, "abc");
  check(e.error?.code === "bad-args", `a hash that is not a commit id: bad-args (${JSON.stringify(e.error)})`);
  e = await clone(`${repoUrl.replace(/app-demo$/, "")}nope`, hashA);
  check(e.error?.code === "not-git" && /HTTP 404/.test(e.error.message), `a URL that is no repository: not-git (${JSON.stringify(e.error)})`);
  e = await clone(repoUrl, hashB);
  check(e.error?.code === "no-manifest", `a commit with no etc/app.json: no-manifest (${JSON.stringify(e.error)})`);
  // The same clone again, now the app is installed: the same tree; the record carries the app's state over, as an upgrade does.
  const again = await clone(repoUrl, hashA);
  const replan = await planInstall(await readStoredApp(view, tree), await instanceView(view), { modules: wasmDirObjects(join(here, "../../wasm")) });
  check(!!again.result?.tree?.equals(tree) && !!again.result?.app?.equals(replan.recordCid) && !!replan.record.state && replan.upgrade === "0.1.0",
    `the same clone again: the same tree, and the record with the installed app's state carried over, as the client rebuilds it (${JSON.stringify(again.result ?? again.error)})`);
  const stranger = await new RawBox(ephemeralWallet(PrivateKey.fromRandom()), `${h.base}/@inst`).send(inst, "git", { fn: "git.clone", args: { url: repoUrl, hash: hashA } }).then(() => "sent", (x: Error) => x.message);
  check(/403/.test(stranger), `a stranger's clone is not admitted: only the owner's row opens box git (${stranger})`);
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
} finally {
  const [removeHome, ...rest] = afters;
  for (const f of rest.reverse()) await f();
  server.closeAllConnections();
  server.close();
  if (store) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "the instance's store replays to itself exactly (the fetch provider's answers are entries)");
  }
  if (!process.env.KEEP) await removeHome?.();
}
if (process.env.KEEP) process.stdout.write(`kept ${work}\n`); else rmSync(work, { recursive: true, force: true });
process.stdout.write(failures ? `git-clone: ${failures} FAILED\n` : "git-clone: all ok\n");
process.exit(failures ? 1 : 0);
