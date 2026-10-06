// The default image's chain part (#132, image-chain.ts) without a kernel:
// regtest headers mined here; filled from a fake chaintracks history from
// genesis, grown by the stream a header at a time (one block and the tip
// rewritten, the full blocks kept), a reorg near the tip, a gap filled from
// the history (or dropped with none); held in host.db across a restart; the
// boot source the static part with `chain/` beside it, every object there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirSource } from "./boot.ts";
import { blockName, headerProblem, historyOf, ImageChain, PER_BLOCK } from "./image-chain.ts";
import { HostDb } from "./instances.ts";
import { parseTree } from "../runtime/tree.ts";

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const REGTEST_GENESIS = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000", "hex");

function mine(prev: Uint8Array, salt: number): Buffer {
  const h = Buffer.alloc(80);
  h.writeUInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  sha256d(Buffer.from(`root ${salt}`)).copy(h, 36);
  h.writeUInt32LE(1_790_000_000 + salt, 68);
  h.writeUInt32LE(0x207fffff, 72);
  for (let n = 0; ; n++) { h.writeUInt32LE(n, 76); if (!headerProblem(h)) return h; }
}

/** A regtest chain: the genesis, then `n` more; `salt` makes a branch differ. */
function chain(n: number, from: Buffer[] = [REGTEST_GENESIS], salt = 0): Buffer[] {
  const out = [...from];
  while (out.length < from.length + n) out.push(mine(sha256d(out.at(-1)!), out.length + salt));
  return out;
}

const tmp = (t: { after(f: () => void): void }) => { const d = mkdtempSync(join(tmpdir(), "image-chain-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

/** A fake chaintracks /headers over `held` (height, count → raw bytes). */
function history(held: () => Buffer[]): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: (async (url: string) => {
      asked.push(url);
      const u = new URL(url);
      const h = Number(u.searchParams.get("height")), c = Number(u.searchParams.get("count"));
      return new Response(Buffer.concat(held().slice(h, h + c)));
    }) as typeof fetch,
  };
}

test("image chain: the history endpoint beside a chaintracks tip stream", () => {
  assert.equal(historyOf("http://127.0.0.1:8083/chaintracks/v2/tip/stream"), "http://127.0.0.1:8083/chaintracks/v2/headers");
  assert.equal(historyOf("http://x/sse"), undefined);
  assert.equal(historyOf(undefined), undefined);
  assert.equal(blockName(4032), "00004032");
});

test("image chain: filled from genesis, grown per header, a reorg, a gap, kept in host.db; the boot source", async (t) => {
  const dir = tmp(t);
  const db = new HostDb(join(dir, "host.db"));
  t.after(() => db.close());
  let held = chain(2 * PER_BLOCK + 10);
  const h = history(() => held);
  const lines: string[] = [];
  const ic = new ImageChain({ db, history: "http://ct/chaintracks/v2/headers", page: 1000, fetch: h.fetch, log: (l) => lines.push(l) });
  assert.equal(ic.tip(), undefined);
  await ic.start();
  assert.equal(ic.tip()?.height, held.length - 1, lines.join("\n"));
  assert.equal(ic.tip()?.hash, Buffer.from(sha256d(held.at(-1)!)).reverse().toString("hex"));
  assert.match(h.asked[0]!, /height=0&count=1000$/);

  const blocksOf = async () => {
    const src = await ic.source();
    assert.equal(src.kind, "tree");
    if (src.kind !== "tree") throw new Error();
    const root = parseTree((await src.objects.get(src.root))!);
    const ch = parseTree((await src.objects.get(root.find((e) => e.name === "chain")!.cid))!);
    const hd = parseTree((await src.objects.get(ch.find((e) => e.name === "headers")!.cid))!);
    const tip = (await src.objects.get(ch.find((e) => e.name === "tip")!.cid))!;
    const blocks = await Promise.all(hd.map(async (e) => { const o = (await src.objects.get(e.cid))!; return Buffer.from(o.subarray(o.indexOf(0) + 1)); }));
    return { root: src.root, rootNames: root.map((e) => e.name), names: hd.map((e) => e.name), cids: hd.map((e) => e.cid.toString()), blocks, tip: JSON.parse(Buffer.from(tip.subarray(tip.indexOf(0) + 1)).toString()) };
  };
  let b = await blocksOf();
  assert.deepEqual(b.names, ["00000000", "00002016", "00004032"]);
  assert.deepEqual(Buffer.concat(b.blocks), Buffer.concat(held));
  assert.deepEqual(b.tip, { height: held.length - 1, hash: ic.tip()!.hash });
  // The static part is there beside it.
  const stat = await dirSource(join(import.meta.dirname, "../../images/default"));
  const statNames = parseTree(await stat.objects.bytes(stat.root)).map((e) => e.name);
  assert.deepEqual(b.rootNames.filter((n) => n !== "chain"), statNames);
  assert.equal(db.setting("image"), b.root.toString());

  // The stream: one header at a time at the tip — the full blocks kept, only the last rewritten.
  const before = b;
  held = chain(1, held);
  await ic.headers([held.at(-1)!]);
  b = await blocksOf();
  assert.equal(b.tip.height, held.length - 1);
  assert.deepEqual(b.cids.slice(0, 2), before.cids.slice(0, 2));
  assert.notEqual(b.cids[2], before.cids[2]);
  assert.notEqual(b.root.toString(), before.root.toString());
  // The replaced objects are gone from host.db; the kept ones are not.
  assert.equal(db.imageBlock(before.cids[2]!), undefined);
  assert.equal(db.imageBlock(before.root.toString()), undefined);
  assert.ok(db.imageBlock(before.cids[0]!));
  // The same header again: nothing.
  await ic.headers([held.at(-1)!]);
  assert.equal((await blocksOf()).root.toString(), b.root.toString());

  // A reorg: a branch from 3 below the tip, longer by one; the stream brings its headers in order.
  const branch = chain(4, held.slice(0, held.length - 3), 7);
  for (const raw of branch.slice(held.length - 3)) await ic.headers([raw]);
  held = branch;
  b = await blocksOf();
  assert.deepEqual(Buffer.concat(b.blocks), Buffer.concat(held), "the branch replaced the chain from the fork");

  // A gap (the stream missed some): the history fills it in.
  held = chain(5, held);
  const asked = h.asked.length;
  await ic.headers([held.at(-1)!]);
  assert.equal(ic.tip()?.height, held.length - 1);
  assert.ok(h.asked.length > asked, "asked the history");

  // Crossing into a new block.
  held = chain(PER_BLOCK, held);
  await ic.sync();
  b = await blocksOf();
  assert.deepEqual(b.names, ["00000000", "00002016", "00004032", "00006048"]);
  assert.deepEqual(Buffer.concat(b.blocks), Buffer.concat(held));

  // A restart: the same chain from host.db, nothing fetched to know it.
  const ic2 = new ImageChain({ db });
  assert.deepEqual(ic2.tip(), ic.tip());
  assert.equal((await ic2.source()).kind === "tree" && (await ic2.source() as { root: { toString(): string } }).root.toString(), b.root.toString());
  // With no history, a header that links to nothing near the tip is dropped.
  const lines2: string[] = [];
  const ic3 = new ImageChain({ db, log: (l) => lines2.push(l) });
  await ic3.headers([mine(Buffer.alloc(32, 9), 1)]);
  assert.equal(ic3.tip()?.height, held.length - 1);
  assert.ok(lines2.some((l) => /no history to fill in from: dropped/.test(l)), lines2.join("\n"));
  // A header that misses its target is refused.
  const bad = Buffer.from(mine(sha256d(held.at(-1)!), 99));
  bad.writeUInt32LE(0, 72);
  await assert.rejects(ic3.put(held.length, [bad]), /unusable target/);
  await assert.rejects(ic3.put(held.length + 5, [mine(sha256d(held.at(-1)!), 1)]), /a gap/);
});

test("image chain: none held → the static image as before", async (t) => {
  const db = new HostDb(join(tmp(t), "host.db"));
  t.after(() => db.close());
  const src = await new ImageChain({ db }).source();
  const stat = await dirSource(join(import.meta.dirname, "../../images/default"));
  assert.ok(src.kind === "tree" && src.root.equals(stat.root));
});
