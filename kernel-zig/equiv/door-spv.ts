// The BEEF proven at the door, always (#121; the door-audit branch's cases, a08e0ac): kernel.beef
// proves every BEEF with skein-sdk's verifier (chain/src/spv.zig) over the BEEF alone. A genesis
// whose event route `deploy`, http route POST /submit and mailbox route `admin` each name
// kernel.beef (the call probe their handler). Before any chain state: refused ("no chain state").
// Root sets chain/state (block 170's header); then on all three transports an Atomic BEEF with no
// BUMP whose subject's parent is in no BEEF and not held: 400 ERR_BEEF "MissingInput", no entry,
// no block. A txid-only parent: "UnknownTxidOnly". A BUMP that does not check: "RootMismatch".
// Block 170's spend with its BUMP: admitted, its BUMP proving it. Root sets chain/state to a header
// at 200 whose merkle root a parent's BUMP gives (output 0 OP_TRUE): the parent with an unmined
// child spending it, in one BEEF, admitted on event and http, marks [0, null], the BUMP proving the
// parent only (the verifier's proven [true, false]); a child spending its OP_FALSE output:
// "ScriptFailed". Replayed. On SQLite (serve) and, with SKEIN_EQUIV_STORE=rocksdb, on RocksDB.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/door-spv.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import type { CID } from "multiformats/cid";
import { signMessage } from "../../src/client/raw.ts";
import { appendRequest, cidOf, httpRecord } from "../../src/host/frontdoor.ts";
import { writeGenesis } from "../../src/host/genesis.ts";
import { DoorAnswered, Kernel, KernelHost } from "../../src/host/kernel.ts";
import { beef170, chainState170, TX_170 } from "../../src/host/testbeef.ts";
import { BITCOIN_BLOCK, BITCOIN_TX, hashCid } from "../../src/runtime/bitcoin.ts";
import { encode } from "../../src/runtime/cid.ts";
import { rawCid } from "../../src/runtime/programs.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { BACKEND, ROCKS_MODE, specFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-doorspv-"));
const handle = "doorspv";
const key = new PrivateKey("e7e7", 16), identity = key.toPublicKey().toString();
const ownerKey = new PrivateKey("0e0e", 16), owner = ownerKey.toPublicKey().toString();

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const out = (l: string) => process.stdout.write(l + "\n");
const log = (l: string) => { if (process.env.VERBOSE) out(`  | [${handle}] ${l}`); };
const sha256d = (b: Uint8Array) => Uint8Array.from(createHash("sha256").update(createHash("sha256").update(b).digest()).digest());
const txCid = (raw: Uint8Array) => hashCid(BITCOIN_TX, sha256d(raw));
const cat = (...xs: ArrayLike<number>[]) => Uint8Array.from(xs.flatMap((x) => Array.from(x)));

/** TX_170 with its locktime's last byte changed: well formed, its parent (0437cd7f…:0) in no BEEF and not held. */
function variant(n: number): Uint8Array { const t = Uint8Array.from(TX_170); t[t.length - 1] = n; return t; }
/** Atomic BEEF (BRC-95) over BEEF V1: no BUMP, one raw transaction. */
const atomicNoBump = (raw: Uint8Array) => cat([1, 1, 1, 1], sha256d(raw), [1, 0, 0xbe, 0xef, 0, 1], raw, [0]);
/** One input (prev:vout, an empty unlocking script), outputs of 1000 sat with the locking scripts given. */
function txOf(prev: Uint8Array, vout: number, locks: number[][]): Uint8Array {
  return cat([1, 0, 0, 0, 1], prev, [vout, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, locks.length], ...locks.map((l) => [0xe8, 3, 0, 0, 0, 0, 0, 0, l.length, ...l]), [0, 0, 0, 0]);
}

const spec = specFor(home, handle);
let host: KernelHost | undefined;
let k: Kernel;
if (ROCKS_MODE) {
  host = KernelHost.acquire(join(home, "store-rocksdb"), { command: kernel, env: { SKEIN_HOME: home }, log });
  k = await host.open({ db: spec, handle, domain: "localhost", wallet: ephemeralWallet(key), log }) as unknown as Kernel;
} else {
  mkdirSync(dirname(spec), { recursive: true });
  k = new Kernel({ db: spec, handle, domain: "localhost", wallet: ephemeralWallet(key), command: kernel, env: { SKEIN_HOME: home }, log });
}
const tip = async () => (await k.store.log.tip())?.toString();
const answer = async (p: Promise<CID>): Promise<{ admitted?: CID; text: string }> => {
  try { const c = await p; return { admitted: c, text: `ADMITTED entry ${c}` }; } catch (e) {
    return { text: e instanceof DoorAnswered ? `REFUSED ${e.answer.status} ${e.answer.code} "${e.answer.reason}"` : `ERROR ${(e as Error).message}` };
  }
};

try {
  const probeWasm = readFileSync(join(here, "../test/call/probe.wasm"));
  const pm = rawCid(probeWasm);
  await k.putBlock(pm, probeWasm);
  const probe = (await k.store.put({ kind: "program", name: "probe", code: { wasm: pm }, inputs: {}, services: [], description: "the call probe" } as never) as CID).toString();
  await writeGenesis(k, {
    identity, root: [owner], handle, domain: "localhost",
    dispatch: [
      { transport: "event", address: "deploy", filters: ["kernel.beef"], program: probe },
      { transport: "http", address: "/submit", filters: ["kernel.beef"], program: probe },
      { transport: "mailbox", address: "admin", filters: ["kernel.beef"], program: probe },
    ],
    scopes: { probe: ["probe"] },
  });
  await k.start();
  await k.idle();

  const admin = async (box: string, body: unknown) => {
    const m = await signMessage(ephemeralWallet(ownerKey), { recipient: identity, box, body: dagCbor.encode(body) });
    const c = await appendRequest(k, "local", { kind: "message", ...m });
    await k.idle();
    return c;
  };
  type Via = "event" | "http" | "mailbox";
  const via = (t: Via, beef: Uint8Array): Promise<CID> => {
    if (t === "event") { const ev = { kind: "deploy", beef }; return k.admit({ box: "deploy", event: cidOf(ev) } as never, { event: ev }); }
    if (t === "http") return appendRequest(k, "http", httpRecord({ method: "POST", path: "/submit", query: "", headers: { "content-type": "application/octet-stream" }, body: beef } as never));
    return admin("admin", { fn: "enable", args: { beef } });
  };
  /** A refusal: its answer printed, 400 ERR_BEEF with `name` first, the log tip unmoved, `absent` not stored. */
  const refusal = async (what: string, t: Via, beef: Uint8Array, name: string | RegExp, absent: CID[] = []) => {
    const t0 = await tip();
    const a = await answer(via(t, beef));
    await k.idle();
    out(`  ${what} [${t}]: ${a.text}`);
    const re = typeof name === "string" ? new RegExp(`^${name}\\b`) : name;
    const m = /^REFUSED (\d+) (\S+) "(.*)"$/s.exec(a.text);
    check(!!m && m[1] === "400" && m[2] === "ERR_BEEF" && re.test(m[3]!), `${what} [${t}]: refused 400 ERR_BEEF ${re}`);
    const stored = await Promise.all(absent.map((c) => k.hasBlock(c)));
    check(await tip() === t0 && !stored.some(Boolean), `${what} [${t}]: no entry, nothing stored`);
  };
  /** An admission: the pointer record the entry's package links. */
  const admitted = async (what: string, t: Via, beef: Uint8Array) => {
    const a = await answer(via(t, beef));
    await k.idle();
    out(`  ${what} [${t}]: ${a.text}`);
    check(!!a.admitted, `${what} [${t}]: admitted`);
    if (!a.admitted) return undefined;
    const e = await k.store.get(a.admitted) as { event?: CID; request?: CID };
    const rec = await k.store.get((e.event ?? e.request)!) as { beef?: { beef?: CID }; body?: { beef?: CID } };
    const ptr = (rec.beef ?? rec.body)?.beef;
    const p = ptr ? await k.store.get(ptr) as { txs: CID[]; marks: unknown[]; bumps: Array<{ block: CID | null; proves: number[] }> } : undefined;
    if (p) out(`    pointer ${dagJson.stringify(p)}`);
    return p;
  };

  const Z = variant(0x09);
  out("[control 0] no chain/state:");
  await refusal("an unproven Atomic BEEF", "event", atomicNoBump(Z), /no chain state/, [txCid(Z)]);

  const cs = chainState170();
  await admin("objects", { records: cs.blocks.map((b) => ({ cid: b.cid, bytes: b.bytes })) });
  await admin("head", { name: "chain/state", tree: cs.state });
  check(((await k.call("head", "chain/state")) as CID | null)?.equals(cs.state) === true, "root set chain/state (block 170's header)");

  out("\n[1–3] an Atomic BEEF, no BUMP, its subject's parent (0437cd7f…:0) in no BEEF and not held:");
  for (const [i, t] of (["event", "http", "mailbox"] as Via[]).entries()) {
    const A = variant(i + 1);
    await refusal("no BUMP, parent absent", t, atomicNoBump(A), "MissingInput", [txCid(A)]);
  }

  out("\n[4] a BEEF V2 whose parent is a txid-only entry:");
  const C = variant(0x05);
  // TX_170's input spends 0437cd7f…:0; C is TX_170 with another locktime: same input. A txid-only entry for that parent.
  const prevOf170 = TX_170.slice(5, 37);
  await refusal("txid-only parent", "event", cat([2, 0, 0xbe, 0xef, 0, 2, 2], prevOf170, [0], C), "UnknownTxidOnly", [txCid(C)]);

  out("\n[5] a BUMP that does not check:");
  await refusal("bad BUMP", "event", beef170({ bad: true }), "RootMismatch");

  out("\n[6] block 170's spend with its BUMP (proven in the BEEF):");
  const p6 = await admitted("proven", "event", beef170());
  check(!!p6 && p6.marks.length === 1 && p6.marks[0] === 0 && JSON.stringify(p6.bumps[0]!.proves) === "[0]" && !!p6.bumps[0]!.block, "proven: marks [0], its BUMP proves it, checked against block 170's header");

  // A parent mined at 200 beside a sibling: output 0 OP_TRUE, output 1 OP_FALSE; a header at 200 whose root its BUMP gives.
  const parent = txOf(new Uint8Array(32).fill(0x11), 0, [[0x51], [0x00]]);
  const ptxid = sha256d(parent);
  const sib = new Uint8Array(32).fill(0x22);
  const bump = cat([0xc8, 1, 2, 0, 0], sib, [1, 2], ptxid);
  const header = new Uint8Array(80);
  header[0] = 1;
  header.set(sha256d(cat(sib, ptxid)), 36);
  const hdr = { cid: hashCid(BITCOIN_BLOCK, sha256d(header)), bytes: header };
  const hkey = new Uint8Array(4);
  new DataView(hkey.buffer).setUint32(0, 200);
  const node = encode([null, [[hkey, hdr.cid, null]]]);
  const state = encode({ kind: "chain-state", network: "main", maps: { headers: node.cid } });
  await admin("objects", { records: [hdr, node, state].map((b) => ({ cid: b.cid, bytes: b.bytes })) });
  await admin("head", { name: "chain/state", tree: state.cid });
  check(((await k.call("head", "chain/state")) as CID | null)?.equals(state.cid) === true, "root set chain/state (a header at 200)");

  out("\n[7] a proven parent and its unmined child (spending output 0, OP_TRUE) in one BEEF V1:");
  for (const [i, t] of (["event", "http"] as Via[]).entries()) {
    const child = txOf(ptxid, 0, [[0x51, ...Array(i).fill(0x51)]]);
    const p = await admitted("parent + unmined child", t, cat([1, 0, 0xbe, 0xef, 1], bump, [2], parent, [1, 0], child, [0]));
    check(!!p && JSON.stringify(p.marks) === "[0,null]" && JSON.stringify(p.bumps[0]!.proves) === "[0]" && p.bumps[0]!.block?.equals(hdr.cid) === true, `[${t}] marks [0, null]: the BUMP proves the parent only (proven [true, false]), checked against the header at 200`);
    check(await k.hasBlock(txCid(child)), `[${t}] the child held as its bitcoin-tx block`);
  }

  out("\n[8] a child spending the parent's output 1 (OP_FALSE):");
  const fails = txOf(ptxid, 1, [[0x51]]);
  await refusal("script fails", "event", cat([1, 0, 0xbe, 0xef, 1], bump, [2], parent, [1, 0], fails, [0]), "ScriptFailed", [txCid(fails)]);
} catch (err) {
  check(false, `the scenario ran: ${(err as Error).stack}`);
} finally {
  await k.stop();
  await host?.release();
}

const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), spec], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL_BIN: kernel } });
process.stdout.write(r.stdout);
if (r.status !== 0) process.stdout.write(r.stderr);
check(r.status === 0, `the store replays to itself exactly (${BACKEND})`);

rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `door-spv (${BACKEND}): ${failures} FAILED\n` : `door-spv (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);
