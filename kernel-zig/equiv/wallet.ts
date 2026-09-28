// The wallet in the VM (issue #29) end to end on the Zig kernel: `skein-kernel
// serve` with equiv/wallet-peer.ts as its peer (a ProtoWallet oracle, a fake
// ARC, a messagebox hub, plain header/status entries), then the store it
// wrote replayed Zig against Zig (equiv/replays.ts): the oracle's and ARC's
// answers come from the attested records, nothing is asked again.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/wallet.ts

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL ?? join(here, "../zig-out/bin/skein-kernel");
const home = mkdtempSync(join(tmpdir(), "skein-kz-wallet-"));
const pub = (h: string) => new PrivateKey(h, 16).toPublicKey().toString();
const db = join(home, "instances/wallettest/runtime.db");

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };

const child = spawn(kernel, ["serve"], {
  env: {
    ...process.env, SKEIN_HOME: home, SKEIN_DB: db, SKEIN_HANDLE: "wallettest@localhost",
    SKEIN_OWNER: pub("2222"), SKEIN_IDENTITY: pub("1111"), SKEIN_HOST_DB: join(home, "none.db"),
    SKEIN_KERNEL_PEER: join(here, "wallet-peer.ts"), SKEIN_MESSAGEBOX: "",
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
const lines: string[] = [];
let partial = "";
child.stdout!.on("data", (d: Buffer) => { const s = partial + d.toString(); const ls = s.split("\n"); partial = ls.pop()!; for (const l of ls) { lines.push(l); if (process.env.VERBOSE) process.stdout.write(`  | ${l}\n`); } });
child.stderr!.on("data", (d: Buffer) => process.stdout.write(`  ! ${d}`));
const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
const report = existsSync(join(home, "wallet.json")) ? JSON.parse(readFileSync(join(home, "wallet.json"), "utf8")) : {};
const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

check(code === 0, `serve exits 0 (exit ${code})`);
check(report.ok === true, `the scenario ran${report.error ? `: ${report.error}` : ""}`);
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

const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(here, "replays.ts"), db], { encoding: "utf8" });
process.stdout.write(r.stdout);
if (r.status !== 0) process.stdout.write(r.stderr);
check(r.status === 0 && /identical .*the source store reproduced exactly/.test(r.stdout), "the store replays to itself exactly, twice over: oracle and http answers from the attested records");

rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `wallet: ${failures} FAILED\n` : "wallet: all ok\n");
process.exit(failures ? 1 : 0);
