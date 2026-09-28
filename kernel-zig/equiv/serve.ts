// The process interface: `skein-kernel serve` started as `skein-host run`
// starts bin/skein-runtime (supervisor.ts: stdio [ignore, pipe, pipe, ipc], the
// row in the environment), with the real providers (peer/peer.ts) on an
// in-process messagebox (equiv/serve-peer.ts). Checks the ready line, a run
// and a chat answered end to end, a sleep woken by the tick, a stop mid-sleep
// and the restart that finishes it, and a stop when the supervisor's channel
// closes, and (issue #5) a shell that never ends running out of fuel under a
// low fuelPerStep. Then the stores the Zig kernel wrote are replayed by the
// Zig kernel twice over (equiv/replays.ts): identical to each other and to
// the stores themselves, fuel included.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/serve.ts

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-serve-"));
const KEYS = { instance: "1111", owner: "2222", host: "3333", infer: "4444" };
const pub = (h: string) => new PrivateKey(h, 16).toPublicKey().toString();

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

async function serve(scenario: string, stopBy: "signal" | "channel" = "signal", instance = "zigtest", extra: Record<string, string> = {}): Promise<{ code: number | null; lines: string[]; report: Record<string, unknown> }> {
  rmSync(join(home, "scenario.json"), { force: true });
  rmSync(join(home, "scenario.done"), { force: true });
  const child = spawn(kernel, ["serve"], {
    env: {
      ...process.env, SKEIN_HOME: home, SKEIN_DB: join(home, `instances/${instance}/runtime.db`), SKEIN_HANDLE: "zigtest@localhost",
      SKEIN_OWNER: pub(KEYS.owner), SKEIN_INFER: pub(KEYS.infer), SKEIN_IDENTITY: pub(KEYS.instance), SKEIN_HOST_DB: join(home, "none.db"),
      SKEIN_KERNEL_PEER: join(here, "serve-peer.ts"), SKEIN_SCENARIO: scenario, SKEIN_SCENARIO_STOP: stopBy, SKEIN_MESSAGEBOX: "", ...extra,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const lines: string[] = [];
  let partial = "";
  child.stdout!.on("data", (d: Buffer) => { const s = partial + d.toString(); const ls = s.split("\n"); partial = ls.pop()!; for (const l of ls) { lines.push(l); if (process.env.VERBOSE) process.stdout.write(`  | ${l}\n`); } });
  child.stderr!.on("data", (d: Buffer) => process.stdout.write(`  ! ${d}`));
  if (stopBy === "channel") {
    const t0 = Date.now();
    while (!existsSync(join(home, "scenario.done")) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 100));
    child.disconnect(); // the supervisor is gone
  }
  const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  const report = existsSync(join(home, "scenario.json")) ? JSON.parse(readFileSync(join(home, "scenario.json"), "utf8")) : {};
  return { code, lines, report };
}

const a = await serve("run");
check(a.code === 0, `serve exits 0 on SIGTERM (exit ${a.code})`);
check(a.lines.some((l) => l.startsWith(`skein runtime ${pub(KEYS.instance)} (zigtest@localhost) · pid `)), "the ready line the supervisor waits for");
check(a.lines.some((l) => l.startsWith("installed brush ")), "the pinned modules installed into a new store");
check(a.lines.some((l) => l.startsWith("genesis ")), "a new store gets its genesis from the peer (the host wallet signs it)");
check(a.report.ok === true, `the scenario ran (${a.report.error ?? ""})`);
check((a.report.first as { stdout?: string })?.stdout?.startsWith("hello\nREADME\nsrc\n") === true, "a run answered through the messagebox");
check((a.report.chat as { text?: string })?.text === "It holds README and src.", "a chat answered: loop → infer peer → reply to the owner");
check((a.report.second as { stdout?: string })?.stdout === "woke\n", "a sleep woken by the tick");
check(a.lines.includes("SIGTERM: stopping"), "SIGTERM: stopping");

const b = await serve("sleep");
check(b.code === 0 && b.report.sleeping === true, "stopped mid-sleep");
const c = await serve("resume");
check(c.report.ok === true && (c.report.resumed as { stdout?: string })?.stdout?.startsWith("woke\n") === true, `the restart re-executes the sleeper, the tick wakes it, the reply comes (${c.report.error ?? ""})`);
check(c.lines.some((l) => l.includes("re-executing from its origin")), "the sleeper re-executed from its origin on start");

const d = await serve("run", "channel");
check(d.code === 0 && d.lines.includes("supervisor gone: stopping"), `stops when the supervisor's channel closes (exit ${d.code})`);

// Fuel (issue #5): a shell that never ends, under a low fuelPerStep, runs out; the step is recorded.
const LIMIT = "1000000000"; // run-handler's reply step (~6·10^8, sealing in Go) fits; the spinning shell does not
const f = await serve("fuel", "signal", "fueltest", { SKEIN_FUEL_PER_STEP: LIMIT });
const spun = f.report.spun as { exitCode?: number; stdout?: string; stderr?: string; error?: string } | undefined;
check(f.report.ok === true, `the fuel scenario ran (${f.report.error ?? ""})`);
check(JSON.stringify(spun ?? {}).includes("fuel exhausted"), `a spinning shell runs out of fuel and run-handler says so (${JSON.stringify(spun ?? null).slice(0, 200)})`);
const fuelDb = join(home, "instances/fueltest/runtime.db");
const fr = spawnSync(kernel, ["fuel", fuelDb], { encoding: "utf8" });
check(fr.status === 0 && fr.stdout.split("\n").some((l) => l.startsWith(`${LIMIT}\t1\t`) && l.endsWith("\tshell")), "skein-kernel fuel: the shell's one step burnt exactly the limit");

const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), join(home, "instances/zigtest/runtime.db"), fuelDb], { encoding: "utf8" });
process.stdout.write(r.stdout);
check(r.status === 0 && (r.stdout.match(/identical .*the source store reproduced exactly/g) ?? []).length === 2, "the stores the Zig kernel wrote replay to themselves exactly, twice over (Zig against Zig)");

rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `serve: ${failures} FAILED\n` : "serve: all ok\n");
process.exit(failures ? 1 : 0);
