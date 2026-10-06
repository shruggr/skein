// The browser build live (issue #35): a skein instance in headless Chrome —
// the wasm kernel in a Worker over IndexedDB, the page as its host
// (web/kernel/host.ts) — against a router on a scratch port (never :8100)
// with a scripted inference peer. The page identity (a wallet in the tab over
// a test key here; Yours in use) registers its mailbox instance on the router;
// the chat app is installed into the browser instance by the install client's
// plan (src/host/install.ts planInstall, over a copy of the browser's store)
// sent as the page identity, its owner, on the page wallet's BRC-104 session
// with its instance (#126 step 4: the page is a client of its instance like
// any other — `http` requests to its front door, plain BRC-33 messages); the
// page chats its instance the same way; the instance's loop asks the
// inference peer (its messagebox program's delivery thread, the kernel's
// authfetch on a BRC-104 session signed through the page wallet, the bytes
// moved by the page). The peer answers into the page identity's mailbox
// instance — the user's, never the instance's inbox (#126 step 4: a skein
// receives mail only where it verifies the sender itself): the page shows the
// answer and admits nothing into the instance. Then the store the browser
// wrote (its records, read back from IndexedDB) is replayed by the native
// kernel and must reach the same state.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/browser-live.ts

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { RawBox } from "../../src/client/raw.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Router } from "../../src/host/router.ts";
import { fakeDiscovery } from "../../src/host/fake-discovery.ts";
import { InferPeer } from "../../src/peers/infer.ts";
import { instanceView, planInstall, readApp, sendInstall } from "../../src/host/install.ts";
import { wasmDirObjects } from "../../src/host/boot.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { appCheckout, CHAT_APP } from "../../src/testapps.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { buildPage, servePage } from "../../web/kernel/serve.ts";
import { chromium, playwright, writeStore } from "./browser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernelBin = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const verbose = !!process.env.VERBOSE;
type Json = Record<string, unknown>;

let seed = 0xb20035n;
const key = () => new PrivateKey((seed++).toString(16), 16);
const answer = (message: Json) => ({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "qwen38" });
function scripted(answers: Json[]) {
  return (async () => {
    const a = answers.shift();
    if (!a) return new Response("no more answers", { status: 500 });
    return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

let status = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) status = 1; };

const home = await fs.mkdtemp(join(tmpdir(), "skein-kz-live-"));
const db = new HostDb(join(home, "host.db"));
const keys = new Map<string, PrivateKey>();
const ownerKey = key(), inferKey = key(), pageKey = key();
const inferId = inferKey.toPublicKey().toString(), pageId = pageKey.toPublicKey().toString();
const router: Router = new Router({
  db, walletFor: (row) => ephemeralWallet(keys.get(row.handle)!), home,
  // No host skein here (#113): discovery over host.db (a fixture); the page's registration is answered below.
  discovery: fakeDiscovery(db, () => router),
  owner: ownerKey.toPublicKey().toString(), infer: inferId, idleMs: 0, kernel: { command: kernelBin, env: { SKEIN_HOME: home } },
  log: (s, l) => { if (verbose) console.log(`  | [${s}] ${l}`); },
});
await router.listen(0);
const base = `http://127.0.0.1:${router.port}`;
// The inference peer's mailbox instance.
keys.set("infer", key());
db.add("infer", { kind: "mailbox", owner: inferId, store: join(home, "instances", "infer", "runtime.db"), identity: keys.get("infer")!.toPublicKey().toString() });
keys.set("page", key()); // the page identity's mailbox instance, registered by the page itself
const iw = ephemeralWallet(inferKey);
// The peer answers the browser instance at the page identity's mailbox instance (its address book, below).
const peer = new InferPeer({
  log: () => {}, wallet: iw, providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } },
  raw: {
    inbox: new RawBox(iw, `${base}/@infer`),
    outbox: (url) => new RawBox(iw, url),
    // Its address book (#40), configured: an identity with a mailbox instance there.
    addressOf: (k) => { const r = db.list().find((x) => x.identity === k && x.kind !== "mailbox") ?? db.mailboxOf(k); return r && router.originOf(r.handle); },
  },
  fetch: scripted([answer({ content: "The blue one is 5." })]),
});

await buildPage();
const web = await servePage(0);
const pageUrl = `http://127.0.0.1:${(web.address() as { port: number }).port}/?host=${encodeURIComponent(base)}&handle=page&infer=${inferId}&key=${pageKey.toHex()}&pollMs=200`;
console.log(`router ${base} (infer ${inferId.slice(-8)}); page identity ${pageId.slice(-8)}`);
const pw = await playwright();
const browser = await pw.chromium.launch({ executablePath: chromium(), headless: true });
type Ev = { kind: string; [k: string]: unknown };
try {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => { if (verbose || m.type() === "error") console.log(`  | page: ${m.text()}`); });
  page.on("pageerror", (e) => console.log(`  | page error: ${e.message}`));
  await page.goto(pageUrl);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean; failed?: string }).ready === true || !!(window as unknown as { failed?: string }).failed, null, { timeout: 180_000 });
  const failed = await page.evaluate(() => (window as unknown as { failed?: string }).failed);
  if (failed) throw new Error(`page: ${failed}`);
  check(true, "the page started its instance (genesis in IndexedDB, modules installed, mailbox registered)");
  // The chat app into the browser instance (#83): the install's plan over a copy of its store, sent as its owner (the page identity) through the page.
  const copy = join(home, "browser-before-install.db");
  writeStore(Uint8Array.from(await page.evaluate(async () => Array.from(await (window as unknown as { skein: { kernel: { kw: { call(m: string, ...a: unknown[]): Promise<Uint8Array> } } } }).skein.kernel.kw.call("bundle", 1, true)))), copy);
  const view = openStoreFile(copy, { readOnly: true });
  const plan = await planInstall(await readApp(appCheckout(CHAT_APP)), await instanceView(view), { modules: wasmDirObjects(join(here, "../../wasm")) });
  await view.close();
  await sendInstall(plan, async (b, body) => await page.evaluate(async ([box, bytes]) => await (window as unknown as { skein: { send(b: string, x: Uint8Array): Promise<string> } }).skein.send(box as string, Uint8Array.from(bytes as number[])), [b, Array.from(body)] as const));
  check(true, `the chat app installed into the browser instance (${plan.records.length} records, ${plan.rows.length} rows), as its owner, on the page's session with its instance`);
  const t0 = Date.now();
  const chatId = await page.evaluate(async () => await (window as unknown as { skein: { chat(t: string): Promise<string> } }).skein.chat("what does the blue one cost?"));
  const events = () => page.evaluate(() => (window as unknown as { skein: { events: unknown[] } }).skein.events) as Promise<Ev[]>;
  let evs: Ev[] = await events();
  check(/^bafy/.test(chatId) && evs.some((e) => e.kind === "sent" && e.box === "chat" && e.message === chatId), `the page's chat went to its instance as a plain message on its session (${chatId.slice(-12)})`);
  for (let i = 0; i < 150; i++) {
    await peer.poll();
    await router.settled();
    evs = await events();
    if (evs.some((e) => e.kind === "message" && e.sender === inferId)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const kinds = evs.map((e) => `${e.kind}${e.box ? `:${String(e.box)}` : ""}`).join(" ");
  if (verbose) console.log(`  events: ${kinds}`);
  const http = (f: (u: string, m: string, s: number) => boolean) => evs.some((e) => e.kind === "http" && f(String(e.url), String(e.method), Number(e.status)));
  check(http((u, m, st) => u.startsWith(router.originOf("infer")) && u.endsWith("/sendMessage") && m === "POST" && st === 200), "the browser instance's loop delivered its inference request itself: its messagebox program's delivery thread, the kernel's authfetch on a BRC-104 session signed through the page wallet");
  const answered = evs.find((e) => e.kind === "message" && e.sender === inferId) as { box?: string; body?: { replyTo?: unknown; choices?: unknown } } | undefined;
  check(answered?.box === "completions", `the inference peer's answer is in the page identity's mailbox, shown by the page (${Date.now() - t0} ms)`);
  check(!evs.some((e) => e.kind === "admitted"), "and nothing from the mailbox was admitted into the instance: the mailbox is the user's (#126 step 4)");
  if (status || verbose) console.log((await page.$eval("#log", (e) => (e as HTMLElement).innerText)).split("\n").map((l) => `  | page: ${l}`).join("\n"));
  // The store the browser wrote, replayed natively.
  const [bundle, state] = await page.evaluate(async () => {
    const s = (window as unknown as { skein: { kernel: { kw: { call(m: string, ...a: unknown[]): Promise<Uint8Array> }; state(): Promise<{ state: { toString(): string } }> } } }).skein;
    const b = await s.kernel.kw.call("bundle", 1, true);
    return [Array.from(b), (await s.kernel.state()).state.toString()] as const;
  });
  const src = join(home, "browser.db"), out = join(home, "browser-replay.db");
  writeStore(Uint8Array.from(bundle), src);
  const r = spawnSync(kernelBin, ["replay", src, out], { maxBuffer: 1 << 30 });
  const report = r.status === 0 ? JSON.parse(r.stdout.toString()) as { lines: string[]; index: { record: string } } : undefined;
  if (!report) console.log(`  ${r.stderr}`);
  check(report?.index.record === state, `the browser's store replays natively to the same state (${state.slice(-12)}; ${report?.lines.length ?? 0} log lines, no DIVERGED: ${!report?.lines.some((l) => l.includes("DIVERGED"))})`);
  check(!!report && !report.lines.some((l) => l.includes("DIVERGED") || l.includes("cannot run")), "every step of the browser's store re-executes natively with the same records (fuel included)");
} finally {
  await browser.close();
  web.close();
  await router.stop();
  db.close();
  await fs.rm(home, { recursive: true, force: true });
}
process.exit(status);
