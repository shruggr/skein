// libp2p end to end (#51): two routers on scratch ports, one instance each
// (alpha on A, beta on B), both subscribed to one topic, loopback TCP, mDNS
// off, bootstrapping each other. A program in alpha (kernel-zig/test/p2p/
// p2p-demo.wasm) publishes by a message to its libp2p provider (#70); beta's host
// appends each message as received (#68), and its front door, stepped on it,
// verifies the GossipSub signature; its route handler judges. The accepted
// message's entry carries from/seqno/topic/signature and the body —
// re-verified here from the entry alone. A rejected (or ignored) message is
// an entry too, its refusal recorded on its thread, nothing else changed; a
// redelivered accepted one is ignored (the kernel's `unique` map holds it). A
// stream round trip alpha → beta → alpha: dial and send are messages to the
// provider, and the frame comes back as an entry (#67). Each request's fuel on its thread's update. Then both stores
// replayed with no router and no network: identical.

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
import { Signer } from "./signer.ts";
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

test("libp2p across two routers: publish → validate → admit (re-verifiable), reject recorded, a stream round trip whose frame arrives as an entry, fuel on the updates, replay with no network", { timeout: 180_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "skein-p2p-router-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SKEIN_EXTRA_MODULES = DEMO_WASM; // the kernels install it (not pinned)
  const kernel = join(ROOT, "kernel-zig/zig-out/bin/skein-kernel");
  const signer = new Signer(PrivateKey.fromHex("55".repeat(32)));
  const ownerKey = new PrivateKey("2222", 16);
  const ownerId = ownerKey.toPublicKey().toString();
  const [pa, pb] = [await freePort(), await freePort()];
  const idA = peerIdOf(signer.peerKey("alpha")).toString(), idB = peerIdOf(signer.peerKey("beta")).toString();
  const lines: string[] = [];

  const mk = (handle: string, listen: string, bootstrap: string, genesis: ConstructorParameters<typeof Router>[0]["genesis"]) => {
    const db = new HostDb(join(home, `${handle}-host.db`));
    db.add(handle, { store: join(home, handle, "runtime.db") });
    const r = new Router({
      db, walletFor: (row) => signer.wallet(row.handle), peerKeyFor: (h) => signer.peerKey(h), providerKeyFor: (n) => signer.providerKey(n), home, owner: ownerId, idleMs: 0, ledgerMs: 200,
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
  const g = await lb.kernel.genesis() as { libp2p?: unknown; dispatch?: Array<{ transport: string; address: string; fn?: string }> };
  assert.deepEqual(g.libp2p, { topics: [TOPIC], protocols: [PROTOCOL] }, "the genesis carries the libp2p config");
  assert.ok(g.dispatch?.some((r) => r.transport === "libp2p" && r.address === PROTOCOL && r.fn === "stream") && g.dispatch?.some((r) => r.transport === "libp2p" && r.address === TOPIC), "libp2p rows (#77)");

  const pubsub = (r: Router, h: string) => (r.p2p!.node(h)!.services as { pubsub: { getSubscribers(t: string): unknown[] } }).pubsub;
  await until(() => pubsub(A.r, "alpha").getSubscribers(TOPIC).length > 0 && pubsub(B.r, "beta").getSubscribers(TOPIC).length > 0, "the two nodes see each other on the topic");

  const box = new RawBox(ephemeralWallet(ownerKey), `http://127.0.0.1:${A.r.port}/@alpha`);
  const send = (body: Record<string, unknown>) => box.send(la.identity, "p2p", body);
  // Beta's verdicts, as the router hands them back to GossipSub (or the stream): wrapped.
  const verdicts: Array<{ call: { topic?: string; protocol?: string; body: Uint8Array }; verdict: string; reason?: string }> = [];
  const inbound = B.r.p2pInbound.bind(B.r);
  B.r.p2pInbound = async (h, call) => { const a = await inbound(h, call); verdicts.push({ call, verdict: a.verdict, reason: a.reason }); return a; };
  const accepted = () => verdicts.filter((v) => v.call.topic === TOPIC && v.verdict === "accept");
  // #68: every message beta was handed is a request entry, the message as received.
  type P2PRecord = { kind: string; topic: string; from: Uint8Array; seqno: Uint8Array; signature: Uint8Array; body: Uint8Array };
  const topicRequests = async () => {
    const out: Array<{ cid: CID; rec: P2PRecord }> = [];
    for (const x of await logOf(lb.kernel)) {
      const e = x.e as Entry & { request?: CID; transport?: string };
      if (e.transport !== "libp2p" || !e.request) continue;
      const rec = await lb.kernel.store.get(e.request) as unknown as P2PRecord;
      if (rec.kind === "p2p") out.push({ cid: x.cid, rec });
    }
    return out;
  };

  // ------------------------------------------------ publish → validate → admit
  await send({ op: "publish", topic: TOPIC, text: "hello" });
  await until(() => accepted().length > 0, "beta accepts the message");
  const [admitted] = await topicRequests();
  const ev = admitted!.rec;
  assert.equal(ev.kind, "p2p");
  assert.equal(ev.topic, TOPIC);
  assert.equal(new TextDecoder().decode(ev.body), "hello");
  assert.equal(peerIdFromMultihash(Digest.decode(ev.from)).toString(), idA, "from: alpha's peer ID");
  assert.equal(keyOfPeerId(ev.from), signer.peerKey("alpha").toPublicKey().toString(), "the publisher's key, out of the entry");
  assert.equal(ev.seqno.length, 8);
  assert.ok(await reverify(ev), "the entry re-verifies from the log alone (GossipSub's signature over topic, seqno, from, body)");
  assert.ok(!(await reverify({ ...ev, body: new TextEncoder().encode("hellp") })), "and a changed body does not");

  // alpha's publish thread (#70): step 1 emits to the libp2p provider and waits; its answer steps it (checked below).
  await until(() => lines.some((l) => l.startsWith("[alpha]") && /p2p-demo step 2 → finished/.test(l)), "alpha's publish thread, stepped by the provider's answer");

  // ------------------------------------------------ reject and ignore: recorded, nothing else changed
  await B.r.settled();
  const n0 = (await logOf(lb.kernel)).length;
  await send({ op: "publish", topic: TOPIC, text: "bad message" });
  await send({ op: "publish", topic: TOPIC, text: "skip this" });
  await until(() => verdicts.some((v) => v.verdict === "reject") && verdicts.some((v) => v.verdict === "ignore"), "beta rejects one and ignores the other");
  await B.r.settled();
  const n1 = (await logOf(lb.kernel)).length;
  assert.equal(n1, n0 + 2, "each is an entry (the message as received), its refusal recorded on its thread");
  assert.equal(accepted().length, 1, "only the first accepted");

  // ------------------------------------------------ a redelivered message: recorded, ignored (#42/#51)
  // GossipSub delivers "hello" again (after its seen-cache expired, say): the same message record, which
  // the kernel's `unique` map holds from the accept — the front door's step sees it (`seen`) and answers
  // ignore (no forward, no penalty); nothing runs for it.
  const redelivered = await B.r.p2pInbound("beta", { transport: "libp2p", topic: TOPIC, from: ev.from, seqno: ev.seqno, signature: ev.signature, body: ev.body });
  await B.r.settled();
  assert.equal(redelivered.verdict, "ignore", `a redelivery is ignore toward GossipSub (${JSON.stringify(redelivered)})`);
  assert.equal(redelivered.reason, "already admitted");
  assert.equal((await logOf(lb.kernel)).length, n1 + 1, "one entry: the redelivery as received");
  assert.equal(accepted().length, 1, "accepted once");

  // ------------------------------------------------ a stream round trip: dial, send, the frame arrives as an entry (#67)
  await send({ op: "echo", peer: idB, protocol: PROTOCOL, text: "ping" });
  await until(() => lines.some((l) => l.startsWith("[alpha]") && / message \S+ in frame from \S+: reply to /.test(l)), "the echo's frame arrives at alpha as a reply to its dial");
  assert.ok(verdicts.some((v) => v.call.protocol === PROTOCOL), "the frame went through beta's front door");

  // ------------------------------------------------ fuel: on each request thread's updates (#68), not a ledger
  await B.r.settled();
  {
    const { openStoreFile } = await import("../runtime/index-store.ts");
    const { collect } = await import("../testkit.ts");
    const view = openStoreFile(join(home, "beta", "runtime.db"), { readOnly: true });
    try {
      let requests = 0;
      for (const th of await collect(view.edges.query({ kind: "thread" }))) {
        const o = await view.get(th) as { args?: { transport?: string } };
        if (o.args?.transport !== "libp2p") continue;
        requests++;
        const ups = (await collect(view.chains.history(th))).slice(1);
        const last = await view.get(ups.at(-1)!) as unknown as { state: string; fuel: number };
        assert.ok(last.state === "finished" && last.fuel > 0, `a libp2p request's thread ends finished, its fuel on its update (${JSON.stringify(last)})`);
      }
      assert.ok(requests >= 5, `one thread per message and frame (${requests})`);
    } finally { view.close?.(); }
  }

  // alpha's updates (#70): what each step emitted (the messages to the libp2p provider), and its stdout.
  const readUpdates = async () => {
    const { openStoreFile } = await import("../runtime/index-store.ts");
    const { collect } = await import("../testkit.ts");
    const view = openStoreFile(join(home, "alpha", "runtime.db"), { readOnly: true });
    try {
      const out: Array<{ thread: string; state: string; emitted: Array<{ box: string; body: Record<string, unknown> }>; stdout: string }> = [];
      for (const th of await collect(view.edges.query({ kind: "thread", program: DEMO_CID }))) {
        for (const u of (await collect(view.chains.history(th))).slice(1)) {
          const up = await view.get(u) as { state: string; emitted?: CID[]; result?: { stdout: Uint8Array } };
          const emitted = [];
          for (const c of up.emitted ?? []) {
            const m = await view.get(c) as unknown as { box: string; body: CID };
            emitted.push({ box: m.box, body: await view.get(m.body) as unknown as Record<string, unknown> });
          }
          out.push({ thread: th.toString(), state: up.state, emitted, stdout: Buffer.from(up.result?.stdout ?? []).toString() });
        }
      }
      return out;
    } finally { view.close?.(); }
  };
  await A.r.settled();
  await until(async () => (await readUpdates()).some((u) => u.stdout.startsWith("reply ")), "the echo thread finishes");
  const ups = await readUpdates();
  const pub = ups.find((u) => u.emitted[0]?.box === "publish" && new TextDecoder().decode(u.emitted[0].body.body as Uint8Array) === "hello");
  assert.ok(pub, "the publish is a message to the libp2p provider, on its step's update");
  assert.equal(pub!.emitted[0]!.body.topic, TOPIC);
  assert.equal(pub!.state, "waiting", "the publishing step waits on the answer");
  const published = ups.find((u) => u.thread === pub!.thread && u.stdout.startsWith("published "));
  assert.equal(published?.stdout, `published ${Buffer.from(ev.seqno).toString("hex")}\n`, "the provider's answer: the admitted message's seqno");
  const reply = ups.find((u) => u.stdout.startsWith("reply "));
  assert.equal(reply?.stdout, "reply echo: ping\n", "the reply, the frame that arrived as an entry");
  assert.deepEqual(reply!.emitted.map((e) => e.box), ["close"]);
  const echo = ups.filter((u) => u.thread === reply!.thread);
  assert.deepEqual(echo[0]!.emitted.map((e) => e.box), ["dial"], "the echo's first step dials");
  assert.ok(echo.some((u) => u.emitted.some((e) => e.box === "send")), "and, on the dial's answer, sends");

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
