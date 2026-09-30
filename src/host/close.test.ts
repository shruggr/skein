// A one-shot command exits (#61): `skein-host add --boot` boots through a
// router and closes it — the fuel-ledger timer, the kernel it spawned — so
// the process ends by itself with 0, and in process nothing it started is
// left live. The router's `close()` is `run`'s shutdown too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { main } from "./cli.ts";
import { HostDb } from "./instances.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { Router } from "./router.ts";
import { ephemeralWallet } from "../wallet.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
const skip = !existsSync(KERNEL_BIN) && "kernel-zig not built";

async function scratch(t: { after(f: () => unknown): void }) {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-close-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const vars = { HOME: home, SKEIN_HOME: home, SKEIN_MASTER_KEY: "66".repeat(32), SKEIN_OWNER: PrivateKey.fromRandom().toPublicKey().toString(), SKEIN_EXPLORE_BASE_PORT: "off", PATH: process.env.PATH };
  const out: string[] = [], err: string[] = [];
  const env = { vars, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  assert.equal(await main(["system", join(home, "system")], env), 0, err.join("\n"));
  return { home, vars, env, out, err, system: join(home, "system") };
}

/** Timers, child processes and sockets: what would keep a process alive. */
const live = () => process.getActiveResourcesInfo().filter((r) => /Timeout|Immediate|Process|TCP|Pipe/.test(r));

test("add --boot: the process exits by itself, 0, once the boot is written", { skip, timeout: 120_000 }, async (t) => {
  const s = await scratch(t);
  const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "add", "booted", "--boot", s.system], { env: s.vars, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d: Buffer) => { stdout += d; });
  p.stderr.on("data", (d: Buffer) => { stderr += d; });
  const code = await new Promise<number | null>((resolve) => {
    const k = setTimeout(() => { p.kill("SIGKILL"); resolve(-1); }, 60_000);
    p.once("close", (c) => { clearTimeout(k); resolve(c); });
  });
  assert.notEqual(code, -1, `still running 60 s later (the #61 hang)\n${stdout}${stderr}`);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /booted: booted from \S+ · \d+ objects pre-filled/);
});

test("add --boot in process: resolves, and leaves no timer, kernel process or socket of its own", { skip, timeout: 120_000 }, async (t) => {
  const s = await scratch(t);
  const before = live();
  assert.equal(await main(["add", "inproc", "--boot", s.system], s.env), 0, s.err.join("\n"));
  assert.ok(s.out.some((l) => /^inproc: booted from /.test(l)), s.out.join("\n"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(live(), before, "what the router started is closed");
});

test("router.close(): the kernels it hydrated, its servers and timers — once, however often it is called", { skip, timeout: 120_000 }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-close-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = new HostDb(join(home, "host.db"));
  t.after(() => db.close());
  db.add("m", { store: join(home, "m.db"), kind: "mailbox", owner: PrivateKey.fromRandom().toPublicKey().toString() });
  const before = live();
  const key = PrivateKey.fromRandom();
  const r = new Router({ db, walletFor: () => ephemeralWallet(key), home, idleMs: 60_000, ledgerMs: 60_000, kernel: { env: { SKEIN_HOME: home } } });
  await r.listen(0);
  const k = (await r.hydrate("m")).kernel;
  assert.ok(live().length > before.length);
  await Promise.all([r.close(), r.close(), r.stop()]);
  assert.ok(k.gone, "the kernel process is gone");
  assert.equal(r.loaded.size, 0);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(live(), before, "nothing of the router is live");
  await assert.rejects(r.hydrate("m"), /the router is stopping/);
});
