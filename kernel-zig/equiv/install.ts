// Installing apps (#72, #76, #79) end to end, as the owner's messages (#124,
// #142: src/client/admin.ts, sent on the owner's session; src/testapps.ts
// ownerCli; the owner's root read by `skein reads` over the control socket), into an
// instance of the stock system on a router:
//
//   skein-site (shruggr/skein-site at the commit src/testapps.ts pins, cloned
//   by the install itself; or $SKEIN_SITE_DIR; 0.7.3, #125): the head
//   `site/app` is the app record (the manifest as installed, linking the
//   tree; no alias head), its one read (#135, `reads[]`) is served under
//   /site/ (the files of its own tree's www) by a call, out of the reads head
//   — no dispatch row, no entry; the owner's own read puts the same function
//   at `/` (`skein reads add`), which an uninstall leaves; a read at a
//   row's path refused; uninstalled, its reads are gone.
//
//   programs/test/app-demo (a counter over the SDK's dispatch helper): its
//   start message schedules a heartbeat with the cron provider, whose tick
//   reaches it in `app-demo/tick` (admitted from $cron only: a stranger's is
//   not); a {fn, args} message from a caller in box `app-demo` is answered in
//   the caller's mailbox (result, bad-args, read-only for a `writes: false`
//   function that writes, unknown-fn); its `peers` message to the kernel, sent
//   as the instance itself, is refused (#87: no row admits a program to a
//   kernel table; recorded, nothing runs, the address book unchanged); a
//   program record it puts itself, claiming app chain (or the name wallet),
//   called or launched, runs but its advance is refused (K1: not installed),
//   while its own installed record still advances app-demo/…; the route /app-demo/call answers on the
//   connection; an install over itself keeps its state; uninstalled, its stop
//   runs and its route is gone.
//
// The instance's store then replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/install.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { adminMain } from "../../src/client/admin-cli.ts";
import { main } from "../../src/host/cli.ts";
import { ownerCli, SITE_APP } from "../../src/testapps.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = join(here, "../../programs/test/app-demo");
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

const afters: Array<() => unknown> = [];
const h = await testHost({ after: (f) => afters.push(f) });
const work = mkdtempSync(join(tmpdir(), "skein-kz-install-"));
let store = "";
try {
  // The caller: an identity with a mailbox instance here, in the instance's address book.
  const callerKey = PrivateKey.fromRandom(), callerId = callerKey.toPublicKey().toString();
  const caller = ephemeralWallet(callerKey);
  h.mailbox("caller", callerId);
  const inst = h.instance("inst");
  await h.router.start();
  const owner = new RawBox(h.owner, `${h.base}/@inst`);
  await owner.send(inst, "peers", { op: "add", key: callerId, url: h.origin("caller") });
  await h.router.settled();
  store = h.db.get("inst")!.store;

  const out: string[] = [], err: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    // #124: install/uninstall are the owner's messages, planned (`skein plan`) and sent to /sendMessage (src/testapps.ts ownerCli).
    const o = args[0] === "install" || args[0] === "uninstall" ? await ownerCli({ home: h.home, port: h.router.port!, owner: h.owner, settled: () => h.router.settled() }, args) : undefined;
    if (o) { out.push(...o.out); err.push(...o.err); }
    const code = o ? o.code : await main(args, {
      vars: { SKEIN_HOME: h.home, HOME: h.home }, out: (l) => out.push(l), err: (l) => err.push(l),
    });
    await h.router.settled();
    if (process.env.VERBOSE) for (const l of [...out, ...err]) process.stdout.write(`  | ${l}\n`);
    return code;
  };
  const k = async () => (await h.router.hydrate("inst")).kernel;
  const record = async (name: string) => {
    const kk = await k();
    const root = await kk.call("head", name) as CID | null;
    return root ? await kk.store.get(root) as Record<string, unknown> : undefined;
  };
  const get = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${h.base}/@inst${path}`, { redirect: "manual", ...init });
    return { status: r.status, body: await r.text() };
  };

  // ------------------------------------------------ skein-site, from its repo (#125)
  const siteSpec = SITE_APP.dir ?? `${SITE_APP.repo}#${SITE_APP.rev}`;
  let code = await cli("install", siteSpec, "--instance", "inst", "--dry-run");
  check(code === 0 && out.some((l) => l.includes("read      /site/* → site.get (root www) (anyone, by a call: nothing logged)")) && !out.some((l) => l.startsWith("  row ")), `the prompt shows the site's read under /site/, and no row (${code}: ${out.filter((l) => /^ {2}(row|read) /.test(l)).join(" | ")})`);
  check((await record("site/app")) === undefined, "a dry run sends nothing");
  code = await cli("install", siteSpec, "--instance", "inst");
  check(code === 0, `skein plan install skein-site, sent to /sendMessage as the owner: exit ${code} ${err.join(" ")}`);
  const st = await record("site/app");
  check(st?.kind === "app" && st.name === "site" && !!st.tree && !!(st.programs as Record<string, unknown>)?.site && st.version === "0.7.7" && (await record("site")) === undefined, `the head site/app is the app record (0.7.7), linking the tree and the program record; no alias head \`site\` (#79) (${JSON.stringify(st && { kind: st.kind, name: st.name, version: st.version })})`);
  const appRows = async (app: string) => ((await (await k()).dispatch()).rows as Array<Record<string, unknown>>).filter((r) => r.app === app).map((r) => `${r.transport} ${r.address}${r.prefix ? "*" : ""}`);
  const appReads = async (app?: string) => (((await record("reads"))?.reads ?? []) as Array<Record<string, unknown>>).filter((x) => x.app === app).map((x) => `${x.address}${x.prefix ? "*" : ""} ${String(x.fn)}`);
  check((await appRows("site")).length === 0 && (await appReads("site")).join(",") === "/site/* get", `#135: the site's read in the reads head, no dispatch row: ${(await appReads("site")).join(", ")} · rows ${(await appRows("site")).join(", ")}`);
  const n0 = await h.entries("inst");
  let r = await get("/site/");
  check(r.status === 200 && r.body.includes('src="app.js"'), `GET /site/: its own tree's www/index.html (${r.status})`);
  r = await get("/site/app.js");
  check(r.status === 200 && r.body.includes("skein-locators"), `GET /site/app.js: the page's script (${r.status})`);
  r = await get("/");
  check(r.status === 404, `GET / : nothing at the root until the owner says so (${r.status})`);
  check(await h.entries("inst") === n0, `#135: a read is no entry, nor is an unsigned 404 (${(await h.entries("inst")) - n0})`);

  // ------------------------------------------------ app-demo: start, ticks, calls
  code = await cli("install", demoDir, "--instance", "inst");
  check(code === 0 && out.some((l) => l.startsWith("  row       mailbox app-demo/tick from $cron → demo")), `skein plan install app-demo: exit ${code} ${err.join(" ")}`);
  const state = async () => {
    const rec = await record("app-demo/app");
    return rec?.state ? await (await k()).store.get(rec.state as CID) as { count: number; ticks: number } : undefined;
  };
  const ticked = await until("the first tick", async () => { await h.router.settled(); const s = await state(); return s && s.ticks >= 1 ? s : undefined; }, 20_000).catch(() => undefined);
  check(!!ticked, `the start message scheduled a heartbeat with the cron provider, and its tick reached app-demo/tick from $cron (ticks ${ticked?.ticks})`);
  check(h.lines.some((l) => /cron: beat \(app-demo\/tick every 3600000 ms\) scheduled/.test(l)), "the cron provider took the schedule (beat, every hour)");

  // A stranger's "tick" is not admitted (only $cron's row takes app-demo/tick).
  const strangerKey = PrivateKey.fromRandom();
  const refused = await new RawBox(ephemeralWallet(strangerKey), `${h.base}/@inst`).send(inst, "app-demo/tick", { kind: "cron", name: "fake", due: 0 }).then(() => "sent", (e: Error) => e.message);
  await h.router.settled();
  check(/403 ERR_NOT_SUBSCRIBED/.test(refused) && (await state())?.ticks === ticked?.ticks, `a stranger's message into app-demo/tick is refused, and runs nothing (${refused})`);

  // Calls by message: answered in the caller's mailbox.
  const callerBox = new RawBox(caller, `${h.base}/@inst`);
  const mine = new RawBox(caller, h.origin("caller"));
  const ask = async (body: Record<string, unknown>) => {
    const id = (await callerBox.send(inst, "app-demo", body)).id.toString();
    const m = await until(`the answer to ${JSON.stringify(body)}`, async () => {
      await h.router.settled();
      return (await mine.list("app-demo")).find((x) => String((x.value as { request?: unknown }).request) === id);
    }, 20_000);
    return m.value as { fn: string; replyTo?: unknown; result?: { count: number }; error?: { code: string; message: string } };
  };
  let a = await ask({ fn: "demo.counter.add", args: { by: 5, note: "first" } });
  check(a.fn === "demo.counter.add" && a.result?.count === 5 && !!a.replyTo, `demo.counter.add {by: 5} → {count: 5}, answered to the sender (${JSON.stringify(a)})`);
  a = await ask({ fn: "demo.counter.get" });
  check(a.result?.count === 5, `demo.counter.get → {count: 5} (${JSON.stringify(a.result)})`);
  a = await ask({ fn: "demo.counter.add", args: { by: "5" } });
  check(a.error?.code === "bad-args" && /args\.by: want int/.test(a.error.message), `args checked against the shape: ${JSON.stringify(a.error)}`);
  a = await ask({ fn: "demo.counter.peek" });
  check(a.error?.code === "read-only" && /writes: false, and it called put/.test(a.error.message), `a writes: false function that writes is refused: ${JSON.stringify(a.error)}`);
  a = await ask({ fn: "demo.counter.nope" });
  check(a.error?.code === "unknown-fn", `an undeclared function: ${JSON.stringify(a.error)}`);
  check((await state())?.count === 5, "the refused calls changed nothing");

  // #87: a program's `peers` message to the kernel is refused. app-demo emits the kernel's `peers`
  // operation as the instance itself (any program can); no row admits the instance's key to an admin
  // box, so the message is recorded (the loopback's `local` request, then the message) and runs nothing.
  const intruder = PrivateKey.fromRandom().toPublicKey().toString();
  const peersBefore = await record("peers");
  const linesBefore = h.lines.length;
  await callerBox.send(inst, "app-demo", { kind: "app-demo-peers", key: intruder, url: "http://intruder.test" });
  const noRow = await until("the program's peers message", async () => {
    await h.router.settled();
    return h.lines.slice(linesBefore).find((l) => l.startsWith("[inst] ") && / in peers from [0-9a-f]+: no dispatch row; recorded, nothing runs/.test(l));
  }, 20_000).catch(() => undefined);
  check(!!noRow, `a program's message to the kernel's \`peers\` box (sent as the instance) finds no row: recorded, nothing runs (${noRow ?? h.lines.slice(linesBefore).filter((l) => l.includes("peers")).join(" | ")})`);
  check(!h.lines.slice(linesBefore).some((l) => l.includes("kernel peers:")), "the kernel's peers operation did not run");
  const peersAfter = await record("peers");
  const book = peersAfter ? await Promise.all(((peersAfter.peers ?? []) as Array<{ peer: CID }>).map(async (p) => await (await k()).store.get(p.peer) as { key: Uint8Array })) : [];
  check(String(peersAfter && JSON.stringify(peersAfter)) === String(peersBefore && JSON.stringify(peersBefore)) && !book.some((p) => Buffer.from(p.key).toString("hex") === intruder), "the address book is unchanged: the intruder's key is not in it");

  // K1: a write scope comes only from a program record the owner installed (a dispatch row's
  // program, one listed in its app's record at <app>/app, a genesis program). app-demo puts a
  // record of its own module claiming another app (or a genesis-wired name) and calls or launches
  // it: the record runs, and its advance is refused. Its own installed record still writes app-demo/….
  const forge = async (body: Record<string, unknown>, want: RegExp, what: string) => {
    const before = h.lines.length;
    await callerBox.send(inst, "app-demo", { kind: "app-demo-forge", ...body });
    const line = await until(what, async () => {
      await h.router.settled();
      return h.lines.slice(before).find((l) => l.startsWith("[inst] ") && want.test(l));
    }, 20_000).catch(() => undefined);
    check(!!line, `${what} (${line ?? h.lines.slice(before).filter((l) => /forge|advance/.test(l)).join(" | ")})`);
  };
  const notInstalled = (head: string, name: string) => new RegExp(`advance: "${head}" is outside the write scope of ${name}: its program record \\S+ is not installed`);
  await forge({ how: "call", app: "chain", head: "chain/state" }, new RegExp(`forge call refused: .*${notInstalled("chain/state", "forged").source}`), "a program record a step put, claiming app chain, called: its advance of chain/state is refused (not installed)");
  await forge({ how: "launch", app: "chain", head: "chain/state" }, new RegExp(` forged step 1 → errored · .*${notInstalled("chain/state", "forged").source}`), "the same record launched: the thread runs and its advance of chain/state is refused");
  await forge({ how: "launch", name: "wallet", head: "wallet/state" }, new RegExp(` wallet step 1 → errored · .*${notInstalled("wallet/state", "wallet").source}`), "a record a step put named like a genesis-wired program (wallet, no app), launched: no genesis scope");
  await forge({ how: "call", app: "app-demo", head: "app-demo/forged" }, new RegExp(`forge call refused: .*${notInstalled("app-demo/forged", "forged").source}`), "a record claiming app-demo itself but not listed in app-demo/app: refused too");
  check((await record("chain/state")) === undefined && (await record("wallet/state")) === undefined && (await record("app-demo/forged")) === undefined, "no forged advance moved a head: chain/state, wallet/state and app-demo/forged never moved");
  await forge({ how: "installed", head: "app-demo/forged" }, /forge call moved app-demo\/forged/, "app-demo's installed record (a dispatch row's program), called the same way: it advances app-demo/forged");
  check((await record("app-demo/forged"))?.kind === "app-demo-forged", "app-demo/forged moved by the installed program");
  await forge({ how: "installed", head: "chain/state" }, /forge call refused: .*advance: "chain\/state" is outside the write scope of app-demo \(app app-demo writes only heads under its own name/, "the installed record still writes only its own app's heads: chain/state refused");

  // The route /app-demo/call: the answer on the connection (BRC-104, the caller admitted by "*").
  const call = async (body: unknown) => {
    let res: Response;
    try {
      res = await callerBox.af.fetch(`${h.base}/@inst/app-demo/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      // A door refusal (no thread ran) is not signed: AuthFetch throws on it.
      const m = /Received HTTP (\d+)/.exec((e as Error).message);
      if (m) return { status: Number(m[1]), v: {} as { fn?: string; result?: { count: number }; error?: { code: string } } };
      throw e;
    }
    // 2026-10-07: every answer to a signed request is signed, an open row's too (the site handler's 405 is text, not JSON).
    const text = await res.text();
    let v: { fn?: string; result?: { count: number }; error?: { code: string } } = {};
    try { v = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, v };
  };
  let c = await call({ fn: "demo.counter.add", args: { by: 2 } });
  check(c.status === 200 && c.v.result?.count === 7, `POST /app-demo/call add {by: 2}: ${c.status} ${JSON.stringify(c.v)}`);
  c = await call({ fn: "demo.counter.get" });
  check(c.status === 200 && c.v.result?.count === 7, `POST /app-demo/call get: ${c.status} ${JSON.stringify(c.v)}`);
  c = await call({ fn: "demo.counter.peek" });
  check(c.status === 409 && c.v.error?.code === "read-only", `POST /app-demo/call peek: ${c.status} ${JSON.stringify(c.v)}`);
  c = await call({ fn: "demo.counter.nope" });
  check(c.status === 404 && c.v.error?.code === "unknown-fn", `POST /app-demo/call nope: ${c.status}`);

  // An install over itself: no new row, the state kept, start sent again.
  code = await cli("install", demoDir, "--instance", "inst");
  check(code === 0 && out[0]?.startsWith("upgrade app-demo 0.1.0 (installed: 0.1.0)") && out.some((l) => l.includes("dispatch ×0 · start")), `reinstalled: ${out[0]} · ${out.find((l) => l.startsWith("  messages"))}`);
  check((await state())?.count === 7, "the state is kept across the install");

  // ------------------------------------------------ uninstall
  code = await cli("uninstall", "app-demo", "--instance", "inst");
  check(code === 0 && out[0]?.includes("dispatch remove ×3"), `skein plan uninstall app-demo: ${code} ${out[0]} ${err.join(" ")}`);
  const stopped = await until("the stop", async () => { await h.router.settled(); return h.lines.some((l) => /cron: beat stopped$/.test(l)) || undefined; }, 10_000).catch(() => false);
  check(stopped, "the stop message reached app-demo before its rows went: the cron provider stopped beat");
  c = await call({ fn: "demo.counter.get" });
  check(c.status === 404, `after uninstall, /app-demo/call is no route: ${c.status}`);
  check((await record("app-demo/app"))?.kind === "app", "the head app-demo/app is left");
  // The owner's own read (#125, #135): the same function at `/` — `skein reads add`, signed with the owner's key
  // in the client and handed to the host over its control socket (#142).
  await h.router.listenControl(join(h.home, "host.sock"));
  const keyFile = join(h.home, "operator.key");
  writeFileSync(keyFile, `${h.ownerKey.toHex()}\n`, { mode: 0o600 });
  const rootArgs = ["--prefix", "--fn", "get", "--settings", JSON.stringify({ root: "www" }), "/", "site.site", "--instance", "inst"];
  const skein = async (cmd: string, ...args: string[]) => {
    out.length = 0; err.length = 0;
    const c = await adminMain(cmd, args, { vars: { SKEIN_HOME: h.home, SKEIN_OPERATOR_KEY: keyFile }, out: (l) => out.push(l), err: (l) => err.push(l) });
    await h.router.settled();
    if (process.env.VERBOSE) for (const l of [...out, ...err]) process.stdout.write(`  | ${l}\n`);
    return c;
  };
  code = await skein("reads", "add", ...rootArgs, "--dry-run");
  check(code === 0 && out.some((l) => /^reads add \/\* → .+\.get \(root www\) \(the owner's/.test(l)), `skein reads add --prefix … / site.site --dry-run: the owner's read, planned (${code}: ${[...out, ...err].join(" | ")})`);
  code = await skein("reads", "add", "--fn", "get", "/sendMessage", "site.site", "--store", h.db.get("inst")!.store);
  check(code !== 0 && err.some((l) => /an http row is at that path/.test(l)), `a read at a row's path (/sendMessage) refused at the plan (${code}: ${err.join(" | ")})`);
  code = await skein("reads", "add", ...rootArgs);
  check(code === 0, `skein reads add --instance inst: sent (${code}: ${[...out, ...err].join(" | ")})`);
  r = await get("/");
  check(r.status === 200 && r.body.includes('src="app.js"'), `GET / : the site, by the owner's read (${r.status})`);
  r = await get("/app.js");
  check(r.status === 200 && r.body.includes("skein-locators"), `GET /app.js: its files at the root too (${r.status})`);
  r = await get("/manifest.json");
  check(r.status === 200 && r.body.includes("groupPermissions"), `GET /manifest.json: the page's grouped request, at the origin (${r.status})`);
  c = await call({ fn: "demo.counter.get" });
  check(c.status === 405, `a path no row or other read takes is the root read's (a catch-all prefix): POST /app-demo/call, app-demo gone, is the site function's 405, signed (${c.status})`);
  const ownerRead = (((await record("reads"))?.reads ?? []) as Array<Record<string, unknown>>).find((x) => x.address === "/");
  check(!!ownerRead && ownerRead.app === undefined && ownerRead.prefix === true && ownerRead.root === "www", "the root read is the owner's (no app)");
  code = await cli("uninstall", "site", "--instance", "inst");
  r = await get("/site/");
  check(code === 0 && r.status === 404 && !r.body.includes('src="app.js"'), `skein plan uninstall site: its read is gone — /site/ falls to the root read, which has no www/site/ (${code}, GET /site/ ${r.status})`);
  check((await appReads("site")).length === 0 && (await appRows("app-demo")).length === 0, "no app reads or rows left");
  r = await get("/");
  check(r.status === 200, `the owner's root read is the owner's: the uninstall leaves it (GET / ${r.status})`);
  code = await skein("reads", "remove", ...rootArgs);
  r = await get("/");
  check(code === 0 && r.status === 404, `skein reads remove with the same arguments: the root read is gone (${code}, GET / ${r.status})`);
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
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), "the instance's store replays to itself exactly");
  }
  if (!process.env.KEEP) await removeHome?.();
}
if (process.env.KEEP) process.stdout.write(`kept ${work}\n`); else rmSync(work, { recursive: true, force: true });
process.stdout.write(failures ? `install: ${failures} FAILED\n` : "install: all ok\n");
process.exit(failures ? 1 : 0);
