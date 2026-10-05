// Subscriptions (#119) end to end: two routers with libp2p. On A, one
// instance (`ev`, the stock system, no libp2p in its genesis) gets two apps
// by the owner's messages (`skein plan install`, #124), both the module
// programs/test/app-demo under other names: `evt-a` (no libp2p row) and
// `evt-b` (an exact libp2p row `demo_mine` → its fn `topic`). A message
// {kind: "app-demo-event", emit: {event, …}} in the app's box makes the app
// emit that event; a libp2p message delivered to its fn `topic` moves its head
// `<app>/seen` to {kind: "app-demo-seen", app, topic, request} and accepts. B
// runs a plain instance (`pub`) whose genesis subscribes the topics: the
// publisher.
//
//   - installed: the node subscribes evt-b's row's topic, nothing else;
//   - a subscribe the kernel refuses as it is emitted (no program or fn, a
//     program not the app's, a /protocol, an unsubscribe of nothing the app
//     has): the step errors with the kernel's reason; nothing is listed;
//   - evt-a emits `subscribe {topic: demo_abc, program: "demo", fn: "topic"}`:
//     the step's update lists {kind: "event", event: "subscribe", app:
//     "evt-a", topic, program, fn}; A's node subscribes demo_abc; B publishes
//     on it: the kernel delivers it by the subscription to evt-a's `topic`
//     (evt-a/seen moves), no row consulted;
//   - evt-b's subscribe of demo_abc is its own: the next message is still
//     evt-a's; evt-a unsubscribes: the node keeps the topic (evt-b's) and the
//     next message is evt-b's; evt-b unsubscribes: the node leaves it; a second
//     unsubscribe is refused (an app unsubscribes only its own);
//   - a row wins: evt-a subscribes demo_mine (evt-b's row's topic); a message
//     there is evt-b's, by the row;
//   - an event nobody wires (`made-up`): listed on the update, a record in the
//     store, a log line; nothing else;
//   - A restarted (a new router on the same host db): the node subscribes the
//     same topics, read from the log (p2p.ts subscriptionsOf); nothing is
//     re-emitted; the new kernel delivers by the subscription it folds.
//
// The instance's store then replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/emit-events.ts

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { main } from "../../src/host/cli.ts";
import { ownerCli } from "../../src/testapps.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { peerIdOf, subscriptionsOf } from "../../src/host/p2p.ts";
import { Router } from "../../src/host/router.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-emit-events-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

// ---------------------------------------------------------------- the two apps: app-demo's module under other names
const wasm = join(here, "../../programs/test/app-demo/bin/app-demo.wasm");
function appTree(name: string, rows: Array<Record<string, unknown>>): string {
  const dir = join(home, "apps", name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "etc"), { recursive: true });
  copyFileSync(wasm, join(dir, "bin/app-demo.wasm"));
  writeFileSync(join(dir, "etc/app.json"), JSON.stringify({
    kind: "app", name, version: "0.1.0", programs: { demo: "bin/app-demo.wasm" }, provides: [], requires: [],
    dispatch: [{ address: name, sender: "$owner", program: "demo" }, ...rows],
    description: `#119's test app ${name}: app-demo's module, emitting the events it is asked to`,
  }, null, 2));
  return dir;
}
const treeA = appTree("evt-a", []);
const treeB = appTree("evt-b", [{ transport: "libp2p", address: "demo_mine", sender: "*", program: "demo", fn: "topic" }]);

// ---------------------------------------------------------------- two routers with libp2p
const key = (h: string) => new PrivateKey(h, 16);
const ownerKey = key("2222");
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("e1e2e3", 16));
const ports = { a: await freePort(), b: await freePort() };
const idOf = (h: string) => peerIdOf(signer.peerKey(h)).toString();
const hdbA = new HostDb(join(home, "host.db"));
hdbA.add("ev", { store: join(home, "instances/ev/runtime.db") });
const hdbB = new HostDb(join(home, "pub-host.db"));
hdbB.add("pub", { store: join(home, "instances/pub/runtime.db") });
const lines: string[] = [];
const common = { walletFor: () => ephemeralWallet(key("1111")), home, owner, idleMs: 0, providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 6000, kernel: { command: kernel, env: { SKEIN_HOME: home } }, libp2pDiscoveryMs: 300 };
const log = (who: string) => (s: string, l: string) => { lines.push(`[${who}:${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${who}:${s}] ${l}\n`); };
const routerA = () => new Router({
  ...common, db: hdbA,
  libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports.a}`], bootstrap: [`/ip4/127.0.0.1/tcp/${ports.b}/p2p/${idOf("pub")}`], dht: "off", relays: [], mdns: false },
  log: log("a"),
});
let rA = routerA();
const rB = new Router({
  ...common, db: hdbB, genesis: { libp2p: { topics: ["demo_abc", "demo_mine", "demo_def"] } },
  libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports.b}`], bootstrap: [`/ip4/127.0.0.1/tcp/${ports.a}/p2p/${idOf("ev")}`], dht: "off", relays: [], mdns: false },
  log: log("b"),
});

let store = "";
try {
  await rA.listen(0);
  await rB.listen(0);
  await rB.hydrate("pub");
  const identity = (await rA.hydrate("ev")).identity;
  store = hdbA.get("ev")!.store;
  const out: string[] = [], err: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    // #124: install/uninstall are the owner's messages, planned (`skein plan`) and sent to /sendMessage (src/testapps.ts ownerCli).
    const o = args[0] === "install" || args[0] === "uninstall" ? await ownerCli({ home: home, port: rA.port!, owner: ownerWallet, settled: () => rA.settled() }, args) : undefined;
    if (o) { out.push(...o.out); err.push(...o.err); }
    const code = o ? o.code : await main(args, {
      vars: { SKEIN_HOME: home, HOME: home }, out: (l) => out.push(l), err: (l) => err.push(l),
    });
    await rA.settled();
    if (process.env.VERBOSE) for (const l of [...out, ...err]) process.stdout.write(`  | ${l}\n`);
    return code;
  };
  const served = () => rA.p2p?.served("ev")?.topics.slice().sort() ?? [];
  /** The app emits `event` (a message {kind: "app-demo-event", emit: event} in its box from the owner), and the router settles. */
  const emit = async (app: string, event: Record<string, unknown>) => {
    const sent = await new RawBox(ownerWallet, `http://127.0.0.1:${rA.port}/@ev`).send(identity, app, { kind: "app-demo-event", emit: event });
    await rA.settled();
    return sent;
  };
  const sub = (topic: string) => ({ event: "subscribe", topic, program: "demo", fn: "topic" });
  /** Every event record the instance's steps emitted (kind "event"), read from its store with the update listing it. */
  const events = async () => {
    const s = openStoreFile(store, { readOnly: true });
    try {
      const found: Array<Record<string, unknown>> = [];
      for await (const origin of s.edges.query({ kind: "thread" })) {
        for await (const c of s.chains.history(origin)) {
          if (c.equals(origin)) continue;
          const u = await s.get(c) as Record<string, unknown>;
          for (const x of Array.isArray(u.emitted) ? u.emitted : []) {
            if (!CID.asCID(x)) continue;
            const rec = await s.get(x as CID) as Record<string, unknown>;
            if (rec.kind === "event") found.push(rec);
          }
        }
      }
      return found;
    } finally { s.close(); }
  };
  const folded = async () => { const s = openStoreFile(store, { readOnly: true }); try { return (await subscriptionsOf(s)).map((x) => `${x.app} ${x.topic} ${x.program}.${x.fn}`).join("; "); } finally { s.close(); } };
  /** `<app>/seen`: the last libp2p message the app's fn `topic` was delivered. */
  const seen = async (app: string) => {
    const k = (await rA.hydrate("ev")).kernel;
    const root = await k.call("head", `${app}/seen`) as CID | null;
    return root ? await k.store.get(root) as Record<string, unknown> : undefined;
  };
  const reqOf = (r: Record<string, unknown> | undefined) => r?.request ? String(r.request) : "";
  const pubPs = () => (rB.p2p!.node("pub")!.services as { pubsub: { getSubscribers(t: string): Array<{ toString(): string }> } }).pubsub;
  let nth = 0;
  /** B publishes on `topic` once A's node is in its mesh; the app whose `<app>/seen` moved (of `apps`), or "" (none within the wait). */
  const deliver = async (topic: string, apps: string[], ms = 15_000): Promise<string> => {
    await until(`the publisher sees the instance on ${topic}`, () => pubPs().getSubscribers(topic).some((p) => p.toString() === idOf("ev")) || undefined).catch(() => undefined);
    await sleep(1200); // a heartbeat: the instance in the publisher's mesh
    const before = new Map(await Promise.all(apps.map(async (a) => [a, reqOf(await seen(a))] as const)));
    await rB.p2p!.publish("pub", topic, new TextEncoder().encode(`message ${++nth} on ${topic}`));
    const moved = await until(`a delivery on ${topic}`, async () => { await rA.settled(); for (const a of apps) if (reqOf(await seen(a)) !== before.get(a)) return a; return undefined; }, ms).catch(() => "");
    await rA.settled();
    return moved;
  };
  /** The last step failure line naming `what` (the kernel's refusal of an emit). */
  const refused = (re: RegExp) => lines.some((l) => /failed|errored/.test(l) && re.test(l));

  // ------------------------------------------------ install: evt-b's row's topic only
  let code = await cli("install", treeA, "--instance", "ev");
  check(code === 0, `skein plan install evt-a (no libp2p row): exit ${code} ${err.join(" ")}`);
  code = await cli("install", treeB, "--instance", "ev");
  check(code === 0 && out.some((l) => /row\s+libp2p demo_mine from anyone → demo\.topic/.test(l)), `skein plan install evt-b (an exact row demo_mine): exit ${code} ${err.join(" ")} ${out.filter((l) => l.includes("libp2p")).join(" | ")}`);
  let topics = await until("the node subscribes evt-b's row", () => served().length ? served() : undefined).catch(() => served());
  check(topics.join(",") === "demo_mine", `the node subscribes the row's topic: ${topics.join(", ")}`);

  // ------------------------------------------------ the kernel's checks, as the event is emitted
  const n0 = (await events()).length;
  await emit("evt-a", { event: "subscribe", topic: "demo_abc" });
  check(refused(/emit: subscribe names its program/), "a subscribe with no program: the emit refused, the step errors");
  await emit("evt-a", { event: "subscribe", topic: "demo_abc", program: "nope", fn: "topic" });
  check(refused(/emit: subscribe: "nope" is not a program of app evt-a/), "a program not the app's: refused");
  await emit("evt-a", { event: "subscribe", topic: "demo_abc", program: "demo" });
  check(refused(/emit: subscribe names the function delivered to/), "no fn: refused");
  await emit("evt-a", { ...sub("/demo/1") });
  check(refused(/emit: subscribe: topic "\/demo\/1" is not a topic/), "a /protocol: refused");
  await emit("evt-a", { event: "unsubscribe", topic: "demo_abc" });
  check(refused(/emit: unsubscribe: app evt-a has no subscription to demo_abc/), "an unsubscribe of nothing the app has: refused");
  check((await events()).length === n0 && served().join(",") === "demo_mine", "nothing refused is listed, and nothing subscribed");

  // ------------------------------------------------ evt-a: subscribe demo_abc → its fn `topic`
  await emit("evt-a", sub("demo_abc"));
  const ev1 = (await events()).find((r) => r.event === "subscribe" && r.topic === "demo_abc");
  check(!!ev1 && ev1.app === "evt-a" && ev1.program === "demo" && ev1.fn === "topic" && Object.keys(ev1).sort().join(",") === "app,event,fn,kind,program,topic", `the step's update lists the subscription, the app named by the kernel: ${JSON.stringify(ev1)}`);
  topics = await until("the node subscribes demo_abc", () => served().includes("demo_abc") ? served() : undefined).catch(() => served());
  check(topics.join(",") === "demo_abc,demo_mine", `evt-a's subscribe: the node subscribes demo_abc, live (${topics.join(", ")})`);
  let got = await deliver("demo_abc", ["evt-a", "evt-b"]);
  const s1 = await seen("evt-a");
  check(got === "evt-a" && s1?.topic === "demo_abc" && s1?.app === "evt-a", `a message B publishes on demo_abc: delivered by the subscription to evt-a's fn topic, no row (${got || "nothing delivered"}; ${JSON.stringify(s1 && { app: s1.app, topic: s1.topic })})`);

  // ------------------------------------------------ another app's subscription is its own
  await emit("evt-b", sub("demo_abc"));
  got = await deliver("demo_abc", ["evt-a", "evt-b"]);
  check(got === "evt-a" && (await seen("evt-b")) === undefined, `evt-b's subscribe of demo_abc is its own: the next message is still evt-a's (${got || "nothing delivered"})`);
  await emit("evt-a", { event: "unsubscribe", topic: "demo_abc" });
  check(served().includes("demo_abc"), "evt-a unsubscribes: the node keeps demo_abc (evt-b's)");
  got = await deliver("demo_abc", ["evt-a", "evt-b"]);
  check(got === "evt-b" && (await seen("evt-b"))?.topic === "demo_abc", `the next message is evt-b's: evt-a's unsubscribe stopped its delivery (${got || "nothing delivered"})`);
  await emit("evt-b", { event: "unsubscribe", topic: "demo_abc" });
  topics = await until("the node leaves demo_abc", () => !served().includes("demo_abc") ? served() : undefined).catch(() => served());
  check(topics.join(",") === "demo_mine", `evt-b unsubscribes too: the node leaves demo_abc (${topics.join(", ")})`);
  const before = lines.length;
  await emit("evt-b", { event: "unsubscribe", topic: "demo_abc" });
  check(lines.slice(before).some((l) => /emit: unsubscribe: app evt-b has no subscription to demo_abc/.test(l)), "evt-b's second unsubscribe: refused (an app unsubscribes only its own)");

  // ------------------------------------------------ a row wins
  await emit("evt-a", sub("demo_mine"));
  got = await deliver("demo_mine", ["evt-a", "evt-b"]);
  check(got === "evt-b" && (await seen("evt-b"))?.topic === "demo_mine", `evt-a subscribes demo_mine, evt-b's row's topic: a message there is evt-b's, by the row (${got || "nothing delivered"})`);

  // ------------------------------------------------ an event nobody wires
  const was = served().join(",");
  await emit("evt-a", { event: "made-up", n: 7 });
  const ev2 = (await events()).find((r) => r.event === "made-up");
  check(!!ev2 && ev2.app === "evt-a" && ev2.n === 7 && served().join(",") === was && lines.some((l) => /an event made-up this host has no wiring for: ignored/.test(l)), `an event nobody wires: a record on the update (${JSON.stringify(ev2)}), a log line, nothing else`);

  // ------------------------------------------------ the subscriptions as the log folds them
  await emit("evt-a", sub("demo_def"));
  topics = await until("the node subscribes demo_def", () => served().includes("demo_def") ? served() : undefined).catch(() => served());
  check(topics.join(",") === "demo_def,demo_mine", `evt-a's subscribe demo_def (${topics.join(", ")})`);
  const f = await folded();
  check(f === "evt-a demo_mine demo.topic; evt-a demo_def demo.topic", `the subscriptions as the log folds them: ${f}`);

  // ------------------------------------------------ restart: read back from the log
  const emittedBefore = (await events()).length;
  await rA.stop();
  rA = routerA();
  await rA.listen(0);
  await rA.hydrate("ev");
  await rA.settled();
  topics = served();
  check(topics.join(",") === "demo_def,demo_mine", `a new router on the same host: the node subscribes the same topics, read from the log (${topics.join(", ")})`);
  check((await events()).length === emittedBefore, "nothing re-emitted at the restart (the host read the events)");
  const before2 = reqOf(await seen("evt-a"));
  got = await deliver("demo_def", ["evt-a", "evt-b"], 20_000);
  check(got === "evt-a" && reqOf(await seen("evt-a")) !== before2 && (await seen("evt-a"))?.topic === "demo_def", `after the restart a message on demo_def is delivered by the subscription the new kernel folds from the log (${got || "nothing delivered"})`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await rA.stop();
  await rB.stop();
  hdbA.close();
  hdbB.close();
  if (store) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "the instance's store replays to itself exactly (the event records, with their app)");
  }
}
if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `emit-events: ${failures} FAILED\n` : "emit-events: all ok\n");
process.exit(failures ? 1 : 0);
