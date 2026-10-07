// Deployment via `objects` (#23) and the front end's roster (#24), with the
// real Zig kernel behind a router (testhost.ts): the owner's messages for a
// filtered directory (#124: `skein deploy`, src/client/admin.ts),
// delivered to the instance's /sendMessage on the owner's session; the first
// root sets main, a changed directory moves it through `head`, an unchanged
// one sends nothing; the loop's next new conversation reads the new SOUL.md.
// A dispatch row the same way (`skein dispatch`). The roster reads
// IDENTITY.md from the deployed tree (`main`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { adminMain } from "../client/admin-cli.ts";
import { planDeploy } from "../client/admin.ts";
import { RawBox } from "../client/raw.ts";
import { InferPeer } from "../peers/infer.ts";
import { headTree, MAIN } from "../runtime/heads.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import type { Store } from "../runtime/store.ts";
import { currentDispatch } from "../runtime/dispatch.ts";
import { readFile, readTree, walk } from "../runtime/tree.ts";
import { CHAT_APP, sendPlan, viewOf } from "../testapps.ts";
import { collect, iso, T0 } from "../testkit.ts";
import { ephemeralWallet } from "../wallet.ts";
import { main } from "./cli.ts";
import { onlyIgnore } from "./deploy.ts";
import { appRecordOf } from "./install.ts";
import { HostDb, type InstanceRow } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { parseIdentity, roster, rosterFor, serveRoster } from "./roster.ts";
import { messagesIn, testHost, until } from "./testhost.ts";

type Json = Record<string, unknown>;
const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";

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

const answer = (content: string) => ({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "qwen38" });

/**
 * A test host with the owner's and the inference peer's mailboxes and the
 * agents `handles`, started; the owner's sessions with each front door; an
 * infer peer answering from a script; each agent's store file, read-only.
 */
async function setup(t: { after(fn: () => unknown): void }, handles: string[]) {
  const inferKey = PrivateKey.fromRandom(), inferId = inferKey.toPublicKey().toString();
  const h = await testHost(t, { infer: inferId });
  h.mailbox("david", h.ownerId);
  h.mailbox("infer", inferId);
  for (const x of handles) h.instance(x);
  await h.router.start();
  const requests: Json[] = [];
  const f = (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return Response.json(answer("ok"));
  }) as unknown as typeof fetch;
  const w = ephemeralWallet(inferKey);
  const peer = new InferPeer({
    wallet: w, providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } }, fetch: f, log: (l) => h.lines.push(`[infer] ${l}`),
    raw: {
      inbox: new RawBox(w, `${h.base}/@infer`),
      outbox: (url) => new RawBox(w, url),
      addressOf: (k) => { const r = h.db.list().find((x) => x.identity === k && x.kind !== "mailbox"); return r && h.origin(r.handle); },
    },
  });
  const owner = { wallet: h.owner, box: (row: { handle: string }) => new RawBox(h.owner, `${h.base}/@${row.handle}`) };
  const stores = new Map<string, Store>();
  const store = async (handle: string): Promise<Store> => {
    let s = stores.get(handle);
    if (!s) {
      await h.router.hydrate(handle);
      s = openStoreFile(h.db.get(handle)!.store, { readOnly: true });
      stores.set(handle, s);
      t.after(() => s!.close());
    }
    return s;
  };
  // #142: the client signs with the operator's key (here the owner's) and delivers over the control socket.
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
  const host = { home: h.home, port: h.router.port!, owner: h.owner, settled: () => h.router.settled() };
  /** `skein deploy <dir> --store <its store>`, sent: the plan. */
  const deploy = async (handle: string, dir: string, only?: string[]) => {
    await h.router.hydrate(handle);
    await h.router.settled();
    const view = await viewOf(host, handle);
    let p;
    try { p = await planDeploy(dir, view, { only }); } finally { view.close(); }
    await sendPlan(host, handle, p);
    return p;
  };
  return { h, peer, requests, owner, store, env, deploy, host };
}

/** The boxes of the messages the instance took in after the genesis (routed from its requests, #68), in order. */
async function boxes(store: Store): Promise<string[]> {
  return (await messagesIn(store)).map((m) => String(m.box));
}

/** The genesis's programs: name → program record CID. */
async function programsOf(store: Store): Promise<Record<string, CID>> {
  for await (const { entry } of store.log.entries(0)) return (await store.get(entry.genesis!) as Json).programs as Record<string, CID>;
  throw new Error("no genesis");
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

test("skein deploy: the filtered tree through `objects` as the owner sets main; the same directory again sends nothing; an edited SOUL.md moves main and the next new conversation reads it", { skip }, async (t) => {
  const { h, peer, requests, owner, store, deploy } = await setup(t, ["martha"]);
  const s = await store("martha");
  const dir = await agentDir(t);
  const row = h.db.get("martha")!;
  const boxesOf = (p: { messages: Array<{ box: string }> }) => p.messages.map((m) => m.box);
  const before = (await boxes(s)).length;
  const since = async () => (await boxes(s)).slice(before);

  // First deploy: no main yet → objects only (the root on the last bundle: the kernel sets main from it).
  const d1 = await deploy("martha", dir);
  assert.deepEqual(boxesOf(d1), ["objects"], "no main yet: the objects operation sets it from the root");
  const records = (d1.messages[0]!.body as { records: unknown[] }).records.length;
  assert.equal(records, 5, "SOUL.md, IDENTITY.md, skills/x.md, skills/, the root");
  await mainIs(s, d1.root.toString());
  assert.deepEqual(await paths(s, d1.root), ["IDENTITY.md", "SOUL.md", "skills/x.md"]);
  assert.deepEqual((await readTree(s, d1.root)).map((e) => e.name), ["IDENTITY.md", "SOUL.md", "skills"]);
  assert.deepEqual(await since(), ["objects"], "one bundle, one message");
  for (const m of await messagesIn(s)) assert.equal(Buffer.from(m.sender as Uint8Array).toString("hex"), h.ownerId, "sent as the owner");

  // The same directory: nothing to send.
  const d2 = await deploy("martha", dir);
  assert.deepEqual([d2.root.toString(), d2.messages.length], [d1.root.toString(), 0]);
  await h.router.settled();
  assert.deepEqual(await since(), ["objects"]);

  // Edited SOUL.md: only what the store lacks (the new blob, the new root), then `head main`.
  await fs.writeFile(join(dir, "SOUL.md"), "You are Martha, now at the back office.\n");
  const d3 = await deploy("martha", dir);
  assert.equal((d3.messages[0]!.body as { records: unknown[] }).records.length, 2);
  assert.deepEqual(boxesOf(d3), ["objects", "head"]);
  await mainIs(s, d3.root.toString());
  assert.deepEqual(await since(), ["objects", "objects", "head"]);

  // A new conversation (no tree: main's) gets the new prompt — the chat app installed for it (#83: the genesis has no chat loop).
  await h.install("martha", [CHAT_APP]);
  await owner.box(row).send(row.identity!, "chat", { text: "who are you?" });
  await until("the inference request", async () => { await peer.poll(); return requests.length ? true : undefined; });
  const system = String((requests[0]!.messages as Json[])[0]!.content);
  assert.ok(system.includes("You are Martha, now at the back office.") && system.includes(IDENTITY), system);
  await h.router.settled();
  const loop = (await appRecordOf(s, "chat"))!.record.programs.loop!;
  assert.equal((await collect(s.edges.query({ kind: "thread", program: loop }))).length, 1);
});

test("skein deploy: a directory into main on a session with the instance's origin (objects, head); a stranger's key is refused", { skip }, async (t) => {
  const { h, store, env } = await setup(t, ["kurt"]);
  const dir = await agentDir(t);
  const e = env();
  await h.router.hydrate("kurt");
  await h.router.settled();
  const origin = `${h.base}/@kurt`;
  assert.equal(await adminMain("deploy", [dir, origin, "--dry-run"], e.env), 0, e.err.join("\n"));
  const root = /→ main (\S+)/.exec(e.out.join("\n"))?.[1];
  const sent = e.out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { message: { recipient: string; messageBox: string } });
  assert.ok(root && sent.length && sent.every((m) => m.message.recipient === h.db.get("kurt")!.identity! && m.message.messageBox === "objects"), e.out.join("\n"));
  const stranger = join(h.home, "stranger.key");
  await fs.writeFile(stranger, `${PrivateKey.fromRandom().toHex()}\n`);
  assert.equal(await adminMain("deploy", [dir, origin], { ...e.env, vars: { ...e.env.vars, SKEIN_OPERATOR_KEY: stranger } }), 1, "a stranger's objects are refused");
  assert.match(e.err.at(-1)!, /403/);
  assert.equal(await adminMain("deploy", [dir, origin], e.env), 0, e.err.join("\n"));
  await h.router.settled();
  await mainIs(await store("kurt"), root!);
});

test("skein dispatch --instance: a message to box `dispatch` as the owner, over the control socket, changes a running instance's dispatch table (a kernel operation), a handler named from its genesis; no new genesis", { skip }, async (t) => {
  const { h, env, store } = await setup(t, ["martha"]);
  const s = await store("martha");
  const e = env();
  const plan = async (...argv: string[]) => { const code = await adminMain("dispatch", [...argv, "--instance", "martha"], e.env); await h.router.settled(); return code; };
  const genesis = (await collect(s.log.entries(0)))[0]!.cid;
  const before = await until("the genesis processed (its seed rows)", () => currentDispatch(s));
  const resolve = (await programsOf(s)).resolve!;
  const peer = PrivateKey.fromRandom().toPublicKey().toString();
  const last = async () => (await currentDispatch(s))!.at(-1)!;

  // #143: a route has no sender — `--sender` is refused; the route is the box's alone.
  assert.equal(await plan("add", "--sender", peer, "register", "resolve"), 1);
  assert.match(e.err.at(-1)!, /--sender: gone \(#143\)/);
  assert.equal(await plan("add", "register", "resolve"), 0, e.err.join("\n"));
  await until("the new row", async () => (await last()).address === "register" ? true : undefined);
  const row = await last();
  assert.deepEqual([row.transport, row.address, String(row.program)], ["mailbox", "register", String(resolve)]);
  assert.equal(await plan("remove", "register", String(resolve)), 0);
  await until("the row removed", async () => (await currentDispatch(s))!.length === before!.length ? true : undefined);
  assert.deepEqual(await currentDispatch(s), before, "removed: the rows as they were");
  assert.ok((await collect(s.log.entries(0)))[0]!.cid.equals(genesis), "the same genesis");

  assert.equal(await plan("swap", "register", "resolve"), 2);
  assert.equal(await plan("add", "register", "no-such-program"), 1);
  assert.match(e.err.at(-1)!, /not a CID or a program name/);
  assert.equal(await main(["dispatch", "martha", "add", "register", "resolve"], e.env), 2, "skein-host changes no dispatch table");
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

test("skein-host knows / roster --for: each agent's ROSTER.md from host.db and the IDENTITY.md the owner deployed (main); deployed with it as the owner's messages", { skip }, async (t) => {
  const { h, env, store, deploy } = await setup(t, ["martha", "kurt"]);
  const mdir = await agentDir(t);
  const kdir = await agentDir(t);
  await fs.writeFile(join(kdir, "IDENTITY.md"), KURT);
  const e = env();
  const cli = (...argv: string[]) => main(argv, e.env);
  const rosterOf = async (handle: string) => { const s = await store(handle); return new TextDecoder().decode(await readFile(s, (await headTree(s, MAIN))!, "ROSTER.md")); };
  // Not --all: the host's mailbox instances (david, infer) are rows too.
  assert.equal(await cli("knows", "martha", "kurt"), 0);
  assert.equal(e.out.at(-1), "martha knows kurt");
  assert.equal(await cli("knows", "kurt", "martha"), 0);
  assert.equal(await cli("knows", "kurt"), 0);
  assert.equal(e.out.at(-1), "kurt knows martha");

  // Before anything is deployed: the handle stands in for the name.
  assert.equal(await cli("roster", "--for", "martha"), 0);
  assert.equal(e.out.at(-1), "## Colleagues\n\n- @kurt@localhost — kurt");

  // Kurt deployed (his IDENTITY.md in his main): Martha's roster names him; written into her directory and deployed with it.
  const k = await deploy("kurt", kdir);
  await mainIs(await store("kurt"), k.root.toString());
  assert.equal(await cli("roster", "--for", "martha"), 0);
  assert.equal(e.out.at(-1), "## Colleagues\n\n- @kurt@localhost — Kurt: Account manager for");
  await fs.writeFile(join(mdir, "ROSTER.md"), `${e.out.at(-1)}\n`);
  const m = await deploy("martha", mdir, ["SOUL.md", "IDENTITY.md", "skills", "ROSTER.md"]);
  await mainIs(await store("martha"), m.root.toString());
  assert.equal(await rosterOf("martha"), "## Colleagues\n\n- @kurt@localhost — Kurt: Account manager for\n");
  assert.equal(await cli("roster", "--for", "kurt"), 0);
  assert.equal(e.out.at(-1), "## Colleagues\n\n- @martha@localhost — Martha: Organization front desk and directory service.");

  // Kurt knows nobody now: no ROSTER.md for him.
  assert.equal(await cli("knows", "kurt", "--none"), 0);
  assert.equal(await cli("roster", "--for", "kurt"), 0);
  assert.equal(e.err.at(-1), "kurt knows nobody: no ROSTER.md");
  await assert.rejects(cli("roster", "--deploy"), /Unknown option '--deploy'/, "skein-host deploys nothing");

  assert.equal(await cli("knows", "nobody", "--all"), 1);
  assert.equal(await cli("knows", "kurt", "martha", "--all"), 2);
});
