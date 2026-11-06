// The host's own calls (0.3.1: the open-exchange host relays a swap itself; the instance logs facts,
// never attempts): `P2PHost.call` — one frame to a peer on a protocol, the one answer frame back, on a
// live stream with no timer; a dial refused, a protocol not served, a stream closed without a frame
// throw at once; the caller's AbortSignal cancels (nothing written once it fired, an open stream
// closed). The answering host writes a stream frame's answer whenever its thread rests (no "not
// answered in time" past its answer wait). `Router.p2pInbound` hands a frame to an instance on this
// host as a peer's would arrive; `Router.signMessage` signs a mail record with an instance's key.
// Nothing of a call is logged by the caller. Under the native kernel and the wasm kernel; both
// stores replay exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { lpStream } from "@libp2p/utils";
import { encode } from "../runtime/cid.ts";
import { rawCid } from "../runtime/programs.ts";
import { program } from "../runtime/records.ts";
import { HostDb } from "./instances.ts";
import { Signer } from "./signer.ts";
import { peerIdOf } from "./p2p.ts";
import { Router } from "./router.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO_WASM = join(ROOT, "kernel-zig/test/p2p/p2p-demo.wasm");
const DEMO_BYTES = readFileSync(DEMO_WASM);
const DEMO = program({
  name: "p2p-demo",
  code: { wasm: rawCid(DEMO_BYTES) },
  inputs: { message: "cid", body: "cid", box: "string", sender: "identity" },
  services: ["libp2p"],
  description: "#51's test program: publish, a stream round trip; topic, stream and slow handlers.",
});
const DEMO_CID = encode(DEMO).cid;
const ECHO = "/skein/echo/1", SLOW = "/skein/slow/1", HANGUP = "/skein/hangup/1", HOLD = "/skein/hold/1";
const KERNEL = join(ROOT, "kernel-zig/zig-out/bin/skein-kernel");
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 30_000): Promise<T> {
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

for (const under of ["native", "wasm"] as const) {
  test(`host call (${under} kernel): the frame and the proven peer; a late answer still written; dial refused, protocol not served, closed without a frame → thrown; a signal cancels; a local frame; a signed message; replay`, { timeout: 240_000 }, async (t) => {
    const home = mkdtempSync(join(tmpdir(), `skein-host-call-${under}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    process.env.SKEIN_EXTRA_MODULES = DEMO_WASM; // the native kernels install it (not pinned); the wasm kernel gets the block below
    const signer = new Signer(PrivateKey.fromHex("56".repeat(32)));
    const ownerId = new PrivateKey("2222", 16).toPublicKey().toString();
    const idA = peerIdOf(signer.peerKey("alpha")).toString(), idB = peerIdOf(signer.peerKey("beta")).toString();
    const [pa, pb] = [await freePort(), await freePort()];
    const lines: string[] = [];
    // The host's row names the SQLite database (the host adds the set: the handle); a reader names the set.
    const row = (h: string) => under === "wasm" ? `sqlite:${join(home, `${h}.sqlite`)}` : join(home, h, "runtime.db");
    const store = (h: string) => under === "wasm" ? `${row(h)}#${h}` : row(h);

    const mk = (handle: string, listen: string, bootstrap: string, genesis: ConstructorParameters<typeof Router>[0]["genesis"], answerWaitMs?: number) => {
      const db = new HostDb(join(home, `${handle}-host.db`));
      if (!db.get(handle)) db.add(handle, { store: row(handle) });
      const r = new Router({
        db, walletFor: (row) => signer.wallet(row.handle), peerKeyFor: (h) => signer.peerKey(h), providerKeyFor: (n) => signer.providerKey(n), home, owner: ownerId, idleMs: 0, ledgerMs: 200,
        ...(answerWaitMs ? { answerWaitMs } : {}),
        kernel: { command: KERNEL, env: { SKEIN_HOME: home } },
        libp2p: { listen: [listen], bootstrap: [bootstrap], dht: "off", relays: [], mdns: false }, libp2pDiscoveryMs: 300,
        genesis,
        log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
      });
      return { db, r };
    };
    const A = mk("alpha", `/ip4/127.0.0.1/tcp/${pa}`, `/ip4/127.0.0.1/tcp/${pb}/p2p/${idB}`, { libp2p: { topics: ["skein-test/call"] } });
    // Beta's answer wait is short (500 ms): its slow handler rests 3 s past it, and its answer is still written.
    const B = mk("beta", `/ip4/127.0.0.1/tcp/${pb}`, `/ip4/127.0.0.1/tcp/${pa}/p2p/${idA}`, {
      libp2p: { topics: ["skein-test/call"], protocols: { [ECHO]: { program: DEMO_CID.toString(), fn: "stream" }, [SLOW]: { program: DEMO_CID.toString(), fn: "slow" } } },
    }, 500);
    const stops: Array<() => Promise<void>> = [];
    t.after(async () => { for (const s of stops) await s().catch(() => {}); });
    stops.push(async () => { await B.r.stop(); B.db.close(); });
    stops.push(async () => { await A.r.stop(); A.db.close(); });

    await A.r.listen(0);
    const la = await A.r.hydrate("alpha"), lb = await B.r.hydrate("beta");
    for (const k of [lb.kernel]) { await k.putBlock(rawCid(DEMO_BYTES), DEMO_BYTES); await k.store.put(DEMO as never); }
    // Raw handlers on beta's node: one closes the stream without a frame, one reads and holds it (counting streams and frames).
    const nodeB = B.r.p2p!.node("beta")!;
    await nodeB.handle(HANGUP, (stream) => { void (async () => { await lpStream(stream).read().catch(() => {}); await stream.close().catch(() => {}); })(); });
    const hold = { streams: 0, frames: 0, ended: 0 };
    await nodeB.handle(HOLD, (stream) => {
      hold.streams++;
      void (async () => {
        const lp = lpStream(stream);
        try { for (;;) { await lp.read(); hold.frames++; } } catch { hold.ended++; }
      })();
    });
    await until(() => A.r.p2p!.node("alpha")!.getConnections().length > 0, "alpha and beta connected");
    const p2p = A.r.p2p!;
    const fromB = Buffer.from(peerIdOf(signer.peerKey("beta")).toMultihash().bytes).toString("hex");
    await A.r.settled();
    const tipA0 = (await la.kernel.store.log.tip())?.toString();

    // ------------------------------------------------ answered: the frame, and the peer the connection proved
    {
      const r = await p2p.call("alpha", idB, ECHO, bytes("hi"));
      assert.equal(text(r.body), "echo: hi");
      assert.equal(Buffer.from(r.from).toString("hex"), fromB, "from: the peer the connection proved");
    }

    // ------------------------------------------------ a late answer: beta's handler rests 3 s past its 500 ms answer wait
    {
      const t0 = Date.now();
      const r = await p2p.call("alpha", idB, SLOW, bytes(`slow ${Date.now() + 3500}`));
      assert.match(text(r.body), /^slow: slow \d+$/);
      assert.ok(Date.now() - t0 >= 3000, "answered after the handler's rest");
      assert.ok(!lines.some((l) => l.startsWith("[beta]") && /not answered in time/.test(l)), "beta never gave up on the frame");
    }

    // ------------------------------------------------ breaks, thrown at once: dial refused, protocol not served, closed without a frame
    const ghost = peerIdFromPrivateKey(await generateKeyPair("secp256k1")).toString();
    await assert.rejects(p2p.call("alpha", `/ip4/127.0.0.1/tcp/${await freePort()}/p2p/${ghost}`, ECHO, bytes("x")), /^Error: the dial was refused: /);
    await assert.rejects(p2p.call("alpha", idB, "/skein/nothing/1", bytes("x")), /^Error: the peer does not serve \/skein\/nothing\/1: /);
    await assert.rejects(p2p.call("alpha", idB, HANGUP, bytes("x")), /^Error: the stream closed without an answer: /);

    // ------------------------------------------------ the caller's signal: fired before → nothing dialled or written; fired on an open stream → closed
    {
      const c = new AbortController();
      c.abort(new Error("the page left"));
      await assert.rejects(p2p.call("alpha", idB, HOLD, bytes("never"), { signal: c.signal }), /^Error: the call was cancelled: the page left$/);
      await sleep(300);
      assert.deepEqual(hold, { streams: 0, frames: 0, ended: 0 }, "no stream opened, nothing written");
      const d = new AbortController();
      const p = p2p.call("alpha", idB, HOLD, bytes("held"), { signal: d.signal });
      await until(() => hold.frames === 1, "beta holds the written frame");
      d.abort(new Error("the page left"));
      await assert.rejects(p, /^Error: the call was cancelled: the page left$/);
      await until(() => hold.ended === 1, "the open stream closed on the peer's side");
      assert.equal(hold.streams, 1);
      // A dial in progress (an address that never answers): cancelled when the signal fires.
      const e = new AbortController();
      const t1 = Date.now();
      const q = p2p.call("alpha", `/ip4/10.255.255.1/tcp/4001/p2p/${ghost}`, ECHO, bytes("x"), { signal: e.signal });
      setTimeout(() => e.abort(new Error("the page left")), 300);
      await assert.rejects(q, /^Error: the call was cancelled: the page left$/);
      assert.ok(Date.now() - t1 < 3000, "the dial stopped at the signal");
    }

    // ------------------------------------------------ a frame handed to an instance on this host, as a peer's arrives
    {
      const a = await B.r.p2pInbound("beta", { transport: "libp2p", protocol: ECHO, from: peerIdOf(signer.peerKey("alpha")).toMultihash().bytes, body: bytes("local") });
      assert.equal(a.verdict, "accept");
      assert.equal(text(a.body!), "echo: local");
    }

    // ------------------------------------------------ a mail record signed with an instance's key by the host's key holder
    {
      const body = dagCbor.encode({ fn: "swap", args: { n: 1 } });
      const nonce = new Uint8Array(16).fill(7);
      const recipient = lb.identity;
      const { message, body: b } = await A.r.signMessage("alpha", { recipient, box: "swap", body, nonce });
      assert.deepEqual(b, body);
      assert.equal(Buffer.from(message.sender).toString("hex"), la.identity, "sender: the instance's identity");
      assert.equal(Buffer.from(message.recipient!).toString("hex"), recipient);
      assert.equal(message.box, "swap");
      assert.ok(message.body.equals(encode(dagCbor.decode(body)).cid), "body: the body's CID");
      assert.deepEqual(Uint8Array.from(message.nonce!), nonce);
      const { signature, ...unsigned } = message;
      const v = await new ProtoWallet("anyone").verifySignature({ protocolID: [2, "metanet handles envelope"], keyID: "send", counterparty: la.identity, data: [...dagCbor.encode(unsigned)], signature: [...signature!] });
      assert.equal(v.valid, true, "signed as every message is ([2, metanet handles envelope], send, anyone)");
      await assert.rejects(A.r.signMessage("alpha", { box: "x", body: new Uint8Array([0xff]) }), /not dag-cbor/);
    }

    // ------------------------------------------------ the caller logged nothing for any of it
    await A.r.settled();
    assert.equal((await la.kernel.store.log.tip())?.toString(), tipA0, "alpha's log unchanged by its calls");

    // ------------------------------------------------ replay, no router, no network
    await A.r.settled();
    await B.r.settled();
    for (const s of stops) await s();
    stops.length = 0;
    if (under === "native") {
      const replays = join(ROOT, "kernel-zig/equiv/replays.ts");
      for (const h of ["alpha", "beta"]) {
        const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", replays, store(h)], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL: KERNEL } });
        assert.equal(r.status, 0, `${h} replays: ${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /the source store reproduced exactly/, `${h}: ${r.stdout}`);
      }
    }
  });
}
