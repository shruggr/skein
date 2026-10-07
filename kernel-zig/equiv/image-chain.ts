// The image carries the header chain (#132), end to end on regtest: a fake
// chaintracks (its history, `/headers?height=&count=`, and its tip stream,
// SSE) serves N mined headers before the host starts; the host builds the
// default image's chain part from its history at start (from genesis), then
// grows it with the M headers its stream brings — all before any skein exists.
// Then:
//
//   - a skein created from the default image (the instance manager's
//     create, claimed by its owner's signed claim) boots from the image as it
//     stands: its tree carries chain/headers and chain/tip (N + M);
//   - its owner installs the chain app (shruggr/skein-chain at the pinned
//     commit, or $SKEIN_CHAIN_DIR); the next header the stream brings is the
//     first header event the skein ever takes, and its chain state then
//     holds the whole chain from genesis — every one of the N + M headers it
//     was never fed, and the new one (no feed replay);
//   - `skein-host add --image default` boots from the same image;
//   - the skein's store replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/image-chain.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { CID as Cid, type CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { signClaim } from "../../src/client/raw.ts";
import { main } from "../../src/host/cli.ts";
import { headerProblem } from "../../src/host/image-chain.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { ownerCli } from "../../src/testapps.ts";
import { readLog } from "../../src/runtime/log.ts";
import { parseTree } from "../../src/runtime/tree.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";

const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "01e68b4f814d1293016ff5002782af48a439bb43";
const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- regtest

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");
const REGTEST_GENESIS = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000", "hex");
function mine(prev: Uint8Array, n: number): Buffer {
  const h = Buffer.alloc(80);
  h.writeInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  sha256d(Buffer.from(`block ${n}`)).copy(h, 36);
  h.writeUInt32LE(1_790_300_000 + n * 600, 68);
  h.writeUInt32LE(0x207fffff, 72);
  for (let nonce = 0; ; nonce++) { h.writeUInt32LE(nonce, 76); if (!headerProblem(h)) return h; }
}
const chain: Buffer[] = [REGTEST_GENESIS];
const mineTo = (height: number) => { while (chain.length <= height) chain.push(mine(sha256d(chain.at(-1)!), chain.length)); };

// ---------------------------------------------------------------- a fake chaintracks: history and tip stream

const streams = new Set<ServerResponse>();
const asked: string[] = [];
const ct = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname === "/chaintracks/v2/headers") {
    asked.push(u.search);
    const h = Number(u.searchParams.get("height")), c = Number(u.searchParams.get("count"));
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.concat(chain.slice(h, h + c)));
  } else if (u.pathname === "/chaintracks/v2/tip/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": hello\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
  } else res.writeHead(404).end();
});
await new Promise<void>((r) => ct.listen(0, "127.0.0.1", r));
const ctUrl = `http://127.0.0.1:${(ct.address() as { port: number }).port}/chaintracks/v2`;
/** Mine one and push it on the stream as chaintracks does (its JSON fields). */
function tipEvent(raw: Buffer, height: number) {
  const data = JSON.stringify({ version: raw.readInt32LE(0), previousHash: display(raw.subarray(4, 36)), merkleRoot: display(raw.subarray(36, 68)), time: raw.readUInt32LE(68), bits: raw.readUInt32LE(72), nonce: raw.readUInt32LE(76), height, hash: display(sha256d(raw)) });
  for (const s of streams) s.write(`data: ${data}\n\n`);
}

const N = 30, M = 20;
mineTo(N);
const afters: Array<() => unknown> = [];
const ownerKey = PrivateKey.fromRandom();
const h = await testHost({ after: (f) => afters.push(f) }, { ownerKey, genesis: { defaults: { walletNetwork: "regtest" } }, headersFeed: `${ctUrl}/tip/stream` });
let store = "";
try {
  // ------------------------------------------------ the host: history from genesis, then the stream
  await h.router.start();
  await h.router.image.ready;
  check(h.router.image.tip()?.height === N && asked[0] === "?height=0&count=100800", `at start the host built the image's chain from genesis out of the history: tip ${h.router.image.tip()?.height} (${asked.join(" ")})`);
  await until("the host on the tip stream", () => streams.size > 0 || undefined, 10_000);
  for (let i = 0; i < M; i++) { mineTo(N + 1 + i); tipEvent(chain.at(-1)!, N + 1 + i); }
  await until(`the image's chain at ${N + M}`, () => h.router.image.tip()?.height === N + M || undefined, 10_000);
  check(h.router.image.tip()?.hash === display(sha256d(chain[N + M]!)), `the stream grew it a header at a time: tip ${N + M} (${h.router.image.tip()?.hash.slice(0, 16)}…)`);

  // ------------------------------------------------ a skein from the image, born with the chain
  const ownerId = ownerKey.toPublicKey().toString();
  const c = await h.router.createInstance("alice", ownerId, { claim: await signClaim(h.owner) });
  check(!!c.identity, `created alice from the default image, claimed by her owner`);
  const k = async () => (await h.router.hydrate("alice")).kernel;
  const main_ = await (await k()).call("head", "main") as CID;
  check(main_.toString() === h.db.setting("image") && main_.toString() === h.db.get("alice")!.tree, `her tree is the image as it stood (host.db image ${String(h.db.setting("image")).slice(0, 16)}…)`);
  const view = openStoreFile(h.db.get("alice")!.store, { readOnly: true });
  const ls = async (cid: CID) => parseTree(await view.bytes(cid));
  const chainDir = (await ls(main_)).find((e) => e.name === "chain")!;
  const parts = await ls(chainDir.cid);
  const blocks = await ls(parts.find((e) => e.name === "headers")!.cid);
  const tipBlob = await view.bytes(parts.find((e) => e.name === "tip")!.cid);
  view.close();
  const tipJson = JSON.parse(Buffer.from(tipBlob.subarray(tipBlob.indexOf(0) + 1)).toString());
  check(blocks.map((e) => e.name).join(",") === "00000000" && tipJson.height === N + M && tipJson.hash === display(sha256d(chain[N + M]!)), `her store holds chain/headers (${blocks.map((e) => e.name).join(",")}) and chain/tip ${JSON.stringify(tipJson)}`);

  // ------------------------------------------------ the chain app installed; the next header its first
  const out: string[] = [], err: string[] = [];
  const spec = process.env.SKEIN_CHAIN_DIR ?? `${CHAIN_REPO}#${CHAIN_REV}`;
  const o = await ownerCli({ home: h.home, port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, ["install", spec, "--instance", "alice"]);
  out.push(...o.out); err.push(...o.err);
  await h.router.settled();
  check(o.code === 0, `the owner installs the chain app into alice: exit ${o.code} ${err.join(" ")}`);
  check(!(await (await k()).call("head", "chain/state")), "no chain state yet: no header has reached her");
  await until("alice on the host's headers feed", () => h.lines.some((l) => l.includes("alice: subscribed to the host's headers feed")) || undefined, 10_000);
  mineTo(N + M + 1);
  tipEvent(chain.at(-1)!, N + M + 1);
  await until("alice's chain state", async () => (await (await k()).call("head", "chain/state")) ?? undefined, 20_000);
  await h.router.settled();
  const kernel = await k();
  const stateCid = await kernel.call("head", "chain/state") as CID;
  const state = await kernel.store.get(stateCid) as { kind: string; network: string; maps: Record<string, CID | null> };
  // The best chain, read off the headers map (the kernel's Merkle search tree: [left, [[key, value, right] …]]).
  const entries: Array<[number, CID]> = [];
  const walk = async (node: CID | null) => {
    if (!node) return;
    const [left, es] = await kernel.store.get(node) as unknown as [CID | null, Array<[Uint8Array, CID, CID | null]>];
    await walk(left);
    for (const [key, value, right] of es) { entries.push([Buffer.from(key).readUInt32BE(0), value]); await walk(right); }
  };
  await walk(state.maps.headers ?? null);
  const want = chain.slice(0, N + M + 2);
  const same = entries.length === want.length && entries.every(([height, cid], i) => height === i && Buffer.from(cid.multihash.digest).equals(sha256d(want[i]!)));
  check(state.kind === "chain-state" && state.network === "regtest" && same, `her chain state holds the whole chain from genesis: heights 0…${entries.at(-1)?.[0]} (${entries.length} headers; the image's ${N + M + 1} and the stream's one)`);
  const view2 = openStoreFile(h.db.get("alice")!.store, { readOnly: true });
  const headerEvents = [];
  for (const { entry } of await readLog(view2)) {
    const ec = (entry as unknown as { event?: CID }).event;
    if (!ec) continue;
    const ev = await view2.get(ec).catch(() => undefined) as { kind?: string } | undefined;
    if (ev?.kind === "header") headerEvents.push(ev);
  }
  view2.close();
  check(headerEvents.length === 1, `no feed replay: the one header event in her log is the new tip's (${headerEvents.length})`);
  const blocksHeld = await Promise.all(chain.slice(0, N + M + 1).map((raw) => kernel.hasBlock(Cid.createV1(0xb0, Digest.create(0x56, sha256d(raw))))));
  check(blocksHeld.every(Boolean), "every header of the image is a bitcoin-block block in her store");

  // ------------------------------------------------ skein-host add --image default: the same image
  const outs: string[] = [], errs: string[] = [];
  const code = await main(["add", "fresh", "--image", "default"], { vars: { SKEIN_HOME: h.home, HOME: h.home }, out: (l) => outs.push(l), err: (l) => errs.push(l) });
  check(code === 0 && outs.some((l) => l.includes(`booted from the image ${h.db.setting("image")}`)), `skein-host add fresh --image default boots from the image as it stands: exit ${code} ${[...outs, ...errs].filter((l) => /booted|fresh/.test(l)).join(" ")}`);
  store = h.db.get("alice")!.store;
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  const [removeHome, ...rest] = afters;
  for (const f of rest.reverse()) await f();
  for (const s of streams) s.end();
  await new Promise((r) => ct.close(r));
  if (store) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "her store replays to itself exactly (the image's chain loaded again from the genesis's tree)");
  }
  if (!process.env.KEEP) await removeHome?.();
}

process.stdout.write(failures ? `image-chain: ${failures} FAILED\n` : "image-chain: all ok\n");
process.exit(failures ? 1 : 0);
