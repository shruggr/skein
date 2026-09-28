// The wallet in the VM (issue #29) end to end on the Zig kernel: `skein-kernel
// serve` with equiv/wallet-peer.ts as its peer (a ProtoWallet oracle, a fake
// ARC, a messagebox hub, plain header/status entries), then the store it
// wrote replayed Zig against Zig (equiv/replays.ts): the oracle's and ARC's
// answers come from the attested records, nothing is asked again.
//
// Issue #34, when the wallet's component build is there
// (wallet-zig/zig-out/bin/wallet.component.wasm, `zig build component`, or
// $SKEIN_WALLET_COMPONENT): the preview1 store's log is replayed with the
// component in the module's place (equiv/abi.ts: every update identical but
// for fuel), and the whole scenario runs again live with the component as the
// wallet program: the same results, and its store replays to itself exactly.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/wallet.ts

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { MODULES } from "../../src/runtime/programs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL ?? join(here, "../zig-out/bin/skein-kernel");
const pub = (h: string) => new PrivateKey(h, 16).toPublicKey().toString();
const node = ["--experimental-strip-types", "--no-warnings"];

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** One run of the scenario: serve with the wallet peer; the exit code, the peer's report, the store. */
async function scenario(extraEnv: Record<string, string>): Promise<{ code: number | null; report: Record<string, any>; db: string; home: string }> {
  const home = mkdtempSync(join(tmpdir(), "skein-kz-wallet-"));
  const db = join(home, "instances/wallettest/runtime.db");
  const child = spawn(kernel, ["serve"], {
    env: {
      ...process.env, SKEIN_HOME: home, SKEIN_DB: db, SKEIN_HANDLE: "wallettest@localhost",
      SKEIN_OWNER: pub("2222"), SKEIN_IDENTITY: pub("1111"), SKEIN_HOST_DB: join(home, "none.db"),
      SKEIN_KERNEL_PEER: join(here, "wallet-peer.ts"), SKEIN_MESSAGEBOX: "", ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let partial = "";
  child.stdout!.on("data", (d: Buffer) => { const s = partial + d.toString(); const ls = s.split("\n"); partial = ls.pop()!; for (const l of ls) if (process.env.VERBOSE) process.stdout.write(`  | ${l}\n`); });
  child.stderr!.on("data", (d: Buffer) => process.stdout.write(`  ! ${d}`));
  const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  const report = existsSync(join(home, "wallet.json")) ? JSON.parse(readFileSync(join(home, "wallet.json"), "utf8")) : {};
  return { code, report, db, home };
}

function checkScenario(code: number | null, report: Record<string, any>, abi: string) {
  check(code === 0, `${abi}: serve exits 0 (exit ${code})`);
  check(report.ok === true, `${abi}: the scenario ran${report.error ? `: ${report.error}` : ""}`);
  check(eq(report.headers, [100, 100]), `headers 1..100 from the owner, chained from regtest's genesis (${JSON.stringify(report.headers)})`);
  check(eq(report.headerEntry, ["header", 102]), `plain header entries, routed by a sender-less subscription (${JSON.stringify(report.headerEntry)})`);
  check(eq(report.internalize, [true, "unproven"]), `a BRC-29 payment internalized (${JSON.stringify(report.internalize)})`);
  const c = report.create ?? {};
  check(c.state === "waiting" && c.awaiting === true && c.outcome === "pending" && c.arc === "SEEN_ON_NETWORK", `createAction: signed, broadcast over http, the thread awaits its status (${JSON.stringify(c)})`);
  check(c.postedIsTheTx === true && c.scriptsVerify === true, "ARC received the transaction as Atomic BEEF; @bsv/sdk verifies its scripts (signatures from the oracle)");
  check(eq(c.outputs?.slice(0, 1), [10000]) && c.outputs?.length === 2, `the payment and our change (${JSON.stringify(c.outputs)})`);
  check(eq(report.woke, { same: true, op: "callback", outcome: "pending", state: "waiting", gets: 1 }), `the deadline: the tick wakes the thread, it re-asks ARC over http, rests again (${JSON.stringify(report.woke)})`);
  check(eq(report.mined, { same: true, outcome: "proven", state: "finished" }), `a status entry (MINED + path) for the transaction's CID steps the awaiting thread: proven (${JSON.stringify(report.mined)})`);
  check(Array.isArray(report.list) && report.list.some((o: unknown[]) => o[0] === "change" && o[2] === true && o[3] === "proven") && report.list.some((o: unknown[]) => o[0] === "payment" && o[2] === false), `list: the change spendable and proven, the payment spent (${JSON.stringify(report.list)})`);
  check(eq(report.rejected, { outcome: "rejected", state: "finished", awaiting: false }) && report.afterReject === report.total, `a rejected broadcast drops the action: the balance is back (${JSON.stringify(report.rejected)}, ${report.afterReject} vs ${report.total})`);
  const d = report.draft ?? {};
  check(d.hasReference === true && d.notPostedAsDraft === true && d.awaiting === true && d.scriptsVerify === true && d.txid === true, `a draft (signAndProcess: false), then signAction: signed, broadcast, awaiting (${JSON.stringify(d)})`);
}

function replays(db: string, abi: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [...node, join(here, "replays.ts"), db], { encoding: "utf8", env: { ...process.env, ...env } });
  process.stdout.write(r.stdout);
  if (r.status !== 0) process.stdout.write(r.stderr);
  check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), `${abi}: the store replays to itself exactly, twice over: oracle and http answers from the attested records`);
}

const p1 = await scenario({});
checkScenario(p1.code, p1.report, "preview1");
replays(p1.db, "preview1");

// Issue #34: the component build of the same program.
const component = process.env.SKEIN_WALLET_COMPONENT ?? join(here, "../../wallet-zig/zig-out/bin/wallet.component.wasm");
if (existsSync(component)) {
  process.stdout.write(`== the wallet as a WASI 0.2 component (${component})\n`);
  const r = spawnSync("node", [...node, join(here, "abi.ts"), p1.db, MODULES.wallet.toString(), component], { encoding: "utf8" });
  process.stdout.write(r.stdout.split("\n").filter((l) => l).map((l) => `  ${l}\n`).join(""));
  if (r.status !== 0) process.stdout.write(r.stderr);
  check(r.status === 0, "the preview1 log replayed with the component in the module's place: every update identical but for fuel");

  const env = { SKEIN_WALLET_COMPONENT: component, SKEIN_EXTRA_MODULES: component };
  const cr = await scenario(env);
  checkScenario(cr.code, cr.report, "component");
  check(eq({ ...cr.report, create: { ...cr.report.create } }, { ...p1.report, create: { ...p1.report.create } }), "the component's run reports exactly what the module's did");
  replays(cr.db, "component", env);
  rmSync(cr.home, { recursive: true, force: true });
} else {
  process.stdout.write(`== the wallet as a component: skipped (no ${component}; \`cd wallet-zig && zig build component\`)\n`);
}

if (process.env.SKEIN_EQUIV_KEEP) process.stdout.write(`kept ${p1.db}\n`); else rmSync(p1.home, { recursive: true, force: true });
process.stdout.write(failures ? `wallet: ${failures} FAILED\n` : "wallet: all ok\n");
process.exit(failures ? 1 : 0);
