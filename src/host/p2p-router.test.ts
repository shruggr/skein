// libp2p end to end (#51): two routers on scratch ports, one instance each
// (alpha on A, beta on B), both subscribed to one topic, loopback TCP, mDNS
// off, bootstrapping each other. A program in alpha (kernel-zig/test/p2p/
// p2p-demo.wasm) publishes through the kernel's `libp2p` import; beta's front
// door verifies the GossipSub signature, its route handler judges, and an
// accepted message is one `p2p` entry carrying from/seqno/topic/signature and
// the body — re-verified here from the entry alone. A rejected (or ignored)
// message writes nothing: beta's store byte-identical. A stream round trip
// alpha → beta → alpha, the `receive` resting and woken by the frame. The
// validator and stream calls' fuel in beta's ledger. Then both stores replayed
// with no router and no network: identical.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { peerIdFromMultihash } from "@libp2p/peer-id";
import * as Digest from "multiformats/hashes/digest";
import type { CID } from "multiformats/cid";
import { RawBox } from "../client/raw.ts";
import { encode } from "../runtime/cid.ts";
import { rawCid } from "../runtime/programs.ts";
import { program } from "../runtime/records.ts";
import { ephemeralWallet } from "../wallet.ts";
import { HostDb } from "./instances.ts";
import { Oracle } from "./oracle.ts";
import { keyOfPeerId, peerIdOf } from "./p2p.ts";
import { Router } from "./router.ts";
import type { Kernel } from "./kernel.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO_WASM = join(ROOT, "kernel-zig/test/p2p/p2p-demo.wasm");
const DEMO = program({
  name: "p2p-demo",
  code: { wasm: rawCid(readFileSync(DEMO_WASM)) },
  inputs: { message: "cid", body: "cid", box: "string", sender: "identity" },
  services: ["libp2p"],
  description: "#51's test program: publish, a stream round trip; topic and stream handlers.",
});
const DEMO_CID = encode(DEMO).cid;
const TOPIC = "skein-test/demo";
const PROTOCOL = "/skein/echo/1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

type Entry = { prev?: CID; n: number; event?: CID; box?: string; mail?: CID; wake?: CID };
/** The log, newest first, from the kernel (entries are records: walk `prev`). */
async function logOf(k: Kernel): Promise<Array<{ cid: CID; e: Entry }>> {
  const out: Array<{ cid: CID; e: Entry }> = [];
  let c = await k.store.log.tip();
  while (c) {
    const e = await k.store.get(c) as unknown as Entry;
    out.push({ cid: c, e });
    c = e.prev;
  }
  return out;
}

/** GossipSub's StrictSign check, from the entry alone: the key is in `from`. */
async function reverify(ev: { topic: string; from: Uint8Array; seqno: Uint8Array; signature: Uint8Array; body: Uint8Array }): Promise<boolean> {
  const pb: number[] = [];
  const field = (tag: number, b: Uint8Array) => {
    pb.push(tag);
    let n = b.length;
    while (n >= 0x80) { pb.push((n & 0x7f) | 0x80); n >>>= 7; }
    pb.push(n);
    pb.push(...b);
  };
  field(0x0a, ev.from);
  field(0x12, ev.body);
  field(0x1a, ev.seqno);
  field(0x22, new TextEncoder().encode(ev.topic));
  const signed = Uint8Array.from([...new TextEncoder().encode("libp2p-pubsub:"), ...pb]);
  const key = peerIdFromMultihash(Digest.decode(ev.from)).publicKey!;
  return await key.verify(signed, ev.signature);
}

test("libp2p across two routers: publish → validate → admit (re-verifiable), reject writes nothing, a stream round trip woken by its frame, fuel ledger, replay with no network", { timeout: 180_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "skein-p2p-router-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SKEIN_EXTRA_MODULES = DEMO_WASM; // the kernels install it (not pinned)
  const kernel = join(ROOT, "kernel-zig/zig-out/bin/skein-kernel");
  const oracle = new Oracle(PrivateKey.fromHex("55".repeat(32)));
  const ownerKey = new PrivateKey("2222", 16);
  const ownerId = ownerKey.toPublicKey().toString();
  const [pa, pb] = [await freePort(), await freePort()];
  const idA = peerIdOf(oracle.peerKey("alpha")).toString(), idB = peerIdOf(oracle.peerKey("beta")).toString();
  const lines: string[] = [];

  const mk = (handle: string, listen: string, bootstrap: string, genesis: ConstructorParameters<typeof Router>[0]["genesis"]) => {
    const db = new HostDb(join(home, `${handle}-host.db`));
    db.add(handle, { store: join(home, handle, "runtime.db") });
    const r = new Router({
      db, walletFor: (row) => oracle.wallet(row.handle), peerKeyFor: (h) => oracle.peerKey(h), home, owner: ownerId, idleMs: 0, ledgerMs: 200,
      kernel: { command: kernel, env: { SKEIN_HOME: home } },
      libp2p: { listen: [listen], bootstrap: [bootstrap], dht: "off", relays: [], mdns: false }, libp2pDiscoveryMs: 300,
      genesis,
      log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
    });
    return { db, r };
  };
  const A = mk("alpha", `/ip4/127.0.0.1/tcp/${pa}`, `/ip4/127.0.0.1/tcp/${pb}/p2p/${idB}`, {
    subscriptions: [{ box: "p2p", sender: ownerId, handler: DEMO_CID }],
    libp2p: { topics: [TOPIC] },
  });
  const B = mk("beta", `/ip4/127.0.0.1/tcp/${pb}`, `/ip4/127.0.0.1/tcp/${pa}/p2p/${idA}`, {
    libp2p: { topics: [TOPIC], protocols: { [PROTOCOL]: { program: DEMO_CID.toString(), fn: "stream" } } },
    routes: [{ path: `libp2p:${TOPIC}`, program: DEMO_CID.toString(), fn: "topic" }],
  });
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await Promise.all([A.r.stop(), B.r.stop()]); A.db.close(); B.db.close(); };
  t.after(stop);

  await A.r.listen(0);
  const la = await A.r.hydrate("alpha"), lb = await B.r.hydrate("beta");
  await la.kernel.store.put(DEMO as never);
  await lb.kernel.store.put(DEMO as never);
  assert.equal(A.r.p2p!.peerId("alpha"), idA);
  assert.equal(B.r.p2p!.node("beta")!.peerId.toString(), idB, "beta's node runs as its derived peer ID");
  const g = await lb.kernel.genesis() as { libp2p?: unknown; routes?: Array<{ path?: string; fn: string }> };
  assert.deepEqual(g.libp2p, { topics: [TOPIC], protocols: [PROTOCOL] }, "the genesis carries the libp2p config");
  assert.ok(g.routes?.some((r) => r.path === `libp2p:${PROTOCOL}` && r.fn === "stream") && g.routes?.some((r) => r.path === `libp2p:${TOPIC}`), "libp2p: route sources");

  const pubsub = (r: Router, h: string) => (r.p2p!.node(h)!.services as { pubsub: { getSubscribers(t: string): unknown[] } }).pubsub;
  await until(() => pubsub(A.r, "alpha").getSubscribers(TOPIC).length > 0 && pubsub(B.r, "beta").getSubscribers(TOPIC).length > 0, "the two nodes see each other on the topic");

  const box = new RawBox(ephemeralWallet(ownerKey), `http://127.0.0.1:${A.r.port}/@alpha`);
  const send = (body: Record<string, unknown>) => box.send(la.identity, "p2p", body);
  const p2pEntries = async () => (await logOf(lb.kernel)).filter((x) => x.e.box === `libp2p:${TOPIC}`);

  // ------------------------------------------------ publish → validate → admit
  await send({ op: "publish", topic: TOPIC, text: "hello" });
  const [admitted] = await until(async () => { const es = await p2pEntries(); return es.length ? es : undefined; }, "beta admits the message");
  const ev = await lb.kernel.store.get(admitted!.e.event!) as { kind: string; topic: string; from: Uint8Array; seqno: Uint8Array; signature: Uint8Array; body: Uint8Array };
  assert.equal(ev.kind, "p2p");
  assert.equal(ev.topic, TOPIC);
  assert.equal(new TextDecoder().decode(ev.body), "hello");
  assert.equal(peerIdFromMultihash(Digest.decode(ev.from)).toString(), idA, "from: alpha's peer ID");
  assert.equal(keyOfPeerId(ev.from), oracle.peerKey("alpha").toPublicKey().toString(), "the publisher's key, out of the entry");
  assert.equal(ev.seqno.length, 8);
  assert.ok(await reverify(ev), "the entry re-verifies from the log alone (GossipSub's signature over topic, seqno, from, body)");
  assert.ok(!(await reverify({ ...ev, body: new TextEncoder().encode("hellp") })), "and a changed body does not");

  // alpha's publish step: one recorded call (checked below, from its update).
  await until(() => lines.some((l) => l.startsWith("[alpha]") && /p2p-demo step 1 → finished · 1 attested/.test(l)), "alpha's publish step");

  // ------------------------------------------------ reject and ignore write nothing
  await B.r.settled();
  B.r.flushLedger();
  const dbB = join(home, "beta", "runtime.db");
  const bytes = () => [readFileSync(dbB), existsSync(`${dbB}-wal`) ? readFileSync(`${dbB}-wal`) : new Uint8Array()];
  const before = bytes();
  const tipBefore = (await lb.kernel.store.log.tip())!.toString();
  const verdicts = () => lines.filter((l) => l.startsWith("[beta]") && l.includes(`libp2p:${TOPIC} from ${idA}:`));
  await send({ op: "publish", topic: TOPIC, text: "bad message" });
  await send({ op: "publish", topic: TOPIC, text: "skip this" });
  await until(() => verdicts().some((l) => l.endsWith(": reject")) && verdicts().some((l) => l.endsWith(": ignore")), "beta rejects one and ignores the other");
  await B.r.settled();
  assert.equal((await lb.kernel.store.log.tip())!.toString(), tipBefore, "no entry");
  const after = bytes();
  assert.ok(Buffer.from(after[0]!).equals(Buffer.from(before[0]!)) && Buffer.from(after[1]!).equals(Buffer.from(before[1]!)), "beta's store (and its WAL) byte-identical");
  assert.equal((await p2pEntries()).length, 1);

  // ------------------------------------------------ a stream round trip, receive resting and woken
  await send({ op: "echo", peer: idB, protocol: PROTOCOL, text: "ping" });
  await until(() => lines.some((l) => l.startsWith("[alpha]") && /p2p-demo step \d → finished/.test(l) && !/step 1 → finished · 1 attested/.test(l)), "the echo thread finishes");
  const woke = lines.find((l) => l.startsWith("[alpha] libp2p: wake"));
  const echoSteps = lines.filter((l) => l.startsWith("[alpha]") && /p2p-demo step/.test(l));
  const echoThread = lines.find((l) => /^\[alpha\] \S+ p2p-demo step 2 → finished/.test(l));
  assert.ok(woke, `a frame woke the resting thread (${echoSteps.join(" | ")})`);
  assert.ok(echoThread, "the echo thread took two steps: rest on the stream, then the woken receive");
  assert.ok(lines.some((l) => /p2p-demo step 1 → waiting · 3 attested/.test(l)), "step 1: dial, send, a pending receive → waiting");

  // ------------------------------------------------ the fuel ledger
  B.r.flushLedger();
  const ledger = B.db.ledger("beta");
  const topicRow = ledger.find((x) => x.op === `libp2p:${TOPIC}`);
  const streamRow = ledger.find((x) => x.op === `libp2p:${PROTOCOL}`);
  assert.ok(topicRow && topicRow.caller === idA && topicRow.calls === 3 && topicRow.fuel > 0, `validator calls charged: ${JSON.stringify(topicRow)}`);
  assert.ok(streamRow && streamRow.caller === idA && streamRow.calls >= 1 && streamRow.fuel > 0, `stream calls charged: ${JSON.stringify(streamRow)}`);

  // alpha's updates: the recorded calls, and the reply on stdout.
  const readUpdates = async () => {
    const { openStoreFile } = await import("../runtime/index-store.ts");
    const { collect } = await import("../testkit.ts");
    const view = openStoreFile(join(home, "alpha", "runtime.db"), { readOnly: true });
    try {
      const out: Array<{ state: string; calls: Array<{ op: string; request: Record<string, unknown>; result: Record<string, unknown> }>; stdout: string }> = [];
      for (const th of await collect(view.edges.query({ kind: "thread", program: DEMO_CID }))) {
        for (const u of (await collect(view.chains.history(th))).slice(1)) {
          const up = await view.get(u) as { state: string; calls?: CID[]; result?: { stdout: Uint8Array } };
          const calls = [];
          for (const c of up.calls ?? []) {
            const rec = await view.get(c) as unknown as { op: string; request: Uint8Array; result: Uint8Array };
            calls.push({ op: rec.op, request: dagCbor.decode(rec.request) as Record<string, unknown>, result: dagCbor.decode(rec.result) as Record<string, unknown> });
          }
          out.push({ state: up.state, calls, stdout: Buffer.from(up.result?.stdout ?? []).toString() });
        }
      }
      return out;
    } finally { view.close?.(); }
  };
  await A.r.settled();
  const ups = await readUpdates();
  const pub = ups.find((u) => u.calls[0]?.request.op === "publish" && u.calls[0].request.body instanceof Uint8Array && new TextDecoder().decode(u.calls[0].request.body as Uint8Array) === "hello");
  assert.ok(pub, "the publish is recorded");
  assert.equal(pub!.calls[0]!.op, "libp2p");
  assert.equal(pub!.calls[0]!.request.topic, TOPIC);
  assert.equal(Buffer.from(pub!.calls[0]!.result.seqno as Uint8Array).toString("hex"), Buffer.from(ev.seqno).toString("hex"), "the recorded seqno is the admitted message's");
  const reply = ups.find((u) => u.stdout.startsWith("reply "));
  assert.equal(reply?.stdout, "reply echo: ping\n", "the reply, received on the woken step");
  assert.deepEqual(reply!.calls.map((c) => c.request.op), ["receive", "close"]);
  const rest = ups.find((u) => u.state === "waiting");
  assert.deepEqual(rest?.calls.map((c) => [c.request.op, Object.keys(c.result).join()]), [["dial", "stream"], ["send", ""], ["receive", "pending"]], "the resting step's calls, recorded");

  // ------------------------------------------------ replay, no router, no network
  await stop();
  const replays = join(ROOT, "kernel-zig/equiv/replays.ts");
  for (const h of ["alpha", "beta"]) {
    const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", replays, join(home, h, "runtime.db")], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL: kernel } });
    assert.equal(r.status, 0, `${h} replays: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /the source store reproduced exactly/, `${h}: ${r.stdout}`);
  }
  // kernel-zig/equiv/libp2p.ts keeps the stores (the browser build replays them, and refuses a live libp2p call).
  const keep = process.env.SKEIN_P2P_KEEP;
  if (keep) for (const h of ["alpha", "beta"]) {
    const db = join(home, h, "runtime.db");
    copyFileSync(db, join(keep, `${h}.db`));
    if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, join(keep, `${h}.db-wal`));
  }
});
