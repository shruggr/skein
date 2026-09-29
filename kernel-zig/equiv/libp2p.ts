// libp2p (#51) in the equivalence suite: the two-router scenario
// (src/host/p2p-router.test.ts: publish → validate → admit, reject writes
// nothing, a stream round trip woken by its frame; replayed natively with no
// network) keeps its two stores here, and then the browser build:
//
//   - replays both in headless Chrome (equiv/browser.ts): the recorded libp2p
//     answers are served by the wasm kernel as natively — same report, same
//     dump, fuel included;
//   - runs a live step that calls the import: alpha's store with one more
//     message for its p2p-demo handler (admitted natively, not processed), then
//     loaded into a Worker and drained. The browser build has no libp2p host:
//     the call is refused with "libp2p: unsupported in the browser", nothing is
//     recorded, and the step ends errored with that message.
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
import { admit2 } from "../../src/host/genesis.ts";
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
    check(r.status === 0, "the browser build replays both stores (recorded libp2p answers served by the wasm kernel) exactly as natively");

    // ---------------------------------------------------------------- a live call, refused
    // One more message for alpha's p2p-demo box, admitted natively but not processed (no `start`).
    const live = join(work, "live.db");
    copyFileSync(join(work, "alpha.db"), live);
    if (existsSync(join(work, "alpha.db-wal"))) copyFileSync(join(work, "alpha.db-wal"), `${live}-wal`);
    const k = new Kernel({ db: live, handle: "alpha", domain: "localhost", command: kernelBin, env: { SKEIN_HOME: work } });
    const g = await k.genesis() as { identity: Uint8Array; subscriptions: Array<{ match: { sender?: Uint8Array; box?: string } }> };
    const owner = g.subscriptions.find((s) => s.match.box === "p2p")!.match.sender!;
    const bodyBytes = dagCbor.encode({ op: "publish", topic: "skein-test/demo", text: "from a tab" });
    const mail = { kind: "mail", op: "put", sender: owner, recipient: g.identity, box: "p2p", body: encode(dagCbor.decode(bodyBytes)).cid };
    const mailCid = await k.store.put(mail as never);
    await admit2(k, { mail: mailCid } as never, { body: bodyBytes });
    await k.stop();

    const said: string[] = [];
    const server = await serveKernel(async (_req, res, path) => {
      if (path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>p2p refused</title><script type="module">
          import { KernelWorker } from "/web/client.js";
          window.runLive = async () => {
            const said = [];
            const kw = new KernelWorker({ wasm: "/kernel/skein-kernel.wasm", workerUrl: "/web/worker.js", onNotify: (op, v) => { if (op === "say") said.push(typeof v === "string" ? v : new TextDecoder().decode(v)); } });
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
    const step = said.find((l) => /p2p-demo step 1 → /.test(l) && l.includes("unsupported in the browser"));
    check(!!step && /→ errored/.test(step) && !/attested/.test(step), `the live step in the browser: the libp2p call refused, nothing recorded, the step errored (${step ?? said.slice(-3).join(" | ")})`);
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
