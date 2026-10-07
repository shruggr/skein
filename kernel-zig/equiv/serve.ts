// The process interface: `skein-kernel serve` as the router (src/host/router.ts,
// issue #33) drives it — frames on its stdin/stdout, hydrated on demand,
// stopped when idle — each instance an HTTP server (its front door, #40),
// the owner and the inference peer speaking raw BRC-33 on BRC-104 sessions,
// each with its mailbox instance on the same router. The shell and the chat
// loop are apps (#83): each instance that runs them has the shell app and/or
// the chat app installed first (the owner's messages, `skein install`, #124; src/testapps.ts).
// Checks a run and a chat answered end to end, a sleep woken by the
// waker provider (#69: the shell's sleep is a wake-me message), an idle stop mid-sleep and the hydration that finishes it,
// and (issue #5) a shell that never ends running out of fuel under a low
// fuelPerStep, and (issue #38) 50 ms busy-waits on the in-step clock (qjs,
// python) ending on their own under that limit, the clock being the entry
// stamp + fuel × 1 ns, and (issue #69) scheduling as a message: a program
// (programs/test/cron-demo) asks the host's cron provider for ticks, and its tick
// starts a thread that rests on a deadline and is woken by the waker.
// Then the stores the Zig kernel wrote are replayed by
// the Zig kernel twice over (equiv/replays.ts): identical to each other and
// to the stores themselves, fuel included.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/serve.ts

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { RawBox } from "../../src/client/raw.ts";
import { dirSource } from "../../src/host/boot.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Router } from "../../src/host/router.ts";
import { fakeDiscovery } from "../../src/host/fake-discovery.ts";
import { Signer } from "../../src/host/signer.ts";
import { InferPeer } from "../../src/peers/infer.ts";
import { CHAT_APP, installApps, SHELL_APP, type PinnedApp } from "../../src/testapps.ts";
import { bundlesOf } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-serve-"));
const key = (h: string) => new PrivateKey(h, 16);
const KEYS = { owner: "2222", infer: "4444" };
const LIMIT = "1000000000"; // run-handler's reply step (delivering over http) fits; the spinning shell does not

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end;) { const v = await f(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}
const text = (b: unknown) => Buffer.from(b as Uint8Array).toString("utf8");

const db = new HostDb(join(home, "host.db"));
db.add("zigtest", { store: join(home, "instances/zigtest/runtime.db") });
const instanceKeys: Record<string, PrivateKey> = { zigtest: key("1111"), fueltest: key("5555"), clocktest: key("6666"), crontest: key("9999"), david: key("7777"), infer: key("8888") };
const lines: string[] = [];
const owner = ephemeralWallet(key(KEYS.owner)), ownerId = key(KEYS.owner).toPublicKey().toString();
const inferId = key(KEYS.infer).toPublicKey().toString();
const make = (fuel?: string): Router => new Router({
  db, walletFor: (row) => ephemeralWallet(instanceKeys[row.handle]!), home, providerKeyFor: (n) => new Signer(new PrivateKey("a77e57", 16)).providerKey(n),
  // No host skein here (#113): the handles resolve over host.db (a fixture).
  discovery: fakeDiscovery(db, () => router),
  owner: ownerId, infer: inferId, fuelPerStep: fuel, idleMs: 1500, kernel: { command: kernel, env: { SKEIN_HOME: home } },
  log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});
let router = make();
let base = "";
let port = 0;
// The router comes back on the same port: an agent's genesis names its owner's mailbox by URL.
const listen = async (r: Router) => { await r.listen(port); port = r.port; base = `http://127.0.0.1:${port}`; };
await listen(router);
// The owner's and the inference peer's mailboxes: the dev agents' mailboxes (#40, `skein-host add --mailbox`:
// Router.addMailbox; never a handle's, #131).
const mb = async (id: string, name: string) => (await router.addMailbox(name, id)).url === router.originOf(name);
check(await mb(ownerId, "david"), "the owner's mailbox instance (Router.addMailbox, as skein-host add --mailbox)");
check(await mb(inferId, "infer"), "the inference peer's mailbox instance");
await router.start();
const zig = db.get("zigtest")!.identity!;

const boxes = new Map<string, RawBox>();
const boxFor = (handle: string) => { const k = `${base}/${handle}`; let b = boxes.get(k); if (!b) { b = new RawBox(owner, `${base}/@${handle}`); boxes.set(k, b); } return b; };
const sendTo = async (to: string, handle: string, b: string, body: unknown) => { await boxFor(handle).send(to, b, body); };
const box = { ack: (ids: string[]) => boxFor("david").ack(ids) };
const inbox = async (b: string) => (await boxFor("david").list(b)).map((m) => ({ id: m.messageId, body: m.value as Record<string, unknown> }));
let waited: { exitCode?: number; stdout?: string } | undefined;
/** Install apps into an instance as the owner (#83). */
const install = async (handle: string, apps: PinnedApp[]) => { await router.hydrate(handle); await installApps({ home, port, owner, settled: () => router.settled() }, handle, apps); };
const results = (n: number, b = "results", ms = 30_000) => until(`${n} in ${b}`, async () => { const x = await inbox(b); return x.length >= n ? x : undefined; }, ms);

try {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-kz-serve-"));
  await fs.mkdir(join(dir, "src"));
  await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "README"), "hello\n");
  const { root, bundles } = await bundlesOf(dir);
  await install("zigtest", [SHELL_APP, CHAT_APP]);
  for (const b of bundles) await sendTo(zig, "zigtest", "objects", b);
  await sendTo(zig, "zigtest", "shell/run", { cmd: "cat README; ls; echo $RANDOM", tree: root });
  const [r1] = await results(1);
  check(text(r1!.body.stdout).startsWith("hello\nREADME\nsrc\n"), "a run answered through the router");
  await box.ack([r1!.id]);

  const iw = ephemeralWallet(key(KEYS.infer));
  const peer = new InferPeer({ log: (l) => lines.push(`infer: ${l}`), wallet: iw, providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } },
    fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "It holds README and src." } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "q" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    raw: {
      inbox: new RawBox(iw, `${base}/@infer`),
      outbox: (url) => new RawBox(iw, url),
      // Its address book (#40), configured: every row's key at its origin.
      addressOf: (k) => { const r = db.list().find((x) => x.identity === k && x.kind !== "mailbox") ?? db.mailboxOf(k); return r && router.originOf(r.handle); },
    } });
  await sendTo(zig, "zigtest", "chat", { text: "What is here?", tree: root });
  const [a] = await until("the chat answer", async () => { await peer.poll(); const x = await inbox("chat"); return x.length ? x : undefined; });
  check(a!.body.text === "It holds README and src.", "a chat answered: loop → the infer peer's mailbox over http → its answer → reply into the owner's mailbox");
  await box.ack([a!.id]);

  // A sleep longer than the idle timeout: stopped mid-sleep, hydrated by the waker, re-executed, woken.
  await sendTo(zig, "zigtest", "shell/run", { cmd: "sleep 3; echo woke", tree: root });
  await until("stopped mid-sleep", async () => !router.loaded.has("zigtest") && router.nextWake("zigtest") !== undefined ? true : undefined, 15_000);
  check(lines.some((l) => /^\[zigtest\] \S+ shell running → waiting \(until \d+\)$/.test(l)), "the sleep: the shell rests waiting, its wake-me with the waker (#69)");
  check(true, "the kernel is stopped while its thread sleeps; the waker keeps the wake-me");
  const [r2] = await results(1);
  check(text(r2!.body.stdout) === "woke\n", "the waker hydrates it at the deadline and the wake finishes the run");
  check(lines.some((l) => l.includes("re-executing from its origin")), "the sleeper re-executed from its origin at hydration");
  await box.ack([r2!.id]);

  // The router itself restarts mid-sleep: the next router hydrates at start and learns the deadline.
  await sendTo(zig, "zigtest", "shell/run", { cmd: "sleep 2; echo again", tree: root });
  await sleep(500);
  await router.stop();
  router = make();
  await listen(router);
  await router.start();
  // The owner's mail is its mailbox instance's records (the messagebox program): kept across the restart.
  const [r3] = await results(1, "results", 20_000);
  check(text(r3!.body.stdout) === "again\n", "a router restart mid-sleep: hydrated at start, the wake still fires");
  await box.ack([r3!.id]);
  // Everything admitted is processed before the router stops: the result's delivery thread still takes the
  // fetch provider's answer after the owner has the result, and a store stopped then replays a step it never ran.
  await router.settled();
  await router.stop();

  // Fuel (issue #5): a shell that never ends, under a low fuelPerStep, runs out; the step is recorded.
  db.add("fueltest", { store: join(home, "instances/fueltest/runtime.db") });
  router = make(LIMIT);
  await listen(router);
  await router.start();
  const ft = db.get("fueltest")!.identity!;
  await install("fueltest", [SHELL_APP]); // the install's steps fit the limit (#83); the spinning shell does not
  for (const b of bundles) await sendTo(ft, "fueltest", "objects", b);
  await sendTo(ft, "fueltest", "shell/run", { cmd: "echo start; while :; do :; done", tree: root });
  const [s] = await results(1, "results", 60_000);
  check(JSON.stringify(s!.body).includes("fuel exhausted"), `a spinning shell runs out of fuel and run-handler says so (${JSON.stringify(s!.body).slice(0, 160)})`);
  await box.ack([s!.id]);

  // The in-step clock (issue #38): entry stamp + fuel × 1 ns. A 50 ms busy-wait on the clock
  // (qjs Date.now, python time.monotonic) ends on its own, under the same fuel limit.
  db.add("clocktest", { store: join(home, "instances/clocktest/runtime.db") });
  await router.hydrate("clocktest");
  const ct = db.get("clocktest")!.identity!;
  await install("clocktest", [SHELL_APP]);
  for (const b of bundles) await sendTo(ct, "clocktest", "objects", b);
  const clockCmd = [
    "qjs -e 'const t0 = Date.now(); let n = 0; while (Date.now() - t0 < 50) n++; console.log(\"qjs\", Date.now() - t0, n > 100)'",
    "python3 -c 'import time\nt0 = time.monotonic()\nwhile time.monotonic() - t0 < 0.05: pass\nprint(\"python\", round((time.monotonic() - t0) * 1000))'",
  ].join("; ");
  await sendTo(ct, "clocktest", "shell/run", { cmd: clockCmd, tree: root });
  const [w] = await results(1, "results", 60_000);
  waited = { exitCode: w!.body.exitCode as number, stdout: w!.body.stdout ? text(w!.body.stdout) : undefined };
  await box.ack([w!.id]);

  // Scheduling is a message (#69): a system tree with cron-demo for the owner's `schedule` box and
  // (sender-less) `tick`. The owner asks it for an hourly tick; it emits the request to its
  // address book's cron provider (the host's, `local`) and rests on the answer; the provider ticks
  // at once — a signed message into `tick` — and cron-demo rests 300 ms on a deadline there, and
  // the waker wakes it.
  const tree = await fs.mkdtemp(join(tmpdir(), "skein-kz-cron-"));
  await fs.mkdir(join(tree, "bin"));
  await fs.mkdir(join(tree, "etc"));
  await fs.writeFile(join(tree, "bin/cron-demo.wasm"), readFileSync(join(here, "../../programs/test/cron-demo/cron-demo.wasm")));
  await fs.writeFile(join(tree, "bin/messagebox.wasm"), readFileSync(join(here, "../../wasm/messagebox.wasm")));
  await fs.writeFile(join(tree, "etc/dispatch.json"), JSON.stringify([{ address: "schedule", program: "cron-demo" }, { address: "tick", program: "cron-demo" }, { transport: "event", address: ":ack", program: "messagebox" }]));
  db.add("crontest", { store: join(home, "instances/crontest/runtime.db") });
  const src = await dirSource(tree);
  await router.bootRow("crontest", { kind: "tree", root: src.root, objects: src.objects });
  await router.hydrate("crontest");
  await sendTo(db.get("crontest")!.identity!, "crontest", "schedule", { name: "beat", every: 3_600_000, rest: 300 });
  const cronLine = (re: RegExp) => lines.some((l) => l.startsWith("[crontest]") && re.test(l));
  const finished = () => lines.filter((l) => l.startsWith("[crontest]") && /cron-demo step 2 → finished/.test(l)).length;
  await until("cron-demo woken", async () => finished() >= 2 || undefined, 20_000);
  check(cronLine(/^\[crontest\] cron: beat \(tick every 3600000 ms\) scheduled/), "cron-demo's tick request reached the host's cron provider (a message, from the instance's step)");
  check(cronLine(/^\[crontest\] cron: beat \(tick every 3600000 ms\) → tick$/), "the provider ticked at once: a signed message into `tick`");
  check(cronLine(/cron-demo step 1 → waiting/), "the tick started cron-demo's thread, which rested on its deadline");
  check(finished() === 2, "the provider's answer finished the request's thread, the waker the tick's");
  const next = router.cron.of("crontest")[0]?.next ?? 0;
  check(next - Date.now() > 3_500_000, "the next tick is an hour on, not a burst");
  await fs.rm(tree, { recursive: true, force: true });
  await router.settled();
  await router.stop();
  await fs.rm(dir, { recursive: true, force: true });
} catch (e) {
  check(false, `the scenario ran: ${(e as Error).message}\n${lines.slice(-30).join("\n")}`);
  await router.stop();
}
db.close();

const fuelDb = join(home, "instances/fueltest/runtime.db");
const fr = spawnSync(kernel, ["fuel", fuelDb], { encoding: "utf8" });
check(fr.status === 0 && fr.stdout.split("\n").some((l) => l.startsWith(`${LIMIT}\t1\t`) && l.endsWith("\tshell")), "skein-kernel fuel: the shell's one step burnt exactly the limit");

// The in-step clock (issue #38), checked: the busy-waits ended 50 ms of fuel later.
const CLOCK_LIMIT = Number(LIMIT);
const [qjsLine, pyLine] = (waited?.stdout ?? "").trim().split("\n").map((l) => l.split(" "));
const ms = (x?: string) => Number(x);
check(waited?.exitCode === 0 && qjsLine?.[0] === "qjs" && ms(qjsLine[1]) >= 50 && ms(qjsLine[1]) < 60 && qjsLine[2] === "true", `a qjs busy-wait on Date.now for 50 ms ends, 50 ms of fuel later (${JSON.stringify(waited ?? null).slice(0, 200)})`);
check(pyLine?.[0] === "python" && ms(pyLine[1]) >= 50 && ms(pyLine[1]) < 60, `a python busy-wait on time.monotonic for 50 ms ends (${waited?.stdout?.trim()})`);
const clockDb = join(home, "instances/clocktest/runtime.db");
const kr = spawnSync(kernel, ["fuel", clockDb], { encoding: "utf8" });
const shellFuel = kr.stdout.split("\n").filter((l) => l.endsWith("\tshell")).map((l) => Number(l.split("\t")[0]));
check(kr.status === 0 && shellFuel.length === 1 && shellFuel[0] >= 100_000_000 && shellFuel[0] < CLOCK_LIMIT, `the shell's step burnt at least the 2 × 50 ms it waited, under the limit (${shellFuel})`);

const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), join(home, "instances/zigtest/runtime.db"), fuelDb, clockDb, join(home, "instances/crontest/runtime.db")], { encoding: "utf8" });
process.stdout.write(r.stdout);
check(r.status === 0 && (r.stdout.match(/identical .*the source store reproduced exactly/g) ?? []).length === 4, "the stores the Zig kernel wrote replay to themselves exactly, twice over (Zig against Zig)");

rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `serve: ${failures} FAILED\n` : "serve: all ok\n");
process.exit(failures ? 1 : 0);
