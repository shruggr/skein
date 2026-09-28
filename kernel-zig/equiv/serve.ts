// The process interface: `skein-kernel serve` as the router (src/host/router.ts,
// issue #33) drives it — frames on its stdin/stdout, hydrated on demand,
// stopped when idle — with the owner and the inference peer as ordinary
// messagebox clients (@bsv/message-box-client over BRC-104) against the
// router. Checks a run and a chat answered end to end, a sleep woken by the
// router's waker, an idle stop mid-sleep and the hydration that finishes it,
// and (issue #5) a shell that never ends running out of fuel under a low
// fuelPerStep. Then the stores the Zig kernel wrote are replayed by the Zig
// kernel twice over (equiv/replays.ts): identical to each other and to the
// stores themselves, fuel included.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/serve.ts

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthFetch, PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { open, seal, verify, type Envelope } from "../../src/envelope.ts";
import { HostDb } from "../../src/host/instances.ts";
import { messageBoxClient, type MessageBox } from "../../src/host/messagebox.ts";
import { Router } from "../../src/host/router.ts";
import { InferPeer } from "../../src/peers/infer.ts";
import { bundlesOf } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-serve-"));
const key = (h: string) => new PrivateKey(h, 16);
const KEYS = { owner: "2222", infer: "4444" };
const LIMIT = "1000000000"; // run-handler's reply step (~6·10^8, sealing in Go) fits; the spinning shell does not

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
const instanceKeys: Record<string, PrivateKey> = { zigtest: key("1111"), fueltest: key("5555") };
const lines: string[] = [];
const owner = ephemeralWallet(key(KEYS.owner)), ownerId = key(KEYS.owner).toPublicKey().toString();
const inferId = key(KEYS.infer).toPublicKey().toString();
const make = (fuel?: string) => new Router({
  db, walletFor: (row) => ephemeralWallet(instanceKeys[row.handle]!), host: ephemeralWallet(key("3333")), authWallet: ephemeralWallet(),
  owner: ownerId, infer: inferId, fuelPerStep: fuel, idleMs: 1500, kernel: { command: kernel, env: { SKEIN_HOME: home } },
  log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
});
let router = make();
let base = "";
const listen = async (r: Router) => { const s = await r.listen(0); base = `http://127.0.0.1:${(s.address() as { port: number }).port}`; };
await listen(router);
await router.start();
const zig = db.get("zigtest")!.identity!;

const register = async (w: ReturnType<typeof ephemeralWallet>, name: string) => (await new AuthFetch(w).fetch(`${base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name }) })).status;
check(await register(owner, "david") === 200, "the owner registers a mailbox (kept by the instance)");
check(await register(ephemeralWallet(key(KEYS.infer)), "infer") === 200, "the inference peer registers a mailbox");
let box: MessageBox = messageBoxClient(owner, `${base}/messagebox`, "skein-client");
const sendTo = async (to: string, handle: string, b: string, body: unknown) => {
  const env = await seal(owner, { recipient: { identityKey: to, handle, domain: "localhost" }, body: body instanceof Uint8Array ? body : dagCbor.encode(body), created: new Date().toISOString() });
  await box.send({ recipient: to, box: b, body: env });
};
const inbox = async (b: string) => {
  const out: Array<{ id: string; body: Record<string, unknown> }> = [];
  for (const m of await box.list(b)) {
    const e = (typeof m.body === "string" ? JSON.parse(m.body) : m.body) as Envelope;
    if (!verify(e)) throw new Error("reply does not verify");
    out.push({ id: m.messageId, body: dagCbor.decode((await open(owner, e)).body) as Record<string, unknown> });
  }
  return out;
};
const results = (n: number, b = "results", ms = 30_000) => until(`${n} in ${b}`, async () => { const x = await inbox(b); return x.length >= n ? x : undefined; }, ms);

try {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-kz-serve-"));
  await fs.mkdir(join(dir, "src"));
  await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
  await fs.writeFile(join(dir, "README"), "hello\n");
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await sendTo(zig, "zigtest", "objects", b);
  await sendTo(zig, "zigtest", "run", { cmd: "cat README; ls; echo $RANDOM", tree: root });
  const [r1] = await results(1);
  check(text(r1!.body.stdout).startsWith("hello\nREADME\nsrc\n"), "a run answered through the router");
  await box.ack([r1!.id]);

  const peer = new InferPeer({ log: (l) => lines.push(`infer: ${l}`), wallet: ephemeralWallet(key(KEYS.infer)), box: messageBoxClient(ephemeralWallet(key(KEYS.infer)), `${base}/messagebox`, "skein-infer"), providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } },
    fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "It holds README and src." } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "q" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    now: () => Date.now() });
  await sendTo(zig, "zigtest", "chat", { text: "What is here?", tree: root });
  const [a] = await until("the chat answer", async () => { await peer.poll(); const x = await inbox("chat"); return x.length ? x : undefined; });
  check(a!.body.text === "It holds README and src.", "a chat answered: loop → infer peer (a messagebox client) → reply to the owner");
  await box.ack([a!.id]);

  // A sleep longer than the idle timeout: stopped mid-sleep, hydrated by the waker, re-executed, woken.
  await sendTo(zig, "zigtest", "run", { cmd: "sleep 3; echo woke", tree: root });
  await until("stopped mid-sleep", async () => !router.loaded.has("zigtest") && router.deadlines.has("zigtest") ? true : undefined, 15_000);
  check(true, "the kernel is stopped while its thread sleeps; the router keeps the deadline");
  const [r2] = await results(1);
  check(text(r2!.body.stdout) === "woke\n", "the waker hydrates it at the deadline and the wake finishes the run");
  check(lines.some((l) => l.includes("re-executing from its origin")), "the sleeper re-executed from its origin at hydration");
  await box.ack([r2!.id]);

  // The router itself restarts mid-sleep: the next router hydrates at start and learns the deadline.
  await sendTo(zig, "zigtest", "run", { cmd: "sleep 2; echo again", tree: root });
  await sleep(500);
  await router.stop();
  router = make();
  await listen(router);
  box = messageBoxClient(owner, `${base}/messagebox`, "skein-client");
  await router.start();
  // Mail kept by the old router was in memory (until the mailbox program keeps it): the reply comes to this one.
  const [r3] = await results(1, "results", 20_000);
  check(text(r3!.body.stdout) === "again\n", "a router restart mid-sleep: hydrated at start, the wake still fires");
  await router.stop();

  // Fuel (issue #5): a shell that never ends, under a low fuelPerStep, runs out; the step is recorded.
  db.add("fueltest", { store: join(home, "instances/fueltest/runtime.db") });
  db.setStatus("zigtest", "disabled");
  router = make(LIMIT);
  await listen(router);
  box = messageBoxClient(owner, `${base}/messagebox`, "skein-client");
  await router.start();
  const ft = db.get("fueltest")!.identity!;
  for (const b of bundles) await sendTo(ft, "fueltest", "objects", b);
  await sendTo(ft, "fueltest", "run", { cmd: "echo start; while :; do :; done", tree: root });
  const [s] = await results(1, "results", 60_000);
  check(JSON.stringify(s!.body).includes("fuel exhausted"), `a spinning shell runs out of fuel and run-handler says so (${JSON.stringify(s!.body).slice(0, 160)})`);
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

const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), join(home, "instances/zigtest/runtime.db"), fuelDb], { encoding: "utf8" });
process.stdout.write(r.stdout);
check(r.status === 0 && (r.stdout.match(/identical .*the source store reproduced exactly/g) ?? []).length === 2, "the stores the Zig kernel wrote replay to themselves exactly, twice over (Zig against Zig)");

rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `serve: ${failures} FAILED\n` : "serve: all ok\n");
process.exit(failures ? 1 : 0);
