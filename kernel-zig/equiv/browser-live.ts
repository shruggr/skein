// The browser build live (issue #35): a skein instance in headless Chrome —
// the wasm kernel in a Worker over IndexedDB, the page as its host
// (web/kernel/host.ts) — against a router on a scratch port (never :8100)
// with an agent on the native kernel and a scripted inference peer. The page
// identity (a wallet in the tab over a test key here; Yours in use) registers its mailbox
// instance on the router; the chat app is installed into both instances (#83:
// a genesis has no chat loop) — the agent's by `skein-host install`, the
// browser instance's by the install client's plan (src/host/install.ts
// planInstall, over a copy of the browser's store) sent as the page
// identity, its owner, through the page; the page chats its instance; the instance's loop asks the
// inference peer (its messagebox program's delivery thread, on a BRC-104
// session, its requests emitted to the page's HTTP proxy provider — #70: the
// page's fetch, each answer a signed message admitted as a `local` request),
// resolves the agent (its resolve program, a BRC-169 lookup through the same
// provider), delivers a chat to it; the agent's loop answers into the
// page identity's mailbox instance (the admin put its key and URL in the
// agent's address book: nothing registers itself, #40), which the page polls
// and admits into the browser instance; the thread resumes and answers the page (into the same
// mailbox, shown).
// Then the store the browser wrote (its records, read back from IndexedDB) is
// replayed by the native kernel and must reach the same state.
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
import { InferPeer } from "../../src/peers/infer.ts";
import { instanceView, planInstall, readApp, sendInstall } from "../../src/host/install.ts";
import { wasmDirObjects } from "../../src/host/boot.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { appCheckout, CHAT_APP, installApps } from "../../src/testapps.ts";
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
const messageCall = (id: string, to: string, text: string) => ({ id, type: "function", function: { name: "message", arguments: JSON.stringify({ to, text }) } });
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
const router = new Router({
  db, walletFor: (row) => ephemeralWallet(keys.get(row.handle)!), home,
  owner: ownerKey.toPublicKey().toString(), infer: inferId, idleMs: 0, kernel: { command: kernelBin, env: { SKEIN_HOME: home } },
  log: (s, l) => { if (verbose) console.log(`  | [${s}] ${l}`); },
});
await router.listen(0);
const base = `http://127.0.0.1:${router.port}`;
// The inference peer's mailbox instance. The agent answers the page (its opener) at the page identity's
// mailbox instance: the admin wrote that into the agent's address book (#40: no claims).
keys.set("infer", key());
router.addMailbox("infer", inferId);
db.add("infer", { identity: keys.get("infer")!.toPublicKey().toString() });
keys.set("page", key()); // the page identity's mailbox instance, registered by the page itself
keys.set("agent", key());
db.add("agent", { store: join(home, "agent.db"), identity: keys.get("agent")!.toPublicKey().toString() });
await router.hydrate("agent");
const agentId = keys.get("agent")!.toPublicKey().toString();
// #83: the agent's chat loop is the chat app, installed by its owner.
await installApps({ home, port: router.port, owner: ephemeralWallet(ownerKey), settled: () => router.settled() }, "agent", [CHAT_APP]);
await new RawBox(ephemeralWallet(ownerKey), `${base}/@agent`).send(agentId, "peers", { op: "add", key: pageId, url: router.originOf("page"), handle: "page", domain: "localhost" });
await router.settled();
const iw = ephemeralWallet(inferKey);
// The conversation, in the order the requests reach the peer: the page's instance, the agent, the page's instance.
const peer = new InferPeer({
  log: () => {}, wallet: iw, providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } },
  raw: {
    inbox: new RawBox(iw, `${base}/@infer`),
    outbox: (url) => new RawBox(iw, url),
    // Its address book (#40), configured: an agent at its origin, an identity with a mailbox instance there.
    addressOf: (k) => { const r = db.list().find((x) => x.identity === k && x.kind !== "mailbox") ?? db.mailboxOf(k); return r && router.originOf(r.handle); },
  },
  fetch: scripted([
    answer({ content: "", tool_calls: [messageCall("m1", "@agent@localhost", "What does the blue one cost?")] }),
    answer({ content: "The blue one is 5." }),
    answer({ content: "The agent says: the blue one is 5." }),
  ]),
});

await buildPage();
const web = await servePage(0);
const pageUrl = `http://127.0.0.1:${(web.address() as { port: number }).port}/?host=${encodeURIComponent(base)}&handle=page&infer=${inferId}&key=${pageKey.toHex()}&pollMs=200`;
console.log(`router ${base} (agent ${agentId.slice(-8)}, infer ${inferId.slice(-8)}); page identity ${pageId.slice(-8)}`);
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
  check(true, `the chat app installed into the browser instance (${plan.records.length} records, ${plan.rows.length} rows), as its owner`);
  const t0 = Date.now();
  await page.evaluate(async () => { await (window as unknown as { skein: { chat(t: string): Promise<unknown> } }).skein.chat("ask the agent about the blue one"); });
  const events = () => page.evaluate(() => (window as unknown as { skein: { events: unknown[] } }).skein.events) as Promise<Ev[]>;
  let evs: Ev[] = [];
  for (let i = 0; i < 150; i++) {
    await peer.poll();
    await router.settled();
    evs = await events();
    if (evs.some((e) => e.kind === "message")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const kinds = evs.map((e) => `${e.kind}${e.box ? `:${String(e.box)}` : ""}`).join(" ");
  if (verbose) console.log(`  events: ${kinds}`);
  const http = (f: (u: string, m: string, s: number) => boolean) => evs.some((e) => e.kind === "http" && f(String(e.url), String(e.method), Number(e.status)));
  check(http((u, m, st) => u.startsWith(router.originOf("infer")) && u.endsWith("/sendMessage") && m === "POST" && st === 200), "the browser instance's loop delivered its inference request itself: its messagebox program's delivery thread through the page's fetch provider, on a BRC-104 session signed through the page wallet");
  check(http((u, m, st) => u.includes("/.well-known/metanet-handles/resolve?handle=agent") && m === "GET" && st === 200), "its resolve program looked the agent up (BRC-169, through the fetch provider)");
  check(http((u, m, st) => u.startsWith(router.originOf("agent")) && u.endsWith("/sendMessage") && m === "POST" && st === 200), "the browser instance delivered the chat to the agent's front door (on the router)");
  check(evs.some((e) => e.kind === "admitted" && e.sender === agentId && e.box === "chat"), "the agent's reply was polled from the page identity's mailbox and admitted into the browser instance");
  const msg = evs.find((e) => e.kind === "message") as { body?: { text?: string } } | undefined;
  check(msg?.body?.text === "The agent says: the blue one is 5.", `the instance answered the page: ${JSON.stringify(msg?.body?.text)} (${Date.now() - t0} ms)`);
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
