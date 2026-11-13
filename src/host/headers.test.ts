// The host's headers (skein next, SPEC 8) with the real wasm kernel over the host's SQLite database: ONE
// intake (Router.takeHeaders) validates and updates the host chain once, whatever the number of instances,
// and each instance whose table takes events in box `chain` gets the pointer event {kind: "chain", root,
// height}; an instance is told the chain inside its load, so an event admitted right after a create lands
// after the pointer event in its log (the race Open Exchange's feedDeploy worked around); an app taking
// `chain` installed into a running instance gets the pointer event at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import { mineHeader, REGTEST_GENESIS } from "./fake-teranode.ts";
import type { KernelSurface } from "./kernel.ts";
import { imageTree, NEXT_APP, testHost, until } from "./testhost.ts";
import { KERNEL_WASM, WasmHost } from "./wasm-kernel.ts";

const skip = !existsSync(KERNEL_WASM) && "the wasm kernel not built";
const regtest = { genesis: { defaults: { walletNetwork: "regtest" } } };
const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();

/** A regtest chain of `n` headers (the genesis header first). */
function chainOf(n: number): Uint8Array[] {
  const out: Uint8Array[] = [REGTEST_GENESIS];
  while (out.length < n) out.push(mineHeader(sha256d(out.at(-1)!), out.length));
  return out;
}

/** The default image with the test app, and root's rows taking the events `chain` and `x` (its handler `event`). */
const chainTree = (dir: string) => imageTree(dir, {
  apps: [NEXT_APP],
  appRoutes: [{ kind: "event", name: "chain", handler: "next.main.event" }, { kind: "event", name: "x", handler: "next.main.event" }],
});

/** The instance's log after the genesis: each entry's box (an event's) or "request", and a chain event's height. */
async function logOf(k: KernelSurface): Promise<Array<{ box: string; height?: number }>> {
  const out: Array<{ box: string; height?: number }> = [];
  for (let c = await k.store.log.tip(); c;) {
    const e = await k.store.get(c) as unknown as { prev?: CID; genesis?: CID; name?: string; event?: CID };
    if (!e.genesis) {
      const ev = e.event ? await k.store.get(e.event) as unknown as { kind?: string; height?: number } : undefined;
      out.unshift({ box: e.name ?? "request", ...(ev?.kind === "chain" ? { height: ev.height } : {}) });
    }
    c = e.prev;
  }
  return out;
}
const chainEvents = async (k: KernelSurface) => (await logOf(k)).filter((x) => x.box === "chain");

test("headers (SPEC 8): one intake updates the host chain once for N instances; each instance taking `chain` gets one pointer event per change, the others none", { skip, timeout: 180_000 }, async (t) => {
  const h = await testHost(t, { sqlite: true, ...regtest });
  const tree = await chainTree(join(h.home, "tree-chain"));
  await h.instance("a", tree);
  await h.instance("b", tree);
  await h.instance("c"); // the default image: no row takes box `chain`
  await h.router.start();
  const frames: number[] = [];
  const headers = WasmHost.prototype.chainHeaders;
  WasmHost.prototype.chainHeaders = function (raws: Uint8Array[]) { frames.push(raws.length); return headers.call(this, raws); };
  t.after(() => { WasmHost.prototype.chainHeaders = headers; });
  const chain = chainOf(6);

  await h.router.takeHeaders(chain.slice(0, 4), 0);
  await h.router.settled();
  assert.deepEqual(frames, [4], "one `headers` frame for the run — the host chain written once, not per instance");
  assert.equal((await h.router.hostChainTips())[0]?.tip?.height, 3);
  const k = async (x: string) => (await h.router.hydrate(x)).kernel;
  await until("a and b told", async () => ((await chainEvents(await k("a"))).length === 1 && (await chainEvents(await k("b"))).length === 1) || undefined);
  assert.deepEqual(await chainEvents(await k("a")), [{ box: "chain", height: 3 }]);
  assert.deepEqual(await chainEvents(await k("b")), [{ box: "chain", height: 3 }]);
  assert.deepEqual(await chainEvents(await k("c")), [], "c takes no `chain` events: none sent");

  // The next header: one frame more, one pointer event more each.
  await h.router.takeHeaders(chain.slice(4, 5), 4);
  await h.router.settled();
  assert.deepEqual(frames, [4, 1]);
  await until("a and b told again", async () => ((await chainEvents(await k("a"))).length === 2 && (await chainEvents(await k("b"))).length === 2) || undefined);
  assert.deepEqual((await chainEvents(await k("a"))).map((x) => x.height), [3, 4]);
  // The same run again (the host chain unchanged): nothing new sent.
  await h.router.takeHeaders(chain.slice(4, 5), 4);
  await h.router.settled();
  assert.equal((await chainEvents(await k("a"))).length, 2, "an unchanged host chain record is not sent again");
});

test("headers (SPEC 8): the first pointer event is in the log inside the load — an event admitted right after a create lands after it, with no wait and no retry", { skip, timeout: 180_000 }, async (t) => {
  const h = await testHost(t, { sqlite: true, ...regtest });
  await h.router.start();
  await h.router.takeHeaders(chainOf(3), 0);
  const images = join(h.home, "images");
  await chainTree(join(images, "chainy"));
  h.router.o.imagesDir = images;
  // What Open Exchange's feedDeploy does, without its chainBirth/queues reach-ins and its 3-try retry.
  await h.router.createInstance("tok", h.ownerId, { image: "chainy", owned: true });
  await h.router.admitEvent("tok", "x", { kind: "deploy", n: 1 });
  await h.router.settled();
  const log = await logOf((await h.router.hydrate("tok")).kernel);
  assert.deepEqual(log.slice(0, 2), [{ box: "chain", height: 2 }, { box: "x" }], `the pointer event first, then the deploy: ${JSON.stringify(log)}`);
  assert.equal(log.filter((x) => x.box === "chain").length, 1, "told once");
});

test("headers (SPEC 8): an app taking `chain` installed into a running instance gets the pointer event at once", { skip, timeout: 180_000 }, async (t) => {
  const h = await testHost(t, { sqlite: true, ...regtest });
  await h.instance("d", await imageTree(join(h.home, "img"), { apps: [NEXT_APP] }));
  await h.router.start();
  await h.router.takeHeaders(chainOf(2), 0);
  await h.router.settled();
  const k = (await h.router.hydrate("d")).kernel;
  assert.deepEqual(await chainEvents(k), [], "no row takes `chain` yet");
  // Root's row (`skein routes add`): an event row taking `chain`, its handler the installed app's.
  await h.request("d", "POST", "/kernel/route", { op: "add", row: { kind: "event", name: "chain", handler: "next.main.event" } });
  await until("the install event", async () => { await h.router.settled(); return (await chainEvents(k)).length === 1 || undefined; });
  assert.deepEqual(await chainEvents(k), [{ box: "chain", height: 1 }]);
});

test("headers (SPEC 8): an HTTP source alone (SKEIN_HEADERS_URL) — the history fill at start, then each streamed header: the host chain written once per header, each instance its pointer event; a gap filled from the history", { skip, timeout: 180_000 }, async (t) => {
  const { createServer } = await import("node:http");
  const chain = chainOf(8);
  let served = 3; // what the history endpoint offers: the first `served` headers
  const conns: Array<import("node:http").ServerResponse> = [];
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    asked.push(`${u.pathname}${u.search}`);
    if (u.pathname.endsWith("/tip/stream")) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": hello\n\n"); conns.push(res); return; }
    if (u.pathname.endsWith("/headers")) {
      const from = Number(u.searchParams.get("height")), n = Number(u.searchParams.get("count"));
      return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.concat(chain.slice(from, Math.min(served, from + n))));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { for (const c of conns) c.end(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/chaintracks/v2/tip/stream`;

  const h = await testHost(t, { sqlite: true, ...regtest, headersUrl: url });
  const tree = await chainTree(join(h.home, "tree-chain"));
  await h.instance("a", tree);
  await h.instance("b", tree);
  const frames: number[] = [];
  const headers = WasmHost.prototype.chainHeaders;
  WasmHost.prototype.chainHeaders = function (raws: Uint8Array[]) { frames.push(raws.length); return headers.call(this, raws); };
  t.after(() => { WasmHost.prototype.chainHeaders = headers; });
  await h.router.start();
  const tip = async () => (await h.router.hostChainTips())[0]?.tip?.height;
  const k = async (x: string) => (await h.router.hydrate(x)).kernel;
  const heights = async (x: string) => (await chainEvents(await k(x))).map((e) => e.height);

  // The history fill, before the instances: one run, then each instance told inside its load.
  assert.equal(await tip(), 2);
  assert.deepEqual(frames, [3], "the history: one `headers` frame");
  assert.ok(asked.includes("/chaintracks/v2/headers?height=0&count=100800"), asked.join(" "));
  assert.deepEqual(await heights("a"), [2]);
  assert.deepEqual(await heights("b"), [2]);

  // The stream: a header as hex, then one as chaintracks' JSON fields.
  await until("subscribed", () => conns[0]);
  const display = (b: Uint8Array) => Buffer.from(b).reverse().toString("hex");
  conns[0]!.write(`data: ${Buffer.from(chain[3]!).toString("hex")}\n\n`);
  await until("3 held", async () => (await tip()) === 3 || undefined);
  const c4 = Buffer.from(chain[4]!);
  conns[0]!.write(`data: ${JSON.stringify({ version: c4.readInt32LE(0), previousHash: display(c4.subarray(4, 36)), merkleRoot: display(c4.subarray(36, 68)), time: c4.readUInt32LE(68), bits: c4.readUInt32LE(72), nonce: c4.readUInt32LE(76), height: 4, hash: display(sha256d(c4)) })}\n\n`);
  await until("4 held", async () => (await tip()) === 4 || undefined);
  await h.router.settled();
  assert.deepEqual(frames, [3, 1, 1], "each streamed header written once, whatever the number of instances");
  await until("a and b told", async () => ((await heights("a")).length === 3 && (await heights("b")).length === 3) || undefined);
  assert.deepEqual(await heights("a"), [2, 3, 4]);
  assert.deepEqual(await heights("b"), [2, 3, 4]);

  // A gap: 5 never streamed, 6 arrives — the history fills it in, through the same intake.
  served = 7;
  conns[0]!.write(`data: ${Buffer.from(chain[6]!).toString("hex")}\n\n`);
  await until("6 held", async () => (await tip()) === 6 || undefined);
  assert.equal(asked.filter((x) => x.startsWith("/chaintracks/v2/headers?")).length, 2, "the history asked again for the gap (from a little below the tip)");
  await h.router.settled();
  await until("a told 6", async () => (await heights("a")).at(-1) === 6 || undefined);
  assert.equal(h.router.headersSource!.stats.taken, 2);
});
