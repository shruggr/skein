// `skein-host run` as a supervisor (#23, "a process per instance"): one child
// process per enabled row, with the row in its environment; lines prefixed by
// handle; a child that dies is started again; each ready row gets its
// explorer; the host page and roster show live children; stop ends them all.
// First with stub children (a few lines of node standing in for
// bin/skein-runtime and bin/skein-explore), then with the real runtime and
// explorer on an ephemeral wallet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { genesisOf } from "../runtime/log.ts";
import { openStore } from "../runtime/sqlite.ts";
import { runHost, type Host } from "./cli.ts";
import { HostDb } from "./instances.ts";

async function tmp(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-sup-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const idOf = (h: string) => `02${createHash("sha256").update(h).digest("hex")}`;

/** bin/skein-runtime's stand-in: its environment, a stderr line, the ready line; `kurt` dies at its first start. */
const RUNTIME = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const e = process.env, h = e.SKEIN_HANDLE;
const f = e.STUB_DIR + "/" + h + ".starts";
const n = (existsSync(f) ? Number(readFileSync(f, "utf8")) : 0) + 1;
writeFileSync(f, String(n));
console.log("env " + JSON.stringify({ db: e.SKEIN_DB, handle: h, wallet: e.SKEIN_WALLET_URL, originator: e.SKEIN_WALLET_ORIGINATOR, identity: e.SKEIN_IDENTITY, hostDb: e.SKEIN_HOST_DB, owner: e.SKEIN_OWNER }));
console.error("a line on stderr");
if (h.startsWith("kurt@") && n === 1) process.exit(3);
console.log("skein runtime 02" + createHash("sha256").update(h.split("@")[0]).digest("hex") + " (" + h + ") · pid " + process.pid);
process.on("SIGTERM", () => { console.log("SIGTERM: stopping"); process.exit(0); });
setInterval(() => {}, 1 << 30);
`;
const EXPLORE = `
console.log("listening " + process.argv[2] + " " + process.env.SKEIN_DB);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

async function until(what: string, f: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out: ${what}`);
}

const get = async (host: Host, path: string) => fetch(`http://127.0.0.1:${host.port}${path}`);

test("supervisor: a process per enabled row with its row in its environment; prefixed lines; a child that dies restarts; explorers once ready; host page and roster live; stop ends them all", async (t) => {
  const home = await tmp(t);
  await fs.writeFile(join(home, "runtime.mjs"), RUNTIME);
  await fs.writeFile(join(home, "explore.mjs"), EXPLORE);
  const db = new HostDb(join(home, "host.db"));
  t.after(() => db.close());
  db.add("martha", { store: join(home, "m.db"), wallet_url: "http://127.0.0.1:3401" }, new Date(1));
  db.add("kurt", { store: join(home, "k.db"), wallet_url: "http://127.0.0.1:3402", wallet_originator: "kurt-o" }, new Date(2));
  db.add("nowallet", { store: join(home, "n.db") }, new Date(3));
  db.add("zed", { store: join(home, "z.db"), wallet_url: "http://127.0.0.1:3403", status: "disabled" }, new Date(4));
  const out: string[] = [], err: string[] = [];
  const env = { vars: { SKEIN_HOME: home, SKEIN_HOST_PORT: "0", SKEIN_EXPLORE_BASE_PORT: "5100", SKEIN_OWNER: "02" + "d".repeat(64), STUB_DIR: home }, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const node = (script: string) => ({ command: process.execPath, args: [join(home, script)] });
  const host = await runHost(db, env, { runtime: node("runtime.mjs"), explore: node("explore.mjs"), backoff: { baseMs: 50, maxMs: 200, stableMs: 60_000 }, killAfterMs: 3000 });
  t.after(() => host.stop());

  assert.deepEqual([...host.instances.keys()], ["martha", "kurt"], "enabled rows with a wallet; nowallet refused, zed disabled");
  assert.ok(err.includes("[nowallet] not started: no wallet_url (skein-host add --wallet-url)"), err.join("\n"));
  await until("both ready", () => host.instances.get("martha")!.ready && host.instances.get("kurt")!.ready);
  const m = host.instances.get("martha")!, k = host.instances.get("kurt")!;
  assert.notEqual(m.pid, k.pid);
  assert.notEqual(m.pid, process.pid, "not in this process");
  assert.equal(k.restarts, 1, "kurt died at its first start and was started again");
  assert.ok(err.some((l) => /^\[kurt\] exited \(code 3\) after \d+ ms; again in 50 ms$/.test(l)), err.join("\n"));
  assert.equal(m.restarts, 0);

  // Each child got its own row, and everything else from the host's environment.
  const envOf = (h: string) => JSON.parse(out.find((l) => l.startsWith(`[${h}] env `))!.slice(`[${h}] env `.length));
  assert.deepEqual(envOf("martha"), { db: join(home, "m.db"), handle: "martha@localhost", wallet: "http://127.0.0.1:3401", originator: "skein", identity: "", hostDb: join(home, "host.db"), owner: "02" + "d".repeat(64) });
  assert.deepEqual([envOf("kurt").db, envOf("kurt").originator], [join(home, "k.db"), "kurt-o"]);
  assert.ok(err.includes("[martha] a line on stderr"), "stderr is prefixed too");
  assert.ok(out.some((l) => l.startsWith(`[martha] skein runtime ${idOf("martha")}`)));

  // The ready line's identity goes into the row; the explorer starts on base + the row's place.
  assert.equal(db.get("martha")!.identity, idOf("martha"));
  assert.equal(db.get("kurt")!.identity, idOf("kurt"));
  await until("explorers", () => out.some((l) => l.startsWith("[martha explore] listening")) && out.some((l) => l.startsWith("[kurt explore] listening")));
  assert.ok(out.includes(`[martha explore] listening 5100 ${join(home, "m.db")}`), out.join("\n"));
  assert.ok(out.includes(`[kurt explore] listening 5101 ${join(home, "k.db")}`));

  // Roster and host page.
  const roster = await (await get(host, "/roster.json")).json() as Array<{ handle: string; status: string; identity: string }>;
  assert.deepEqual(roster.map((r) => [r.handle, r.status]), [["martha", "live"], ["kurt", "live"], ["nowallet", "idle"]]);
  const page = await (await get(host, "/")).text();
  assert.match(page, /<title>skein host<\/title>/);
  for (const s of [`<b>martha</b>@localhost`, `<td>${m.pid}</td>`, `href="http://127.0.0.1:5100/"`, `href="http://127.0.0.1:5101/"`, join(home, "k.db"), "not run", `title="${idOf("kurt")}"`]) assert.ok(page.includes(s), s);
  assert.equal((await get(host, "/nope")).status, 404);

  // A child killed from outside comes back, with a new pid.
  const old = m.pid!;
  process.kill(old, "SIGKILL");
  await until("martha back", () => m.ready && m.pid !== old);
  assert.equal(m.restarts, 1);
  assert.equal((await (await get(host, "/roster.json")).json() as Array<{ status: string }>)[0].status, "live");

  // Stop: every child gets SIGTERM and exits; none comes back.
  const procs = host.supervisor.children.map((c) => c.proc!);
  assert.equal(procs.length, 4, "two runtimes, two explorers");
  await host.stop();
  for (const p of procs) assert.ok(p.exitCode !== null || p.signalCode !== null);
  assert.ok(out.includes("[martha] SIGTERM: stopping") && out.includes("[kurt] SIGTERM: stopping"));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(host.supervisor.children.every((c) => !c.running), "no restarts after stop");
});

test("supervisor: --only runs just those rows, and says why it skips the others", async (t) => {
  const home = await tmp(t);
  await fs.writeFile(join(home, "runtime.mjs"), RUNTIME);
  const db = new HostDb(join(home, "host.db"));
  t.after(() => db.close());
  db.add("martha", { store: join(home, "m.db"), wallet_url: "http://x" }, new Date(1));
  db.add("kurt", { store: join(home, "k.db"), wallet_url: "http://x" }, new Date(2));
  db.add("zed", { store: join(home, "z.db"), wallet_url: "http://x", status: "disabled" }, new Date(3));
  const out: string[] = [], err: string[] = [];
  const env = { vars: { SKEIN_HOME: home, SKEIN_HOST_PORT: "0", SKEIN_EXPLORE_BASE_PORT: "off", STUB_DIR: home }, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const host = await runHost(db, env, { only: ["martha", "zed", "ghost"], runtime: { command: process.execPath, args: [join(home, "runtime.mjs")] }, backoff: { baseMs: 50 } });
  t.after(() => host.stop());
  assert.deepEqual([...host.instances.keys()], ["martha"]);
  assert.ok(err.includes("skein-host run: zed is disabled; skipped") && err.includes("skein-host run: no instance ghost; skipped"), err.join("\n"));
  await until("martha ready", () => host.instances.get("martha")!.ready);
  const roster = await (await get(host, "/roster.json")).json() as Array<{ handle: string; status: string }>;
  assert.deepEqual(roster.map((r) => [r.handle, r.status]), [["martha", "live"], ["kurt", "idle"]]);
  assert.equal(host.explorers.size, 0, "SKEIN_EXPLORE_BASE_PORT=off");
  await host.stop();
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

test("supervisor, for real: bin/skein-runtime per row on an ephemeral wallet — genesis from the row, ready, its explorer serving its store; SIGTERM stops it cleanly", async (t) => {
  const home = await tmp(t);
  const db = new HostDb(join(home, "host.db"));
  t.after(() => db.close());
  const store = join(home, "instances/solo/runtime.db");
  db.add("solo", { store, domain: "example.test" });
  const out: string[] = [], err: string[] = [];
  const owner = PrivateKey.fromRandom().toPublicKey().toString();
  const vars = { ...process.env, SKEIN_HOME: home, SKEIN_HOST_PORT: "0", SKEIN_EXPLORE_BASE_PORT: String(await freePort()), SKEIN_WALLET: "ephemeral", SKEIN_OWNER: owner, SKEIN_MESSAGEBOX: "" };
  const host = await runHost(db, { vars, out: (l) => out.push(l), err: (l) => err.push(l) }, { backoff: { baseMs: 60_000 } });
  t.after(() => host.stop());
  const solo = host.instances.get("solo")!;
  await until("solo ready", () => solo.ready, 30_000).catch((e) => { throw new Error(`${e.message}\n${out.concat(err).join("\n")}`); });
  assert.ok(out.some((l) => /^\[solo\] genesis bafy/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => l.startsWith("[solo] installed loop ")), "the child installs the modules into its store");
  assert.equal(db.get("solo")!.identity, null, "ephemeral keys are not recorded");

  const x = host.explorers.get("solo")!;
  await until("explorer", () => out.some((l) => l.startsWith("[solo explore] skein explore:")), 15_000);
  const overview = await (await fetch(`http://127.0.0.1:${x.port}/`)).text();
  assert.match(overview, /solo@example\.test/, "the explorer reads the row's store");
  assert.ok(overview.includes(solo.identity!));
  const page = await (await get(host, "/")).text();
  assert.ok(page.includes(`href="http://127.0.0.1:${x.port}/"`) && page.includes(`<td>${solo.pid}</td>`));

  const p = solo.proc!;
  await host.stop();
  assert.equal(p.exitCode, 0, "SIGTERM: a clean stop");
  assert.ok(out.includes("[solo] SIGTERM: stopping"), out.join("\n"));
  const s = openStore(store, { readOnly: true });
  const g = await genesisOf(s);
  await s.close();
  assert.deepEqual([g.handle, g.domain, g.owner, g.identity], ["solo", "example.test", owner, solo.identity]);
  assert.deepEqual(g.subscriptions.map((r) => r.match.box), ["run", "objects", "head", "chat", "subscribe", "chat"], "the host's genesis: the owner's boxes, then chat from anyone");
});
