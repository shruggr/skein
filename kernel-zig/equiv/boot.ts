// The bootstrap loader (issue #4) end to end, through `skein-host` and the
// router, on the Zig kernel: the stock system written as a system tree
// (`skein-host system`), one handler carried as a .wasm file, a SOUL.md;
//   alpha   booted from the directory (`add --boot <dir>`)
//   beta    booted from a packet of it (`pack <dir>` in the ordfs form, mined; `add --packet --proofs`)
// A genesis has no shell and no chat loop (#83): each instance has apps
// installed on top (the owner's messages, `skein plan install`, #124; src/testapps.ts) — alpha the chat
// app, beta the chat app and the shell app — then is chatted with — no tree
// named, so the loop reads `main`, the system tree — and beta runs a command
// over `main`. (alpha has no shell so that its checkpoint stays small: a
// checkpoint is every block of the store, and the shell app's modules make
// that hundreds of MB, more than `pack --checkpoint` holds in memory.) Then alpha is checkpointed (`pack
// --checkpoint`) and restored into a second host with the same master key
// (`add --packet`): the restored store's derived state is the source's, and
// it goes on answering. Finally the booted stores are replayed Zig against
// Zig (replays.ts): the replay copies the system tree and reproduces them.
// With the wallet's component build there (#34, run.sh builds it), the tree
// also carries it as bin/wallet.wasm — a WASI 0.2 component handler — and
// each instance answers an owner's `list` through it.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/boot.ts

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { PrivateKey } from "@bsv/sdk";
import { RawBox } from "../../src/client/raw.ts";
import { main } from "../../src/host/cli.ts";
import { keyHex } from "../../src/host/genesis.ts";
import { HostDb } from "../../src/host/instances.ts";
import { masterKey, Signer } from "../../src/host/signer.ts";
import { decodePacket } from "../../src/host/packet.ts";
import { rawCid } from "../../src/host/boot.ts";
import { decode } from "../../src/runtime/cid.ts";
import { openStoreFile } from "../../src/runtime/index-store.ts";
import { WALLET } from "../../src/runtime/programs.ts";
import { CHAT_APP, installApps, SHELL_APP } from "../../src/testapps.ts";
import { collect } from "../../src/testkit.ts";
import { CID } from "multiformats/cid";
import { existsSync } from "node:fs";
import { Router } from "../../src/host/router.ts";
import { fakeDiscovery } from "../../src/host/fake-discovery.ts";
import { InferPeer } from "../../src/peers/infer.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const work = mkdtempSync(join(tmpdir(), "skein-kz-boot-"));
const key = (h: string) => new PrivateKey(h, 16);
const owner = ephemeralWallet(key("2222")), ownerId = key("2222").toPublicKey().toString();
const inferKey = key("4444"), inferId = inferKey.toPublicKey().toString();

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end;) { const v = await f(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}
const text = (b: unknown) => Buffer.from(b as Uint8Array).toString("utf8");
const lines: string[] = [];
// The port the routers serve on: an agent's genesis names its owner's mailbox by URL (#40), so it is fixed before the boots.
const port = await new Promise<number>((res) => { const srv = createServer(); srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => res(p)); }); });
const cli = async (home: string, ...argv: string[]) => {
  const out: string[] = [];
  const code = await main(argv, { vars: { ...process.env, SKEIN_HOME: home, SKEIN_OWNER: ownerId, SKEIN_INFER: inferId, SKEIN_KERNEL_BIN: kernel, SKEIN_ROUTER_PORT: String(port) }, out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) });
  lines.push(`$ skein-host ${argv.join(" ")}`, ...out);
  if (process.env.VERBOSE) process.stdout.write(`  | $ skein-host ${argv.join(" ")}\n${out.map((l) => `  | ${l}\n`).join("")}`);
  return { code, out };
};

const home = join(work, "home"), home2 = join(work, "home2");
const sys = join(work, "system");
const COMPONENT = process.env.SKEIN_WALLET_COMPONENT ?? join(here, "../../programs/wallet/zig-out/bin/wallet.component.wasm");
const withComponent = existsSync(COMPONENT);
let router: Router | undefined;
const routerFor = (h: string, db: HostDb) => {
  const signer = new Signer(masterKey({}, h));
  const r: Router = new Router({
    db, walletFor: (row) => signer.wallet(row.handle), providerKeyFor: (n) => signer.providerKey(n), home: h, port,
    // No host skein here (#113): the handles resolve over host.db (a fixture).
    discovery: fakeDiscovery(db, () => r),
    owner: ownerId, infer: inferId, idleMs: 0, kernel: { command: kernel, env: { SKEIN_HOME: h } },
    log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
  });
  return r;
};

/** The instances the shell app is installed into (#83); the others have the chat app only. */
const withShell = new Set(["beta"]);

async function talk(r: Router, handles: string[], install?: string): Promise<void> {
  await r.listen(port);
  // The apps on top of the booted system (#83), from the host at `install`'s SKEIN_HOME; a restored checkpoint has them already.
  if (install) for (const h of handles) { await r.hydrate(h); await installApps({ home: install, port, owner, settled: () => r.settled() }, h, withShell.has(h) ? [SHELL_APP, CHAT_APP] : [CHAT_APP]); }
  const base = `http://127.0.0.1:${port}`;
  const iw = ephemeralWallet(inferKey);
  const peer = new InferPeer({ log: (l) => lines.push(`infer: ${l}`), wallet: iw, providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } },
    fetch: (async (_u: string, init: { body: string }) => {
      // The prompt the loop sent: its system message is SOUL.md from the tree it runs over (main).
      const soul = String((JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> }).messages.find((m) => m.role === "system")?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: soul.includes("booted from a system tree") ? "I was booted from a system tree." : `no soul: ${soul.slice(0, 80)}` } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "q" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
    raw: {
      inbox: new RawBox(iw, `${base}/@infer`),
      outbox: (url) => new RawBox(iw, url),
      // Its address book (#40), configured: every row's key at its origin.
      addressOf: (k) => { const x = r.o.db.list().find((y) => y.identity === k && y.kind !== "mailbox") ?? r.o.db.mailboxOf(k); return x && r.originOf(x.handle); },
    } });
  const mine = new RawBox(owner, `${base}/@david`);
  const box = { ack: (ids: string[]) => mine.ack(ids) };
  const inbox = async (b: string) => (await mine.list(b)).map((m) => ({ id: m.messageId, body: m.value as Record<string, unknown> }));
  for (const h of handles) {
    const id = r.o.db.get(h)!.identity!;
    const to = new RawBox(owner, `${base}/@${h}`);
    const send = async (b: string, body: unknown) => { await to.send(id, b, body); };
    await send("chat", { text: "Who are you?" });
    const [a] = await until(`${h}'s chat answer`, async () => { await peer.poll(); const x = await inbox("chat"); return x.length ? x : undefined; });
    check(a!.body.text === "I was booted from a system tree.", `${h}: a chat answered, the loop reading SOUL.md from main (the system tree) (${String(a!.body.text).slice(0, 80)})`);
    await box.ack([a!.id]);
    if (withShell.has(h)) {
      await send("shell/run", { cmd: "cat etc/config.json | head -c 1; ls bin | head -3; cat SOUL.md" });
    const [x] = await until(`${h}'s run`, async () => { const y = await inbox("results"); return y.length ? y : undefined; });
    check(text(x!.body.stdout).includes("booted from a system tree") && text(x!.body.stdout).includes("frontdoor.cid"), `${h}: a run over main sees the system tree (${JSON.stringify(text(x!.body.stdout)).slice(0, 100)})`);
    await box.ack([x!.id]);
    }
    if (!withComponent) continue;
    // The component handler from bin/ (#34): an owner's `list` to its box, answered by the component.
    const g = await r.loaded.get(h)!.kernel.genesis() as { programs: Record<string, CID> };
    const prog = g.programs.wallet!;
    const rec = await r.loaded.get(h)!.kernel.store.get(prog) as { code: { wasm: CID } };
    check(rec.code.wasm.equals(rawCid(readFileSync(COMPONENT))), `${h}: bin/wallet.wasm (a component) is the wallet program's module`);
    await send("wallet", { op: "list" });
    const view = openStoreFile(r.o.db.get(h)!.store, { readOnly: true });
    try {
      const out = await until(`${h}'s wallet list`, async () => {
        for (const t of await collect(view.edges.query({ kind: "thread", program: prog }))) {
          for (const u of (await collect(view.chains.history(t))).slice(1)) {
            const up = await view.get(u) as { state: string; result?: { stdout: Uint8Array }; error?: { message: string } };
            if (up.state === "errored") return { error: up.error?.message };
            if (up.state === "finished") return { result: decode<{ op: string; outputs: unknown[] }>(await view.bytes(CID.decode(Buffer.from(Buffer.from(up.result!.stdout).toString().trim(), "hex")))) };
          }
        }
        return undefined;
      });
      check(out.result?.op === "list" && Array.isArray(out.result.outputs), `${h}: the component handler ran and answered the list (${JSON.stringify(out).slice(0, 120)})`);
    } finally { view.close(); }
  }
  // Everything admitted is processed before the router stops: a store stopped mid-delivery replays a step it never ran.
  await r.settled();
}

try {
  // The stock system as a tree, one handler as its module bytes, a soul.
  check((await cli(home, "system", sys)).code === 0, "skein-host system writes the stock system tree");
  await fs.rm(join(sys, "bin/resolve.cid"));
  copyFileSync(join(here, "../../wasm/resolve.wasm"), join(sys, "bin/resolve.wasm"));
  await fs.writeFile(join(sys, "SOUL.md"), "You were booted from a system tree.\n");
  const config = JSON.parse(readFileSync(join(sys, "etc/config.json"), "utf8"));
  config.defaults.model = "ripper/booted";
  if (withComponent) {
    // A WASI 0.2 component as a handler (#34): its bytes in bin/, its record's metadata beside it, a box for it.
    copyFileSync(COMPONENT, join(sys, "bin/wallet.wasm"));
    await fs.writeFile(join(sys, "bin/wallet.json"), JSON.stringify({ inputs: WALLET.inputs, services: WALLET.services, description: WALLET.description }));
    const rows = JSON.parse(readFileSync(join(sys, "etc/dispatch.json"), "utf8"));
    await fs.writeFile(join(sys, "etc/dispatch.json"), JSON.stringify([...rows, { address: "wallet", sender: "$owner", program: "wallet" }]));
    config.defaults.walletNetwork = "regtest";
  } else process.stdout.write("note: no wallet component build (programs/wallet: zig build component); the component handler case is skipped\n");
  await fs.writeFile(join(sys, "etc/config.json"), JSON.stringify(config));

  // The owner's and the inference peer's mailbox instances, before the agents (whose geneses name the owner's).
  check((await cli(home, "add", "david", "--mailbox", "--owner", ownerId)).code === 0 && (await cli(home, "add", "infer", "--mailbox", "--owner", inferId)).code === 0, "mailbox instances for the owner and the inference peer");
  // Source A: the directory.
  const a = await cli(home, "add", "alpha", "--boot", sys);
  check(a.code === 0 && a.out.some((l) => l.startsWith("alpha: booted from ")), `add --boot <dir> (${a.out.join(" | ").slice(0, 200)})`);
  // Source B: a packet of the same directory (ordfs form, mined), with its proofs checked.
  const pk = join(work, "system.packet"), roots = join(work, "roots.json");
  const p = await cli(home, "pack", sys, pk, "--mined", roots);
  check(p.code === 0, `pack <dir> (${p.out.join(" | ")})`);
  const b = await cli(home, "add", "beta", "--packet", pk, "--proofs", roots);
  check(b.code === 0 && b.out.some((l) => l.startsWith("beta: booted from ")), `add --packet --proofs (${b.out.join(" | ").slice(0, 200)})`);
  const bad = await cli(home, "add", "gamma", "--packet", pk, "--scope", "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
  check(bad.code === 1 && bad.out.some((l) => l.includes("scope-mismatch")), "a packet for another scope is refused");
  const db = new HostDb(join(home, "host.db"));
  db.remove("gamma");
  const alphaRow = db.get("alpha")!, betaRow = db.get("beta")!;
  const scope = decodePacket(new Uint8Array(readFileSync(pk))).scope;
  check(alphaRow.tree === scope.toString() && betaRow.tree === scope.toString(), "a directory and a packet of it yield the same tree");

  router = routerFor(home, db);
  await router.start();
  for (const h of ["alpha", "beta"]) {
    const k = router.loaded.get(h)!.kernel;
    const g = await k.genesis() as { tree?: { toString(): string }; defaults: Record<string, string>; programs: Record<string, unknown>; dispatch: unknown[] };
    check(g.tree?.toString() === scope.toString() && g.defaults.model === "ripper/booted", `${h}: the genesis names the tree and takes its config`);
    check(String(await k.call("head", "main")) === scope.toString(), `${h}: main is the system tree`);
    check(Object.keys(g.programs).sort().join() === `frontdoor,messagebox,resolve${withComponent ? ",wallet" : ""}`, `${h}: its programs are bin/'s, no shell (#83: an app) (${Object.keys(g.programs)})`);
    check(keyHex((await k.genesis() as { owner: Uint8Array }).owner) === ownerId, `${h}: $owner is the host's owner`);
  }
  await talk(router, ["alpha", "beta"], home);
  await router.stop();
  router = undefined;

  // A checkpoint of alpha, restored on a second host with the same master key.
  const ck = join(work, "alpha.checkpoint");
  const c = await cli(home, "pack", "alpha", ck, "--checkpoint");
  check(c.code === 0, `pack <handle> --checkpoint (${c.out.join(" | ")})`);
  await fs.mkdir(home2, { recursive: true });
  copyFileSync(join(home, "master.key"), join(home2, "master.key"));
  await cli(home2, "add", "david", "--mailbox", "--owner", ownerId);
  await cli(home2, "add", "infer", "--mailbox", "--owner", inferId);
  const rc = await cli(home2, "add", "alpha", "--packet", ck);
  check(rc.code === 0 && rc.out.some((l) => l.startsWith("alpha: restored checkpoint")), `add --packet <checkpoint> (${rc.out.join(" | ").slice(0, 200)})`);
  const db2 = new HostDb(join(home2, "host.db"));
  // The derived state and every record; not `indexBlocks` (the count of index history, which a checkpoint leaves behind).
  const dump = (path: string) => spawnSync(kernel, ["dump", path], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout.replace(/,"indexBlocks":\d+}\s*$/, "}");
  const d1 = dump(db2.get("alpha")!.store), d0 = dump(alphaRow.store);
  if (process.env.KEEP) { await fs.writeFile(join(work, "d0.json"), d0); await fs.writeFile(join(work, "d1.json"), d1); }
  check(d1 === d0 && d0.length > 1000, "the restored store's derived state is the source's (read from the state record, not rebuilt)");
  router = routerFor(home2, db2);
  await router.start();
  await talk(router, ["alpha"]);
  await router.stop();
  router = undefined;
  db.close();
  db2.close();

  const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), alphaRow.store, betaRow.store], { encoding: "utf8" });
  process.stdout.write(r.stdout);
  check(r.status === 0 && (r.stdout.match(/identical .*the source store reproduced exactly/g) ?? []).length === 2, "the booted stores replay to themselves exactly (the replay copies the system tree)");
} catch (e) {
  check(false, `the scenario ran: ${(e as Error).stack}\n${lines.slice(-30).join("\n")}`);
  await router?.stop();
}
if (!process.env.KEEP) rmSync(work, { recursive: true, force: true }); else process.stdout.write(`kept ${work}\n`);
process.stdout.write(failures ? `boot: ${failures} FAILED\n` : "boot: all ok\n");
process.exit(failures ? 1 : 0);
