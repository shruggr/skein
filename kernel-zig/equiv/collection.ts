// The collection image (shruggr/skein#151) end to end on regtest: a skein
// booted from images/collection (images/default with shruggr/skein-collection
// installed at birth, its engine with it) registers nothing; its owner claims
// it, and root registers one collection's topic tm_col_<txid>_<vout> and the
// lookup ls_collection in the box collection/register. Then, each
// transaction mined in a block of its own (a header event in box chain, the
// chain app's answer `proven` at ingest) and posted as Atomic BEEF to
// POST /collection/submit (BRC-22):
//
//   - the collection's mint (a 1-sat inscription, MAP type=ord
//     subType=collection, a SIGMA by the issuer, signed as 1sat-sdk signs):
//     admitted;
//   - an item mint naming it, signed by the issuer: admitted; an item signed
//     by another key in the same transaction: not;
//   - a transfer whose funding input comes before the item's: the item's
//     satoshi lands at offset 10 000, in Bob's output; admitted, the item's
//     coin retained, the funding parent named as ancillary (the read /holds
//     answers it `via: "ancillary"`);
//   - an OrdLock v2 listing of it, then its purchase (the unlocking script's
//     purchase branch): each admitted;
//
// and each read answers, as a read route (/collection/collection/items,
// /history, /listings, /sales) and as BRC-24 (/collection/lookup, service
// ls_collection): the item, its owner, its chain of custody (mint, transfer,
// listing, sale), the open listing and then none, the sale with its block's
// time. `skein-host add --image collection` boots the same image. The
// skein's store replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/collection.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BSM, MerklePath, PrivateKey, Script, Transaction, UnlockingScript, Utils } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { planClaim } from "../../src/client/admin.ts";
import { main } from "../../src/host/cli.ts";
import { sendPlan } from "../../src/testapps.ts";
import { testHost, until } from "../../src/host/testhost.ts";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- regtest

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();
const sha256d = (b: Uint8Array) => sha256(sha256(b));
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const REGTEST_GENESIS = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000", "hex");
const TARGET = 0x7fffffn << BigInt(8 * (0x20 - 3));
function mine(prev: Uint8Array, merkleRoot: Uint8Array, time: number): Buffer {
  const h = Buffer.alloc(80);
  h.writeInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(merkleRoot).copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(0x207fffff, 72);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt("0x" + Buffer.from(sha256d(h)).reverse().toString("hex")) <= TARGET) return h;
  }
}

// ---------------------------------------------------------------- 1Sat scripts

/** A minimal push of `d`. */
const push = (d: Uint8Array | string): number[] => {
  const b = typeof d === "string" ? Buffer.from(d, "utf8") : Buffer.from(d);
  if (b.length < 0x4c) return [b.length, ...b];
  if (b.length <= 0xff) return [0x4c, b.length, ...b];
  return [0x4d, b.length & 0xff, b.length >> 8, ...b];
};
const p2pkh = (pkh: number[]) => [0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac];
const MAP = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5";
/** A 1Sat inscription owned by `owner` (1SAT_P2PKH before the envelope) with a MAP `SET` of `pairs`. */
const inscribed = (owner: number[], content: string, pairs: Array<[string, string]>) => [
  ...p2pkh(owner), 0x00, 0x63, ...push("ord"), 0x51, ...push("text/plain"), 0x00, ...push(content), 0x68,
  0x6a, ...push(MAP), ...push("SET"), ...pairs.flatMap(([k, v]) => [...push(k), ...push(v)]),
];
/**
 * `lock` with a SIGMA by `key` appended (1sat-sdk's `Sigma.sign`, vin 0): BSM over
 * sha256(sha256(input 0's txid in display order ‖ its index LE) ‖ sha256(the script before the `|`)).
 */
function sigma(lock: number[], prevTxid: string, prevIndex: number, key: PrivateKey): number[] {
  const op = Buffer.alloc(36);
  Buffer.from(prevTxid, "hex").copy(op, 0);
  op.writeUInt32LE(prevIndex, 32);
  const msg = sha256(Buffer.concat([sha256(op), sha256(Buffer.from(lock))]));
  const sig = Buffer.from(BSM.sign([...msg], key, "base64") as string, "base64");
  return [...lock, ...push("|"), ...push("SIGMA"), ...push("BSM"), ...push(key.toAddress()), ...push(sig), ...push("0")];
}
// OrdLock v2 (1sat-stack pkg/template/ordlock constants_v2.go): payOutput at template byte 436, the seller's
// public key hash at 468.
const ORDLOCK_V2 = Buffer.from("76009c637576ab76aa517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01007e8100011f80517e9321414136d08c5ed2bf3ba048afe6dcaebafeffffffffffffffffffffffffffffff007d97785296789f527952798d9495937776927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e827c7e23022079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798027c7e827c7e01307c7e01c37e2102b405d7f0322a89d0f9f3a98e6f938fdc1c969a8d1382a2bf66a71ae74a1e83b0ad6900aa7c820128947f7701207f758767519d7b0a6f6c323a63616e63656c8876a90088ac68", "hex");
function ordLock(seller: number[], price: number, payTo: number[]): number[] {
  const pay = Buffer.alloc(34);
  pay.writeBigUInt64LE(BigInt(price), 0);
  pay[8] = 25;
  Buffer.from(p2pkh(payTo)).copy(pay, 9);
  return [...ORDLOCK_V2.subarray(0, 436), ...push(pay), ...ORDLOCK_V2.subarray(437, 468), ...push(Buffer.from(seller)), ...ORDLOCK_V2.subarray(469)];
}

/** A transaction spending `ins` (unlocking scripts as given: every transaction here is mined, its scripts unchecked). */
function tx(ins: Array<{ from: Transaction | string; vout: number; unlock?: string }>, outs: Array<{ sats: number; lock: number[] }>): Transaction {
  const t = new Transaction();
  for (const i of ins) t.addInput({ ...(typeof i.from === "string" ? { sourceTXID: i.from } : { sourceTransaction: i.from }), sourceOutputIndex: i.vout, unlockingScript: UnlockingScript.fromHex(i.unlock ?? "51"), sequence: 0xffffffff });
  for (const o of outs) t.addOutput({ lockingScript: Script.fromBinary(o.lock), satoshis: o.sats });
  return t;
}

// ---------------------------------------------------------------- the host

const afters: Array<() => unknown> = [];
const h = await testHost({ after: (f) => afters.push(f) }, { genesis: { defaults: { walletNetwork: "regtest" } } });
let store = "";
try {
  h.mailbox("david", h.ownerId);
  await h.router.start();
  const handle = "col";
  h.db.add(handle, { store: join(h.home, "instances", handle, "runtime.db"), identity: h.keyOf(handle).toPublicKey().toString() });
  const booted = await h.router.bootRow(handle, await h.router.image.source({ image: "collection" }), { image: true });
  store = h.db.get(handle)!.store;
  const identity = h.db.get(handle)!.identity!;
  const k = async () => (await h.router.hydrate(handle)).kernel;
  const record = async (name: string) => {
    const root = await (await k()).call("head", name) as CID | null;
    return root ? await (await k()).store.get(root) as Record<string, unknown> : undefined;
  };
  const origin = h.origin(handle);

  // ------------------------------------------------ the image: chain, git, site, collection; nothing registered
  const app = await record("collection/app");
  check(booted.programs.length > 0 && app?.kind === "app" && app.version === "0.1.0", `booted from the collection image: collection/app is skein-collection ${app?.version}`);
  for (const n of ["chain/app", "git/app", "site/app"]) check(!!(await record(n)), `${n}: installed at birth`);
  check(!(await record("collection/topics")) && !(await record("collection/lookups")), "the image registers nothing: no collection/topics, no collection/lookups");
  const siteAt = await fetch(`${origin}/`);
  check(siteAt.status === 200, `GET /: the management site, root's only route (${siteAt.status})`);

  // ------------------------------------------------ the claim, then root's registrations
  await sendPlan({ port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, handle, planClaim(identity, { messagebox: h.origin("david") }));
  const root = new RawBox(h.owner, `${h.base}/@${handle}`);

  // The chain: block 1 is [coinbase, fund]; Alice's six 10 000-sat outputs.
  const issuer = PrivateKey.fromRandom();
  const pkh = (k: PrivateKey) => k.toPublicKey().toHash() as number[];
  const alice = PrivateKey.fromRandom(), bob = PrivateKey.fromRandom(), carol = PrivateKey.fromRandom();
  let tip: Uint8Array = REGTEST_GENESIS;
  let height = 0;
  const times = new Map<string, number>();
  /** `t` mined at the next height, alone with its coinbase; the header to the chain app (box chain). */
  const mineTx = async (t: Transaction) => {
    height += 1;
    const cb = sha256(Buffer.from(`coinbase ${height}`)).toString("hex");
    const id = t.id("hex");
    t.merklePath = new MerklePath(height, [[{ offset: 0, hash: cb }, { offset: 1, hash: id, txid: true }]]);
    const time = 1_790_200_000 + height * 600;
    tip = mine(sha256d(tip), sha256d(Buffer.concat([internal(cb), internal(id)])), time);
    times.set(id, time);
    await h.router.admitEvent(handle, "chain", { kind: "header", raw: tip });
    await h.router.settled();
  };
  const fund = tx([{ from: "72".repeat(32), vout: 0 }], Array.from({ length: 6 }, () => ({ sats: 10_000, lock: p2pkh(pkh(alice)) })));
  await mineTx(fund);

  // The collection's mint: output 0 of a transaction spending fund:0, signed by the issuer.
  const coll = tx([{ from: fund, vout: 0 }], [
    { sats: 1, lock: sigma(inscribed(pkh(alice), "roots", [["type", "ord"], ["subType", "collection"], ["name", "Roots"]]), fund.id("hex"), 0, issuer) },
    { sats: 9_000, lock: p2pkh(pkh(alice)) },
  ]);
  await mineTx(coll);
  const collId = `${coll.id("hex")}_0`;
  const topic = `tm_col_${collId}`;

  for (const body of [{ fn: "register", args: { topic, program: "collection-topic" } }, { fn: "registerLookup", args: { service: "ls_collection", program: "collection-lookup" } }]) {
    await root.send(identity, "collection/register", body);
    await h.router.settled();
  }
  const topics = await until("root's register", async () => {
    const r = await record("collection/topics") as { topics?: Array<{ topic: string; program: string }> } | undefined;
    return r?.topics?.some((x) => x.topic === topic) ? r.topics : undefined;
  }, 20_000).catch(() => undefined);
  check(!!topics && topics.length === 1 && topics[0]!.program === "collection-topic", `root registered ${topic.slice(0, 20)}… with collection-topic (collection/topics: ${JSON.stringify(topics)})`);
  const lookups = await record("collection/lookups") as { lookups?: Array<{ service: string; program: string; topics?: unknown }> } | undefined;
  check(lookups?.lookups?.length === 1 && lookups.lookups[0]!.service === "ls_collection" && lookups.lookups[0]!.topics === undefined, `root registered ls_collection with collection-lookup, every topic (collection/lookups: ${JSON.stringify(lookups?.lookups)})`);

  /**
   * POST /collection/submit (BRC-22): a BEEF (V1) of `parents` then `t`, each mined with its own BUMP, `t`
   * last (its subject); the STEAK. (An Atomic BEEF of a proven subject would carry no parents, and the topic
   * reads the funding parents' outputs.)
   */
  const submit = async (t: Transaction, parents: Transaction[]) => {
    const txs = [...parents, t];
    const w = new Utils.Writer();
    w.writeUInt32LE(0xefbe0001); // BEEF V1: 01 00 be ef
    w.writeVarIntNum(txs.length);
    for (const x of txs) w.write(x.merklePath!.toBinary());
    w.writeVarIntNum(txs.length);
    txs.forEach((x, i) => { w.write(x.toBinary()); w.writeUInt8(1); w.writeVarIntNum(i); });
    const res = await fetch(`${origin}/collection/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify([topic]) }, body: new Uint8Array(w.toArray()) });
    const text = await res.text();
    await h.router.settled();
    let steak: Record<string, { outputsToAdmit: number[]; coinsToRetain: number[] }> | undefined;
    try { steak = JSON.parse(text); } catch { steak = undefined; }
    return { status: res.status, steak: steak?.[topic], text };
  };
  const show = (s: { status: number; steak?: unknown; text: string }) => `${s.status} ${s.steak ? JSON.stringify(s.steak) : s.text.slice(0, 200)}`;

  // ------------------------------------------------ rule 1: the collection's mint
  let s = await submit(coll, [fund]);
  check(s.status === 200 && JSON.stringify(s.steak?.outputsToAdmit) === "[0]", `the collection's mint admitted, output 0 (${show(s)})`);

  // ------------------------------------------------ rule 2: an item mint signed by the issuer; one by another key not
  const item = (n: number) => inscribed(pkh(alice), `item ${n}`, [["type", "ord"], ["subType", "collectionItem"], ["name", `Item ${n}`], ["subTypeData", JSON.stringify({ collectionId: collId, mintNumber: String(n) })]]);
  const mint = tx([{ from: fund, vout: 1 }], [
    { sats: 1, lock: sigma(item(1), fund.id("hex"), 1, issuer) },
    { sats: 1, lock: sigma(item(2), fund.id("hex"), 1, PrivateKey.fromRandom()) },
    { sats: 9_000, lock: p2pkh(pkh(alice)) },
  ]);
  await mineTx(mint);
  s = await submit(mint, [fund]);
  check(s.status === 200 && JSON.stringify(s.steak?.outputsToAdmit) === "[0]", `an item mint: the issuer's item admitted (output 0), another key's not (${show(s)})`);
  const origin1 = `${mint.id("hex")}_0`;

  // ------------------------------------------------ rules 3 and 4: a transfer with a funding parent
  const xfer = tx([{ from: fund, vout: 2 }, { from: mint, vout: 0 }], [
    { sats: 10_000, lock: p2pkh(pkh(alice)) },
    { sats: 1, lock: p2pkh(pkh(bob)) },
  ]);
  await mineTx(xfer);
  s = await submit(xfer, [fund, mint]);
  check(s.status === 200 && JSON.stringify(s.steak?.outputsToAdmit) === "[1]" && JSON.stringify(s.steak?.coinsToRetain) === "[1]", `a transfer, funding (10 000) before the item: its satoshi lands in Bob's output 1, admitted; the item's coin retained (${show(s)})`);
  const held = await fetch(`${origin}/collection/holds?txid=${fund.id("hex")}`);
  const heldJ = await held.json().catch(() => ({})) as { via?: string; txid?: string };
  check(held.status === 200 && heldJ.via === "ancillary" && heldJ.txid === fund.id("hex"), `the admittance names the funding parent as ancillary: GET /collection/holds?txid=<fund> → ${JSON.stringify(heldJ)}`);

  // ------------------------------------------------ an OrdLock v2 listing, and its purchase
  const listing = tx([{ from: xfer, vout: 1 }], [{ sats: 1, lock: ordLock(pkh(bob), 1000, pkh(bob)) }]);
  await mineTx(listing);
  s = await submit(listing, [xfer]);
  check(s.status === 200 && JSON.stringify(s.steak?.outputsToAdmit) === "[0]", `an OrdLock v2 listing of it admitted (${show(s)})`);

  const read = async (find: string, q: string) => {
    const r = await fetch(`${origin}/collection/collection/${find}?${q}`);
    return { status: r.status, rows: await r.json().catch(() => undefined) as Array<Record<string, unknown>> | undefined };
  };
  let listings = await read("listings", `collection=${collId}`);
  const bobAddr = bob.toAddress();
  check(listings.status === 200 && listings.rows?.length === 1 && listings.rows[0]!.outpoint === `${listing.id("hex")}_0` && listings.rows[0]!.price === 1000 && listings.rows[0]!.seller === bobAddr && listings.rows[0]!.payout === bobAddr && listings.rows[0]!.origin === origin1, `GET /collection/collection/listings: the open listing, price 1000, seller and payout Bob (${JSON.stringify(listings.rows)})`);

  const buy = tx([{ from: listing, vout: 0, unlock: "01aa00" }, { from: fund, vout: 3 }], [
    { sats: 1, lock: p2pkh(pkh(carol)) },
    { sats: 1000, lock: p2pkh(pkh(bob)) },
    { sats: 9_000, lock: p2pkh(pkh(carol)) },
  ]);
  await mineTx(buy);
  s = await submit(buy, [listing, fund]);
  check(s.status === 200 && JSON.stringify(s.steak?.outputsToAdmit) === "[0]" && JSON.stringify(s.steak?.coinsToRetain) === "[0]", `the purchase (its unlocking script's purchase branch): the item to Carol's output 0, admitted (${show(s)})`);

  // ------------------------------------------------ the four reads, as read routes
  const items = await read("items", `collection=${collId}`);
  const it = items.rows?.[0];
  check(items.status === 200 && items.rows?.length === 1 && it?.origin === origin1 && it.outpoint === `${buy.id("hex")}_0` && it.owner === carol.toAddress() && it.name === "Item 1" && it.mintNumber === 1 && it.contentType === "text/plain", `GET /collection/collection/items: one item, at Carol's output, her address its owner, its mint metadata (${JSON.stringify(it)})`);
  const hist = await read("history", `origin=${origin1}`);
  check(hist.status === 200 && JSON.stringify(hist.rows?.map((x) => x.kind)) === '["mint","transfer","listing","sale"]' && hist.rows?.[3]?.outpoint === `${buy.id("hex")}_0`, `GET /collection/collection/history: mint, transfer, listing, sale (${JSON.stringify(hist.rows)})`);
  listings = await read("listings", `collection=${collId}`);
  check(listings.status === 200 && listings.rows?.length === 0, `GET /collection/collection/listings: none open after the purchase (${JSON.stringify(listings.rows)})`);
  const sales = await read("sales", `collection=${collId}`);
  const sale = sales.rows?.[0];
  check(sales.status === 200 && sales.rows?.length === 1 && sale?.type === "purchase" && sale.price === 1000 && sale.txid === buy.id("hex") && sale.height === height && sale.time === times.get(buy.id("hex")), `GET /collection/collection/sales: the purchase, price 1000, its block's height and time (${JSON.stringify(sale)})`);
  const bad = await read("items", "collection=nope");
  check(bad.status === 400, `a read out of shape: 400 (${bad.status})`);

  // ------------------------------------------------ BRC-24
  const lookup = async (query: unknown) => {
    const r = await fetch(`${origin}/collection/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "ls_collection", query }) });
    const j = await r.json().catch(() => undefined) as { type?: string; outputs?: Array<{ beef: number[]; outputIndex: number; context?: number[] }> } | undefined;
    return { status: r.status, type: j?.type, outputs: (j?.outputs ?? []).map((o) => ({ at: `${Transaction.fromBEEF(o.beef).id("hex")}_${o.outputIndex}`, row: o.context ? JSON.parse(Buffer.from(o.context).toString("utf8")) as Record<string, unknown> : undefined })) };
  };
  const li = await lookup({ find: "items", collection: collId });
  check(li.status === 200 && li.type === "output-list" && li.outputs.length === 1 && li.outputs[0]!.at === `${buy.id("hex")}_0` && li.outputs[0]!.row?.origin === origin1, `POST /collection/lookup {find: items}: an output-list, the item's current output with its BEEF, its row as context (${JSON.stringify(li.outputs)})`);
  const lh = await lookup({ find: "history", origin: origin1 });
  check(lh.status === 200 && JSON.stringify(lh.outputs.map((o) => o.at)) === JSON.stringify([origin1, `${xfer.id("hex")}_1`, `${listing.id("hex")}_0`, `${buy.id("hex")}_0`]), `POST /collection/lookup {find: history}: the four outpoints, each with its BEEF (${lh.outputs.map((o) => o.at.slice(0, 8)).join(", ")})`);
  const ls = await lookup({ find: "sales", collection: collId });
  check(ls.status === 200 && ls.outputs.length === 1 && ls.outputs[0]!.at === `${listing.id("hex")}_0` && ls.outputs[0]!.row?.type === "purchase", `POST /collection/lookup {find: sales}: the spent listing, its sale as context (${JSON.stringify(ls.outputs)})`);
  const ll = await lookup({ find: "listings", collection: collId });
  check(ll.status === 200 && ll.outputs.length === 0, `POST /collection/lookup {find: listings}: none (${ll.outputs.length})`);

  // ------------------------------------------------ skein-host add --image collection
  const out: string[] = [], err: string[] = [];
  const code = await main(["add", "fresh", "--image", "collection"], { vars: { SKEIN_HOME: h.home, HOME: h.home }, out: (l) => out.push(l), err: (l) => err.push(l) });
  check(code === 0 && out.some((l) => /booted from the image .* no owner: claim it/.test(l)), `skein-host add fresh --image collection: exit ${code} ${[...out, ...err].join(" ").slice(0, 200)}`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  // testhost's afters: [remove the home, stop the router]: the router first, the replay, then the home.
  const [removeHome, ...rest] = afters;
  for (const f of rest.reverse()) await f();
  if (store) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), store], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "the collection skein's store replays to itself exactly");
  }
  if (!process.env.KEEP) await removeHome?.();
}
process.stdout.write(failures ? `collection: ${failures} FAILED\n` : "collection: all ok\n");
process.exit(failures ? 1 : 0);
