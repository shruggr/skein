#!/usr/bin/env node
// skein-host for the npm package (and any checkout): src/host/cli.ts built to dist/ (node strips no
// types under node_modules), else the checkout's TypeScript. No shell, no toolchain: node alone
// (the kernel is the wasm file the package ships). As bin/skein-host does: SKEIN_HOME (default
// ~/.skein), and for run | add | event | init SKEIN_OWNER / SKEIN_INFER from owner.identity /
// infer.identity under it when unset.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const home = process.env.SKEIN_HOME || join(homedir(), ".skein");
process.env.SKEIN_HOME = home;
const cmd = process.argv[2] ?? "";
if (["run", "add", "event", "init"].includes(cmd)) {
  for (const [k, f] of [["SKEIN_OWNER", "owner.identity"], ["SKEIN_INFER", "infer.identity"]]) {
    if (!process.env[k] && existsSync(join(home, f))) process.env[k] = readFileSync(join(home, f), "utf8").trim();
  }
}
const built = new URL("dist/host/cli.js", root);
const { main } = await import(existsSync(built) ? built.href : new URL("src/host/cli.ts", root).href);
process.exitCode = await main(process.argv.slice(2), { vars: process.env, out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) });
