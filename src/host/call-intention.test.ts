// The `call` intention (the swap relay's call, 2026-11-06): a step emits {event: "call", peer,
// protocol, body} and rests; the HOST's libp2p node dials the peer on the protocol, writes the one
// frame, waits on the open stream for the one answer frame, closes, and answers the intention with a
// signed message from its libp2p provider {replyTo, request, from, body} | {replyTo, request, error},
// which steps the thread with `reply` (scheduler.zig intentionAnswer). One attempt, no timer: a dial
// refused, a protocol not served, a stream closed without a frame → {error} at once. The answering
// host writes a stream frame's answer whenever its thread rests (no "not answered in time" past its
// answer wait). A call still awaited at a host's start is answered "the host restarted" (nothing is
// sent again). Under the native kernel and the wasm kernel; both stores replay exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { lpStream } from "@libp2p/utils";
import type { CID } from "multiformats/cid";
import { RawBox } from "../client/raw.ts";
import { encode } from "../runtime/cid.ts";
import { rawCid } from "../runtime/programs.ts";
import { program } from "../runtime/records.ts";
import { ephemeralWallet } from "../wallet.ts";
import { HostDb } from "./instances.ts";
import { Signer } from "./signer.ts";
import { peerIdOf } from "./p2p.ts";
import { CALL_RESTARTED } from "./providers.ts";
import { Router } from "./router.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO_WASM = join(ROOT, "kernel-zig/test/p2p/p2p-demo.wasm");
const DEMO_BYTES = readFileSync(DEMO_WASM);
const DEMO = program({
  name: "p2p-demo",
  code: { wasm: rawCid(DEMO_BYTES) },
  inputs: { message: "cid", body: "cid", box: "string", sender: "identity" },
  services: ["libp2p"],
  description: "#51's test program: publish, a stream round trip, a call; topic, stream and slow handlers.",
});
const DEMO_CID = encode(DEMO).cid;
const ECHO = "/skein/echo/1", SLOW = "/skein/slow/1", HANGUP = "/skein/hangup/1", HOLD = "/skein/hold/1";
const KERNEL = join(ROOT, "kernel-zig/zig-out/bin/skein-kernel");

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
  test(`call intention (${under} kernel): answered with the frame and the proven peer; dial refused, protocol not served, closed without a frame → error; a late answer still written; a call awaited at a start → "${CALL_RESTARTED}"; replay`, { timeout: 240_000 }, async (t) => {
    const home = mkdtempSync(join(tmpdir(), `skein-call-intention-${under}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    process.env.SKEIN_EXTRA_MODULES = DEMO_WASM; // the native kernels install it (not pinned); the wasm kernel gets the block below
    const signer = new Signer(PrivateKey.fromHex("56".repeat(32)));
    const ownerKey = new PrivateKey("2222", 16);
    const ownerId = ownerKey.toPublicKey().toString();
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
    const genesisA = { subscriptions: [{ box: "p2p", handler: DEMO_CID }], libp2p: { topics: ["skein-test/call"] } };
    let A = mk("alpha", `/ip4/127.0.0.1/tcp/${pa}`, `/ip4/127.0.0.1/tcp/${pb}/p2p/${idB}`, genesisA);
    // Beta's answer wait is short (500 ms): its slow handler rests 3 s past it, and its answer is still written.
    const B = mk("beta", `/ip4/127.0.0.1/tcp/${pb}`, `/ip4/127.0.0.1/tcp/${pa}/p2p/${idA}`, {
      libp2p: { topics: ["skein-test/call"], protocols: { [ECHO]: { program: DEMO_CID.toString(), fn: "stream" }, [SLOW]: { program: DEMO_CID.toString(), fn: "slow" } } },
    }, 500);
    const stops: Array<() => Promise<void>> = [];
    t.after(async () => { for (const s of stops) await s().catch(() => {}); });
    stops.push(async () => { await B.r.stop(); B.db.close(); });
    let stopA = async () => { await A.r.stop(); A.db.close(); };
    stops.push(() => stopA());

    await A.r.listen(0);
    const la = await A.r.hydrate("alpha"), lb = await B.r.hydrate("beta");
    for (const k of [la.kernel, lb.kernel]) { await k.putBlock(rawCid(DEMO_BYTES), DEMO_BYTES); await k.store.put(DEMO as never); }
    // Two raw handlers on beta's node: one closes the stream without a frame, one reads and holds it.
    const nodeB = B.r.p2p!.node("beta")!;
    await nodeB.handle(HANGUP, (stream) => { void (async () => { await lpStream(stream).read().catch(() => {}); await stream.close().catch(() => {}); })(); });
    await nodeB.handle(HOLD, (stream) => { void lpStream(stream).read().catch(() => {}); });
    await until(() => A.r.p2p!.node("alpha")!.getConnections().length > 0, "alpha and beta connected");

    const box = () => new RawBox(ephemeralWallet(ownerKey), `http://127.0.0.1:${A.r.port}/@alpha`);
    let rb = box();
    const send = (body: Record<string, unknown>) => rb.send(la.identity, "p2p", body);
    /** The demo's updates in alpha's store: each step's state and stdout, and what it emitted. */
    const updates = async () => {
      const { openStoreFile } = await import("./stores.ts");
      const { collect } = await import("../testkit.ts");
      const view = openStoreFile(store("alpha"), { readOnly: true });
      try {
        const out: Array<{ thread: string; state: string; stdout: string; emitted: Array<Record<string, unknown>> }> = [];
        for (const th of await collect(view.edges.query({ kind: "thread", program: DEMO_CID }))) {
          for (const u of (await collect(view.chains.history(th))).slice(1)) {
            const up = await view.get(u) as { state: string; emitted?: CID[]; result?: { stdout: Uint8Array } };
            const emitted = [];
            for (const c of up.emitted ?? []) emitted.push(await view.get(c) as unknown as Record<string, unknown>);
            out.push({ thread: th.toString(), state: up.state, emitted, stdout: Buffer.from(up.result?.stdout ?? []).toString() });
          }
        }
        return out;
      } finally { view.close?.(); }
    };
    const outcome = async (prefix: RegExp, what: string) => (await until(async () => (await updates()).find((u) => prefix.test(u.stdout)), what)).stdout;
    const fromB = Buffer.from(peerIdOf(signer.peerKey("beta")).toMultihash().bytes).toString("hex");

    // ------------------------------------------------ answered: the frame, and the peer the connection proved
    await send({ op: "call", peer: idB, protocol: ECHO, text: "hi" });
    assert.equal(await outcome(/^called echo: hi /, "the echo call answered"), `called echo: hi from ${fromB}\n`);
    {
      const ups = await updates();
      const first = ups.find((u) => u.emitted.some((e) => e.event === "call" && new TextDecoder().decode(e.body as Uint8Array) === "hi"))!;
      assert.equal(first.state, "waiting", "the calling step rests on its intention");
      const ev = first.emitted.find((e) => e.event === "call")!;
      assert.deepEqual(Object.keys(ev).sort(), ["body", "event", "kind", "peer", "protocol", "step", "thread"], "the intention as recorded: peer, protocol, body, its thread and step");
    }

    // ------------------------------------------------ a late answer: beta's handler rests 3 s past its 500 ms answer wait
    const t0 = Date.now();
    const at = Date.now() + 3500;
    await send({ op: "call", peer: idB, protocol: SLOW, text: `slow ${at}` });
    assert.equal(await outcome(/^called slow: /, "the slow call answered"), `called slow: slow ${at} from ${fromB}\n`);
    assert.ok(Date.now() - t0 >= 3000, "answered after the handler's rest");
    assert.ok(!lines.some((l) => l.startsWith("[beta]") && /not answered in time/.test(l)), "beta never gave up on the frame");

    // ------------------------------------------------ errors, at once: dial refused, protocol not served, closed without a frame
    const ghost = peerIdFromPrivateKey(await generateKeyPair("secp256k1")).toString();
    await send({ op: "call", peer: `/ip4/127.0.0.1/tcp/${await freePort()}/p2p/${ghost}`, protocol: ECHO, text: "x" });
    assert.match(await outcome(/^call error the dial was refused/, "the refused dial answered"), /^call error the dial was refused: /);
    await send({ op: "call", peer: idB, protocol: "/skein/nothing/1", text: "x" });
    assert.match(await outcome(/^call error the peer does not serve/, "the unserved protocol answered"), /^call error the peer does not serve \/skein\/nothing\/1: /);
    await send({ op: "call", peer: idB, protocol: HANGUP, text: "x" });
    assert.match(await outcome(/^call error the stream closed without an answer/, "the hang-up answered"), /^call error the stream closed without an answer: /);

    // ------------------------------------------------ a call awaited at a start: answered "the host restarted", nothing sent again
    let held = 0;
    await nodeB.unhandle(HOLD);
    await nodeB.handle(HOLD, (stream) => { held++; void lpStream(stream).read().catch(() => {}); });
    await send({ op: "call", peer: idB, protocol: HOLD, text: "hold" });
    await until(() => held === 1, "beta holds the stream");
    await until(async () => (await updates()).some((u) => u.state === "waiting" && u.emitted.some((e) => e.event === "call" && e.protocol === HOLD)), "alpha's thread rests on the call");
    await A.r.settled();
    await stopA();
    A = mk("alpha", `/ip4/127.0.0.1/tcp/${await freePort()}`, `/ip4/127.0.0.1/tcp/${pb}/p2p/${idB}`, genesisA);
    stopA = async () => { await A.r.stop(); A.db.close(); };
    await A.r.listen(0);
    await A.r.hydrate("alpha");
    assert.equal(await outcome(new RegExp(`^call error ${CALL_RESTARTED}`), "the held call answered at the start"), `call error ${CALL_RESTARTED}\n`);
    await sleep(1000);
    assert.equal(held, 1, "nothing was sent again");
    rb = box();

    // ------------------------------------------------ replay, no router, no network
    await A.r.settled();
    await B.r.settled();
    await stopA();
    await B.r.stop(); B.db.close();
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
