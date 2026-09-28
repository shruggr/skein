// The bootstrap loader (issue #4) end to end, through `skein-host` and the
// router, on the Zig kernel: the stock system written as a system tree
// (`skein-host system`), one handler carried as a .wasm file, a SOUL.md;
//   alpha   booted from the directory (`add --boot <dir>`)
//   beta    booted from a packet of it (`pack <dir>` in the ordfs form, mined; `add --packet --proofs`)
// Each is chatted with — no tree named, so the loop reads `main`, the system
// tree — and runs a command over `main`. Then alpha is checkpointed (`pack
// --checkpoint`) and restored into a second host with the same master key
// (`add --packet`): the restored store's derived state is the source's, and
// it goes on answering. Finally the booted stores are replayed Zig against
// Zig (replays.ts): the replay copies the system tree and reproduces them.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/boot.ts

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthFetch, PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { open, seal, verify, type Envelope } from "../../src/envelope.ts";
import { main } from "../../src/host/cli.ts";
import { keyHex } from "../../src/host/genesis.ts";
import { HostDb } from "../../src/host/instances.ts";
import { messageBoxClient, type MessageBox } from "../../src/host/messagebox.ts";
import { masterKey, Oracle } from "../../src/host/oracle.ts";
import { decodePacket } from "../../src/host/packet.ts";
import { Router } from "../../src/host/router.ts";
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
const cli = async (home: string, ...argv: string[]) => {
  const out: string[] = [];
  const code = await main(argv, { vars: { ...process.env, SKEIN_HOME: home, SKEIN_OWNER: ownerId, SKEIN_INFER: inferId, SKEIN_KERNEL_BIN: kernel }, out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) });
  lines.push(`$ skein-host ${argv.join(" ")}`, ...out);
  if (process.env.VERBOSE) process.stdout.write(`  | $ skein-host ${argv.join(" ")}\n${out.map((l) => `  | ${l}\n`).join("")}`);
  return { code, out };
};

const home = join(work, "home"), home2 = join(work, "home2");
const sys = join(work, "system");
let router: Router | undefined;
const routerFor = (h: string, db: HostDb) => {
  const oracle = new Oracle(masterKey({}, h));
  return new Router({
    db, walletFor: (row) => oracle.wallet(row.handle), authWallet: oracle.routerWallet(),
    owner: ownerId, infer: inferId, idleMs: 0, kernel: { command: kernel, env: { SKEIN_HOME: h } },
    log: (s, l) => { lines.push(`[${s}] ${l}`); if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
  });
};

async function talk(r: Router, handles: string[]): Promise<void> {
  const base = `http://127.0.0.1:${((await r.listen(0)).address() as { port: number }).port}`;
  for (const [w, name] of [[owner, "david"], [ephemeralWallet(inferKey), "infer"]] as const) {
    const res = await new AuthFetch(w).fetch(`${base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name }) });
    if (res.status !== 200 && res.status !== 409) throw new Error(`register ${name}: ${res.status}`);
  }
  const box: MessageBox = messageBoxClient(owner, `${base}/messagebox`, "skein-client");
  const peer = new InferPeer({ log: (l) => lines.push(`infer: ${l}`), wallet: ephemeralWallet(inferKey), box: messageBoxClient(ephemeralWallet(inferKey), `${base}/messagebox`, "skein-infer"), providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } },
    fetch: (async (_u: string, init: { body: string }) => {
      // The prompt the loop sent: its system message is SOUL.md from the tree it runs over (main).
      const soul = String((JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> }).messages.find((m) => m.role === "system")?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: soul.includes("booted from a system tree") ? "I was booted from a system tree." : `no soul: ${soul.slice(0, 80)}` } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "q" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
    now: () => Date.now() });
  const inbox = async (b: string) => {
    const out: Array<{ id: string; body: Record<string, unknown> }> = [];
    for (const m of await box.list(b)) {
      const e = (typeof m.body === "string" ? JSON.parse(m.body) : m.body) as Envelope;
      if (!verify(e)) throw new Error("reply does not verify");
      out.push({ id: m.messageId, body: dagCbor.decode((await open(owner, e)).body) as Record<string, unknown> });
    }
    return out;
  };
  for (const h of handles) {
    const id = r.o.db.get(h)!.identity!;
    const send = async (b: string, body: unknown) => box.send({ recipient: id, box: b, body: await seal(owner, { recipient: { identityKey: id, handle: h, domain: "localhost" }, body: dagCbor.encode(body), created: new Date().toISOString() }) });
    await send("chat", { text: "Who are you?" });
    const [a] = await until(`${h}'s chat answer`, async () => { await peer.poll(); const x = await inbox("chat"); return x.length ? x : undefined; });
    check(a!.body.text === "I was booted from a system tree.", `${h}: a chat answered, the loop reading SOUL.md from main (the system tree) (${String(a!.body.text).slice(0, 80)})`);
    await box.ack([a!.id]);
    await send("run", { cmd: "cat etc/config.json | head -c 1; ls bin | head -3; cat SOUL.md" });
    const [x] = await until(`${h}'s run`, async () => { const y = await inbox("results"); return y.length ? y : undefined; });
    check(text(x!.body.stdout).includes("booted from a system tree") && text(x!.body.stdout).includes("head-handler.cid"), `${h}: a run over main sees the system tree (${JSON.stringify(text(x!.body.stdout)).slice(0, 100)})`);
    await box.ack([x!.id]);
  }
}

try {
  // The stock system as a tree, one handler as its module bytes, a soul.
  check((await cli(home, "system", sys)).code === 0, "skein-host system writes the stock system tree");
  await fs.rm(join(sys, "bin/run-handler.cid"));
  copyFileSync(join(here, "../../wasm/run-handler.wasm"), join(sys, "bin/run-handler.wasm"));
  await fs.writeFile(join(sys, "SOUL.md"), "You were booted from a system tree.\n");
  const config = JSON.parse(readFileSync(join(sys, "etc/config.json"), "utf8"));
  config.defaults.model = "ripper/booted";
  await fs.writeFile(join(sys, "etc/config.json"), JSON.stringify(config));

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
    const g = await k.genesis() as { tree?: { toString(): string }; defaults: Record<string, string>; programs: Record<string, unknown>; subscriptions: unknown[] };
    check(g.tree?.toString() === scope.toString() && g.defaults.model === "ripper/booted", `${h}: the genesis names the tree and takes its config`);
    check(String(await k.call("head", "main")) === scope.toString(), `${h}: main is the system tree`);
    check(Object.keys(g.programs).sort().join() === "head-handler,loop,messagebox,objects-handler,run-handler,shell,subscribe-handler", `${h}: its programs are bin/'s (+ the VM's shell) (${Object.keys(g.programs)})`);
    check(keyHex((await k.genesis() as { owner: Uint8Array }).owner) === ownerId, `${h}: $owner is the host's owner`);
  }
  await talk(router, ["alpha", "beta"]);
  await router.stop();
  router = undefined;

  // A checkpoint of alpha, restored on a second host with the same master key.
  const ck = join(work, "alpha.checkpoint");
  const c = await cli(home, "pack", "alpha", ck, "--checkpoint");
  check(c.code === 0, `pack <handle> --checkpoint (${c.out.join(" | ")})`);
  await fs.mkdir(home2, { recursive: true });
  copyFileSync(join(home, "master.key"), join(home2, "master.key"));
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
