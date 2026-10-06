// Liveness (#138) end to end: two routers with libp2p, an instance on each
// (`one` on router 1, `two` on router 2), each with apps installed by the
// owner's messages — programs/test/app-demo's module under other names
// (a message {kind: "app-demo-event", emit: {event, …}} in the app's box
// makes it emit that event):
//
//   - the kernel refuses a liveness with a window under a second as it is
//     emitted; live-b (on two) emits `liveness {topic: demo_live, window:
//     3000}`: listed on the step's update, the app named by the kernel; two's
//     node subscribes demo_live; GET /@two/live-b/.live/demo_live answers [];
//     another app's or another topic's: 404;
//   - live-a (on one) beacons on demo_live every second: two's endpoint shows
//     its beat {sender: one's identity, at, body (base64), from: one's peer
//     ID} within one beat, and a fresher `at` within the next; nothing is
//     admitted — two's log does not move, no host line per beat;
//   - live-b beacons on demo_live too: its own beats appear in two's set
//     (from: two's peer ID), though gossip does not echo them;
//   - a frame on demo_live whose signature is not its sender's (published by
//     one's node, well formed): never in the set;
//   - live-a unbeacons: after the window its entry drops;
//   - live-b's unliveness: the endpoint answers 404, the node leaves the
//     topic; a liveness again, then live-b's uninstall: 404 again;
//   - two's store replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/liveness.ts

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { ownerCli } from "../../src/testapps.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL as SIGN_PROTOCOL } from "../../src/host/providers.ts";
import { beaconFrame, peerIdOf } from "../../src/host/p2p.ts";
import { Router } from "../../src/host/router.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const root = mkdtempSync(join(tmpdir(), "skein-kz-liveness-"));
const home1 = join(root, "one"), home2 = join(root, "two");
mkdirSync(home1, { recursive: true });
mkdirSync(home2, { recursive: true });
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

// ---------------------------------------------------------------- the apps: app-demo's module under other names
const wasm = join(here, "../../programs/test/app-demo/bin/app-demo.wasm");
function appTree(name: string): string {
  const dir = join(root, "apps", name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "etc"), { recursive: true });
  copyFileSync(wasm, join(dir, "bin/app-demo.wasm"));
  writeFileSync(join(dir, "etc/app.json"), JSON.stringify({
    kind: "app", name, version: "0.1.0", programs: { demo: "bin/app-demo.wasm" }, provides: [], requires: [],
    dispatch: [{ address: name, sender: "$owner", program: "demo" }],
    description: `#138's test app ${name}: app-demo's module, emitting the events it is asked to`,
  }, null, 2));
  return dir;
}

// ---------------------------------------------------------------- two routers with libp2p
const ownerKey = new PrivateKey("2222", 16);
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("e1e2e3", 16));
const ports = { a: await freePort(), b: await freePort() };
const idOf = (h: string) => peerIdOf(signer.peerKey(h)).toString();
const hdb1 = new HostDb(join(home1, "host.db"));
hdb1.add("one", { store: join(home1, "instances/one/runtime.db") });
const hdb2 = new HostDb(join(home2, "host.db"));
hdb2.add("two", { store: join(home2, "instances/two/runtime.db") });
const lines: string[] = [];
const log = (who: string) => (s: string, l: string) => { lines.push(`[${who}:${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${who}:${s}] ${l}\n`); };
const common = { walletFor: (row: { handle: string }) => signer.wallet(row.handle), owner, idleMs: 0, providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 6000, libp2pDiscoveryMs: 300 };
const r1 = new Router({
  // one's node runs from its genesis (no topics), so the mesh is up before live-a's first beat.
  ...common, db: hdb1, home: home1, genesis: { libp2p: { topics: [] } }, kernel: { command: kernel, env: { SKEIN_HOME: home1 } }, log: log("1"),
  libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports.a}`], bootstrap: [`/ip4/127.0.0.1/tcp/${ports.b}/p2p/${idOf("two")}`], dht: "off", relays: [], mdns: false },
});
const r2 = new Router({
  ...common, db: hdb2, home: home2, kernel: { command: kernel, env: { SKEIN_HOME: home2 } }, log: log("2"),
  libp2p: { listen: [`/ip4/127.0.0.1/tcp/${ports.b}`], bootstrap: [`/ip4/127.0.0.1/tcp/${ports.a}/p2p/${idOf("one")}`], dht: "off", relays: [], mdns: false },
});

let store = "";
try {
  await r1.listen(0);
  await r2.listen(0);
  const id1 = (await r1.hydrate("one")).identity;
  const id2 = (await r2.hydrate("two")).identity;
  store = hdb2.get("two")!.store;
  const install = async (r: Router, home: string, handle: string, app: string) => {
    const o = await ownerCli({ home, port: r.port!, owner: ownerWallet, settled: () => r.settled() }, ["install", appTree(app), "--instance", handle]);
    await r.settled();
    check(o.code === 0, `skein plan install ${app} on ${handle}: exit ${o.code} ${o.err.join(" ")}`);
  };
  await install(r1, home1, "one", "live-a");
  await install(r2, home2, "two", "live-b");
  const emit = async (r: Router, handle: string, identity: string, app: string, event: Record<string, unknown>) => {
    await new RawBox(ownerWallet, `http://127.0.0.1:${r.port}/@${handle}`).send(identity, app, { kind: "app-demo-event", emit: event });
    await r.settled();
  };
  const refused = (re: RegExp) => lines.some((l) => /failed|errored/.test(l) && re.test(l));
  /** GET /@two/<app>/.live/<topic>: status and the JSON. */
  const read = async (app = "live-b", topic = "demo_live") => {
    const r = await fetch(`http://127.0.0.1:${r2.port}/@two/${app}/.live/${topic}`);
    return { status: r.status, json: await r.json() as unknown };
  };
  type Beat = { sender: string; at: number; body: string; from: string };
  const beatsOf = async (sender: string): Promise<Beat[]> => { const r = await read(); return r.status === 200 ? (r.json as Beat[]).filter((b) => b.sender === sender) : []; };
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
  const tip2 = async () => (await (await r2.hydrate("two")).kernel.store.log.tip())?.toString();
  const listening = () => r2.p2p?.listening("two").sort() ?? [];

  // ------------------------------------------------ the kernel's check; live-b's liveness
  await emit(r2, "two", id2, "live-b", { event: "liveness", topic: "demo_live", window: 10 });
  check(refused(/emit: liveness: window 10 ms: from 1000 ms to a day/), "a liveness window under a second: refused as it is emitted");
  await emit(r2, "two", id2, "live-b", { event: "liveness", topic: "demo_live", window: 3000 });
  const lev = (await events()).find((r) => r.event === "liveness");
  check(!!lev && lev.app === "live-b" && lev.topic === "demo_live" && lev.window === 3000 && Object.keys(lev).sort().join(",") === "app,event,kind,topic,window", `the step's update lists the liveness, the app named by the kernel: ${JSON.stringify(lev)}`);
  await until("two's node subscribes demo_live", () => listening().includes("demo_live") || undefined).catch(() => undefined);
  check(listening().includes("demo_live") && !(r2.p2p?.served("two")?.topics ?? []).includes("demo_live"), `two's node subscribes demo_live for the liveness tool, not as a topic it admits (${listening().join(", ")})`);
  let r = await read();
  check(r.status === 200 && JSON.stringify(r.json) === "[]", `GET /@two/live-b/.live/demo_live: 200 [] (${r.status} ${JSON.stringify(r.json)})`);
  r = await read("live-x");
  check(r.status === 404, `another app's: 404 (${r.status})`);
  r = await read("live-b", "other_topic");
  check(r.status === 404, `another topic's: 404 (${r.status})`);

  // ------------------------------------------------ live-a on one beacons: two's set shows it within a beat; nothing admitted
  const ps1 = (r1.p2p!.node("one")!.services as { pubsub: { getSubscribers(t: string): Array<{ toString(): string }> } }).pubsub;
  await until("one's node sees two on demo_live", () => ps1.getSubscribers("demo_live").some((p) => p.toString() === idOf("two")) || undefined).catch(() => undefined);
  await sleep(1200); // a heartbeat: the mesh
  const tipBefore = await tip2();
  const linesBefore = lines.length;
  const t0 = Date.now();
  await emit(r1, "one", id1, "live-a", { event: "beacon", topic: "demo_live", every: 1000, body: new TextEncoder().encode("live-a lives") });
  const first = await until("live-a's beat in two's set", async () => (await beatsOf(id1))[0], 5000).catch(() => undefined);
  const took = Date.now() - t0;
  check(!!first && first.from === idOf("one") && Buffer.from(first.body, "base64").toString() === "live-a lives" && typeof first.at === "number", `live-a's beat in two's set {sender: one's identity, at, body (base64), from: one's peer ID} after ${took} ms: ${JSON.stringify(first)}`);
  check(!!first && took <= 2500, `within one beat of the beacon's declaration (${took} ms; the beat at declaration, the next a second later)`);
  const next = await until("a fresher beat", async () => { const b = (await beatsOf(id1))[0]; return b && first && b.at > first.at ? b : undefined; }, 1800).catch(() => undefined);
  check(!!next && (await beatsOf(id1)).length === 1, `the next beat within one beat replaces it, one entry per sender (${first?.at} → ${next?.at})`);
  check(tipBefore === await tip2() && !lines.slice(linesBefore).some((l) => l.startsWith("[2:") && /demo_live/.test(l)), "nothing admitted: two's log did not move, no host line per beat or per read");

  // ------------------------------------------------ two's own beacon on the topic, in its own set
  await emit(r2, "two", id2, "live-b", { event: "beacon", topic: "demo_live", every: 1000, body: new TextEncoder().encode("live-b lives") });
  const own = await until("two's own beat in its set", async () => (await beatsOf(id2))[0], 3000).catch(() => undefined);
  check(!!own && own.from === idOf("two") && Buffer.from(own.body, "base64").toString() === "live-b lives", `two's own beacon on demo_live appears in its own set (from: two's peer ID): ${JSON.stringify(own)}`);

  // ------------------------------------------------ a frame whose signature is not its sender's: never in the set
  const third = Uint8Array.from(Buffer.from(signer.identity("mallory"), "hex"));
  const good = dagCbor.decode(await beaconFrame("demo_live", new TextEncoder().encode("forged"), Date.now(), third, async (d) => {
    const w = signer.wallet("one");
    return Uint8Array.from((await w.createSignature({ protocolID: SIGN_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...d] })).signature);
  })) as Record<string, unknown>;
  // What two's liveness tool judged (to see the forged frames did reach it).
  const judged: string[] = [];
  const live2 = r2.p2p!.live;
  const observe = live2.observe.bind(live2);
  live2.observe = (h, t, frame, from) => { const v = observe(h, t, frame, from); if (from === idOf("one")) judged.push(v); return v; };
  for (let i = 0; i < 3; i++) {
    await r1.p2p!.publish("one", "demo_live", dagCbor.encode({ ...good, at: Date.now() }));
    await sleep(400);
  }
  await sleep(800);
  const all = (await read()).json as Beat[];
  check(judged.includes("reject") && !all.some((b) => b.sender === signer.identity("mallory") || Buffer.from(b.body, "base64").toString() === "forged"), `a frame whose signature is not its sender's reaches two's tool, is rejected (${judged.filter((v) => v === "reject").length} rejected), and never appears (${all.map((b) => b.sender.slice(0, 8)).join(", ")})`);

  // ------------------------------------------------ the window: live-a stops, its entry drops
  await emit(r1, "one", id1, "live-a", { event: "unbeacon", topic: "demo_live" });
  const stopped = Date.now();
  const gone = await until("live-a's entry drops", async () => (await beatsOf(id1)).length === 0 || undefined, 6000).catch(() => undefined);
  check(!!gone && Date.now() - stopped < 5000 && (await beatsOf(id2)).length === 1, `after the window with no beats live-a's entry drops (${Date.now() - stopped} ms after its unbeacon; two's own stays)`);

  // ------------------------------------------------ unliveness and uninstall
  await emit(r2, "two", id2, "live-b", { event: "unliveness", topic: "demo_live" });
  r = await read();
  await until("two's node leaves demo_live", () => !listening().includes("demo_live") || undefined, 5000).catch(() => undefined);
  check(r.status === 404 && !listening().includes("demo_live"), `live-b's unliveness: the endpoint answers 404 (${r.status}), the node leaves the topic (${listening().join(", ") || "none"})`);
  await emit(r2, "two", id2, "live-b", { event: "liveness", topic: "demo_live", window: 3000 });
  await until("two's own beat again", async () => (await beatsOf(id2))[0], 4000).catch(() => undefined);
  check((await beatsOf(id2)).length === 1, "a liveness again: the set fills from the next beat");
  const u = await ownerCli({ home: home2, port: r2.port!, owner: ownerWallet, settled: () => r2.settled() }, ["uninstall", "live-b", "--instance", "two"]);
  await r2.settled();
  r = await read();
  check(u.code === 0 && r.status === 404, `live-b uninstalled: the endpoint answers 404 (${u.code} ${u.err.join(" ")}; ${r.status})`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await r1.stop();
  await r2.stop();
  hdb1.close();
  hdb2.close();
  if (store) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "two's store replays to itself exactly (the liveness records, with their app)");
  }
}
if (process.env.KEEP) process.stdout.write(`kept ${root}\n`); else rmSync(root, { recursive: true, force: true });
process.stdout.write(failures ? `liveness: ${failures} FAILED\n` : "liveness: all ok\n");
process.exit(failures ? 1 : 0);
