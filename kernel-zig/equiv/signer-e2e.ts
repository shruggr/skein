// The signer app end to end on a real kernel (shruggr/skein branch `call-permissions`).
//
// Run from a skein checkout of that branch (the script imports its host code by relative path):
//
//   cp test/e2e.ts <skein>/kernel-zig/equiv/signer-e2e.ts
//   SIGNER_APP=<this repo> node --experimental-strip-types --no-warnings <skein>/kernel-zig/equiv/signer-e2e.ts
//
// Two instances, two ways of approving:
//   - `sg` (the stock genesis): the owner installs this app (`services: ["signer"]`) and a probe app
//     (skein's programs/test/perm-probe module) whose manifest asks `calls: {signer: ["1/amm pool",
//     "2/skein instance/self"]}`; the probe's steps call the signer app;
//   - `si` (an image): the same two apps installed at birth, their approvals in the genesis; the probe
//     is driven by kernel calls.
// Shown: the approved level-1 and level-2 names sign (the signature checked against the instance's
// own derivation); an unapproved name is refused by the KERNEL (the signer app never runs); an
// approved name with a request that does not match it is refused by the SIGNER APP; the probe
// calling the raw signer directly is refused by the kernel; a nameless level-1 request is refused
// and the identity key is served; both stores replay to themselves.

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey, PublicKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { ownerCli } from "../../src/testapps.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { Router } from "../../src/host/router.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import type { IndexStore } from "../../src/runtime/index-store.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { BACKEND, routerStore, specFor, storeFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const signerApp = process.env.SIGNER_APP ?? join(here, "../../../skein-signer");
const home = mkdtempSync(join(tmpdir(), "skein-signer-e2e-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

// ------------------------------------------------ the app trees
const probeWasm = join(here, "../../programs/test/perm-probe/bin/perm-probe.wasm");
const NAMES = ["1/amm pool", "2/skein instance/self"];
function probeTree(at: string): string {
  mkdirSync(join(at, "bin"), { recursive: true });
  mkdirSync(join(at, "etc"), { recursive: true });
  copyFileSync(probeWasm, join(at, "bin/perm-probe.wasm"));
  writeFileSync(join(at, "etc/app.json"), JSON.stringify({
    kind: "app", name: "probe", version: "0.1.0", programs: { probe: "bin/perm-probe.wasm" }, provides: [], requires: [],
    routes: [{ address: "", handler: "probe" }], calls: { signer: NAMES }, description: "the signer app's e2e probe (perm-probe's module)",
  }, null, 2));
  return at;
}
function signerTree(at: string): string {
  mkdirSync(at, { recursive: true });
  cpSync(join(signerApp, "etc"), join(at, "etc"), { recursive: true });
  cpSync(join(signerApp, "bin"), join(at, "bin"), { recursive: true });
  return at;
}
const images = join(home, "images");
signerTree(join(images, "signer"));
probeTree(join(images, "probe"));
mkdirSync(join(images, "signed", "etc"), { recursive: true });
writeFileSync(join(images, "signed", "etc/apps.json"), JSON.stringify({ install: ["../signer", "../probe"] }));

// ------------------------------------------------ BRC-100 request frames (ts-sdk WalletWireTransceiver layout)
const enc = (s: string) => [...new TextEncoder().encode(s)];
const str = (s: string) => { const b = enc(s); return [b.length, ...b]; };
const HASH = Array.from({ length: 32 }, (_, i) => i + 1);
/** createSignature over a 32-byte hash. */
const sigFrame = (level: number, protocol: string, keyID: string, cp: number[]) => Uint8Array.from([15, 0, level, ...str(protocol), ...str(keyID), ...cp, 0, 0xff, 2, ...HASH, 0]);
/** getPublicKey (not the identity key), forSelf none. */
const pubFrame = (level: number, protocol: string, keyID: string, cp: number[]) => Uint8Array.from([8, 0, 0, level, ...str(protocol), ...str(keyID), ...cp, 0, 0xff, 0xff, 0]);
const SELF = [11], ANYONE = [12];
const IDENTITY = Uint8Array.from([8, 0, 1, 0, 0xff, 0]);
const argOf = (frame: Uint8Array) => ({ frame });

type Ans = { frame?: Uint8Array; error?: string };
type Out = { op: string; ok?: boolean; answer?: Uint8Array; error?: string; signed?: boolean; prev: CID | null };

const ownerKey = new PrivateKey("4444", 16);
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("a1a2a3", 16));
const handle = "sg";
const hdb = new HostDb(join(home, "host.db"));
hdb.add(handle, { store: storeFor(home, handle) });
const r = new Router({
  db: hdb, home, owner, idleMs: 0, walletFor: (row: { handle: string }) => signer.wallet(row.handle),
  providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 6000,
  kernel: { command: kernel, env: { SKEIN_HOME: home } }, imagesDir: images, ...routerStore(home),
  log: (s: string, l: string) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});

const withStore = async <T>(spec: string, f: (st: IndexStore) => Promise<T>): Promise<T> => {
  const st = openStoreFile(spec, { readOnly: true }) as unknown as IndexStore;
  try { return await f(st); } finally { st.close(); }
};
const record = async (spec: string, c: CID) => withStore(spec, async (st) => dagCbor.decode(await st.bytes(c)) as Record<string, unknown>);
const headRoot = (spec: string, name: string) => withStore(spec, async (st) => st.heads().find((x) => x.name === name)?.root);
const progOf = async (spec: string, app: string, prog: string): Promise<CID> => ((await record(spec, (await headRoot(spec, `${app}/app`))!)).programs as Record<string, CID>)[prog]!;

/** Whether `frame` (a createSignature result) is a signature by the instance's own derivation. */
async function verifies(h: string, ans: Ans | undefined, level: 1 | 2, protocol: string, keyID: string, counterparty: "self" | "anyone"): Promise<boolean> {
  if (!ans?.frame || ans.frame[0] !== 0) return false;
  try {
    const { valid } = await signer.wallet(h).verifySignature({ protocolID: [level, protocol], keyID, counterparty, forSelf: true, hashToDirectlyVerify: HASH, signature: [...ans.frame.slice(1)] });
    return valid;
  } catch { return false; }
}
async function keyIs(h: string, ans: Ans | undefined, level: 1 | 2, protocol: string, keyID: string, counterparty: "self" | "anyone"): Promise<boolean> {
  if (!ans?.frame || ans.frame[0] !== 0 || ans.frame.length !== 34) return false;
  const { publicKey } = await signer.wallet(h).getPublicKey({ protocolID: [level, protocol], keyID, counterparty });
  return PublicKey.fromString(publicKey).toString() === Buffer.from(ans.frame.slice(1)).toString("hex");
}

try {
  await r.listen(0);
  const identity = (await r.hydrate(handle)).identity;
  const base = `http://127.0.0.1:${r.port}/@${handle}`;
  const cli = (argv: string[]) => ownerCli({ home, port: r.port!, owner: ownerWallet, settled: () => r.settled() }, argv);

  // ================================================ `sg`: installed by the owner
  for (const [name, tree] of [["signer", signerTree(join(home, "apps", "signer"))], ["probe", probeTree(join(home, "apps", "probe"))]] as const) {
    const o = await cli(["install", tree, "--instance", handle]);
    await r.settled();
    check(o.code === 0, `skein install ${name}: exit ${o.code} ${o.err.join(" ")}`);
    if (name === "signer") check(o.out.some((l) => /grant\s+holds service signer/.test(l)), "the signer app's install prompt reads its service aloud");
    if (name === "probe") check(NAMES.every((n) => o.out.some((l) => l.includes(`calls signer as "${n}"`))), "the probe's install prompt reads its two names aloud");
  }
  const spec = specFor(home, handle);
  const grants = await record(spec, (await headRoot(spec, "grants"))!) as { calls?: Record<string, Record<string, string[]>>; services?: Record<string, string[]> };
  check(JSON.stringify(grants.calls?.probe) === JSON.stringify({ signer: [...NAMES].sort() }) && JSON.stringify(grants.services?.signer) === '["signer"]', `grants: probe → signer ${JSON.stringify(grants.calls?.probe)}, services ${JSON.stringify(grants.services)}`);
  const sg = await progOf(spec, "signer", "signer");
  const box = new RawBox(ownerWallet, base);
  const last = () => withStore(spec, async (st) => { const h = st.heads().find((x) => x.name === "probe/out")!; return dagCbor.decode(await st.bytes(h.root)) as Out; });
  const step = async (body: Record<string, unknown>) => { await box.send(identity, "probe", { kind: "probe", ...body }); await r.settled(); return await last(); };
  const viaSigner = async (name: string | undefined, frame: Uint8Array) => {
    const o = await step({ op: "call", prog: sg, fn: "wallet", ...(name ? { name } : {}), arg: argOf(frame) });
    return { o, ans: o.answer ? dagCbor.decode(o.answer) as Ans : undefined };
  };

  let x = await viaSigner("1/amm pool", sigFrame(1, "amm pool", "k1", ANYONE));
  check(x.o.ok === true && await verifies(handle, x.ans, 1, "amm pool", "k1", "anyone"), `step: level 1 under "1/amm pool" signs, the signature the instance's [1,"amm pool"] k1 key's (${x.o.error ?? x.ans?.error ?? "signed"})`);
  x = await viaSigner("2/skein instance/self", pubFrame(2, "skein instance", `libp2p:${handle}`, SELF));
  check(x.o.ok === true && await keyIs(handle, x.ans, 2, "skein instance", `libp2p:${handle}`, "self"), `step: level 2 under "2/skein instance/self" answers the derived key (${x.o.error ?? x.ans?.error ?? "key"})`);
  x = await viaSigner("2/skein instance/self", pubFrame(2, "skein instance", `libp2p:${handle}`, [...Buffer.from(identity, "hex")]));
  check(x.o.ok === true && !!x.ans?.frame, `step: the identity key written as the counterparty is "self" (${x.ans?.error ?? "key"})`);
  x = await viaSigner("1/amm commission", sigFrame(1, "amm commission", "relay", ANYONE));
  check(x.o.ok === false && /callAs: probe is not approved to call signer as "1\/amm commission"/.test(x.o.error ?? ""), `step: an unapproved name is refused by the kernel (${x.o.error})`);
  x = await viaSigner("1/amm pool", sigFrame(1, "amm commission", "relay", ANYONE));
  check(x.o.ok === true && /needs "1\/amm commission"/.test(x.ans?.error ?? ""), `step: an approved name with a request that is not its own is refused by the signer app (${x.ans?.error})`);
  x = await viaSigner("2/skein instance/self", pubFrame(2, "skein instance", "k", ANYONE));
  check(x.o.ok === true && /needs "2\/skein instance\/anyone"/.test(x.ans?.error ?? ""), `step: level 2 for another counterparty is refused by the signer app (${x.ans?.error})`);
  x = await viaSigner(undefined, sigFrame(1, "amm pool", "k1", ANYONE));
  check(x.o.ok === true && /served only under a name/.test(x.ans?.error ?? ""), `step: a nameless level-1 request is refused (${x.ans?.error})`);
  x = await viaSigner(undefined, IDENTITY);
  check(x.o.ok === true && x.ans?.frame?.[0] === 0 && Buffer.from(x.ans.frame.slice(1)).toString("hex") === identity, "step: the identity key needs no name");
  const raw = await step({ op: "sign" });
  check(raw.signed === false && /wallet: probe does not hold the signer service/.test(raw.error ?? ""), `step: the probe calling the raw signer directly is refused by the kernel (${raw.error})`);

  // ================================================ `si`: an image, approvals at birth
  await r.createInstance("si", owner, { image: "signed", owned: true, publish: false });
  const si = await r.hydrate("si");
  const cspec = specFor(home, "si");
  const cg = await withStore(cspec, async (st) => {
    for await (const { entry } of (st as unknown as { log: { entries(n: number): AsyncIterable<{ entry: { genesis?: CID } }> } }).log.entries(0)) return dagCbor.decode(await st.bytes(entry.genesis!)) as Record<string, unknown>;
    return {};
  });
  check(JSON.stringify(cg.calls) === JSON.stringify({ probe: { signer: NAMES } }) && JSON.stringify((cg.services as Record<string, string[]>)?.signer) === '["signer"]', `the image's genesis: ${JSON.stringify({ calls: cg.calls, services: cg.services })}`);
  const [cprobe, csigner] = [await progOf(cspec, "probe", "probe"), await progOf(cspec, "signer", "signer")];
  const kcall = async (name: string, frame: Uint8Array) => {
    const res = await si.kernel.invoke(cprobe, "callAs", dagCbor.encode({ prog: csigner, name, fn: "wallet", arg: argOf(frame) }));
    const w = res.ok ? dagCbor.decode(res.result) as { ok?: boolean; answer?: Uint8Array; error?: string } : { error: res.err };
    return { w, ans: w.answer ? dagCbor.decode(w.answer) as Ans : undefined };
  };
  let k = await kcall("1/amm pool", sigFrame(1, "amm pool", "k2", ANYONE));
  check(k.w.ok === true && await verifies("si", k.ans, 1, "amm pool", "k2", "anyone"), `image, kernel call: level 1 signs (${k.w.error ?? k.ans?.error ?? "signed"})`);
  k = await kcall("2/skein instance/self", pubFrame(2, "skein instance", "libp2p:si", SELF));
  check(k.w.ok === true && await keyIs("si", k.ans, 2, "skein instance", "libp2p:si", "self"), `image, kernel call: level 2 answers the derived key (${k.w.error ?? k.ans?.error ?? "key"})`);
  k = await kcall("*", sigFrame(2, "auth message signature", "a b", ANYONE));
  check(k.w.ok === false && /callAs: probe is not approved to call signer as "\*"/.test(k.w.error ?? ""), `image, kernel call: "*" not approved → refused by the kernel (${k.w.error})`);
  const direct = await si.kernel.invoke(cprobe, "who", dagCbor.encode({}));
  const dw = direct.ok ? dagCbor.decode(direct.result) as { signed?: boolean; error?: string } : { error: direct.err };
  check(dw.signed === false && /wallet: probe does not hold the signer service/.test(dw.error ?? ""), `image, kernel call: the probe's raw signer refused (${dw.error})`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await r.stop();
  hdb.close();
  for (const h of [handle, "si"]) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), specFor(home, h)], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL_BIN: kernel, SKEIN_KERNEL: kernel } });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${h}: the store replays to itself exactly (${BACKEND})`);
  }
}

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `signer e2e (${BACKEND}): ${failures} FAILED\n` : `signer e2e (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);
