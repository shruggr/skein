// skein — David's client. Signs as David through his wallet-api, talks only to
// the messagebox. See scripts/host/README.md for the processes it expects.
//
//   skein whoami
//   skein import <dir>
//   skein run --tree <cid> [--cwd <path>] [--env K=V]... -- '<cmd>'
//   skein inbox [--wait] [--timeout <s>] [--no-ack] [--json]

import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { SkeinClient, type Result } from "./client.ts";

export type Command =
  | { cmd: "whoami" }
  | { cmd: "import"; dir: string }
  | { cmd: "run"; tree: string; cwd?: string; env?: Record<string, string>; line: string }
  | { cmd: "inbox"; wait: boolean; timeout: number; ack: boolean; json: boolean }
  | { cmd: "help" };

export const USAGE = `usage:
  skein whoami
  skein import <dir>
  skein run --tree <cid> [--cwd <path>] [--env K=V]... -- '<cmd>'
  skein inbox [--wait] [--timeout <seconds>] [--no-ack] [--json]`;

export function parseCli(argv: string[]): Command {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined: case "help": case "-h": case "--help":
      return { cmd: "help" };
    case "whoami":
      parseArgs({ args: rest, options: {}, allowPositionals: false });
      return { cmd: "whoami" };
    case "import": {
      const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
      if (positionals.length !== 1) throw new Error("import: expected exactly one <dir>");
      return { cmd: "import", dir: positionals[0]! };
    }
    case "run": {
      const dd = rest.indexOf("--");
      if (dd < 0) throw new Error("run: the command goes after `--`");
      const line = rest.slice(dd + 1).join(" ");
      if (!line.trim()) throw new Error("run: empty command");
      const { values, positionals } = parseArgs({
        args: rest.slice(0, dd),
        options: { tree: { type: "string" }, cwd: { type: "string" }, env: { type: "string", multiple: true } },
        allowPositionals: true,
      });
      if (positionals.length) throw new Error(`run: unexpected ${positionals.join(" ")} (the command goes after \`--\`)`);
      if (!values.tree) throw new Error("run: --tree <cid> is required");
      let env: Record<string, string> | undefined;
      for (const kv of values.env ?? []) {
        const i = kv.indexOf("=");
        if (i <= 0) throw new Error(`run: --env wants K=V, got ${kv}`);
        (env ??= {})[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return { cmd: "run", tree: values.tree, line, ...(values.cwd !== undefined && { cwd: values.cwd }), ...(env && { env }) };
    }
    case "inbox": {
      const { values } = parseArgs({
        args: rest,
        options: { wait: { type: "boolean" }, timeout: { type: "string" }, "no-ack": { type: "boolean" }, json: { type: "boolean" } },
        allowPositionals: false,
      });
      const timeout = values.timeout === undefined ? 300 : Number(values.timeout);
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(`inbox: bad --timeout ${values.timeout}`);
      return { cmd: "inbox", wait: !!values.wait, timeout, ack: !values["no-ack"], json: !!values.json };
    }
    default:
      throw new Error(`unknown command: ${sub}`);
  }
}

// ---------------------------------------------------------------- printing

function text(v: unknown): string {
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return v === undefined || v === null ? "" : String(v);
}

function show(r: Result, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(r, (_k, v) => (v instanceof Uint8Array ? text(v) : v)));
    return;
  }
  const b = r.body ?? {};
  console.log(`— ${r.created ?? "?"} from ${r.sender.slice(0, 16)}… ${r.verified ? "verified" : "UNVERIFIED"} msg ${r.messageId.slice(0, 12)}`);
  if (r.error) { console.log(`  error: ${r.error}`); return; }
  if (b.replyTo !== undefined) console.log(`  replyTo:  ${text(b.replyTo)}`);
  if (b.exitCode !== undefined) console.log(`  exitCode: ${text(b.exitCode)}`);
  if (b.tree !== undefined) console.log(`  tree:     ${text(b.tree)}`);
  for (const k of ["stdout", "stderr"] as const) {
    const s = text(b[k]);
    if (s) console.log(`  ${k}:\n${s.replace(/^/gm, "    ").replace(/\s+$/, "")}`);
  }
  const other = Object.keys(b).filter((k) => !["replyTo", "exitCode", "tree", "stdout", "stderr"].includes(k));
  for (const k of other) console.log(`  ${k}: ${JSON.stringify(b[k], (_k, v) => (v instanceof Uint8Array ? text(v) : v))}`);
}

// ---------------------------------------------------------------- main

export async function main(argv: string[]): Promise<number> {
  const c = parseCli(argv);
  if (c.cmd === "help") { console.log(USAGE); return 0; }
  const cfg = loadConfig();
  const client = new SkeinClient(cfg);

  switch (c.cmd) {
    case "whoami": {
      console.log(`owner (you):  ${await client.identityKey()}  via ${cfg.walletUrl} as ${cfg.originator}`);
      console.log(`instance:     ${cfg.instance.identityKey}  ${cfg.instance.handle}@${cfg.instance.domain}`);
      console.log(`messagebox:   ${cfg.messageboxUrl}`);
      return 0;
    }
    case "import": {
      const r = await client.importDir(c.dir, (i, n, bytes) => process.stderr.write(`bundle ${i + 1}/${n} (${bytes} bytes)\n`));
      process.stderr.write(`${r.records} objects in ${r.bundles.length} envelope(s) to box objects\n`);
      console.log(r.root.toString());
      return 0;
    }
    case "run": {
      const s = await client.run({ tree: c.tree, cmd: c.line, cwd: c.cwd, env: c.env });
      console.log(s.cid);
      return 0;
    }
    case "inbox": {
      const want = c.wait ? client.lastSent("run")?.cid : undefined;
      if (c.wait && !want) throw new Error("inbox --wait: no run sent from this machine yet (~/.skein/client/sent.jsonl)");
      const deadline = Date.now() + c.timeout * 1000;
      for (;;) {
        const rs = await client.inbox({ ack: c.ack });
        for (const r of rs) show(r, c.json);
        if (!c.wait || rs.some((r) => r.body && text(r.body.replyTo) === want)) return 0;
        if (Date.now() > deadline) { console.error(`inbox: no result for ${want} within ${c.timeout}s`); return 1; }
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e: Error) => {
    console.error(`skein: ${e.message}`);
    process.exit(1);
  });
}
