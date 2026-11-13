// The first cut's bar (skein next, the H2 brief): an instance born from an image on this host with the
// rebuilt chain app and overlay installed at birth (build C's skein-chain and skein-overlay `next`
// worktrees: SKEIN_CHAIN_DIR / SKEIN_OVERLAY_DIR, default ../wt-skein-chain-next, ../wt-skein-overlay-next),
// on regtest with the host's one header intake:
//   - a BEEF taken in through the public submit row (/overlay/submit: chain.beef, overlay.admits; recheck
//     chain.unspent) → BRC-22's STEAK; the chain app's chain/tx fact makes the host remember the holder;
//     the overlay's admitted fact carries `topics`;
//   - a second BEEF spending the same output: checks pass, refused at COMMIT ("already spent"), nothing written;
//   - a sync delivery (the host's own: /overlay/sync, plain BEEF) taken in; the sync row not offered over HTTP;
//   - a merkle proof as the event chain/proof (checked by chain.proof): taken; an EARLY one (its header not
//     held yet) refused 425, kept, and offered again by the host when the header arrives;
//   - a rejected status from the host's status service (its own key, role chain.status) → outcome rejected.
// The second test: the undecided flow (SPEC 7) over the demo topic tm_chain_demo (a root: its first output
// tm_demo's marker; a non-root spending nothing admitted, with a source unreadable here: MissingParents).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { MerklePath, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { txCid } from "./feeds.ts";
import { REGTEST_GENESIS } from "./fake-teranode.ts";
import { DoorAnswered } from "./door-answer.ts";
import { imageTree, testHost, until } from "./testhost.ts";

const AGENT_ENV = resolve(import.meta.dirname, "../../..");
const CHAIN_DIR = process.env.SKEIN_CHAIN_DIR ?? join(AGENT_ENV, "wt-skein-chain-next");
const OVERLAY_DIR = process.env.SKEIN_OVERLAY_DIR ?? join(AGENT_ENV, "wt-skein-overlay-next");
const skip = (!existsSync(join(CHAIN_DIR, "bin/chain.wasm")) || !existsSync(join(OVERLAY_DIR, "bin/overlay.wasm"))) && "build C's chain app and overlay not here (SKEIN_CHAIN_DIR, SKEIN_OVERLAY_DIR)";

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const TARGET = 0x7fffffn << BigInt(8 * (0x20 - 3));
function mine(prev: Uint8Array, merkleRoot: Uint8Array, time: number): Uint8Array {
  const h = Buffer.alloc(80);
  h.writeInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(merkleRoot).copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(0x207fffff, 72);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt("0x" + Buffer.from(sha256d(h)).reverse().toString("hex")) <= TARGET) return new Uint8Array(h);
  }
}

test("the first cut: an instance with the chain app and the overlay, born from an image — public submit, a double spend refused at COMMIT, a sync delivery, proofs (one early, offered again), a rejection", { skip, timeout: 300_000 }, async (t) => {
  const h = await testHost(t, { network: "regtest", genesis: { defaults: { walletNetwork: "regtest" } } });
  const img = await imageTree(join(h.home, "img"), { apps: [CHAIN_DIR, OVERLAY_DIR] });
  await h.instance("ov", img);
  // Regtest: the genesis, then F (a funding transaction with a stand-in input) mined at height 1.
  const alice = new PrivateKey("3333", 16);
  const lock = () => new P2PKH().lock(alice.toPublicKey().toHash());
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 4; i++) fund.addOutput({ lockingScript: lock(), satoshis: 10_000 });
  const headers: Uint8Array[] = [new Uint8Array(REGTEST_GENESIS)];
  const mineAlone = (tx: Transaction) => {
    const height = headers.length;
    const cb = (height * 17 % 256).toString(16).padStart(2, "0").repeat(32);
    tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: cb }, { offset: 1, hash: tx.id("hex"), txid: true }]]);
    headers.push(mine(sha256d(headers.at(-1)!), sha256d(Buffer.concat([internal(cb), internal(tx.id("hex"))])), 1_790_200_000 + height * 600));
    return height;
  };
  mineAlone(fund);
  await h.router.start();
  await h.router.takeHeaders(headers, 0);
  await h.router.settled();
  const k = (await h.router.hydrate("ov")).kernel;
  const rows = (await k.routes()).rows as Array<Record<string, unknown>>;
  assert.ok(rows.some((r) => r.path === "/overlay/submit") && rows.some((r) => r.name === "chain/proof") && rows.some((r) => r.path === "/chain/rejected"), "the apps' rows installed at birth");

  /** A tm_demo token spending F's output `vout`. */
  const token = async (vout: number, n: number) => {
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: fund, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
    tx.addOutput({ lockingScript: Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...lock().toBinary()]), satoshis: 9_000 + n });
    await tx.sign();
    return tx;
  };
  const submit = async (tx: Transaction) => await fetch(`${h.base}/@ov/overlay/submit`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(tx.toBEEF()) });

  // 1. The public submit row.
  const t1 = await token(0, 1);
  const n0 = await h.entries("ov");
  const r1 = await submit(t1);
  const steak = await r1.text();
  assert.equal(r1.status, 200, steak);
  assert.deepEqual(JSON.parse(steak).tm_demo?.outputsToAdmit, [0], `BRC-22's STEAK: ${steak}`);
  assert.equal(await h.entries("ov"), n0 + 1, "one entry");
  await h.router.settled();
  assert.deepEqual(h.router.holdersOf(t1.id("hex")), ["ov"], "the host remembers the holder from the chain app's chain/tx fact");
  const fact = (await h.router.events.read("ov", { name: `overlay/topic/tx/${t1.id("hex")}` })).at(-1);
  assert.ok(fact && /"admitted"/.test(fact.data) && /"tm_demo"/.test(fact.data), `the overlay's admitted fact with its topics: ${fact?.data}`);

  // 2. A second BEEF spending the same output: past the checks, refused at COMMIT, nothing written.
  const t2 = await token(0, 2);
  const r2 = await submit(t2);
  assert.equal(r2.status, 409, await r2.clone().text());
  assert.equal(((await r2.json()) as { code: string }).code, "ERR_SPENT");
  assert.equal(await h.entries("ov"), n0 + 1, "nothing written");

  // 3. A sync delivery: the host's own (plain BEEF to /overlay/sync); the sync row not offered over HTTP.
  const t3 = await token(1, 3);
  const s3 = await h.router.submitBeef("ov", "/overlay/sync", Uint8Array.from(t3.toBEEF()));
  assert.equal(s3.verdict, "accept", s3.reason ?? "");
  const viaHttp = await fetch(`${h.base}/@ov/overlay/sync`, { method: "POST", body: Buffer.from(t3.toBEEF()) });
  assert.equal(viaHttp.status, 404, "the sync row is the host's: not offered over HTTP");
  assert.equal(await h.entries("ov"), n0 + 2);

  // 4. Proofs: t1 mined at height 2 (its header first) — taken; t3 mined at 3, its proof offered before the
  //    header — refused early (425), kept, offered again when the header arrives.
  const proofOf = (tx: Transaction) => ({ kind: "proof", subject: txCid(tx.id("hex")), txid: tx.id("hex"), path: Uint8Array.from(tx.merklePath!.toBinary()) });
  mineAlone(t1);
  await h.router.takeHeaders([headers[2]!], 2);
  await h.router.settled();
  assert.ok(await h.router.offerProof("ov", proofOf(t1)), "t1's proof taken");
  await h.router.settled();
  await until("t1 mined (the holder forgotten)", () => h.router.holdersOf(t1.id("hex")).length === 0 || undefined);
  mineAlone(t3);
  assert.equal(await h.router.offerProof("ov", proofOf(t3)), undefined, "early: kept, not taken");
  assert.ok(h.lines.some((l) => /proof .*: early/.test(l)));
  await h.router.takeHeaders([headers[3]!], 3);
  await until("t3's early proof taken after its header", async () => { await h.router.settled(); return h.router.holdersOf(t3.id("hex")).length === 0 || undefined; });

  // 5. A rejection from the host's status service (its own key, role chain.status).
  const t4 = await token(2, 4);
  assert.equal((await submit(t4)).status, 200);
  const e = await h.router.statusRequest("ov", { kind: "status", txid: t4.id("hex"), txStatus: "REJECTED", extraInfo: "a test" });
  await h.router.settled();
  const after = (await h.router.events.read("ov", { name: `chain/tx/${t4.id("hex")}` })).at(-1);
  assert.ok(after && /"rejected"/.test(after.data), `the chain app took the rejection: ${after?.data}`);
  void e;
  // The rejected row takes no other key: the owner (root) is no chain.status holder.
  await assert.rejects(h.request("ov", "POST", "/chain/rejected", { txid: t4.id("hex"), txStatus: "REJECTED" }), (x) => x instanceof DoorAnswered && x.answer.status === 403);
  void dagCbor;
});

/** N for the long chain (HF1): SKEIN_UNDECIDED_N, default 300. */
const N = Number(process.env.SKEIN_UNDECIDED_N ?? 300);

test("the undecided flow (SPEC 7): children delivered before their root are undecided; a repeat changes nothing; the public row refuses one; the root releases them one per launched step; a long chain released with no step out of fuel", { skip, timeout: 1_800_000 }, async (t) => {
  const h = await testHost(t, { network: "regtest", genesis: { defaults: { walletNetwork: "regtest" } } });
  const img = await imageTree(join(h.home, "img"), { apps: [CHAIN_DIR, OVERLAY_DIR] });
  await h.instance("ov", img);
  await h.instance("fresh", img);
  const alice = new PrivateKey("4444", 16);
  const lock = () => new P2PKH().lock(alice.toPublicKey().toHash());
  const marker = () => Script.fromBinary([0x07, ...Buffer.from("tm_demo"), 0x75, ...lock().toBinary()]);
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "73".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  fund.addOutput({ lockingScript: lock(), satoshis: 10_000_000 });
  fund.addOutput({ lockingScript: lock(), satoshis: 10_000_000 });
  const headers: Uint8Array[] = [new Uint8Array(REGTEST_GENESIS)];
  const mineAlone = (tx: Transaction) => {
    const height = headers.length;
    const cb = createHash("sha256").update(`cb ${height}`).digest("hex");
    tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: cb }, { offset: 1, hash: tx.id("hex"), txid: true }]]);
    headers.push(mine(sha256d(headers.at(-1)!), sha256d(Buffer.concat([internal(cb), internal(tx.id("hex"))])), 1_790_300_000 + height * 600));
  };
  mineAlone(fund);
  /** A transaction spending `src`:0, one output (`root`: tm_demo's marker first, so tm_chain_demo takes it as a root), mined alone. */
  const spend = async (src: Transaction, vout: number, root = false) => {
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
    tx.addOutput({ lockingScript: root ? marker() : lock(), satoshis: src.outputs[vout]!.satoshis! - 10 });
    await tx.sign();
    mineAlone(tx);
    return tx;
  };
  // A root R and its chain C1 → C2 (the scenario), and a second root R2 with a chain of N.
  const R = await spend(fund, 0, true);
  const C1 = await spend(R, 0);
  const C2 = await spend(C1, 0);
  const R2 = await spend(fund, 1, true);
  const long: Transaction[] = [];
  for (let i = 0, src = R2; i < N; i++) { src = await spend(src, 0); long.push(src); }
  await h.router.start();
  await h.router.takeHeaders(headers, 0);
  await h.router.settled();

  /** A delivery on its own: the transaction alone, proven by its BUMP (no ancestors). */
  const beefOf = (tx: Transaction) => {
    const alone = Transaction.fromHex(tx.toHex());
    alone.merklePath = tx.merklePath;
    return Uint8Array.from(alone.toBEEF());
  };
  const sync = async (tx: Transaction, handle = "ov") => {
    const before = await h.entries(handle);
    const v = await h.router.submitBeef(handle, "/overlay/sync", beefOf(tx));
    await h.router.settled();
    return { v, entries: (await h.entries(handle)) - before };
  };
  const facts = async (tx: Transaction) => (await h.router.events.read("ov", { name: `overlay/topic/tx/${tx.id("hex")}` })).map((d) => ({ id: d.id, verdict: (JSON.parse(d.data) as { verdict?: string }).verdict }));
  const held = async (tx: Transaction) => (await h.router.events.read("ov", { name: `chain/tx/${tx.id("hex")}` })).length > 0;

  // The ov store, read: the threads launched to re-judge (args {fn: "rejudge", txid}) and every update's fuel.
  const { openStoreFile } = await import("./stores.ts");
  const { storeSpec } = await import("../runtime/index-store.ts");
  const rejudges = async () => {
    const st = openStoreFile(storeSpec(h.db.get("ov")!), { readOnly: true });
    const out: Array<{ thread: string; txid: string; fuel: number[] }> = [];
    try {
      for await (const th of st.edges.query({ kind: "thread" })) {
        const o = await st.get(th) as unknown as { args?: unknown };
        let args = o.args as Record<string, unknown> | undefined;
        if (args && (args as { "/"?: unknown })["/"] === undefined && typeof (args as { toString?: unknown }).toString === "function" && "multihash" in (args as object)) args = await st.get(args as never) as unknown as Record<string, unknown>;
        if (!args || args.fn !== "rejudge") continue;
        const fuel: number[] = [];
        for await (const u of st.chains.history(th)) { if (u.equals(th)) continue; const up = await st.get(u) as unknown as { fuel?: number | bigint }; if (up.fuel !== undefined) fuel.push(Number(up.fuel)); }
        out.push({ thread: th.toString(), txid: String(args.txid), fuel });
      }
    } finally { await st.close(); }
    return out;
  };
  const maxFuel = async () => {
    const st = openStoreFile(storeSpec(h.db.get("ov")!), { readOnly: true });
    let max = 0;
    try {
      for await (const th of st.edges.query({ kind: "thread" })) for await (const u of st.chains.history(th)) {
        if (u.equals(th)) continue;
        const up = await st.get(u) as unknown as { fuel?: number | bigint };
        if (up.fuel !== undefined && Number(up.fuel) > max) max = Number(up.fuel);
      }
    } finally { await st.close(); }
    return max;
  };
  const record: string[] = [];

  // 1. A mined child before its parent: committed, recorded by the chain app, undecided, nothing admitted.
  const s1 = await sync(C1);
  assert.equal(s1.v.verdict, "accept", s1.v.reason ?? "");
  assert.equal(s1.entries, 1, "one entry");
  assert.ok(await held(C1), "the chain app recorded it (chain/tx fact)");
  assert.deepEqual((await facts(C1)).map((f) => f.verdict), ["undecided"]);
  record.push("1. C1 before R: committed (1 entry), chain/tx recorded, verdict undecided");

  // 2. Its child next (its parent held but undecided): undecided too.
  const s2 = await sync(C2);
  assert.equal(s2.v.verdict, "accept", s2.v.reason ?? "");
  assert.deepEqual((await facts(C2)).map((f) => f.verdict), ["undecided"]);
  record.push("2. C2 (parent held, undecided): committed, verdict undecided");

  // 3. C1 again: no new verdict fact, no re-judge.
  const s3 = await sync(C1);
  assert.equal(s3.v.verdict, "accept", s3.v.reason ?? "");
  assert.deepEqual((await facts(C1)).map((f) => f.verdict), ["undecided"], "no new verdict fact");
  assert.equal((await rejudges()).length, 0, "no re-judge");
  record.push(`3. C1 again: ${s3.entries} entry, no new fact, no re-judge`);

  // 4. C1 to the PUBLIC row of an instance lacking its parent: refused, nothing written.
  const nf = await h.entries("fresh");
  const pub = await fetch(`${h.base}/@fresh/overlay/submit`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(beefOf(C1)) });
  const pubText = await pub.text();
  assert.equal(pub.status, 422, pubText);
  assert.equal(await h.entries("fresh"), nf, "nothing written");
  record.push(`4. C1 to /overlay/submit on a fresh instance: ${pub.status} ${pubText.slice(0, 120)}, nothing written`);

  // 5. The root: admitted; C1 and C2 released, each in its own launched step.
  const s5 = await sync(R);
  assert.equal(s5.v.verdict, "accept", s5.v.reason ?? "");
  await until("C1 and C2 admitted", async () => { await h.router.settled(); return ((await facts(C2)).at(-1)?.verdict === "admitted") || undefined; }, 60_000);
  assert.equal((await facts(R)).at(-1)?.verdict, "admitted");
  assert.equal((await facts(C1)).at(-1)?.verdict, "admitted");
  const rj = await rejudges();
  assert.deepEqual(rj.map((x) => x.txid).sort(), [C1.id("hex"), C2.id("hex")].sort(), "one re-judge thread per released transaction");
  const placeThread = (id: string) => id.split(".")[2];
  const rootThread = placeThread((await facts(R)).at(-1)!.id);
  for (const tx of [C1, C2]) {
    const th = placeThread((await facts(tx)).at(-1)!.id);
    assert.notEqual(th, rootThread, "the root's own step did not judge it");
    assert.equal(rj.find((x) => x.thread === th)?.txid, tx.id("hex"), "admitted in the re-judge step for it");
  }
  record.push(`5. R: admitted; C1, C2 admitted, each in its own launched re-judge thread (${rj.length} threads), not in R's step`);

  // 6. A long chain: N children child-first (all undecided), then the root; released one per step.
  const t0 = Date.now();
  for (const tx of [...long].reverse()) {
    const v = await h.router.submitBeef("ov", "/overlay/sync", beefOf(tx));
    assert.equal(v.verdict, "accept", v.reason ?? "");
  }
  await h.router.settled();
  const tDeliver = Date.now() - t0;
  assert.equal((await facts(long[0]!)).at(-1)?.verdict, "undecided");
  assert.equal((await facts(long.at(-1)!)).at(-1)?.verdict, "undecided");
  const t1 = Date.now();
  assert.equal((await h.router.submitBeef("ov", "/overlay/sync", beefOf(R2))).verdict, "accept");
  await until(`all ${N} released`, async () => { await h.router.settled(); return ((await facts(long.at(-1)!)).at(-1)?.verdict === "admitted") || undefined; }, 1_500_000);
  const tRelease = Date.now() - t1;
  const all = await rejudges();
  const longIds = new Set(long.map((x) => x.id("hex")));
  const longRj = all.filter((x) => longIds.has(x.txid));
  assert.equal(longRj.length, N, "one re-judge step per transaction");
  for (const tx of long) assert.equal((await facts(tx)).at(-1)?.verdict, "admitted");
  const rjFuel = Math.max(...longRj.flatMap((x) => x.fuel));
  const stepMax = await maxFuel();
  record.push(`6. N=${N}: delivered child-first in ${tDeliver} ms (all undecided), the root then released all in ${tRelease} ms, ${longRj.length} re-judge threads; the largest re-judge step's fuel ${rjFuel}, the largest step of any thread ${stepMax}, against fuelPerStep 1000000000000`);
  for (const l of record) console.log(`HF1 ${l}`);
});
