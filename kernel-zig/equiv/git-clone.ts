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
//      as the answer, and as `skein install` of the checkout would write
//      — with nothing to send but `head`, `dispatch` and `start`; sent, the
//      app runs (its start's cron tick, a {fn, args} call answered);
//   3. a hash the server does not hold (not-found), a server that answers
//      with another commit's pack (mismatch), a URL that is not one
//      (bad-args), a URL that is not a repository (not-git), a commit
//      without a manifest (no-manifest) are error answers; a stranger's clone
//      is not admitted; the same clone again, once the app is installed,
//      answers the same tree and the record with the app's state carried
//      over (as the client rebuilds it);
//   4. an overlay app with no topics (#120: it registers them at runtime, as
//      skein-amm does) and mailbox rows relative to the app (#128: "", the
//      box "register", the box "submit" with filter beef): cloned, its record
//      rebuilt by the client (the same CID), installed — its rows and the
//      derived ones, the boxes resolved under its name;
//   5. the client's `skein install <url>#<hash> --instance` (#142): one
//      git.clone message, the plan from the stored tree, head and row sent —
//      signed in the client with the operator's key, over the host's control
//      socket; a key with no row in box git is refused before anything is sent;
//   6. the instance's store replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/git-clone.ts

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { adminMain } from "../../src/client/admin-cli.ts";
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

// An overlay app with no topics (#120) and relative boxes (#128): app-demo's module as its engine.
const ovRepo = join(repos, "ov-dyn");
mkdirSync(join(ovRepo, "etc"), { recursive: true });
cpSync(join(demoDir, "bin"), join(ovRepo, "bin"), { recursive: true });
writeFileSync(join(ovRepo, "etc/app.json"), JSON.stringify({
  kind: "app", name: "ov-dyn", version: "0.1.0",
  programs: { overlay: "bin/app-demo.wasm" },
  config: { overlay: { lookups: { ls_dyn: { program: "overlay" } } } },
  routes: [
    { address: "register", handler: "overlay" },
    { address: "submit", filters: ["kernel.beef"], handler: "overlay" },
    { transport: "event", address: "", handler: "overlay" },
  ],
}, null, 2));
const ovGit = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: ovRepo, env: gitEnv, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
ovGit("init", "-q", "-b", "main");
ovGit("add", "-A");
ovGit("commit", "-qm", "ov-dyn");
const hashOv = ovGit("rev-parse", "HEAD");

// #142: an app for `skein install <url>#<hash> --instance`: app-demo's module under another name, one row from the owner.
const twoRepo = join(repos, "app-two");
mkdirSync(join(twoRepo, "etc"), { recursive: true });
cpSync(join(demoDir, "bin"), join(twoRepo, "bin"), { recursive: true });
writeFileSync(join(twoRepo, "etc/app.json"), JSON.stringify({ kind: "app", name: "app-two", version: "0.1.0", programs: { two: "bin/app-demo.wasm" }, routes: [{ address: "", handler: "two" }] }, null, 2));
const twoGit = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: twoRepo, env: gitEnv, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
twoGit("init", "-q", "-b", "main");
twoGit("add", "-A");
twoGit("commit", "-qm", "app-two");
const hashTwo = twoGit("rev-parse", "HEAD");

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
// The ov-dyn record's routes (#143): the manifest's three, then the derived own box, /submit and the read /lookup.
const OV_ROUTES = "mailbox register overlay, mailbox submit [kernel.beef] overlay, event  overlay, mailbox ov-dyn overlay, http /submit [kernel.beef] overlay.submit, http /lookup [ov-dyn.lookup] (read)";
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
  check(fromDir.recordCid.equals(app) && stored.root.equals(fromDir.record.tree), "and skein install of the checkout would write the same record (the client's path, #124)");
  const rec = await kk.store.get(app) as { kind?: string; tree?: CID; programs?: Record<string, CID> };
  const prog = rec.programs?.demo ? await kk.store.get(rec.programs.demo) as { app?: string; code?: { wasm?: CID } } : undefined;
  check(rec.kind === "app" && !!rec.tree?.equals(tree) && prog?.app === "app-demo" && !!prog.code?.wasm && await view.has(prog.code.wasm), "the app record links the tree and a program record for bin/app-demo.wasm, its module a block of the store");
  const before = await h.entries("inst");
  const r = await sendInstall(plan, (box, body) => owner.send(inst, box, dagCbor.decode(body)));
  await h.router.settled();
  check(r.messages === 5, `the install: head, three routes, start (${r.messages} messages)`);
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
  // #143: a message is taken in by the messagebox (its route is open); the gate runs on the box route when it is processed.
  const nStranger = asked.length;
  const stranger = await new RawBox(ephemeralWallet(PrivateKey.fromRandom()), `${h.base}/@inst`).send(inst, "git", { fn: "git.clone", args: { url: repoUrl, hash: hashA } }).then(() => "sent", (x: Error) => x.message);
  await h.router.settled();
  check(stranger === "sent" && asked.length === nStranger, `a stranger's clone is recorded and runs nothing: git's call is root's (#143), nothing fetched (${stranger}, ${asked.length - nStranger} fetches)`);

  // ------------------------------------------------ 4. an overlay with no topics, boxes relative to the app
  const ov = await clone(repoUrl.replace(/app-demo$/, "ov-dyn"), hashOv);
  check(!ov.error && !!ov.result?.app, `git.clone of an overlay manifest with no topics (#120): answered (${JSON.stringify(ov.error ?? ov.result)})`);
  if (ov.result?.tree && ov.result.app) {
    const ovPlan = await planInstall(await readStoredApp(view, ov.result.tree), await instanceView(view), { modules: wasmDirObjects(join(here, "../../wasm")) });
    check(ovPlan.recordCid.equals(ov.result.app), `planInstall rebuilds its record: the same CID (${ovPlan.recordCid} = ${ov.result.app})`);
    const ovRec = await kk.store.get(ov.result.app) as { routes?: Array<{ transport: string; address: string; filters?: string[]; handler?: string }> };
    const keys = (ovRec.routes ?? []).map((r) => `${r.transport} ${r.address}${r.filters ? ` [${r.filters.join(",")}]` : ""} ${r.handler ?? "(read)"}`).join(", ");
    check(keys === OV_ROUTES, `its routes as written, then the derived ones the manifest has not (#143: no sender; /lookup a read route): ${keys}`);
    const sentOv = await sendInstall(ovPlan, (box, body) => owner.send(inst, box, dagCbor.decode(body)));
    await h.router.settled();
    check(sentOv.messages === 1 + 6, `the install: head ov-dyn/app, six routes (${sentOv.messages} messages)`);
    const table = (await instanceView(view)).dispatch.filter((r) => (r as { app?: string }).app === "ov-dyn").map((r) => `${r.transport} ${r.address}`).sort().join(", ");
    check(table === "event ov-dyn, http /ov-dyn/lookup, http /ov-dyn/submit, mailbox ov-dyn, mailbox ov-dyn/register, mailbox ov-dyn/submit",
      `the kernel's table holds them under the app's name: ${table}`);
  }

  // ------------------------------------------------ 6. the client: `skein install <url>#<hash> --instance` (#142)
  // One message to the git app (the clone in the VM), the plan from the stored tree, head + row: signed with the
  // operator's key (here the owner's) in the client, handed to the host over its control socket. No objects.
  await h.router.listenControl(join(h.home, "host.sock"));
  const keyFile = join(h.home, "operator.key");
  writeFileSync(keyFile, `${h.ownerKey.toHex()}\n`, { mode: 0o600 });
  const out: string[] = [], err: string[] = [];
  const env = { vars: { SKEIN_HOME: h.home, SKEIN_OPERATOR_KEY: keyFile }, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const asked2 = asked.length;
  const code = await adminMain("install", [`${repoUrl.replace(/app-demo$/, "app-two")}#${hashTwo}`, "--instance", "inst"], env);
  await h.router.settled();
  const two = await record("app-two/app");
  const cloneLine = out.find((l) => l.startsWith("git.clone "));
  check(code === 0 && two?.kind === "app" && out.some((l) => l.startsWith("installed app-two 0.1.0 into inst (this host)")), `skein install <url>#<hash> --instance inst: exit ${code} (${[...out, ...err].join(" | ")})`);
  check(!!cloneLine && asked.length - asked2 === 2, `the commit came by the git app's clone in the VM, two fetches (${cloneLine})`);
  check(out.some((l) => /objects ×1 \(0 records\) · head ×1 · dispatch ×1/.test(l)) && out.some((l) => /: 2 messages sent/.test(l)), `nothing of the tree crossed from the client: head and one row (${out.filter((l) => /messages/.test(l)).join(" | ")})`);
  const twoRow = (await instanceView(view)).dispatch.find((r) => (r as { app?: string }).app === "app-two");
  check(!!twoRow && !("sender" in twoRow) && twoRow.address === "app-two", `its route, the app's box, no sender (#143) (${JSON.stringify(twoRow && { t: twoRow.transport, a: twoRow.address })})`);
  // A stranger's key: not root — git's call refused at the gate (#143), nothing fetched.
  const strangerKey = join(h.home, "stranger.key");
  writeFileSync(strangerKey, `${PrivateKey.fromRandom().toHex()}\n`);
  const n2 = asked.length;
  const refused = await adminMain("install", [`${repoUrl}#${hashA}`, "--instance", "inst"], { ...env, vars: { ...env.vars, SKEIN_OPERATOR_KEY: strangerKey } });
  check(refused === 1 && /403|gated/.test(err.at(-1) ?? "") && asked.length === n2, `a key that is not root: git.clone refused at the gate, nothing fetched (${err.at(-1)})`);
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
