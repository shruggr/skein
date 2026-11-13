// Deployment via the kernel's `objects` and `head` operations (#23) and the front end's roster (#24),
// with the real kernel behind a router (testhost.ts): root's requests for a filtered directory
// (`skein deploy`, src/client/admin.ts), signed by the owner; the first root sets main, a changed
// directory moves it through `head`, an unchanged one sends nothing. A row the same way (`skein
// routes`), and a grant. The roster reads IDENTITY.md from the deployed tree (`main`).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { adminMain } from "../client/admin-cli.ts";
import { planDeploy } from "../client/admin.ts";
import { headTree, MAIN } from "../runtime/heads.ts";
import { storeSpec } from "../runtime/index-store.ts";
import { openStoreFile } from "./stores.ts";
import type { Store } from "../runtime/store.ts";
import { currentDispatch } from "../runtime/dispatch.ts";
import { readFile, readTree, walk } from "../runtime/tree.ts";
import { sendPlan, viewOf } from "../testapps.ts";
import { collect, iso, T0 } from "../testkit.ts";
import { main } from "./cli.ts";
import { onlyIgnore } from "./deploy.ts";
import { HostDb, type InstanceRow } from "./instances.ts";
import { parseIdentity, roster, rosterFor, serveRoster } from "./roster.ts";
import { testHost, until } from "./testhost.ts";

type Json = Record<string, unknown>;
const skip = false;

async function tmp(t: { after(fn: () => unknown): void }, prefix = "skein-deploy-"): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SOUL = "You are Martha, the front desk.\n";
const IDENTITY = "# IDENTITY\n\n- Name: Martha\n- Emoji: :woman_office_worker:\n- Theme: front desk\n- Description: Organization front desk and directory service.\n";

/** An agent directory as in b-open-io/prompts/.agents/<name>/, with the code around it. */
async function agentDir(t: { after(fn: () => unknown): void }): Promise<string> {
  const d = await tmp(t);
  await fs.writeFile(join(d, "SOUL.md"), SOUL);
  await fs.writeFile(join(d, "IDENTITY.md"), IDENTITY);
  await fs.mkdir(join(d, "skills"));
  await fs.writeFile(join(d, "skills/x.md"), "# a skill\n");
  await fs.mkdir(join(d, "node_modules/junk"), { recursive: true });
  await fs.writeFile(join(d, "node_modules/junk/index.js"), "junk\n");
  await fs.mkdir(join(d, "src"));
  await fs.writeFile(join(d, "src/index.ts"), "code\n");
  await fs.writeFile(join(d, "bun.lock"), "lock\n");
  await fs.writeFile(join(d, "package.json"), "{}\n");
  return d;
}

/** A test host with the instances `handles` born owned by the owner, started; each one's store, read-only; the client's env. */
async function setup(t: { after(fn: () => unknown): void }, handles: string[]) {
  const h = await testHost(t);
  for (const x of handles) await h.instance(x);
  await h.router.start();
  const stores = new Map<string, Store>();
  const store = async (handle: string): Promise<Store> => {
    let s = stores.get(handle);
    if (!s) {
      await h.router.hydrate(handle);
      s = openStoreFile(storeSpec(h.db.get(handle)!), { readOnly: true });
      stores.set(handle, s);
      t.after(() => s!.close());
    }
    return s;
  };
  // The client signs with the operator's key (here the owner's) and delivers over the control socket.
  await h.router.listenControl(join(h.home, "host.sock"));
  const keyFile = join(h.home, "operator.key");
  await fs.writeFile(keyFile, `${h.ownerKey.toHex()}\n`, { mode: 0o600 });
  const env = (vars: Record<string, string> = {}) => {
    const out: string[] = [], err: string[] = [];
    return {
      out, err,
      env: {
        vars: { SKEIN_HOME: h.home, SKEIN_ROUTER_PORT: String(h.router.port), SKEIN_MASTER_KEY: "11".repeat(32), SKEIN_OPERATOR_KEY: keyFile, ...vars },
        out: (l: string) => out.push(l), err: (l: string) => err.push(l),
      },
    };
  };
  /** `skein deploy <dir>`, planned over its store and sent: the plan. */
  const deploy = async (handle: string, dir: string, only?: string[]) => {
    await h.router.hydrate(handle);
    await h.router.settled();
    const view = await viewOf(h.router, handle);
    let p;
    try { p = await planDeploy(dir, view, { only }); } finally { view.close(); }
    await sendPlan(h.router, handle, p, h.owner);
    return p;
  };
  return { h, store, env, deploy };
}

/** The paths of the requests the instance took in after the genesis, in order. */
async function paths_(store: Store): Promise<string[]> {
  const out: string[] = [];
  for await (const { entry } of store.log.entries(1)) {
    const r = (entry as unknown as { request?: CID }).request;
    if (r) out.push(String(((await store.get(r)) as unknown as { payload: { path: string } }).payload.path));
  }
  return out;
}

const mainIs = (store: Store, root: string) => until(`main at ${root}`, async () => (await headTree(store, MAIN))?.toString() === root ? true : undefined);

const rowOf = (handle: string, identity: string | null = null, tree: string | null = null): InstanceRow => ({
  handle, domain: "localhost", identity, store: `${handle}.db`, tree, source: null, knows: null, status: "enabled", created_at: iso(T0),
});

/** Every path in a tree, "/"-separated, files only. */
async function paths(store: Store, tree: CID): Promise<string[]> {
  const out: string[] = [];
  for await (const e of walk(store, tree, "")) out.push(e.path);
  return out.sort();
}

test("onlyIgnore: named files and everything under a named directory, directories on the way, never node_modules; * within a segment", async (t) => {
  const d = await agentDir(t);
  await fs.mkdir(join(d, "data"));
  const ig = onlyIgnore(d, ["SOUL.md", "IDENTITY.md", "skills", "data/*.json"]);
  assert.deepEqual(["SOUL.md", "IDENTITY.md", "skills", "skills/x.md", "data", "data/r.json"].filter(ig), []);
  assert.deepEqual(["bun.lock", "src", "src/index.ts", "node_modules", "package.json", "data/r.txt", "SOUL.md.bak"].filter((p) => !ig(p)), []);
  assert.ok(onlyIgnore(d, ["*"])("node_modules"), "node_modules is never kept");
  assert.ok(!onlyIgnore(d, ["*"])("src/index.ts"));
});

test("skein deploy: the filtered tree through `objects` and `head` as the owner moves main; the same directory again sends nothing; an edited SOUL.md moves main again", { skip }, async (t) => {
  const { h, store, deploy } = await setup(t, ["martha"]);
  const s = await store("martha");
  const dir = await agentDir(t);
  const boxesOf = (p: { requests: Array<{ path: string }> }) => p.requests.map((m) => m.path.slice("/kernel/".length));
  const boxes = async (st: Store) => (await paths_(st)).map((x) => x.slice("/kernel/".length));
  const before = (await boxes(s)).length;
  const since = async () => (await boxes(s)).slice(before);

  // First deploy: main is the tree the instance was born from (one loader, SPEC 8) → objects, then `head main`.
  const d1 = await deploy("martha", dir);
  assert.deepEqual(boxesOf(d1), ["objects", "head"], "main is the image's tree: the objects, then head main");
  const records = (d1.requests[0]!.body as { records: unknown[] }).records.length;
  assert.equal(records, 5, "SOUL.md, IDENTITY.md, skills/x.md, skills/, the root");
  await mainIs(s, d1.root.toString());
  assert.deepEqual(await paths(s, d1.root), ["IDENTITY.md", "SOUL.md", "skills/x.md"]);
  assert.deepEqual((await readTree(s, d1.root)).map((e) => e.name), ["IDENTITY.md", "SOUL.md", "skills"]);
  assert.deepEqual(await since(), ["objects", "head"], "one bundle, one message, and the head");
  void h;

  // The same directory: nothing to send.
  const d2 = await deploy("martha", dir);
  assert.deepEqual([d2.root.toString(), d2.requests.length], [d1.root.toString(), 0]);
  await h.router.settled();
  assert.deepEqual(await since(), ["objects", "head"]);

  // Edited SOUL.md: only what the store lacks (the new blob, the new root), then `head main`.
  await fs.writeFile(join(dir, "SOUL.md"), "You are Martha, now at the back office.\n");
  const d3 = await deploy("martha", dir);
  assert.equal((d3.requests[0]!.body as { records: unknown[] }).records.length, 2);
  assert.deepEqual(boxesOf(d3), ["objects", "head"]);
  await mainIs(s, d3.root.toString());
  assert.deepEqual(await since(), ["objects", "head", "objects", "head"]);
});

test("skein routes / grant --instance: root's requests over the control socket change a running instance's route table and grants (kernel operations); no new genesis", { skip }, async (t) => {
  const { h, env, store } = await setup(t, ["martha"]);
  const s = await store("martha");
  const e = env();
  const run = async (cmd: string, ...argv: string[]) => { const code = await adminMain(cmd, [...argv, "--instance", "martha"], e.env); await h.router.settled(); return code; };
  const genesis = (await collect(s.log.entries(0)))[0]!.cid;
  const before = await until("the genesis processed (its rows)", () => currentDispatch(s));
  const row = { kind: "request", path: "/register", role: "user", handler: "kernel.objects" };
  assert.equal(await run("routes", "add", JSON.stringify(row)), 1, "a kernel row's role is root");
  assert.match(e.err.at(-1)!, /role root/);
  const r2 = { kind: "request", path: "/register", role: "root", handler: "kernel.objects" };
  assert.equal(await run("routes", "add", JSON.stringify(r2)), 0, e.err.join("\n"));
  await until("the new row", async () => (await currentDispatch(s))!.some((x) => x.path === "/register") ? true : undefined);
  assert.equal(await run("routes", "remove", JSON.stringify(r2)), 0, e.err.join("\n"));
  await until("the row removed", async () => (await currentDispatch(s))!.length === before!.length ? true : undefined);
  assert.deepEqual(await currentDispatch(s), before, "removed: the rows as they were");
  assert.ok((await collect(s.log.entries(0)))[0]!.cid.equals(genesis), "the same genesis");
  assert.equal(await run("routes", "swap", JSON.stringify(r2)), 2);
  assert.equal(await run("routes", "remove", JSON.stringify({ kind: "request", path: "/nothing", role: "root", handler: "kernel.head" })), 1);
  assert.match(e.err.at(-1)!, /no row there/);

  // skein grant: an app role to a key, the grants head moved; revoked.
  const peer = PrivateKey.fromRandom().toPublicKey().toString();
  const grants = async () => { const c = await (await h.router.hydrate("martha")).kernel.call("head", "grants") as CID | null; return c ? (await s.get(c) as unknown as { roles: Record<string, Uint8Array[]> }).roles : {}; };
  assert.equal(await run("grant", "add", peer, "--role", "demo.ops"), 0, e.err.join("\n"));
  await until("granted", async () => (await grants())["demo.ops"]?.length ? true : undefined);
  assert.equal(await run("grant", "remove", peer, "--role", "demo.ops"), 0, e.err.join("\n"));
  await until("revoked", async () => !(await grants())["demo.ops"] ? true : undefined);
  assert.equal(await main(["dispatch", "martha", "add", "register", "mail"], e.env), 2, "skein-host changes no route table");
});

// ---------------------------------------------------------------- the roster

test("parseIdentity: the `- Key: value` lines of IDENTITY.md", () => {
  assert.deepEqual(parseIdentity(IDENTITY), { displayName: "Martha", emoji: ":woman_office_worker:", description: "Organization front desk and directory service." });
  assert.deepEqual(parseIdentity("# Identity\n\n- Name: Kurt\n- Role: account-manager\n- Avatar: https://x/k.png\n"), { displayName: "Kurt", description: "", avatar: "https://x/k.png" });
  assert.deepEqual(parseIdentity(""), { displayName: "", description: "" });
});

test("roster: a deployed row has its IDENTITY.md fields; one not deployed has empty ones; live per the host process; served as /roster.json with CORS *", { skip }, async (t) => {
  const { h, store, deploy } = await setup(t, ["martha", "kurt"]);
  const a = h.db.get("martha")!, b = h.db.get("kurt")!;
  const db = new HostDb(join(await tmp(t), "host.db"));
  t.after(() => db.close());
  db.add("martha", { store: a.store, identity: a.identity! }, new Date(0));
  db.add("kurt", { store: b.store, identity: b.identity! }, new Date(1));
  const dir = await agentDir(t);
  // #124: deployed by the owner's messages; the roster reads IDENTITY.md from the store's main (the row has no `tree`).
  const d = { root: (await deploy("martha", dir)).root.toString() };
  await mainIs(await store("martha"), d.root);
  const stores: Record<string, Store> = { martha: await store("martha"), kurt: await store("kurt") };
  const get = () => roster(db.list("enabled"), async (row) => ({ blocks: stores[row.handle] }), (row) => row.handle === "martha");
  const expected = [
    { handle: "martha", domain: "localhost", identity: a.identity, displayName: "Martha", description: "Organization front desk and directory service.", emoji: ":woman_office_worker:", status: "live" },
    { handle: "kurt", domain: "localhost", identity: b.identity, displayName: "", description: "", status: "idle" },
  ];
  assert.deepEqual(await get(), expected);
  assert.equal(new TextDecoder().decode(await readFile(stores.martha!, CID.parse(d.root), "IDENTITY.md")), IDENTITY);

  const server = await serveRoster(0, get);
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/roster.json`, { headers: { origin: "http://elsewhere.example" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await res.json(), expected);
  assert.equal((await fetch(`http://127.0.0.1:${port}/roster.json`, { method: "OPTIONS" })).status, 204);
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);

  // A row's `tree` the store does not have yet: empty fields, not an error.
  db.add("kurt", { tree: d.root });
  assert.equal((await get())[1]!.displayName, "");
});

// ---------------------------------------------------------------- each agent's ROSTER.md (#27)

const KURT = "# IDENTITY\n\n- Name: Kurt\n- Description: Account manager for\n";

test("rosterFor: the rows a row knows, in row order, never itself; `- @handle@domain — Name: description`; no name → the handle; knows nobody → no file", async () => {
  const rows = [
    { ...rowOf("martha"), knows: '["*"]' },
    { ...rowOf("kurt"), knows: '["martha", "ghost"]' },
    { ...rowOf("flow"), domain: "bopen.ai" },
  ];
  const fields: Record<string, { displayName: string; description: string }> = {
    martha: { displayName: "Martha", description: "Organization front desk and directory service." },
    kurt: { displayName: "Kurt", description: "Account manager." },
    flow: { displayName: "", description: "" },
  };
  const f = async (r: InstanceRow) => fields[r.handle]!;
  assert.equal(await rosterFor(rows[0]!, rows, f), "## Colleagues\n\n- @kurt@localhost — Kurt: Account manager.\n- @flow@bopen.ai — flow\n");
  assert.equal(await rosterFor(rows[1]!, rows, f), "## Colleagues\n\n- @martha@localhost — Martha: Organization front desk and directory service.\n");
  assert.equal(await rosterFor(rows[2]!, rows, f), undefined);
  assert.equal(await rosterFor({ ...rowOf("solo"), knows: '["*"]' }, [], f), undefined);
});

