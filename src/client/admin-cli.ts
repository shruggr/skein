// The operator's admin commands (#124, #142, #143): each builds root's messages (admin.ts, plan.ts), signs
// them in this process with the operator's key (SKEIN_OPERATOR_KEY, default $SKEIN_HOME/operator.key;
// hostenv.ts) and delivers them (target.ts) — no other process, no wallet command.
//
//   skein install <catalog-name | url#commit | dir> <where> [--config <file.json>] [--dry-run]
//   skein uninstall <app> <where> [--dry-run]
//   skein routes add|remove [--transport t] [--prefix] [--filters f,g] [--fn f] [--settings json] <address> [<handler>] <where> [--dry-run]
//   skein grant add|remove <key> [--role root|<app>.<role>] <where> [--dry-run]
//   skein peers add <key> <address> [--transport mailbox|libp2p|local] [--handle h@d] <where> [--dry-run]
//   skein peers remove <key> <where> [--dry-run]
//   skein host add|remove (<host-key> --x sats [--rates json] | --from <host origin>) <where> [--dry-run]
//   skein claim [--messagebox url] [--handle h@d] <where> [--dry-run]
//   skein deploy <dir> [--only glob,glob | --all] <where> [--dry-run]
//
// <where> is the instance: `--instance <handle>` (on this host machine: host.db's row, its store read
// read-only, the messages over the running host's control socket), or its origin `<url>` (one BRC-104
// session: the messages, and the explorer's reads — the owner's), or `--store <runtime.db>` (its store
// file, read-only: planned and printed, nothing sent). `--dry-run` prints the prompt and the messages
// (their `/sendMessage` JSON, one a line) and sends nothing.
//
// `install` of a catalog name or `<url>#<commit>` sends one message to the instance's git app — `git.clone
// {url, hash}`: the VM fetches that commit by hash and keeps its tree (#91) — reads the answer, plans the
// install from the stored tree, and sends the head, the rows and the start: nothing of the app's tree or
// modules crosses from here. A catalog name is looked up in the instance's own site tree
// (www/catalog.json). A directory is read here and its objects sent (what the instance lacks); installing
// a tree the instance holds already (an image's app, `images/default/apps/<app>`) sends only what changes:
// the owner's rows after a claim. `--dry-run` with a clone still sends the clone (the tree is read from the
// instance), then sends nothing more.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CID } from "multiformats/cid";
import { appHead, readStoredApp, type AppTree, type InstanceView } from "../host/plan.ts";
import { identityOf, operatorKey, type Vars } from "../host/hostenv.ts";
import { keyWallet } from "../wallet.ts";
import { catalogOf, messageJson, planClaim, planDeploy, planGrant, planHost, planInstallApp, planPeers, planRoute, planUninstallApp, type AdminPlan, type HostTerms, type PeerChange, type RouteArgs } from "./admin.ts";
import { localTarget, remoteTarget, stdoutOf, type Target } from "./target.ts";

export const ADMIN_USAGE = `usage (the operator's messages, signed with SKEIN_OPERATOR_KEY, default $SKEIN_HOME/operator.key):
  skein install <catalog-name | url#commit | dir> <where> [--config <file.json>] [--dry-run]
                                                     an app (docs/APPS.md §3): a name from the instance's catalog or a repository
                                                     and commit, cloned by the instance's git app; head <app>/app, its rows, start
  skein uninstall <app> <where> [--dry-run]          its stop, then its routes removed (the heads are left)
  skein routes add [--transport mailbox|event|http|libp2p] [--prefix] [--filters f,g] [--fn f] [--settings json] <address> [<handler>] <where> [--dry-run]
                                                     root's own route (#143): <handler> a program record CID, a genesis program,
                                                     or <app>.<role>; an http route with --filters and no handler is a read route
                                                     (the site at /: routes add --prefix --filters site.get --settings '{"root":"www"}' /)
  skein routes remove [--transport t] [--prefix] <address> <where> [--dry-run]
  skein grant add|remove <key> [--role root|<app>.<role>] <where> [--dry-run]     a grant (#143; root by default)
  skein peers add <key> <address> [--transport mailbox|libp2p|local] [--handle h@d] <where> [--dry-run]
  skein peers remove <key> <where> [--dry-run]      an address-book entry (#70)
  skein host add|remove (<host-key> --x sats [--rates json] | --from <host origin>) <where> [--dry-run]
                                                     the host row (#130)
  skein claim [--messagebox url] [--handle h@d] <where> [--dry-run]               an image's claim (#127, #143): root to the key that sends it
  skein deploy <dir> [--only glob,glob | --all] <where> [--dry-run]               a directory into main (objects, head)
<where>: --instance <handle> (this host machine: over its control socket) | <origin> (one BRC-104 session)
         | --store <runtime.db> (read only: planned and printed, nothing sent)`;

export const ADMIN_COMMANDS = ["install", "uninstall", "routes", "grant", "peers", "host", "claim", "deploy"] as const;

export interface AdminEnv {
  vars: Vars;
  out(line: string): void;
  err(line: string): void;
}

const where = { instance: { type: "string" }, store: { type: "string" }, "dry-run": { type: "boolean" } } as const;
type Where = { instance?: string; store?: string; "dry-run"?: boolean };

const isUrl = (s: string) => /^https?:\/\/[^/]/.test(s);

/** The instance the command is for: --instance, an origin (the last positional), or --store (read only). */
interface Session { target?: Target; view(): Promise<InstanceView>; identity(): Promise<string>; dry: boolean; close(): Promise<void>; signer?: string }

async function sessionOf(v: Where, origin: string | undefined, env: AdminEnv): Promise<Session> {
  const given = [v.instance !== undefined, origin !== undefined, v.store !== undefined].filter(Boolean).length;
  if (given !== 1) throw new Error("where is the instance: --instance <handle>, its origin <url>, or --store <runtime.db> (one)");
  if (v.store !== undefined) {
    if (!existsSync(v.store)) throw new Error(`--store ${v.store}: no such file`);
    const { openStoreFile } = await import("../runtime/index-store.ts");
    const { instanceView } = await import("../host/install.ts");
    const s = openStoreFile(v.store, { readOnly: true });
    let view: InstanceView;
    try { view = await instanceView(s); } catch (e) { s.close(); throw e; }
    return { view: async () => view, identity: async () => view.identity, dry: true, close: async () => s.close() };
  }
  const key = operatorKey(env.vars).key;
  const wallet = keyWallet(key);
  const target = v.instance !== undefined ? localTarget(env.vars, v.instance, wallet) : await remoteTarget(origin!, wallet);
  return { target, view: () => target.view(), identity: async () => target.identity, dry: !!v["dry-run"], close: () => target.close(), signer: key.toPublicKey().toString() };
}

/** The origin among the positionals: the last one when it is a URL and the command takes one more than it needs. */
function splitOrigin(positionals: string[], needs: number): { args: string[]; origin?: string } {
  if (positionals.length === needs + 1 && isUrl(positionals.at(-1)!)) return { args: positionals.slice(0, -1), origin: positionals.at(-1) };
  return { args: positionals };
}

const json = (what: string, text: string): Record<string, unknown> => {
  let v: unknown;
  try { v = JSON.parse(text); } catch { v = undefined; }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what}: a JSON object`);
  return v as Record<string, unknown>;
};

/** Print the plan; unless it is a dry run, send its messages in order (signed here, over the target). */
async function deliver(p: AdminPlan, s: Session, env: AdminEnv): Promise<number> {
  for (const l of p.prompt) env.out(l);
  if (s.dry || !s.target) {
    for (const m of p.messages) env.out(messageJson(p.recipient, m));
    env.out(`${p.messages.length} message${p.messages.length === 1 ? "" : "s"} to ${p.recipient} (not sent)`);
    return 0;
  }
  const t0 = Date.now();
  for (const m of p.messages) await s.target.send(m.box, m.body);
  env.out(`${s.target.where}: ${p.messages.length} message${p.messages.length === 1 ? "" : "s"} sent (${Date.now() - t0} ms)`);
  return 0;
}

/** `skein <command> …` for the admin commands. */
export async function adminMain(cmd: string, argv: string[], env: AdminEnv): Promise<number> {
  let s: Session | undefined;
  try {
    switch (cmd) {
      case "install": {
        const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, config: { type: "string" } } });
        const { args: [spec, ...more], origin } = splitOrigin(positionals, 1);
        if (!spec || more.length) { env.err(ADMIN_USAGE); return 2; }
        const config = v.config !== undefined ? json(`--config ${v.config}`, readFileSync(v.config, "utf8")) : undefined;
        s = await sessionOf(v, origin, env);
        return await install(spec, s, config, env);
      }
      case "uninstall": {
        const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: where });
        const { args: [app, ...more], origin } = splitOrigin(positionals, 1);
        if (!app || more.length) { env.err(ADMIN_USAGE); return 2; }
        s = await sessionOf(v, origin, env);
        return await deliver(await planUninstallApp(app, await s.view()), s, env);
      }
      case "routes": {
        const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, transport: { type: "string" }, prefix: { type: "boolean" }, filters: { type: "string" }, fn: { type: "string" }, settings: { type: "string" } } });
        const origin = positionals.length > 1 && isUrl(positionals.at(-1)!) ? positionals.at(-1) : undefined;
        const [op, address, handler, ...more] = origin ? positionals.slice(0, -1) : positionals;
        if (!address || more.length || (op !== "add" && op !== "remove") || (op === "remove" && handler !== undefined)) { env.err(ADMIN_USAGE); return 2; }
        const settings = v.settings !== undefined ? json("skein routes --settings", v.settings) : undefined;
        const filters = v.filters !== undefined ? v.filters.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
        s = await sessionOf(v, origin, env);
        const programs = handler ? await handlerPrograms(s, handler) : {};
        return await deliver(await planRoute(await s.view(), { op, address, ...(v.transport ? { transport: v.transport as RouteArgs["transport"] } : {}), ...(v.prefix ? { prefix: true } : {}), ...(filters ? { filters } : {}), ...(handler ? { handler } : {}), ...(v.fn ? { fn: v.fn } : {}), ...(settings ? { settings } : {}) }, programs), s, env);
      }
      case "grant": {
        const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, role: { type: "string" } } });
        const { args: [op, key, ...more], origin } = splitOrigin(positionals, 2);
        if (!key || more.length || (op !== "add" && op !== "remove")) { env.err(ADMIN_USAGE); return 2; }
        s = await sessionOf(v, origin, env);
        return await deliver(await planGrant(await s.view(), key, { ...(v.role ? { role: v.role } : {}), ...(op === "remove" ? { remove: true } : {}) }), s, env);
      }
      case "peers": {
        const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, transport: { type: "string" }, handle: { type: "string" } } });
        const op = positionals[0];
        const { args: [, key, address, ...more], origin } = splitOrigin(positionals, op === "remove" ? 2 : 3);
        const shape = op === "remove" ? !!key && !address : op === "add" ? !!key && !!address : false;
        if (more.length || !shape || ((v.transport ?? v.handle) !== undefined && op !== "add")) { env.err(ADMIN_USAGE); return 2; }
        const transport = (v.transport ?? "mailbox") as "mailbox" | "libp2p" | "local";
        if (!["mailbox", "libp2p", "local"].includes(transport)) { env.err("skein peers: --transport is mailbox, libp2p or local"); return 2; }
        if (op === "add" && transport === "mailbox" && !isUrl(address!)) { env.err(`skein peers: ${address} is not an http(s) URL`); return 2; }
        const named = v.handle !== undefined ? handleOf(v.handle) : {};
        const change: PeerChange = op === "add" ? { op: "add", key: key!, transport, address: address!, ...named } : { op: "remove", key: key! };
        s = await sessionOf(v, origin, env);
        return await deliver(planPeers(await s.identity(), [change]), s, env);
      }
      case "claim": {
        const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, messagebox: { type: "string" }, handle: { type: "string" } } });
        const { args: more, origin } = splitOrigin(positionals, 0);
        if (more.length) { env.err(ADMIN_USAGE); return 2; }
        if (v.messagebox !== undefined && !isUrl(v.messagebox)) { env.err(`skein claim: ${v.messagebox} is not an http(s) URL`); return 2; }
        const named = v.handle !== undefined ? handleOf(v.handle) : {};
        s = await sessionOf(v, origin, env);
        const p = planClaim(await s.identity(), { messagebox: v.messagebox, ...named });
        if (s.dry || !s.target) return await deliver(p, s, env);
        for (const l of p.prompt) env.out(l);
        await s.target.claim(p.messages[0]!.body as Record<string, unknown>);
        env.out(`${s.target.where}: the claim sent`);
        return 0;
      }
      case "host": {
        const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, x: { type: "string" }, rates: { type: "string" }, from: { type: "string" } } });
        const { args: [op, key, ...more], origin } = splitOrigin(positionals, v.from !== undefined ? 1 : 2);
        if (more.length || (op !== "add" && op !== "remove") || (!key && v.from === undefined) || (key && v.from !== undefined)) { env.err(ADMIN_USAGE); return 2; }
        let terms: HostTerms;
        if (v.from !== undefined) {
          const r = await fetch(new URL("/.well-known/skein-host", v.from));
          const b = (await r.json() as { billing?: HostTerms }).billing;
          if (!r.ok || !b) throw new Error(`${v.from}: no billing terms at /.well-known/skein-host`);
          terms = { key: b.key, x: b.x, rates: b.rates };
        } else {
          const rates = v.rates !== undefined ? json("skein host --rates", v.rates) as Record<string, number> : undefined;
          terms = { key: key!, x: Number(v.x ?? (op === "remove" ? 1 : NaN)), ...(rates ? { rates } : {}) };
        }
        s = await sessionOf(v, origin, env);
        return await deliver(planHost(await s.identity(), op, terms), s, env);
      }
      case "deploy": {
        const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...where, only: { type: "string" }, all: { type: "boolean" } } });
        const { args: [dir, ...more], origin } = splitOrigin(positionals, 1);
        if (!dir || more.length || (v.all && v.only !== undefined)) { env.err(ADMIN_USAGE); return 2; }
        const only = v.all ? [] : v.only !== undefined ? v.only.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
        s = await sessionOf(v, origin, env);
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

function handleOf(given: string): { handle?: string; domain?: string } {
  const h = given.replace(/^@/, "");
  const at = h.lastIndexOf("@");
  const named = at > 0 ? { handle: h.slice(0, at), domain: h.slice(at + 1) } : { handle: h };
  if (!named.handle || (at > 0 && !named.domain)) throw new Error(`--handle ${given}: want handle@domain`);
  return named;
}

/** The programs a handler may name (#125): the genesis's by name, and `<app>.<role>` — the installed app's. */
async function handlerPrograms(s: Session, handler: string): Promise<Record<string, CID>> {
  const role = /^([a-z0-9][a-z0-9-]*)\.([A-Za-z0-9_-]+)$/.exec(handler);
  const needsView = !!role || !/^baf/.test(handler);
  if (!needsView) return {};
  const view = await s.view();
  const programs = { ...(view.programs as Record<string, CID>) };
  if (role && !programs[handler]) {
    const { appRecordIn } = await import("../host/plan.ts");
    const app = await appRecordIn(view, role[1]!);
    if (!app) throw new Error(`handler ${handler}: no app ${role[1]} installed (no head ${role[1]}/app)`);
    const cid = app.record.programs[role[2]!];
    if (!cid) throw new Error(`handler ${handler}: app ${role[1]} has no program ${role[2]} (${Object.keys(app.record.programs).join(", ")})`);
    programs[handler] = cid;
  }
  return programs;
}

const hexOf = (k: unknown) => (k instanceof Uint8Array ? Buffer.from(k).toString("hex") : typeof k === "string" ? k : "");

/**
 * `skein install`: the tree — a directory read here, or a commit the instance's git app clones by hash (a
 * catalog name gives the URL and the commit) — then the plan from it, printed, and its messages sent.
 */
async function install(spec: string, s: Session, config: Record<string, unknown> | undefined, env: AdminEnv): Promise<number> {
  const { wasmDirObjects, WASM_DIR } = await import("../host/boot.ts");
  let view = await s.view();
  let tree: AppTree;
  let cloned: { tree: CID; app: CID } | undefined;
  if (existsSync(spec) && statSync(spec).isDirectory()) {
    const { readApp } = await import("../host/install.ts");
    tree = await readApp(resolve(spec));
  } else {
    let url: string, hash: string;
    const m = /^(.+)#([0-9a-fA-F]{40})$/.exec(spec);
    if (m) { url = m[1]!; hash = m[2]!.toLowerCase(); } else if (/^[a-z0-9][a-z0-9-]*$/.test(spec)) {
      const cat = await catalogOf(view);
      const e = cat.find((x) => x.name === spec);
      if (!e) throw new Error(`${spec}: not in the instance's catalog (it names ${cat.map((x) => x.name).join(", ") || "nothing"}); give <url>#<commit>`);
      url = e.url; hash = e.hash.toLowerCase();
      env.out(`catalog: ${e.name}${e.version ? ` ${e.version}` : ""} = ${url}#${hash}`);
    } else throw new Error(`${spec}: a catalog name, <url>#<40-hex commit>, or a directory`);
    if (!s.target) throw new Error("--store reads a store file: it cannot ask the instance's git app to clone (give a directory, or --instance / an origin)");
    // #143: the git app's box is a route; its function is gated by root (git's roles) — the gate judges the sender.
    const gitRoute = view.dispatch.find((r) => r.transport === "mailbox" && r.address === "git");
    if (!gitRoute) {
      throw new Error(`the instance has no route to box git${view.heads.some((h) => h.name === appHead("git")) ? "" : " (no git app installed)"}`);
    }
    // The gate, read before anything is sent (the kernel's own check runs on the message; a refused one runs nothing).
    const { gatePasses } = await import("./admin.ts");
    const gate = await gatePasses(view, gitRoute, s.signer!);
    if (!gate.pass) throw new Error(`box git is gated (${gate.roles.join(", ")}) and ${s.signer!.slice(0, 10)}… holds none of those roles: nothing sent`);
    const t0 = Date.now();
    const id = await s.target.send("git", { fn: "git.clone", args: { url, hash } });
    const end = await s.target.answer(id);
    if (end.state === "errored") throw new Error(`git.clone: the git app's thread errored: ${JSON.stringify(end.error ?? {})}`);
    const out = stdoutOf(end) as { result?: { tree?: CID; app?: CID }; error?: { code?: string; message?: string } } | undefined;
    if (out?.error) throw new Error(`git.clone: ${out.error.code}: ${out.error.message}`);
    if (!out?.result?.tree || !out.result.app) throw new Error(`git.clone: no {tree, app} in the answer (${JSON.stringify(out)})`);
    cloned = { tree: out.result.tree, app: out.result.app };
    env.out(`git.clone ${url}#${hash}: tree ${cloned.tree} · app record ${cloned.app} (${Date.now() - t0} ms, in the instance)`);
    view = await s.view();
    tree = await readStoredApp(view.store, cloned.tree);
  }
  const p = await planInstallApp(tree, view, { config, modules: wasmDirObjects(WASM_DIR) });
  if (cloned && !config && !p.recordCid.equals(cloned.app)) p.prompt.push(`  note      the plan's app record ${p.recordCid} is not the git app's ${cloned.app}`);
  await deliver(p, s, env);
  if (s.dry || !s.target) return 0;
  // Installed when its head names the record (the kernel takes the messages in order).
  // Its start may move the head on at once (the app's `state`): the record without `state` is what counts.
  const { encode } = await import("../runtime/cid.ts");
  const bare = (r: Record<string, unknown>) => { const { state: _s, ...rest } = r; void _s; return encode(rest as never).cid; };
  const want = bare(p.record as unknown as Record<string, unknown>);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const v = await s.view();
    const root = v.heads.find((h) => h.name === appHead(p.app))?.root;
    const rec = root ? await v.store.get(root).catch(() => undefined) as Record<string, unknown> | undefined : undefined;
    if (rec && bare(rec).equals(want)) break;
    if (Date.now() > deadline) throw new Error(`${p.app}: head ${appHead(p.app)} does not name ${p.recordCid} after 120 s (the instance's log says why)`);
    await new Promise((r) => setTimeout(r, 300));
  }
  env.out(`installed ${p.app} ${p.version} into ${s.target.where}`);
  return 0;
}
