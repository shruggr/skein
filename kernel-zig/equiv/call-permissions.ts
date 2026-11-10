// Call permissions end to end: one router, one instance `cp`, programs/test/perm-probe's module
// installed by the owner's messages as three apps — `pa` (calls pb as "1/amm pool", pc as "*"),
// `pb` (holds the signer service), `pc` (nothing) — and an image instance `ci` whose two apps carry
// their approvals into its genesis:
//
//   - a named call (callAs) the grants approve runs; the callee reads the name as `as`;
//   - an unapproved name is refused before the callee runs (an error to the caller, not a step error);
//   - "*" approves any name;
//   - a call with no name is today's call: the callee's input has no `as`;
//   - a launched thread and a messaged step see no `as`;
//   - a nested call does not inherit `as` — from a step and from a kernel call (cCall);
//   - the raw signer is refused to an app without the signer service, answered to one with it, and
//     the stock genesis's front door holds it (the handshake every owner message rides on);
//   - root's grant without a manifest (`skein grant add --calls`); a non-root `grant` refused;
//   - a caller's `as` inside its `arg` never reaches the callee's top level;
//   - a program record a step put: refused a named call, and refused as a named callee;
//   - a dotted app name (`pd.x`) with the signer service;
//   - an upgrade takes back what the grants head holds for the app and the new manifest does not
//     ask; an uninstall takes back everything the grants head holds for that name — never read
//     from the app's own record, which the app may rewrite (drop its `services`; take another
//     app's `name`);
//   - an image app's approvals come from the genesis;
//   - both stores replay to themselves exactly — on SQLite, and with SKEIN_EQUIV_STORE=rocksdb on RocksDB.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/call-permissions.ts

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { ownerCli, sendPlan, viewOf } from "../../src/testapps.ts";
import { planGrantCalls, planGrantService } from "../../src/client/admin.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Signer } from "../../src/host/signer.ts";
import { Router } from "../../src/host/router.ts";
import { openStoreFile } from "../../src/host/stores.ts";
import type { IndexStore } from "../../src/runtime/index-store.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { BACKEND, routerStore, specFor, storeFor } from "./backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-perm-"));
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

const wasm = join(here, "../../programs/test/perm-probe/bin/perm-probe.wasm");
function appTree(name: string, more: Record<string, unknown> = {}, at = join(home, "apps", name)): string {
  mkdirSync(join(at, "bin"), { recursive: true });
  mkdirSync(join(at, "etc"), { recursive: true });
  copyFileSync(wasm, join(at, "bin/perm-probe.wasm"));
  writeFileSync(join(at, "etc/app.json"), JSON.stringify({
    kind: "app", name, version: "0.1.0", programs: { probe: "bin/perm-probe.wasm" }, provides: [], requires: [],
    routes: [{ address: "", handler: "probe" }], description: `call permissions' test app ${name}: perm-probe's module`, ...more,
  }, null, 2));
  return at;
}

// The image `perm`: an overlay over the default image (no bin/) installing two apps at birth.
const images = join(home, "images");
appTree("ia", { calls: { ib: ["1/amm pool"] } }, join(images, "ia"));
appTree("ib", { services: ["signer"] }, join(images, "ib"));
mkdirSync(join(images, "perm", "etc"), { recursive: true });
writeFileSync(join(images, "perm", "etc/apps.json"), JSON.stringify({ install: ["../ia", "../ib"] }));

const ownerKey = new PrivateKey("3333", 16);
const owner = ownerKey.toPublicKey().toString();
const ownerWallet = ephemeralWallet(ownerKey);
const signer = new Signer(new PrivateKey("f1f2f3", 16));
const handle = "cp";
const hdb = new HostDb(join(home, "host.db"));
hdb.add(handle, { store: storeFor(home, handle) });
const lines: string[] = [];
const r = new Router({
  db: hdb, home, owner, idleMs: 0, walletFor: (row: { handle: string }) => signer.wallet(row.handle),
  providerKeyFor: (n: string) => signer.providerKey(n), peerKeyFor: (x: string) => signer.peerKey(x), answerWaitMs: 6000,
  kernel: { command: kernel, env: { SKEIN_HOME: home } }, imagesDir: images, ...routerStore(home),
  log: (s: string, l: string) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});

type Out = { op: string; ok?: boolean; answer?: Uint8Array; error?: string; as?: string | null; signed?: boolean; prev: CID | null };
type Who = { as?: string | null; signed?: boolean; error?: string; inner?: Uint8Array; ok?: boolean; answer?: Uint8Array };

try {
  await r.listen(0);
  const identity = (await r.hydrate(handle)).identity;
  const base = `http://127.0.0.1:${r.port}/@${handle}`;
  const cli = (argv: string[]) => ownerCli({ home, port: r.port!, owner: ownerWallet, settled: () => r.settled() }, argv);
  for (const [app, more] of [["pa", { calls: { pb: ["1/amm pool"], pc: "*" } }], ["pb", { services: ["signer"] }], ["pc", {}]] as const) {
    const o = await cli(["install", appTree(app, more), "--instance", handle]);
    await r.settled();
    check(o.code === 0, `skein install ${app}: exit ${o.code} ${o.err.join(" ")}`);
    if (app === "pa") check(o.out.some((l) => /grant\s+calls pb as "1\/amm pool"/.test(l)) && o.out.some((l) => /grant\s+calls pc as ANY NAME \(admin\)/.test(l)), "the install prompt reads pa's calls aloud");
    if (app === "pb") check(o.out.some((l) => /grant\s+holds service signer \(the raw signer import: any derivation\)/.test(l)), "the install prompt reads pb's service aloud");
  }
  const box = new RawBox(ownerWallet, base);
  const withStore = async <T>(spec: string, f: (st: IndexStore) => Promise<T>): Promise<T> => {
    const st = openStoreFile(spec, { readOnly: true }) as unknown as IndexStore;
    try { return await f(st); } finally { st.close(); }
  };
  const record = async (spec: string, c: CID) => withStore(spec, async (st) => dagCbor.decode(await st.bytes(c)) as Record<string, unknown>);
  const headRoot = (spec: string, name: string) => withStore(spec, async (st) => st.heads().find((x) => x.name === name)?.root);
  const progOf = async (spec: string, app: string): Promise<CID> => ((await record(spec, (await headRoot(spec, `${app}/app`))!)).programs as Record<string, CID>).probe!;
  const outOf = (app: string) => withStore(specFor(home, handle), async (st) => {
    const out: Out[] = [];
    const h = st.heads().find((x) => x.name === `${app}/out`);
    for (let c: CID | null = h ? h.root : null; c; ) { const v = dagCbor.decode(await st.bytes(c)) as Out; out.unshift(v); c = v.prev; }
    return out;
  });
  const last = async (app: string) => (await outOf(app)).at(-1)!;
  const probe = async (app: string, body: Record<string, unknown>) => { await box.send(identity, app, { kind: "probe", ...body }); await r.settled(); return await last(app); };
  const who = (o: Out): Who => (o.answer ? dagCbor.decode(o.answer) as Who : {});
  const spec = specFor(home, handle);
  const [pa, pb, pc] = [await progOf(spec, "pa"), await progOf(spec, "pb"), await progOf(spec, "pc")];

  // ------------------------------------------------ the grants record
  const grants = await record(spec, (await headRoot(spec, "grants"))!) as { calls?: Record<string, Record<string, string[]>>; services?: Record<string, string[]> };
  check(JSON.stringify(grants.calls?.pa) === JSON.stringify({ pb: ["1/amm pool"], pc: ["*"] }), `the grants' calls: pa → pb "1/amm pool", pc "*" (${JSON.stringify(grants.calls)})`);
  check(JSON.stringify(grants.services?.pb) === '["signer"]' && JSON.stringify(grants.services?.["genesis:frontdoor"]) === '["signer"]' && grants.services?.["genesis:wallet"] === undefined, `the grants' services: pb, and the stock genesis's front door at birth (0.7.0: no genesis wallet) (${JSON.stringify(grants.services)})`);

  // ------------------------------------------------ named calls from a step
  let o = await probe("pa", { op: "call", prog: pb, fn: "who", name: "1/amm pool" });
  check(o.ok === true && who(o).as === "1/amm pool", `an approved name: the call runs, the callee reads it as \`as\` (${JSON.stringify(who(o))})`);
  check(who(o).signed === true, "pb (the signer service) signs inside the named call");
  o = await probe("pa", { op: "call", prog: pb, fn: "who", name: "2/skein instance/self" });
  check(o.ok === false && /callAs: pa is not approved to call pb as "2\/skein instance\/self"/.test(o.error ?? ""), `an unapproved name is refused to the caller, the step goes on (${o.error})`);
  o = await probe("pa", { op: "call", prog: pc, fn: "who", name: "anything at all" });
  check(o.ok === true && who(o).as === "anything at all", `"*" approves any name (${JSON.stringify(who(o))})`);
  check(who(o).signed === false && /wallet: pc does not hold the signer service/.test(who(o).error ?? ""), `the raw signer refused to pc, no service (${who(o).error})`);
  o = await probe("pa", { op: "call", prog: pb, fn: "who" });
  check(o.ok === true && who(o).as === null, `a call with no name is today's: no \`as\` (${JSON.stringify(who(o))})`);
  o = await probe("pc", { op: "call", prog: pb, fn: "who", name: "1/amm pool" });
  check(o.ok === false && /callAs: pc is not approved to call pb/.test(o.error ?? ""), "an app with no approvals: every named call refused");
  o = await probe("pa", { op: "sign" });
  check(o.signed === false && /wallet: pa does not hold the signer service/.test(o.error ?? ""), `the raw signer refused to pa's own step (${o.error})`);
  o = await probe("pb", { op: "sign" });
  check(o.signed === true, "pb's own step signs (the service is its app's)");
  o = await probe("pa", { op: "call", prog: pb, fn: "nest", name: "1/amm pool", arg: { prog: pc } });
  const nest = who(o);
  check(o.ok === true && nest.as === "1/amm pool" && (dagCbor.decode(nest.inner!) as Who).as === null, `a nested plain call from a step does not inherit \`as\` (${JSON.stringify({ as: nest.as, inner: nest.inner ? dagCbor.decode(nest.inner) : null })})`);

  // ------------------------------------------------ launched and messaged: no `as`
  o = await probe("pa", { op: "launch", prog: pb });
  check(o.ok === true, "pa launches pb's program");
  const launched = await last("pb");
  check(launched.op === "launched" && launched.as === null, `the launched thread (pb's program, launched by pa's step) sees no \`as\` (${JSON.stringify({ op: launched.op, as: launched.as })})`);
  o = await probe("pa", { op: "mail", to: Uint8Array.from(Buffer.from(identity, "hex")), box: "pb" });
  check(o.ok === true, "pa sends the instance a message in pb's box");
  const seen = await last("pb");
  check(seen.op === "seen" && seen.as === null, `the messaged step sees no \`as\` (${JSON.stringify({ op: seen.op, as: seen.as })})`);

  // ------------------------------------------------ the kernel-call path (cCall)
  const l = await r.hydrate(handle);
  const call = async (prog: CID, fn: string, arg: Record<string, unknown>) => {
    const res = await l.kernel.invoke(prog, fn, dagCbor.encode(arg));
    return res.ok ? dagCbor.decode(res.result) as Who : { error: res.err } as Who;
  };
  let w = await call(pa, "callAs", { prog: pb, name: "1/amm pool", fn: "nest", arg: { prog: pc } });
  const wa = w.answer ? dagCbor.decode(w.answer) as Who : {};
  check(w.ok === true && wa.as === "1/amm pool" && (dagCbor.decode(wa.inner!) as Who).as === null, `a kernel call: the named call checked, its nested plain call inherits no \`as\` (${JSON.stringify({ ok: w.ok, as: wa.as, inner: wa.inner ? dagCbor.decode(wa.inner) : null, error: w.error })})`);
  w = await call(pa, "callAs", { prog: pb, name: "nope", fn: "who" });
  check(w.ok === false && /callAs: pa is not approved to call pb as "nope"/.test(w.error ?? ""), `a kernel call: an unapproved name refused (${w.error})`);
  w = await call(pb, "who", {});
  check(w.as === null && w.signed === true, `a kernel call into pb: no \`as\`, pb signs (${JSON.stringify(w)})`);
  w = await call(pc, "who", {});
  check(w.signed === false && /wallet: pc does not hold the signer service/.test(w.error ?? ""), "a kernel call into pc: the raw signer refused");

  // ------------------------------------------------ root's grant without a manifest
  const ih = { home, port: r.port!, owner: ownerWallet, settled: () => r.settled() };
  const grantBy = async (plan: (v: Awaited<ReturnType<typeof viewOf>>) => Parameters<typeof sendPlan>[2]) => { const v = await viewOf(ih, handle); try { return await sendPlan(ih, handle, plan(v)); } finally { v.close(); } };
  check(await grantBy((v) => planGrantCalls(v, "pa", "pb", "2/skein instance/self")) === 1, "root's grant without a manifest (planGrantCalls, `skein grant add --calls`): one message");
  await r.settled();
  o = await probe("pa", { op: "call", prog: pb, fn: "who", name: "2/skein instance/self" });
  check(o.ok === true && who(o).as === "2/skein instance/self", "the granted name now runs");
  check(await grantBy((v) => planGrantService(v, "pc", "signer")) === 1, "root's service grant (planGrantService, `skein grant add --service`): one message");
  await r.settled();
  o = await probe("pc", { op: "sign" });
  check(o.signed === true, "pc signs once root grants it the service");

  const grantsNow = async () => await record(spec, (await headRoot(spec, "grants"))!) as { calls?: Record<string, Record<string, string[]>>; services?: Record<string, string[]> };

  // ------------------------------------------------ a non-root grant is refused
  const stranger = ephemeralWallet(new PrivateKey("4444", 16));
  try { await new RawBox(stranger, base).send(identity, "grant", { op: "add", service: { caller: "pa", service: "signer" } }); } catch { /* refused at the gate */ }
  await r.settled();
  check(!(await grantsNow()).services?.pa, "a grant message from a key that is not root is refused (pa holds no service)");

  // ------------------------------------------------ `as` in the caller's arg is the callee's argument, not the name
  o = await probe("pa", { op: "call", prog: pb, fn: "who", arg: { as: "forged" } });
  check(o.ok === true && who(o).as === null, `a caller's \`as\` inside its arg does not reach the callee's top level (${JSON.stringify(who(o))})`);
  o = await probe("pa", { op: "call", prog: pb, fn: "who", name: "1/amm pool", arg: { as: "forged" } });
  check(o.ok === true && who(o).as === "1/amm pool", "… and under a named call the callee reads the kernel's name");

  // ------------------------------------------------ a program record a step put: no party
  const stray = (await probe("pa", { op: "putprog" }) as unknown as { prog: CID }).prog;
  w = await call(stray, "callAs", { prog: pb, name: "1/amm pool", fn: "who" });
  check(w.ok === false && /callAs: a named call needs an installed caller/.test(w.error ?? ""), `a step-put record makes no named call (${w.error})`);
  w = await call(pa, "callAs", { prog: stray, name: "1/amm pool", fn: "who" });
  check(w.ok === false && /callAs: \S+ is no installed app's program/.test(w.error ?? ""), `a step-put record is no named callee, whatever \`app\` it names (${w.error})`);

  // ------------------------------------------------ a dotted app name
  let d = await cli(["install", appTree("pd.x", { services: ["signer"] }), "--instance", handle]);
  await r.settled();
  check(d.code === 0, `skein install pd.x: exit ${d.code} ${d.err.join(" ")}`);
  check(JSON.stringify((await grantsNow()).services?.["pd.x"]) === '["signer"]', "pd.x holds the signer service");
  o = await probe("pd.x", { op: "sign" });
  check(o.signed === true, "pd.x signs");

  // ------------------------------------------------ upgrade and uninstall take back from the grants head
  d = await cli(["install", appTree("pa", { version: "0.2.0", calls: { pb: ["1/amm pool"] } }, join(home, "apps", "pa-0.2.0")), "--instance", handle]);
  await r.settled();
  check(d.code === 0 && d.out.some((l) => /grant\s+no longer calls pc as ANY NAME/.test(l)) && d.out.some((l) => /grant\s+no longer calls pb as "2\/skein instance\/self"/.test(l)), `the upgrade's prompt takes back pc "*" and the root-granted "2/skein instance/self" (${d.code} ${d.err.join(" ")})`);
  check(JSON.stringify((await grantsNow()).calls?.pa) === JSON.stringify({ pb: ["1/amm pool"] }), `after the upgrade pa calls pb as "1/amm pool" only (${JSON.stringify((await grantsNow()).calls?.pa)})`);
  // (A) an app drops `services` from its own record, then is uninstalled: the grants head still takes it back.
  d = await cli(["install", appTree("pz", { services: ["signer"] }), "--instance", handle]);
  await r.settled();
  check(d.code === 0, "skein install pz (the signer service)");
  o = await probe("pz", { op: "rewrite", drop: ["services"] });
  check(o.ok === true && !(await record(spec, (await headRoot(spec, "pz/app"))!)).services, "pz rewrites its own record without `services`");
  d = await cli(["uninstall", "pz", "--instance", handle]);
  await r.settled();
  check(d.code === 0 && !(await grantsNow()).services?.pz, `uninstall pz takes its signer service back from the grants head (${JSON.stringify((await grantsNow()).services)})`);
  // (B) an app names itself `pb` in its own record, then is uninstalled: pb keeps its service.
  d = await cli(["install", appTree("pw"), "--instance", handle]);
  await r.settled();
  o = await probe("pw", { op: "rewrite", name: "pb" });
  check(o.ok === true, "pw rewrites its own record's name to pb");
  d = await cli(["uninstall", "pw", "--instance", handle]);
  await r.settled();
  check(d.code === 0 && JSON.stringify((await grantsNow()).services?.pb) === '["signer"]', `uninstall pw leaves pb's service (${JSON.stringify((await grantsNow()).services)})`);

  // ------------------------------------------------ an image's apps: their approvals from the genesis
  await r.createInstance("ci", owner, { image: "perm", owned: true, publish: false });
  const ci = await r.hydrate("ci");
  const cspec = specFor(home, "ci");
  const cg = await withStore(cspec, async (st) => {
    for await (const { entry } of (st as unknown as { log: { entries(n: number): AsyncIterable<{ entry: { genesis?: CID } }> } }).log.entries(0)) return dagCbor.decode(await st.bytes(entry.genesis!)) as Record<string, unknown>;
    return {};
  });
  check(JSON.stringify(cg.calls) === JSON.stringify({ ia: { ib: ["1/amm pool"] } }) && JSON.stringify((cg.services as Record<string, string[]>)?.ib) === '["signer"]', `the image's genesis carries its apps' calls and services (${JSON.stringify({ calls: cg.calls, services: cg.services })})`);
  const [ia, ib] = [await progOf(cspec, "ia"), await progOf(cspec, "ib")];
  const res = await ci.kernel.invoke(ia, "callAs", dagCbor.encode({ prog: ib, name: "1/amm pool", fn: "who" }));
  const iw = res.ok ? dagCbor.decode(res.result) as Who : { error: res.err } as Who;
  const iwa = iw.answer ? dagCbor.decode(iw.answer) as Who : {};
  check(iw.ok === true && iwa.as === "1/amm pool" && iwa.signed === true, `in the image instance ia calls ib as "1/amm pool", ib signs (${JSON.stringify({ ...iw, answer: iwa })})`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await r.stop();
  hdb.close();
  for (const h of [handle, "ci"]) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), specFor(home, h)], { encoding: "utf8", env: { ...process.env, SKEIN_KERNEL_BIN: kernel } });
    process.stdout.write(rp.stdout);
    if (rp.status !== 0) process.stdout.write(rp.stderr);
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${h}: the store replays to itself exactly (${BACKEND})`);
  }
}

if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `call-permissions (${BACKEND}): ${failures} FAILED\n` : `call-permissions (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);
