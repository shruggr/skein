// Open emit events (#119) end to end: two routers with libp2p. On A, one
// instance (`ev`, the stock system, no libp2p in its genesis) gets two apps
// by the owner's messages (`skein plan install`, #124), both the module programs/test/app-demo under other
// names: `evt-a` (a libp2p row `demo_` with `prefix: true`) and `evt-b` (a
// prefix row `other_` and an exact row `demo_mine`). A message {kind:
// "app-demo-event", event, …} in the app's box makes the app emit that event.
// B runs a plain instance (`pub`) whose genesis subscribes `demo_abc`: the
// publisher.
//
//   - installed, the prefix rows subscribe nothing; evt-b's exact row does;
//   - evt-a emits `subscribe {topic: demo_abc}`: the step's update lists the
//     record {kind: "event", event: "subscribe", app: "evt-a", topic}, and A's
//     node subscribes demo_abc; B publishes on it: the front door routes it by
//     the prefix row (dispatch.zig forLibp2p) to evt-a's `topic` fn, which
//     accepts (GossipSub delivers it to A's node);
//   - scope: evt-b's `subscribe demo_abc` (no row of evt-b takes it) and
//     evt-a's `subscribe demo_mine` (evt-b's exact row is the more specific)
//     are refused, nothing subscribed; evt-b's `subscribe other_1` is;
//   - an event nobody wires (`made-up`): listed on the update, a record in the
//     store, a log line; nothing else;
//   - `unsubscribe`: the node leaves the topic;
//   - A restarted (a new router on the same host db): the node's topics are
//     the same, read from the log (p2p.ts askedTopics); nothing is re-emitted;
//   - evt-a uninstalled: its asked topics go with its rows.
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
import { askedTopics, peerIdOf } from "../../src/host/p2p.ts";
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
const p2pRow = (address: string, prefix: boolean) => ({ transport: "libp2p", address, ...(prefix ? { prefix: true } : {}), sender: "*", program: "demo", fn: "topic" });
const treeA = appTree("evt-a", [p2pRow("demo_", true)]);
const treeB = appTree("evt-b", [p2pRow("other_", true), p2pRow("demo_mine", false)]);

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
  ...common, db: hdbB, genesis: { libp2p: { topics: ["demo_abc"] } },
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
  /** The app emits `event` (a message {kind: "app-demo-event", …event} in its box from the owner), and the router settles. */
  const emit = async (app: string, event: Record<string, unknown>) => {
    const sent = await new RawBox(ownerWallet, `http://127.0.0.1:${rA.port}/@ev`).send(identity, app, { kind: "app-demo-event", ...event });
    await rA.settled();
    return sent;
  };
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
  const asked = async () => { const s = openStoreFile(store, { readOnly: true }); try { return await askedTopics(s); } finally { s.close(); } };
  const fmtAsked = (m: Map<string, Set<string>>) => [...m].map(([a, t]) => `${a}: ${[...t].sort().join(" ")}`).sort().join("; ");

  // ------------------------------------------------ install: the prefix rows subscribe nothing
  let code = await cli("install", treeA, "--instance", "ev");
  check(code === 0 && out.some((l) => /row\s+libp2p demo_\*? from anyone → demo\.topic/.test(l)), `skein plan install evt-a (a libp2p prefix row demo_): exit ${code} ${err.join(" ")} ${out.filter((l) => l.includes("libp2p")).join(" | ")}`);
  code = await cli("install", treeB, "--instance", "ev");
  check(code === 0, `skein plan install evt-b (a prefix row other_, an exact row demo_mine): exit ${code} ${err.join(" ")}`);
  let topics = await until("the node subscribes evt-b's exact row", () => served().length ? served() : undefined).catch(() => served());
  check(topics.join(",") === "demo_mine", `a prefix row is not subscribed; the exact row is: ${topics.join(", ")}`);

  // ------------------------------------------------ evt-a: subscribe demo_abc
  await emit("evt-a", { event: "subscribe", topic: "demo_abc" });
  const ev1 = (await events()).find((r) => r.event === "subscribe" && r.topic === "demo_abc");
  check(!!ev1 && ev1.app === "evt-a" && Object.keys(ev1).sort().join(",") === "app,event,kind,topic", `the step's update lists the event record, the emitting app named by the kernel: ${JSON.stringify(ev1)}`);
  topics = await until("the node subscribes demo_abc", () => served().includes("demo_abc") ? served() : undefined).catch(() => served());
  check(topics.join(",") === "demo_abc,demo_mine", `evt-a's subscribe: the node subscribes demo_abc, live (${topics.join(", ")})`);

  // B publishes on demo_abc: routed by the prefix row to evt-a, which accepts.
  const node = rA.p2p!.node("ev")!;
  const ps = (node.services as { pubsub: { addEventListener(t: string, f: (e: { detail: { msg?: { topic: string; data: Uint8Array }; topic?: string } }) => void): void; getSubscribers(t: string): unknown[] } }).pubsub;
  const got: string[] = [];
  ps.addEventListener("message", (e) => { const m = (e.detail as { msg?: { topic: string; data: Uint8Array } }).msg ?? (e.detail as unknown as { topic: string; data: Uint8Array }); if (m?.topic === "demo_abc") got.push(new TextDecoder().decode(m.data)); });
  const pubPs = (rB.p2p!.node("pub")!.services as { pubsub: { getSubscribers(t: string): unknown[] } }).pubsub;
  await until("the publisher sees the instance on demo_abc", () => pubPs.getSubscribers("demo_abc").length > 0 || undefined).catch(() => undefined);
  await sleep(1200); // a heartbeat: the instance in the publisher's mesh
  await rB.p2p!.publish("pub", "demo_abc", new TextEncoder().encode("hello demo_abc"));
  const accepted = await until("the message accepted", () => got.length ? got : undefined, 15_000).catch(() => undefined);
  await rA.settled();
  check(accepted?.[0] === "hello demo_abc", `a message B publishes on demo_abc: routed by evt-a's prefix row to its topic fn, accepted (${accepted?.join(", ") ?? "nothing delivered"})`);

  // ------------------------------------------------ scope
  await emit("evt-b", { event: "subscribe", topic: "demo_abc" });
  await emit("evt-a", { event: "subscribe", topic: "demo_mine" });
  check(lines.some((l) => /subscribe demo_abc from app evt-b: refused/.test(l)) && lines.some((l) => /subscribe demo_mine from app evt-a: refused .*evt-b/.test(l)), "evt-b's subscribe demo_abc (no row of evt-b takes it) and evt-a's subscribe demo_mine (evt-b's exact row is the more specific): refused, with a log line each");
  await emit("evt-b", { event: "subscribe", topic: "other_1" });
  topics = await until("the node subscribes other_1", () => served().includes("other_1") ? served() : undefined).catch(() => served());
  check(topics.join(",") === "demo_abc,demo_mine,other_1", `evt-b's subscribe other_1 (its prefix row other_): subscribed; nothing else changed (${topics.join(", ")})`);
  // evt-b unsubscribing evt-a's topic changes nothing of evt-a's.
  await emit("evt-b", { event: "unsubscribe", topic: "demo_abc" });
  check(served().includes("demo_abc"), "evt-b's unsubscribe demo_abc leaves evt-a's subscription");

  // ------------------------------------------------ an event nobody wires
  const before = served().join(",");
  await emit("evt-a", { event: "made-up", n: 7 });
  const ev2 = (await events()).find((r) => r.event === "made-up");
  check(!!ev2 && ev2.app === "evt-a" && ev2.n === 7 && served().join(",") === before && lines.some((l) => /an event made-up this host has no wiring for: ignored/.test(l)), `an event nobody wires: a record on the update (${JSON.stringify(ev2)}), a log line, nothing else`);

  // ------------------------------------------------ unsubscribe
  await emit("evt-a", { event: "unsubscribe", topic: "demo_abc" });
  topics = await until("the node leaves demo_abc", () => !served().includes("demo_abc") ? served() : undefined).catch(() => served());
  check(topics.join(",") === "demo_mine,other_1", `evt-a's unsubscribe: the node leaves demo_abc (${topics.join(", ")})`);
  await emit("evt-a", { event: "subscribe", topic: "demo_def" });
  topics = await until("the node subscribes demo_def", () => served().includes("demo_def") ? served() : undefined).catch(() => served());
  check(topics.join(",") === "demo_def,demo_mine,other_1", `evt-a's subscribe demo_def (${topics.join(", ")})`);
  const foldedLive = fmtAsked(await asked());
  check(foldedLive === "evt-a: demo_def demo_mine; evt-b: other_1", `the asked sets as the log folds them (the scope applied when subscribing, not to the fold): ${foldedLive}`);

  // ------------------------------------------------ restart: read back from the log
  const emittedBefore = (await events()).length;
  await rA.stop();
  rA = routerA();
  await rA.listen(0);
  await rA.hydrate("ev");
  await rA.settled();
  topics = served();
  check(topics.join(",") === "demo_def,demo_mine,other_1", `a new router on the same host: the node subscribes the same topics, read from the log (${topics.join(", ")})`);
  check((await events()).length === emittedBefore, "nothing re-emitted at the restart (the kernel keeps nothing for the events; the host read them)");

  // ------------------------------------------------ uninstall evt-a: its asked topics go with its rows
  code = await cli("uninstall", "evt-a", "--instance", "ev");
  topics = await until("the node leaves demo_def", () => !served().includes("demo_def") ? served() : undefined).catch(() => served());
  check(code === 0 && topics.join(",") === "demo_mine,other_1", `evt-a uninstalled: no row of evt-a takes demo_def any more, so the node leaves it (${topics.join(", ")})`);
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
