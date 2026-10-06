// `skein plan` and `skein send` (#124): the owner's admin messages as files,
// and their delivery by a BRC-100 wallet (src/client/admin.ts).
//
//   skein plan install <repo-url#commit | dir> <where> [--config json] [--out dir]
//   skein plan uninstall <app> <where> [--out dir]
//   skein plan dispatch add|remove [--sender key] <box> <handler> <where> [--out dir]
//   skein plan dispatch add|remove --http [--prefix] --fn f [--settings json] [--sender key|session] <path> <handler> <where> [--out dir]
//   skein plan peers add <key> <address> [--transport mailbox|libp2p|local] [--handle h@d] <where> [--out dir]
//   skein plan peers remove <key> <where> [--out dir]
//   skein plan deploy <dir> [--only glob,glob | --all] <where> [--out dir]
//   skein plan claim [--messagebox url] [--handle h@d] <where> [--out dir]
//   skein plan host add|remove (<host-key> --x sats [--rates json] | --from <host origin>) <where> [--out dir]
//   skein send <origin> <dir>
//
// <where> is how the plan reads the instance: `--origin <url>` (its explorer,
// the owner's, read through the wallet: `1sat authfetch GET`), or `--store
// <runtime.db>` (its store file, read only, on the host). `dispatch`, `peers`
// `claim` (#127: an image's claim row, from anyone; the sender owns it),
// and `deploy` also take `--recipient <identity key>` alone (no reads: a
// deploy then sends every object and the head). With `--out` the plan is a
// directory — prompt.txt and 001-<box>.json, … — else the prompt goes to
// stderr and the messages to stdout, one JSON body per line. `send` POSTs a
// directory's files in order to <origin>/sendMessage with the wallet
// ($SKEIN_AUTHFETCH, default `1sat authfetch`), stopping at the first answer
// that is not 2xx.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CID } from "multiformats/cid";
import { authfetchPoster, authfetchReader, deliver, explorerView, messageJson, oversized, planClaim, planDeploy, planDispatch, planFiles, planHost, planInstallApp, planPeers, planUninstallApp, writePlan, type AdminPlan, type HostTerms, type PeerChange } from "./admin.ts";
import type { InstanceView } from "../host/plan.ts";

export const PLAN_USAGE = `usage:
  skein plan install <repo-url#commit | dir> <where> [--config json] [--out dir]   an app (docs/APPS.md §3): objects, head <app>/app, its dispatch rows, start
  skein plan uninstall <app> <where> [--out dir]                                     its stop, then its dispatch rows removed (the heads are left)
  skein plan dispatch add|remove [--sender key] <box> <handler> <where> [--out dir]  a mailbox row of the dispatch table (#77)
  skein plan dispatch add|remove --http [--prefix] --fn f [--settings json] [--sender key|session] <path> <handler> <where> [--out dir]
                                                                                     an http row (#125: e.g. an app's handler at /); <handler>: a program
                                                                                     record CID, a genesis program, or <app>.<role> (the installed app's)
  skein plan peers add <key> <address> [--transport mailbox|libp2p|local] [--handle h@d] <where> [--out dir]
  skein plan peers remove <key> <where> [--out dir]                                  an address-book entry (#70)
  skein plan deploy <dir> [--only glob,glob | --all] <where> [--out dir]             a directory into main (objects, head)
  skein plan claim [--messagebox url] [--handle h@d] <where> [--out dir]             an image's claim (#127): the wallet that sends it owns the instance
  skein plan host add|remove (<host-key> --x sats [--rates json] | --from <host origin>) <where> [--out dir]
                                                                                     the host row (#130): the host and its rates, granted (--from: the terms
                                                                                     the host publishes at /.well-known/skein-host)
  skein send <origin> <dir>                                                          the files, in order, to <origin>/sendMessage by the wallet
<where>: --origin <url> (the explorer, read by the wallet: \`1sat authfetch GET\`; the owner's) | --store <runtime.db> (read only)
         | --recipient <key> (dispatch, peers, deploy, claim: no reads)
the wallet: $SKEIN_AUTHFETCH, default \`1sat authfetch\` (load its env first: set -a; . ~/.1sat/cli/wallet.env; set +a)`;

export interface AdminEnv {
  vars: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
}

const where = { origin: { type: "string" }, store: { type: "string" }, recipient: { type: "string" }, out: { type: "string" } } as const;

/** The instance as the plan reads it: --origin (its explorer, through the wallet) or --store (its file). */
async function viewOf(v: { origin?: string; store?: string }, env: AdminEnv): Promise<{ view: InstanceView; close(): void }> {
  if (v.origin && v.store) throw new Error("--origin or --store, not both");
  if (v.origin) return { view: await explorerView(authfetchReader(v.origin, (env.vars.SKEIN_AUTHFETCH || "1sat authfetch").split(/\s+/))), close: () => {} };
  if (v.store) {
    if (!existsSync(v.store)) throw new Error(`--store ${v.store}: no such file`);
    const { openStoreFile } = await import("../runtime/index-store.ts");
    const { instanceView } = await import("../host/install.ts");
    const s = openStoreFile(v.store, { readOnly: true });
    try { return { view: await instanceView(s), close: () => s.close() }; } catch (e) { s.close(); throw e; }
  }
  throw new Error("where is the instance: --origin <url> or --store <runtime.db>");
}

/** The view, or with --recipient alone the key only. */
async function targetOf(v: { origin?: string; store?: string; recipient?: string }, env: AdminEnv): Promise<{ view?: InstanceView; recipient: string; close(): void }> {
  if (v.recipient !== undefined) {
    if (v.origin || v.store) throw new Error("--recipient goes alone (no reads)");
    if (!/^0[23][0-9a-f]{64}$/.test(v.recipient)) throw new Error(`--recipient ${v.recipient}: not an identity key (hex)`);
    return { recipient: v.recipient, close: () => {} };
  }
  const { view, close } = await viewOf(v, env);
  return { view, recipient: view.identity, close };
}

function emit(p: AdminPlan, out: string | undefined, env: AdminEnv): void {
  const big = oversized(p);
  if (big.length) {
    const max = Math.max(...big.map((b) => b.bytes));
    p = { ...p, prompt: [...p.prompt, `  note      ${big.length} message${big.length === 1 ? " is" : "s are"} over 4 MB as JSON (the largest ${(max / 1e6).toFixed(1)} MB: a module travels whole): \`1sat authfetch\` refuses a body that large ("Authentication message exceeds the byte limit"); send those with a wallet that takes them`] };
  }
  if (out) {
    for (const l of p.prompt) env.out(l);
    const files = writePlan(resolve(out), p);
    env.out(`${out}: prompt.txt and ${files.length} message${files.length === 1 ? "" : "s"} to ${p.recipient}`);
    return;
  }
  for (const l of p.prompt) env.err(l);
  for (const m of p.messages) env.out(messageJson(p.recipient, m));
}

export async function planMain(argv: string[], env: AdminEnv): Promise<number> {
  const [what, ...rest] = argv;
  try {
    switch (what) {
      case "install": {
        const { values: v, positionals: [spec, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { ...where, config: { type: "string" } } });
        if (!spec || more.length || v.recipient !== undefined) { env.err(PLAN_USAGE); return 2; }
        let config: Record<string, unknown> | undefined;
        if (v.config !== undefined) {
          try { config = JSON.parse(v.config) as Record<string, unknown>; } catch { config = undefined; }
          if (!config || typeof config !== "object" || Array.isArray(config)) { env.err("skein plan install --config: a JSON object ({<program>: {…}}), merged over the manifest's config"); return 2; }
        }
        const { fetchApp, readApp } = await import("../host/install.ts");
        const { wasmDirObjects, WASM_DIR } = await import("../host/boot.ts");
        const tree = await readApp(fetchApp(spec));
        const { view, close } = await viewOf(v, env);
        try {
          emit(await planInstallApp(tree, view, { config, modules: wasmDirObjects(WASM_DIR) }), v.out, env);
        } finally { close(); }
        return 0;
      }
      case "uninstall": {
        const { values: v, positionals: [app, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: where });
        if (!app || more.length || v.recipient !== undefined) { env.err(PLAN_USAGE); return 2; }
        const { view, close } = await viewOf(v, env);
        try { emit(await planUninstallApp(app, view), v.out, env); } finally { close(); }
        return 0;
      }
      case "dispatch": {
        const { values: v, positionals: [op, box, handler, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { ...where, sender: { type: "string" }, http: { type: "boolean" }, prefix: { type: "boolean" }, fn: { type: "string" }, settings: { type: "string" } } });
        if (!handler || more.length || (op !== "add" && op !== "remove")) { env.err(PLAN_USAGE); return 2; }
        if (!v.http && (v.prefix || v.fn !== undefined || v.settings !== undefined)) { env.err("skein plan dispatch: --prefix, --fn and --settings are an http row's (--http)"); return 2; }
        let settings: Record<string, unknown> | undefined;
        if (v.settings !== undefined) {
          try { settings = JSON.parse(v.settings) as Record<string, unknown>; } catch { settings = undefined; }
          if (!settings || typeof settings !== "object" || Array.isArray(settings)) { env.err("skein plan dispatch --settings: a JSON object (the handler's own settings, e.g. {\"root\":\"www\"})"); return 2; }
        }
        const t = await targetOf(v, env);
        try {
          const programs = { ...(t.view?.programs as Record<string, CID> | undefined) };
          // <app>.<role>: the installed app's program (its app record's `programs`).
          const role = /^([a-z0-9][a-z0-9-]*)\.([A-Za-z0-9_-]+)$/.exec(handler);
          if (role && !programs[handler]) {
            if (!t.view) throw new Error(`handler ${handler}: an app's program needs the instance's view (--origin or --store), not --recipient`);
            const { appRecordIn } = await import("../host/plan.ts");
            const app = await appRecordIn(t.view, role[1]!);
            if (!app) throw new Error(`handler ${handler}: no app ${role[1]} installed (no head ${role[1]}/app)`);
            const cid = app.record.programs[role[2]!];
            if (!cid) throw new Error(`handler ${handler}: app ${role[1]} has no program ${role[2]} (${Object.keys(app.record.programs).join(", ")})`);
            programs[handler] = cid;
          }
          emit(planDispatch(t.recipient, { op, sender: v.sender, box: box!, handler, ...(v.http ? { http: { prefix: !!v.prefix, fn: v.fn ?? "", settings } } : {}) }, programs), v.out, env);
        } finally { t.close(); }
        return 0;
      }
      case "peers": {
        const { values: v, positionals: [op, key, address, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { ...where, transport: { type: "string" }, handle: { type: "string" } } });
        const shape = op === "remove" ? !!key && !address : op === "add" ? !!key && !!address : false;
        if (more.length || !shape || ((v.transport ?? v.handle) !== undefined && op !== "add")) { env.err(PLAN_USAGE); return 2; }
        const transport = (v.transport ?? "mailbox") as "mailbox" | "libp2p" | "local";
        if (!["mailbox", "libp2p", "local"].includes(transport)) { env.err("skein plan peers: --transport is mailbox, libp2p or local"); return 2; }
        if (op === "add" && transport === "mailbox" && !/^https?:\/\/[^/]/.test(address!)) { env.err(`skein plan peers: ${address} is not an http(s) URL`); return 2; }
        let named: { handle?: string; domain?: string } = {};
        if (v.handle !== undefined) {
          const h = v.handle.replace(/^@/, "");
          const at = h.lastIndexOf("@");
          named = at > 0 ? { handle: h.slice(0, at), domain: h.slice(at + 1) } : { handle: h };
          if (!named.handle || (at > 0 && !named.domain)) { env.err(`skein plan peers: --handle ${v.handle}: want handle@domain`); return 2; }
        }
        const change: PeerChange = op === "add" ? { op: "add", key: key!, transport, address: address!, ...named } : { op: "remove", key: key! };
        const t = await targetOf(v, env);
        try { emit(planPeers(t.recipient, [change]), v.out, env); } finally { t.close(); }
        return 0;
      }
      case "claim": {
        const { values: v, positionals: more } = parseArgs({ args: rest, allowPositionals: true, options: { ...where, messagebox: { type: "string" }, handle: { type: "string" } } });
        if (more.length) { env.err(PLAN_USAGE); return 2; }
        if (v.messagebox !== undefined && !/^https?:\/\/[^/]/.test(v.messagebox)) { env.err(`skein plan claim: ${v.messagebox} is not an http(s) URL`); return 2; }
        let named: { handle?: string; domain?: string } = {};
        if (v.handle !== undefined) {
          const h = v.handle.replace(/^@/, "");
          const at = h.lastIndexOf("@");
          named = at > 0 ? { handle: h.slice(0, at), domain: h.slice(at + 1) } : { handle: h };
          if (!named.handle || (at > 0 && !named.domain)) { env.err(`skein plan claim: --handle ${v.handle}: want handle@domain`); return 2; }
        }
        const t = await targetOf(v, env);
        try { emit(planClaim(t.recipient, { messagebox: v.messagebox, ...named }), v.out, env); } finally { t.close(); }
        return 0;
      }
      case "host": {
        const { values: v, positionals: [op, key, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { ...where, x: { type: "string" }, rates: { type: "string" }, from: { type: "string" } } });
        if (more.length || (op !== "add" && op !== "remove") || (!key && v.from === undefined) || (key && v.from !== undefined)) { env.err(PLAN_USAGE); return 2; }
        let terms: HostTerms;
        if (v.from !== undefined) {
          const r = await fetch(new URL("/.well-known/skein-host", v.from));
          const b = (await r.json() as { billing?: HostTerms }).billing;
          if (!r.ok || !b) throw new Error(`${v.from}: no billing terms at /.well-known/skein-host`);
          terms = { key: b.key, x: b.x, rates: b.rates };
        } else {
          let rates: Record<string, number> | undefined;
          if (v.rates !== undefined) {
            try { rates = JSON.parse(v.rates) as Record<string, number>; } catch { rates = undefined; }
            if (!rates || typeof rates !== "object" || Array.isArray(rates)) { env.err("skein plan host --rates: a JSON object {fuel, storage, served, fetch, authfetch, publish}"); return 2; }
          }
          terms = { key: key!, x: Number(v.x ?? (op === "remove" ? 1 : NaN)), ...(rates ? { rates } : {}) };
        }
        const t = await targetOf(v, env);
        try { emit(planHost(t.recipient, op, terms), v.out, env); } finally { t.close(); }
        return 0;
      }
      case "deploy": {
        const { values: v, positionals: [dir, ...more] } = parseArgs({ args: rest, allowPositionals: true, options: { ...where, only: { type: "string" }, all: { type: "boolean" } } });
        if (!dir || more.length || (v.all && v.only !== undefined)) { env.err(PLAN_USAGE); return 2; }
        const only = v.all ? [] : v.only !== undefined ? v.only.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
        const t = await targetOf(v, env);
        try { emit(await planDeploy(resolve(dir), t.view ?? { identity: t.recipient }, { only }), v.out, env); } finally { t.close(); }
        return 0;
      }
      default:
        env.err(PLAN_USAGE);
        return what === undefined || what === "help" ? 0 : 2;
    }
  } catch (e) {
    env.err(`skein plan ${what}: ${(e as Error).message}`);
    return 1;
  }
}

/** `skein send <origin> <dir>`: the plan's files, in order, by the wallet's command; stops at the first non-2xx. */
export async function sendMain(argv: string[], env: AdminEnv): Promise<number> {
  const { positionals: [origin, dir, ...more] } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  if (!origin || !dir || more.length || !/^https?:\/\/[^/]/.test(origin)) { env.err(PLAN_USAGE); return 2; }
  const files = existsSync(dir) ? planFiles(dir) : [];
  if (!files.length) { env.err(`skein send: no message files (001-<box>.json, …) in ${dir}`); return 1; }
  const prompt = resolve(dir, "prompt.txt");
  if (existsSync(prompt)) for (const l of readFileSync(prompt, "utf8").trimEnd().split("\n")) env.out(l);
  const cmd = (env.vars.SKEIN_AUTHFETCH || "1sat authfetch").split(/\s+/);
  try {
    const done = await deliver(files, authfetchPoster(origin, cmd), (d) => env.out(`${d.file.slice(d.file.lastIndexOf("/") + 1)}: ${d.status}${d.status >= 200 && d.status <= 299 ? "" : ` ${d.text.slice(0, 300)}`}`));
    const last = done.at(-1)!;
    if (last.status < 200 || last.status > 299) { env.err(`skein send: stopped at ${last.file} (${last.status}); ${files.length - done.length} not sent`); return 1; }
    env.out(`${origin}: ${done.length} message${done.length === 1 ? "" : "s"} sent`);
    return 0;
  } catch (e) {
    env.err(`skein send: ${(e as Error).message}`);
    return 1;
  }
}
