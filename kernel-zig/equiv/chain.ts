// The chain module (#78) end to end: shruggr/skein-chain at a pinned commit
// (or $SKEIN_CHAIN_DIR), installed as the owner's messages (`skein install`, sent to /sendMessage, #124)
// into an instance of the stock system on a router with an Arcade (so a
// broadcaster and a `$status` provider), called by the instance's owner (a
// mailbox of its own on the same host; #79: the chain app takes calls from
// `$owner` and `$self`, not from anyone):
//
//   - the install asks for the rows `chain` from `event` (the host's events),
//     from `$self` and from `$owner`, and `status` (box chain/status, #128) from $status (optional),
//     and the head chain/app; chain/state is its writes; a stranger's call
//     routes nowhere;
//   - the host's chain feed (a `header` event in box chain) reaches it;
//   - ingest proven ({fn: "ingest", args: {beef}} in box chain): recorded,
//     answered at once (state proven, the block's CID);
//   - ingest unproven: recorded, broadcast (the host's Arcade gets it — from
//     the chain app, the only thing that emits it here), and answered on each
//     state change: accepted (the status provider's RECEIVED), proven (the
//     proof Arcade reports once mined; the header first); a second ingest of
//     it while pending is answered accepted at once and proven later;
//   - ingest unproven that Arcade refuses: answered rejected;
//   - the reads `status` and `proof` answer CIDs; a bad BEEF is an error;
//   - nothing unproven is at rest without a registered broadcast;
//   - the same reads as a kernel call; ingest is refused there (a message only);
//   - at boot: a system tree (the stock files, bin/chain.wasm, the two rows)
//     takes the feed, ingests, broadcasts and answers the same way, its writes
//     under the stock scope `chain/`.
//
// Both stores then replay to themselves exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/chain.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { dirSource, stockSystemFiles } from "../../src/host/boot.ts";
import { main } from "../../src/host/cli.ts";
import { ownerCli } from "../../src/testapps.ts";
import { FakeArcade } from "../../src/host/fake-arcade.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

// The app under test: SKEIN_CHAIN_DIR names a checkout, else this commit.
const CHAIN_REPO = "https://github.com/shruggr/skein-chain";
const CHAIN_REV = process.env.SKEIN_CHAIN_REV ?? "e8d21021182ae02c673e2a2809cea5e1988bd47a";
const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ---------------------------------------------------------------- regtest (as equiv/overlay.ts)

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");
const REGTEST_GENESIS = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000", "hex");
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

const arcade = await FakeArcade.start();
const afters: Array<() => unknown> = [];
// The caller is the instance's owner (#79: the chain app's rows admit $owner and $self).
const callerKey = PrivateKey.fromRandom(), callerId = callerKey.toPublicKey().toString();
const h = await testHost({ after: (f) => afters.push(f) }, { ownerKey: callerKey, genesis: { defaults: { walletNetwork: "regtest" } }, arc: { url: arcade.url, token: "the-chain-arcade-token", events: arcade.eventsUrl }, arcRetry: { min: 300, max: 1000 } });
let store = "";
const bootStores: string[] = [];
/** The app's checkout at the pinned commit (for its bin/chain.wasm in a system tree). */
function cloneChain(home: string): string {
  const dir = join(home, "skein-chain");
  for (const args of [["clone", "-q", CHAIN_REPO, dir], ["-C", dir, "checkout", "-q", CHAIN_REV]]) {
    const r = spawnSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.status}`);
  }
  return dir;
}
try {
  const callerWallet = ephemeralWallet(callerKey);
  h.mailbox("caller", callerId);
  const inst = h.instance("ch");
  await h.router.start();
  const owner = new RawBox(h.owner, `${h.base}/@ch`);
  await owner.send(inst, "peers", { op: "add", key: callerId, url: h.origin("caller") });
  await h.router.settled();
  store = h.db.get("ch")!.store;
  const k = async () => (await h.router.hydrate("ch")).kernel;
  const record = async (name: string) => {
    const kk = await k();
    const root = await kk.call("head", name) as CID | null;
    return root ? await kk.store.get(root) as Record<string, unknown> : undefined;
  };

  // ------------------------------------------------ install
  const out: string[] = [], err: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    // #124: install/uninstall are the owner's messages, planned and sent on the owner's session (src/testapps.ts ownerCli).
    const o = args[0] === "install" || args[0] === "uninstall" ? await ownerCli({ home: h.home, port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, args) : undefined;
    if (o) { out.push(...o.out); err.push(...o.err); }
    const code = o ? o.code : await main(args, {
      vars: { SKEIN_HOME: h.home, HOME: h.home }, out: (l) => out.push(l), err: (l) => err.push(l),
    });
    await h.router.settled();
    if (process.env.VERBOSE) for (const l of [...out, ...err]) process.stdout.write(`  | ${l}\n`);
    return code;
  };
  const spec = process.env.SKEIN_CHAIN_DIR ?? `${CHAIN_REPO}#${CHAIN_REV}`;
  const code = await cli("install", spec, "--instance", "ch");
  check(code === 0, `skein install skein-chain: exit ${code} ${err.join(" ")}`);
  check(["event", "$self", "$owner"].every((who) => out.some((l) => l.includes(`row       mailbox chain from ${who} → chain`))) && out.some((l) => /row {7}mailbox chain\/status from \$status .*→ chain/.test(l)) && !out.some((l) => l.includes("mailbox chain from anyone")), `the prompt shows its rows (#79: no open box): ${out.filter((l) => l.includes("row ")).map((l) => l.trim().replace(/\s+/g, " ")).join(" | ")}`);
  const app = await record("chain/app");
  check(app?.kind === "app" && app.name === "chain" && app.version === "0.4.0", "the head chain/app is the app record (0.4.0)");
  const rows = ((await (await k()).dispatch()).rows as Array<Record<string, unknown>>).filter((r) => r.app === "chain");
  const senderOf = (r: Record<string, unknown>) => r.sender instanceof Uint8Array ? Buffer.from(r.sender).toString("hex") : String(r.sender);
  check(rows.length === 4 && rows.every((r) => r.transport === "mailbox" && !("optional" in r)) && rows.map((r) => r.address).join(",") === "chain,chain,chain,chain/status"
    && senderOf(rows[0]!) === "event" && senderOf(rows[1]!) === inst && senderOf(rows[2]!) === callerId,
  `its rows in the dispatch table (event; $self → the instance's key; $owner; optional not carried): ${rows.map((r) => `${r.transport} ${r.address} ${senderOf(r).slice(0, 10)}`).join(", ")}`);

  // ------------------------------------------------ the chain: block 1 holds the funding alone
  const alice = PrivateKey.fromRandom();
  const fund = new Transaction();
  fund.addInput({ sourceTXID: "72".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 3; i++) fund.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 10_000 });
  const fundTxid = fund.id("hex");
  fund.merklePath = new MerklePath(1, [[{ offset: 0, hash: fundTxid, txid: true }]]);
  const h1 = mine(sha256d(REGTEST_GENESIS), internal(fundTxid), 1_790_200_000);
  await h.router.admitEvent("ch", "chain", { kind: "header", raw: h1 });
  await h.router.settled();
  const state = async () => {
    const r = await record("chain/state") as { kind?: string; network?: string } | undefined;
    return r;
  };
  const st1 = await state();
  check(st1?.kind === "chain-state" && st1.network === "regtest", `the feed's header reached the chain app: chain/state is a chain-state on regtest (${JSON.stringify(st1 && { kind: st1.kind, network: st1.network })})`);

  // ------------------------------------------------ calls by message, answers in the caller's mailbox
  const callerBox = new RawBox(callerWallet, `${h.base}/@ch`);
  const mine_ = new RawBox(callerWallet, h.origin("caller"));
  type Answer = { fn: string; request?: CID; replyTo?: CID; result?: Record<string, unknown>; error?: { code: string; message: string } };
  const answersTo = async (id: string) => (await mine_.list("chain")).map((x) => x.value as Answer).filter((v) => String(v.request) === id);
  const send = async (body: Record<string, unknown>) => (await callerBox.send(inst, "chain", body)).id.toString();
  const answers = async (id: string, n: number, what: string) => await until(what, async () => { await h.router.settled(); const a = await answersTo(id); return a.length >= n ? a : undefined; }, 30_000);

  // A stranger's call is refused at the door (no open box, #79): the messagebox admits only a sender a row takes.
  const strangerWallet = ephemeralWallet(PrivateKey.fromRandom());
  const refused = await new RawBox(strangerWallet, `${h.base}/@ch`).send(inst, "chain", { fn: "status", args: { txid: "00".repeat(32) } }).then(() => "sent", (e: Error) => e.message);
  check(/ERR_NOT_SUBSCRIBED/.test(refused), `a stranger's call to the chain app is refused: no row admits it (${refused})`);

  // Proven in: answered at once.
  const postsBefore = arcade.posts.length;
  const r1 = await send({ fn: "ingest", args: { beef: new Uint8Array(fund.toBEEF()) } });
  const a1 = (await answers(r1, 1, "the proven ingest's answer"))[0]!;
  check(a1.fn === "ingest" && a1.result?.state === "proven" && a1.result.txid === fundTxid && String(a1.result.block) !== "undefined" && a1.result.height === 1 && String(a1.replyTo) === r1, `ingest proven: answered at once, {state: proven, block, height: 1} (${JSON.stringify(a1.result && { state: a1.result.state, height: a1.result.height })})`);
  check(arcade.posts.length === postsBefore, "a proven transaction is not broadcast");

  // Unproven in: broadcast; accepted, then proven.
  const child = new Transaction();
  child.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  child.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 9_000 });
  await child.sign();
  const childTxid = child.id("hex");
  const r2 = await send({ fn: "ingest", args: { beef: new Uint8Array(child.toBEEF()) } });
  const posted = await until("the broadcast reaches the Arcade", () => arcade.posts.find((b) => FakeArcade.txOf(b).id("hex") === childTxid), 20_000).catch(() => undefined);
  check(!!posted, "ingest unproven: broadcast (the host's Arcade got it, from the chain app)");
  const a2 = await answers(r2, 1, "accepted");
  check(a2[0]?.result?.state === "accepted" && a2[0].result.txStatus === "RECEIVED" && String(a2[0].result.broadcast) !== "undefined", `accepted on the status provider's first status (${JSON.stringify(a2[0]?.result && { state: a2[0].result.state, txStatus: a2[0].result.txStatus })})`);
  // While it is pending, another ingest of it: answered accepted at once (its watcher registered).
  const r3 = await send({ fn: "chain.ingest", args: { beef: new Uint8Array(child.toBEEF()) } });
  const a3 = await answers(r3, 1, "the second ingest's answer");
  check(a3[0]?.fn === "chain.ingest" && a3[0].result?.state === "accepted", `a second ingest while it is pending: accepted at once (${a3[0]?.result?.state})`);
  const st = await (await k()).store.get((await (await k()).call("head", "chain/state")) as CID) as { maps: Record<string, CID | null> };
  check(!!st.maps.unproven && !!st.maps.broadcasts, "at rest unproven: the broadcast registered (maps unproven and broadcasts)");
  // Mined at 2: the header, then Arcade's MINED with its path.
  const h2 = mine(sha256d(h1), internal(childTxid), 1_790_200_600);
  await h.router.admitEvent("ch", "chain", { kind: "header", raw: h2 });
  await h.router.settled();
  const path = new MerklePath(2, [[{ offset: 0, hash: childTxid, txid: true }]]);
  arcade.emit(childTxid, { txStatus: "MINED", blockHash: display(sha256d(h2)), blockHeight: 2, merklePath: path.toHex() });
  const a2b = await answers(r2, 2, "proven");
  check(a2b[1]?.result?.state === "proven" && a2b[1].result.height === 2, `then proven, on Arcade's proof: a second answer to the same request (${a2b.map((x) => x.result?.state).join(" → ")})`);
  const a3b = await answers(r3, 2, "proven to the second watcher");
  check(a3b[1]?.result?.state === "proven", `the second watcher told too (${a3b.map((x) => x.result?.state).join(" → ")})`);

  // Unproven that Arcade refuses: rejected.
  const child2 = new Transaction();
  child2.addInput({ sourceTransaction: fund, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  child2.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 8_000 });
  await child2.sign();
  arcade.mode = "reject";
  const r4 = await send({ fn: "ingest", args: { beef: new Uint8Array(child2.toBEEF()) } });
  const a4 = await answers(r4, 1, "rejected");
  arcade.mode = "ok";
  check(a4[0]?.result?.state === "rejected" && a4[0].result.reason === "REJECTED" && String(a4[0].result.settlement) !== "undefined", `ingest unproven, refused by Arcade: rejected (${JSON.stringify(a4[0]?.result && { state: a4[0].result.state, reason: a4[0].result.reason })})`);

  // Reads: CIDs.
  const r5 = await send({ fn: "status", args: { txid: childTxid } });
  const a5 = (await answers(r5, 1, "status"))[0]!;
  check(a5.result?.state === "proven" && String(a5.result.tx).length > 10 && a5.result.height === 2, `status: proven, the tx and block CIDs (${a5.result?.state})`);
  const r6 = await send({ fn: "proof", args: { txid: childTxid } });
  const a6 = (await answers(r6, 1, "proof"))[0]!;
  check(a6.result?.height === 2 && a6.result.depth === 1 && a6.result.position === 0, `proof: block, height, depth, position (${JSON.stringify(a6.result && { height: a6.result.height, depth: a6.result.depth, position: a6.result.position })})`);
  const r7 = await send({ fn: "status", args: { txid: "00".repeat(32) } });
  check((await answers(r7, 1, "unknown"))[0]?.result?.state === "unknown", "status of a transaction it does not hold: unknown");
  const r8 = await send({ fn: "ingest", args: { beef: new Uint8Array([1, 2, 3]) } });
  const a8 = (await answers(r8, 1, "bad beef"))[0]!;
  check(a8.error?.code === "failed" && /InvalidBeef/.test(a8.error.message), `a bad BEEF: an error answer (${JSON.stringify(a8.error)})`);
  const r9 = await send({ fn: "nope", args: {} });
  check((await answers(r9, 1, "unknown fn"))[0]?.error?.code === "unknown-fn", "an unknown function: unknown-fn");

  // The same reads as a kernel call (no entry, no writes): dag-cbor in and out; ingest is a message only.
  const prog = (app!.programs as Record<string, CID>).chain!;
  const kc = await (await k()).invoke(prog, "status", dagCbor.encode({ txid: childTxid }));
  const kv = kc.ok ? dagCbor.decode(kc.result) as Record<string, unknown> : undefined;
  check(kv?.state === "proven" && kv.height === 2, `a kernel call of status: ${kc.ok ? JSON.stringify({ state: kv?.state, height: kv?.height }) : kc.error}`);
  const ki = await (await k()).invoke(prog, "ingest", dagCbor.encode({ beef: new Uint8Array(child.toBEEF()) }));
  check(!ki.ok && /IngestIsAMessage/.test(ki.error), `a kernel call of ingest is refused (its answers come later, by message): ${ki.ok ? "ok?" : ki.error}`);

  // At rest: nothing unproven, no broadcast registered.
  const fin = await (await k()).store.get((await (await k()).call("head", "chain/state")) as CID) as { maps: Record<string, CID | null> };
  check(fin.maps.unproven === null && fin.maps.broadcasts === null, "at rest: nothing unproven, no broadcast left registered");
  const dumped = dagCbor.encode(fin);
  check(dumped.length > 0, "chain/state readable by CID");

  // ------------------------------------------------ at boot: the chain app in a system tree
  // The stock system's files, the app's module, its two rows; its writes are the stock scope `chain/`.
  const sys = join(h.home, "system-chain");
  for (const [p, text] of Object.entries(await stockSystemFiles(await k()))) {
    mkdirSync(dirname(join(sys, p)), { recursive: true });
    writeFileSync(join(sys, p), text);
  }
  copyFileSync(join(process.env.SKEIN_CHAIN_DIR ?? cloneChain(h.home), "bin/chain.wasm"), join(sys, "bin/chain.wasm"));
  const conf = JSON.parse(readFileSync(join(sys, "etc/config.json"), "utf8")) as { defaults: Record<string, string>; scopes?: Record<string, string[]> };
  conf.defaults.walletNetwork = "regtest";
  check(JSON.stringify(conf.scopes?.chain) === '["chain/"]', `the stock scopes name chain/ for a genesis-wired chain program (${JSON.stringify(conf.scopes?.chain)})`);
  writeFileSync(join(sys, "etc/config.json"), JSON.stringify(conf));
  const rowsAt = JSON.parse(readFileSync(join(sys, "etc/dispatch.json"), "utf8")) as unknown[];
  rowsAt.push({ transport: "event", address: "chain", program: "chain" }, { address: "chain", filters: ["kernel.beef"], program: "chain" }, { address: "chain/status", program: "chain" });
  writeFileSync(join(sys, "etc/dispatch.json"), JSON.stringify(rowsAt));
  const bootId = h.instance("boot");
  const src = await dirSource(sys);
  await h.router.bootRow("boot", { kind: "tree", root: src.root, objects: src.objects });
  await new RawBox(h.owner, `${h.base}/@boot`).send(bootId, "peers", { op: "add", key: callerId, url: h.origin("caller") });
  for (const raw of [h1, h2]) await h.router.admitEvent("boot", "chain", { kind: "header", raw });
  await h.router.settled();
  const bootStore = h.db.get("boot")!.store;
  const bootBox = new RawBox(callerWallet, `${h.base}/@boot`);
  const child3 = new Transaction();
  child3.addInput({ sourceTransaction: fund, sourceOutputIndex: 2, unlockingScriptTemplate: new P2PKH().unlock(alice), sequence: 0xffffffff });
  child3.addOutput({ lockingScript: new P2PKH().lock(alice.toPublicKey().toHash()), satoshis: 7_000 });
  await child3.sign();
  const c3 = child3.id("hex");
  const rb = (await bootBox.send(bootId, "chain", { fn: "ingest", args: { beef: new Uint8Array(child3.toBEEF()) } })).id.toString();
  const ab = await answers(rb, 1, "accepted at boot");
  check(ab[0]?.result?.state === "accepted", `booted with the chain app: ingest unproven → broadcast → accepted (${ab[0]?.result?.state})`);
  const h3 = mine(sha256d(h2), internal(c3), 1_790_201_200);
  for (const hh of ["boot", "ch"]) await h.router.admitEvent(hh, "chain", { kind: "header", raw: h3 });
  await h.router.settled();
  arcade.emit(c3, { txStatus: "MINED", blockHash: display(sha256d(h3)), blockHeight: 3, merklePath: new MerklePath(3, [[{ offset: 0, hash: c3, txid: true }]]).toHex() });
  const ab2 = await answers(rb, 2, "proven at boot");
  check(ab2[1]?.result?.state === "proven" && ab2[1].result.height === 3, `… → proven (${ab2.map((x) => x.result?.state).join(" → ")})`);
  const bk = (await h.router.hydrate("boot")).kernel;
  const bootHeads = (await bk.call("head", "chain/state")) as CID | null;
  check(!!bootHeads, "the genesis-wired chain program wrote chain/state (the stock scope)");
  bootStores.push(bootStore);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  const [removeHome, ...rest] = afters;
  for (const f of rest.reverse()) await f();
  await arcade.close();
  for (const s of [store, ...bootStores]) {
    if (!s) continue;
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), s], { encoding: "utf8" });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${s === store ? "the installed" : "the booted"} instance's store replays to itself exactly`);
  }
  if (!process.env.KEEP) await removeHome?.();
}
process.stdout.write(failures ? `chain: ${failures} FAILED\n` : "chain: all ok\n");
process.exit(failures ? 1 : 0);
