// libp2p (#51) in the equivalence suite: the two-router scenario
// (src/host/p2p-router.test.ts: publish → validate → admit, reject writes
// nothing, a stream round trip whose frame arrives as an entry; replayed
// natively with no network) keeps its two stores here, and then the browser
// build:
//
//   - replays both in headless Chrome (equiv/browser.ts): the libp2p
//     provider's answers are entries in the log, so the wasm kernel replays
//     them as natively — same report, same dump, fuel included;
//   - runs a live step that publishes (#70: an emit to the libp2p provider):
//     alpha's store with one more message for its p2p-demo handler (the
//     owner's signed message appended natively as a `local` request, K2, not
//     processed), then loaded into a Worker and drained. This
//     page answers no signer, and an emit needs none (#126 step 4: a message
//     is unsigned): the step rests waiting on its publish, handed to the tab
//     once (one `emit` notice).
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/libp2p.ts
//
// The browser parts need Playwright and Chromium (as equiv/browser.ts), else
// they are skipped with a note (SKEIN_EQUIV_BROWSER=0 skips them too).

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as dagCbor from "@ipld/dag-cbor";
import { PrivateKey } from "@bsv/sdk";
import { appendRequest } from "../../src/host/frontdoor.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL } from "../../src/host/providers.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { Kernel } from "../../src/host/kernel.ts";
import { encode } from "../../src/runtime/cid.ts";
import { bundleOf, chromium, playwright, serveKernel, writeStore } from "./browser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const kernelBin = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const work = mkdtempSync(join(tmpdir(), "skein-kz-p2p-"));
let status = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) status = 1; };

try {
  // ---------------------------------------------------------------- the scenario, natively
  const t = spawnSync("node", ["--experimental-strip-types", "--no-warnings", "--test", join(root, "src/host/p2p-router.test.ts")], { encoding: "utf8", env: { ...process.env, SKEIN_P2P_KEEP: work } });
  check(t.status === 0 && existsSync(join(work, "alpha.db")) && existsSync(join(work, "beta.db")), "two routers over libp2p: publish, validate, admit, reject, a stream round trip; both stores replayed with no network (src/host/p2p-router.test.ts)");
  if (t.status !== 0) console.log(t.stdout.split("\n").filter((l) => /✖|Error|assert/i.test(l)).slice(0, 20).join("\n"));

  const browserOk = process.env.SKEIN_EQUIV_BROWSER !== "0" && existsSync(chromium()) && spawnSync("sh", ["-c", "command -v playwright"]).status === 0;
  if (t.status !== 0) {
    // nothing more to check
  } else if (!browserOk) {
    console.log("== libp2p in the browser: skipped (SKEIN_EQUIV_BROWSER=0, or no playwright / Chromium)");
  } else {
    execFileSync("mise", ["exec", "--", "zig", "build", "web"], { cwd: join(here, ".."), stdio: "inherit" });
    // ---------------------------------------------------------------- recorded answers, served in the browser
    const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "browser.ts"), join(work, "alpha.db"), join(work, "beta.db")], { encoding: "utf8" });
    process.stdout.write(r.stdout.split("\n").map((l) => (l ? `  ${l}\n` : "")).join(""));
    check(r.status === 0, "the browser build replays both stores (the libp2p provider's answers are entries) exactly as natively");

    // ---------------------------------------------------------------- a live step in a tab with no signer
    // One more message for alpha's p2p-demo box, admitted natively but not processed (no `start`).
    const live = join(work, "live.db");
    copyFileSync(join(work, "alpha.db"), live);
    if (existsSync(join(work, "alpha.db-wal"))) copyFileSync(join(work, "alpha.db-wal"), `${live}-wal`);
    const k = new Kernel({ db: live, handle: "alpha", domain: "localhost", command: kernelBin, env: { SKEIN_HOME: work } });
    const g = await k.genesis() as { identity: Uint8Array; dispatch: Array<{ transport: string; address: string; sender: Uint8Array | string }> };
    const owner = g.dispatch.find((r) => r.transport === "mailbox" && r.address === "p2p")!.sender as Uint8Array;
    const bodyBytes = dagCbor.encode({ op: "publish", topic: "skein-test/demo", text: "from a tab" });
    // K2: the owner's message signed by the owner (src/host/p2p-router.test.ts's key) and appended as a
    // `local` request, which the front door verifies when the tab drains (no signer needed for that).
    const ownerKey = new PrivateKey("2222", 16);
    if (ownerKey.toPublicKey().toString() !== Buffer.from(owner).toString("hex")) throw new Error("the p2p row's sender is not p2p-router.test.ts's owner key");
    const unsigned = { kind: "mail", op: "put", sender: owner, recipient: g.identity, box: "p2p", body: encode(dagCbor.decode(bodyBytes)).cid, nonce: new Uint8Array(16) };
    const { signature } = await ephemeralWallet(ownerKey).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
    await appendRequest(k, "local", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) }, body: bodyBytes });
    await k.stop();

    const said: string[] = [];
    const server = await serveKernel(async (_req, res, path) => {
      if (path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>p2p refused</title><script type="module">
          import { KernelWorker } from "/web/client.js";
          window.runLive = async () => {
            const said = [];
            const kw = new KernelWorker({ wasm: "/kernel/skein-kernel.wasm", workerUrl: "/web/worker.js", onNotify: (op, v) => { if (op === "say") said.push(typeof v === "string" ? v : new TextDecoder().decode(v)); if (op === "emit") said.push("EMIT " + (v.length ?? 0)); } });
            await kw.ready;
            await kw.call("openMemory", 1, await (await fetch("/bundle")).arrayBuffer(), false);
            await kw.call("open", 1);
            await kw.call("start");
            await kw.call("drain");
            const out = await kw.call("bundle", 1);
            kw.terminate();
            await fetch("/result", { method: "POST", body: out });
            return said;
          };
          window.ready = true;</script>`);
        return true;
      }
      if (path === "/bundle") { res.writeHead(200, { "content-type": "application/octet-stream" }).end(bundleOf(live)); return true; }
      if (path === "/result") {
        const chunks: Buffer[] = [];
        for await (const c of _req) chunks.push(c as Buffer);
        writeStore(new Uint8Array(Buffer.concat(chunks)), join(work, "live.web.db"));
        res.writeHead(200).end("ok");
        return true;
      }
      return false;
    });
    const pw = await playwright();
    const browser = await pw.chromium.launch({ executablePath: chromium(), headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      page.on("pageerror", (e) => console.log(`  | page error: ${e.message}`));
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
      await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
      said.push(...await page.evaluate(async () => await (window as unknown as { runLive(): Promise<string[]> }).runLive()));
    } finally {
      await browser.close();
      server.close();
    }
    // This page answers no signer (no onRequest). An emit needs none (#126 step 4: a message is unsigned, its
    // transport proves its sender): the step rests waiting on its publish, which is handed to the tab to carry out.
    const step = said.find((l) => /p2p-demo step 1 → /.test(l));
    check(!!step && /→ waiting/.test(step) && /emitted/.test(step), `the live step in the browser, with no signer: the publish needs no signature, emitted and awaited (${step ?? said.slice(-3).join(" | ")})`);
    check(said.filter((l) => l.startsWith("EMIT ")).length === 1, "the publish handed to the tab to carry out, once");
    const dump = JSON.parse(execFileSync(kernelBin, ["dump", join(work, "live.web.db")], { maxBuffer: 1 << 30 }).toString()) as { entries: unknown[] };
    check(dump.entries.length > 0, `the tab's store reads back natively (${dump.entries.length} entries)`);
  }
} catch (e) {
  check(false, `the scenario ran: ${(e as Error).stack}`);
} finally {
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(status ? "libp2p: FAILED" : "libp2p: all ok");
process.exit(status);
