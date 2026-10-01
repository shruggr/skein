// Installing apps (#72, #76) end to end, through `skein-host install` and
// `uninstall` (src/host/cli.ts, install.ts) as the owner, into an instance of
// the stock system on a router:
//
//   skein-static (shruggr/skein-static at a pinned commit, cloned by the
//   install itself; or $SKEIN_STATIC_DIR): the head `static/app` is the app
//   record (the manifest as installed, linking the tree; `static` an alias for
//   its pre-#77 manifest), its rows are served under /static/ (the files from
//   `main`) out of the kernel's dispatch table; uninstalled, its rows are gone.
//
//   programs/test/app-demo (a counter over the SDK's dispatch helper): its
//   start message schedules a heartbeat with the cron provider, whose tick
//   reaches it in `app-demo-tick` (admitted from $cron only: a stranger's is
//   not); a {fn, args} message from a caller in box `app-demo` is answered in
//   the caller's mailbox (result, bad-args, read-only for a `writes: false`
//   function that writes, unknown-fn); the route /app-demo/call answers on the
//   connection; an install over itself keeps its state; uninstalled, its stop
//   runs and its route is gone.
//
// The instance's store then replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/install.ts

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { dirBundles } from "../../src/client/client.ts";
import { main } from "../../src/host/cli.ts";
import { testHost, until } from "../../src/host/testhost.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const STATIC_REPO = "https://github.com/shruggr/skein-static";
const STATIC_REV = "a6ea46e069487bee2ebe891953bda0e9eaefd488";
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
  const inst = h.agent("inst");
  await h.router.start();
  const owner = new RawBox(h.owner, `${h.base}/@inst`);
  await owner.send(inst, "peers", { op: "add", key: callerId, url: h.origin("caller") });
  // `main`: a site for static to serve.
  const site = join(work, "site");
  mkdirSync(join(site, "www/docs"), { recursive: true });
  writeFileSync(join(site, "www/index.html"), "<p>the site</p>\n");
  writeFileSync(join(site, "www/docs/index.html"), "<p>docs</p>\n");
  for (const b of (await dirBundles(site)).bundles) await owner.send(inst, "objects", b);
  await h.router.settled();
  store = h.db.get("inst")!.store;

  const out: string[] = [], err: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0; err.length = 0;
    const code = await main(args, {
      vars: { SKEIN_HOME: h.home, HOME: h.home }, out: (l) => out.push(l), err: (l) => err.push(l),
      owner: { wallet: h.owner, box: (row) => new RawBox(h.owner, `${h.base}/@${row.handle}`) },
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

  // ------------------------------------------------ skein-static, from its repo
  const staticSpec = process.env.SKEIN_STATIC_DIR ?? `${STATIC_REPO}#${STATIC_REV}`;
  let code = await cli("install", staticSpec, "--instance", "inst", "--dry-run");
  check(code === 0 && out.some((l) => l.includes("row       http /static/site* from anyone → static.get")) && out.some((l) => l.includes("row       http /static/ from anyone → static.get")), `the prompt shows static's rows under /static/ (${code}: ${out.filter((l) => l.includes("row ")).join(" | ")})`);
  check((await record("static/app")) === undefined, "a dry run sends nothing");
  code = await cli("install", staticSpec, "--instance", "inst");
  check(code === 1 && err.some((l) => /not approved/.test(l)), `without --approve-all (and no terminal) the install is refused (${code} ${err.join(" ")})`);
  code = await cli("install", staticSpec, "--instance", "inst", "--approve-all");
  check(code === 0, `skein-host install skein-static: exit ${code} ${err.join(" ")}`);
  const st = await record("static/app");
  check(st?.kind === "app" && st.name === "static" && !!st.tree && !!(st.programs as Record<string, unknown>)?.static && (await record("static"))?.kind === "app", `the head static/app is the app record, linking the tree and the program record; static its alias (${JSON.stringify(st && { kind: st.kind, name: st.name, grants: st.grants, legacy: st.legacy })})`);
  const appRows = async (app: string) => ((await (await k()).dispatch()).rows as Array<Record<string, unknown>>).filter((r) => r.app === app).map((r) => `${r.transport} ${r.address}${r.prefix ? "*" : ""}`);
  check((await appRows("static")).join(",") === "http /static/site*,http /static/", `the dispatch table has static's rows: ${(await appRows("static")).join(", ")}`);
  let r = await get("/static/");
  check(r.status === 200 && r.body === "<p>the site</p>\n", `GET /static/: main's www/index.html (${r.status})`);
  r = await get("/static/site/docs/");
  check(r.status === 200 && r.body === "<p>docs</p>\n", `GET /static/site/docs/: www/docs/index.html (${r.status})`);
  r = await get("/site/");
  check(r.status === 404, `GET /site/ (the manifest's own path, outside /static/): 404 (${r.status})`);

  // ------------------------------------------------ app-demo: start, ticks, calls
  code = await cli("install", demoDir, "--instance", "inst", "--approve-all");
  check(code === 0 && out.some((l) => l.startsWith("  row       mailbox app-demo-tick from $cron → demo")), `skein-host install app-demo: exit ${code} ${err.join(" ")}`);
  const state = async () => {
    const rec = await record("app-demo/app");
    return rec?.state ? await (await k()).store.get(rec.state as CID) as { count: number; ticks: number } : undefined;
  };
  const ticked = await until("the first tick", async () => { await h.router.settled(); const s = await state(); return s && s.ticks >= 1 ? s : undefined; }, 20_000).catch(() => undefined);
  check(!!ticked, `the start message scheduled a heartbeat with the cron provider, and its tick reached app-demo-tick from $cron (ticks ${ticked?.ticks})`);
  check(h.lines.some((l) => /cron: beat \(app-demo-tick every 3600000 ms\) scheduled/.test(l)), "the cron provider took the schedule (beat, every hour)");

  // A stranger's "tick" is not admitted (only $cron's row takes app-demo-tick).
  const strangerKey = PrivateKey.fromRandom();
  const refused = await new RawBox(ephemeralWallet(strangerKey), `${h.base}/@inst`).send(inst, "app-demo-tick", { kind: "cron", name: "fake", due: 0 }).then(() => "sent", (e: Error) => e.message);
  await h.router.settled();
  check(/403 ERR_NOT_SUBSCRIBED/.test(refused) && (await state())?.ticks === ticked?.ticks, `a stranger's message into app-demo-tick is refused, and runs nothing (${refused})`);

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

  // The route /app-demo/call: the answer on the connection (BRC-104, the caller admitted by "*").
  const call = async (body: unknown) => {
    let res: Response;
    try {
      res = await callerBox.af.fetch(`${h.base}/@inst/app-demo/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      // The front door's "no route" is not signed (no handler took the request): AuthFetch throws on it.
      const m = /Received HTTP (\d+)/.exec((e as Error).message);
      if (m) return { status: Number(m[1]), v: {} as { fn?: string; result?: { count: number }; error?: { code: string } } };
      throw e;
    }
    return { status: res.status, v: JSON.parse(await res.text()) as { fn?: string; result?: { count: number }; error?: { code: string } } };
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
  code = await cli("install", demoDir, "--instance", "inst", "--approve-all");
  check(code === 0 && out[0]?.startsWith("upgrade app-demo 0.1.0 (installed: 0.1.0)") && out.some((l) => l.includes("dispatch ×0 · start")), `reinstalled: ${out[0]} · ${out.find((l) => l.startsWith("  messages"))}`);
  check((await state())?.count === 7, "the state is kept across the install");

  // ------------------------------------------------ uninstall
  code = await cli("uninstall", "app-demo", "--instance", "inst", "--approve-all");
  check(code === 0 && out[0]?.includes("dispatch remove ×3"), `skein-host uninstall app-demo: ${code} ${out[0]} ${err.join(" ")}`);
  const stopped = await until("the stop", async () => { await h.router.settled(); return h.lines.some((l) => /cron: beat stopped$/.test(l)) || undefined; }, 10_000).catch(() => false);
  check(stopped, "the stop message reached app-demo before its rows went: the cron provider stopped beat");
  c = await call({ fn: "demo.counter.get" });
  check(c.status === 404, `after uninstall, /app-demo/call is no route: ${c.status}`);
  check((await record("app-demo/app"))?.kind === "app", "the head app-demo/app is left");
  code = await cli("uninstall", "static", "--instance", "inst", "--approve-all");
  r = await get("/static/");
  check(code === 0 && r.status === 404, `skein-host uninstall static: its routes are gone (${code}, GET /static/ ${r.status})`);
  check((await appRows("static")).length === 0 && (await appRows("app-demo")).length === 0, "no app rows left in the dispatch table");
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
