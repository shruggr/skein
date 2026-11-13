// The operator's admin commands (skein next): each builds root's requests (admin.ts, plan.ts), signs
// them in this process with the operator's key (SKEIN_OPERATOR_KEY, default $SKEIN_HOME/operator.key;
// hostenv.ts) and hands them to the running host (target.ts) — no other process, no wallet command.
//
//   skein install <dir> <where> [--config <file.json>] [--dry-run]
//   skein uninstall <app> <where> [--dry-run]
//   skein routes add|remove <row JSON> <where> [--dry-run]
//   skein grant add|remove <key> [--role root|<app>.<role>] <where> [--dry-run]
//   skein grant add|remove --calls <caller> <callee> <name> <where> [--dry-run]
//   skein grant add|remove --service <caller> <service> <where> [--dry-run]
//   skein claim [--handle h@d] <where> [--dry-run]
//   skein deploy <dir> [--only glob,glob | --all] <where> [--dry-run]
//
// <where> is the instance: `--instance <handle>` (on this host machine: host.db's row, its store read
// read-only, the requests over the running host's control socket) or `--store <runtime set>` (its
// store, read-only: planned and printed, nothing sent). `--dry-run` prints the prompt and the requests
// and sends nothing.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import { appHead, type InstanceView } from "../host/plan.ts";
import { operatorKey, type Vars } from "../host/hostenv.ts";
import { keyWallet } from "../wallet.ts";
import type { DispatchRow } from "../runtime/dispatch.ts";
import { planClaim, planDeploy, planGrant, planGrantCalls, planGrantService, planInstallApp, planRoute, planUninstallApp, type AdminPlan } from "./admin.ts";
import { localTarget, type Target } from "./target.ts";

export const ADMIN_USAGE = `usage (root's requests, signed with SKEIN_OPERATOR_KEY, default $SKEIN_HOME/operator.key):
  skein install <dir> <where> [--config <file.json>] [--dry-run]     an app (docs/APPS.md §3): head <app>/app, its rows, its grants
  skein uninstall <app> <where> [--dry-run]                          its rows removed (the heads are left)
  skein routes add|remove '<row JSON>' <where> [--dry-run]           root's own row: {kind, path | name, role, checks?, handler, …}
  skein grant add|remove <key> [--role root|<app>.<role>] <where> [--dry-run]     a grant (root by default)
  skein grant add|remove --calls <caller> <callee> <name> <where> [--dry-run]     a call permission ("*": any name)
  skein grant add|remove --service <caller> <service> <where> [--dry-run]         a kernel service (signer)
  skein claim [--handle h@d] <where> [--dry-run]                     an image's claim: root to the key that sends it
  skein deploy <dir> [--only glob,glob | --all] <where> [--dry-run]  a directory into main (objects, head)
<where>: --instance <handle> (this host machine: over its control socket) | --store <runtime set> (read only: planned and printed, nothing sent)`;

export const ADMIN_COMMANDS = ["install", "uninstall", "routes", "grant", "claim", "deploy"] as const;

export interface AdminEnv { vars: Vars; out(line: string): void; err(line: string): void }

const where = { instance: { type: "string" }, store: { type: "string" }, "dry-run": { type: "boolean" } } as const;
type Where = { instance?: string; store?: string; "dry-run"?: boolean };

interface Session { target?: Target; view(): Promise<InstanceView>; identity(): Promise<string>; dry: boolean; close(): Promise<void> }

async function sessionOf(v: Where, env: AdminEnv): Promise<Session> {
  if ((v.instance !== undefined) === (v.store !== undefined)) throw new Error("where is the instance: --instance <handle> or --store <runtime set> (one)");
  if (v.store !== undefined) {
    const { openStoreFile, storeExists } = await import("../host/stores.ts");
    if (!storeExists(v.store)) throw new Error(`--store ${v.store}: no such store`);
    const { instanceView } = await import("../host/install.ts");
    const s = openStoreFile(v.store, { readOnly: true });
    let view: InstanceView;
    try { view = await instanceView(s); } catch (e) { s.close(); throw e; }
    return { view: async () => view, identity: async () => view.identity, dry: true, close: async () => s.close() };
  }
  const target = localTarget(env.vars, v.instance!, keyWallet(operatorKey(env.vars).key));
  return { target, view: () => target.view(), identity: async () => target.identity, dry: !!v["dry-run"], close: () => target.close() };
}

const json = (what: string, text: string): Record<string, unknown> => {
  let v: unknown;
  try { v = JSON.parse(text); } catch { v = undefined; }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what}: a JSON object`);
  return v as Record<string, unknown>;
};

/** Print the plan; unless it is a dry run, send its requests in order (signed here, over the target). */
async function deliver(p: AdminPlan, s: Session, env: AdminEnv): Promise<number> {
  for (const l of p.prompt) env.out(l);
  if (s.dry || !s.target) {
    for (const r of p.requests) env.out(`POST ${r.path} ${new TextDecoder().decode(dagJson.encode(r.body as never))}`);
    env.out(`${p.requests.length} request${p.requests.length === 1 ? "" : "s"} to ${p.recipient} (not sent)`);
    return 0;
  }
  const t0 = Date.now();
  for (const r of p.requests) {
    const a = await s.target.send(r.path, r.body);
    if (a.status >= 400) {
      let why = "";
      try { why = JSON.stringify(dagCbor.decode(a.body)); } catch { why = new TextDecoder().decode(a.body).slice(0, 200); }
      throw new Error(`POST ${r.path}: ${a.status} ${why} (entry ${a.entry})`);
    }
  }
  env.out(`${s.target.where}: ${p.requests.length} request${p.requests.length === 1 ? "" : "s"} done (${Date.now() - t0} ms)`);
  return 0;
}

function handleOf(given: string): { handle?: string; domain?: string } {
  const h = given.replace(/^@/, "");
  const at = h.lastIndexOf("@");
  const named = at > 0 ? { handle: h.slice(0, at), domain: h.slice(at + 1) } : { handle: h };
  if (!named.handle || (at > 0 && !named.domain)) throw new Error(`--handle ${given}: want handle@domain`);
  return named;
}

/** `skein <command> …` for the admin commands. */
export async function adminMain(cmd: string, argv: string[], env: AdminEnv): Promise<number> {
  let s: Session | undefined;
  try {
    switch (cmd) {
      case "install": {
        const { values: v, positionals: [dir, ...more] } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, config: { type: "string" } } });
        if (!dir || more.length) { env.err(ADMIN_USAGE); return 2; }
        if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir}: an app's directory`);
        const config = v.config !== undefined ? json(`--config ${v.config}`, readFileSync(v.config, "utf8")) : undefined;
        s = await sessionOf(v, env);
        const { readApp } = await import("../host/install.ts");
        const { wasmDirObjects, WASM_DIR } = await import("../host/boot.ts");
        const p = await planInstallApp(await readApp(resolve(dir)), await s.view(), { config, modules: wasmDirObjects(WASM_DIR) });
        await deliver(p, s, env);
        if (!s.dry && s.target) {
          const v2 = await s.view();
          const root = v2.heads.find((h) => h.name === appHead(p.app))?.root;
          env.out(root?.equals(p.recordCid) ? `installed ${p.app} ${p.version} into ${s.target.where}` : `${p.app}: head ${appHead(p.app)} does not name ${p.recordCid} (the instance's log says why)`);
        }
        return 0;
      }
      case "uninstall": {
        const { values: v, positionals: [app, ...more] } = parseArgs({ args: argv, allowPositionals: true, options: where });
        if (!app || more.length) { env.err(ADMIN_USAGE); return 2; }
        s = await sessionOf(v, env);
        return await deliver(await planUninstallApp(app, await s.view()), s, env);
      }
      case "routes": {
        const { values: v, positionals: [op, row, ...more] } = parseArgs({ args: argv, allowPositionals: true, options: where });
        if (!row || more.length || (op !== "add" && op !== "remove")) { env.err(ADMIN_USAGE); return 2; }
        s = await sessionOf(v, env);
        return await deliver(await planRoute(await s.view(), op, json("the row", row) as DispatchRow), s, env);
      }
      case "grant": {
        const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, role: { type: "string" }, calls: { type: "boolean" }, service: { type: "boolean" } } });
        const [op, ...xs] = positionals;
        if (op !== "add" && op !== "remove") { env.err(ADMIN_USAGE); return 2; }
        const remove = op === "remove" ? { remove: true } : {};
        if (v.calls || v.service) {
          if (xs.length !== (v.calls ? 3 : 2) || (v.calls && v.service) || v.role !== undefined) { env.err(ADMIN_USAGE); return 2; }
          s = await sessionOf(v, env);
          return await deliver(v.calls ? planGrantCalls(await s.view(), xs[0]!, xs[1]!, xs[2]!, remove) : planGrantService(await s.view(), xs[0]!, xs[1]!, remove), s, env);
        }
        if (xs.length !== 1) { env.err(ADMIN_USAGE); return 2; }
        s = await sessionOf(v, env);
        return await deliver(await planGrant(await s.view(), xs[0]!, { ...(v.role ? { role: v.role } : {}), ...remove }), s, env);
      }
      case "claim": {
        const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, handle: { type: "string" } } });
        if (positionals.length) { env.err(ADMIN_USAGE); return 2; }
        s = await sessionOf(v, env);
        return await deliver(planClaim(await s.identity(), v.handle !== undefined ? handleOf(v.handle) : {}), s, env);
      }
      case "deploy": {
        const { values: v, positionals: [dir, ...more] } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, only: { type: "string" }, all: { type: "boolean" } } });
        if (!dir || more.length || (v.all && v.only !== undefined)) { env.err(ADMIN_USAGE); return 2; }
        const only = v.all ? [] : v.only !== undefined ? v.only.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
        s = await sessionOf(v, env);
        return await deliver(await planDeploy(resolve(dir), await s.view(), { only }), s, env);
      }
      default:
        env.err(ADMIN_USAGE);
        return 2;
    }
  } catch (e) {
    env.err(`skein ${cmd}: ${(e as Error).message}`);
    return 1;
  } finally {
    await s?.close();
  }
}
