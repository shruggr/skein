// Installing an app (skein next, SPEC.md section 3; docs/APPS.md §3): root's client. An app is a
// tree (a directory or a git repository) with etc/app.json; installing it into an instance is root's
// requests to the kernel's operation rows (plan.ts KERNEL_PATHS, each returning data) — nothing else:
//
//   1. objects    {records: [{cid, bytes}]}: the tree's git objects, the modules its bin/*.wasm carry,
//                 a program record per program, and the **app record** (below) — ≤ 1 MiB bundles
//   2. head       {name: "<app>/app", tree: <the app record>}: the app's root head
//   3. route      one per row the manifest asks for: {op: "add", row} — the row as the kernel takes
//                 it (manifest.ts rowOf: a path under /<app>/, an event name under the app's, the
//                 handler "<app>.<role>.<fn>", its role and checks)
//   4. grant      the call permissions the manifest asks for
//
// The **app record** is the head's root: the manifest as installed —
//
//   {kind: "app", name, version, programs: {<role>: <program record CID>}, roles?: {<role>: text},
//    routes: [<rows as the manifest wrote them>], config?, provides, requires, calls?, services?,
//    description?, tree: <the app's git tree>, state?: <the app's own state>}
//
// An install over an earlier version carries `state` over and removes the rows the earlier record
// had and the new one does not. Uninstall: every row the app's handler names removed; the heads are
// left. **Write scope**: an app's programs write only heads under `<app>/` (the kernel's rule).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CID } from "multiformats/cid";
import { hashDir } from "../client/bundle.ts";
import { defaultIgnore } from "../dev/scan.ts";
import { currentDispatch } from "../runtime/dispatch.ts";
import { headTree } from "../runtime/heads.ts";
import type { IndexStore } from "../runtime/index-store.ts";
import type { Store } from "../runtime/store.ts";
import { checkManifest } from "./manifest.ts";
import { appHead, parseManifest, type AppRecord, type AppTree, type InstanceView } from "./plan.ts";

// The plan — what an install or an uninstall sends, read from an instance
// view — is ./plan.ts, which runs in a browser too (the management site,
// shruggr/skein-site, #92, plans an install over the explorer's reads).
export * from "./plan.ts";

/** What a tree carries that is not the app: build output, dependencies, VCS. */
export function appIgnore(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return defaultIgnore(rel) || base === "zig-out" || base === ".zig-cache" || base === "zig-pkg";
}

/** Read and check the app in `dir`. */
export async function readApp(dir: string): Promise<AppTree> {
  const p = join(dir, "etc/app.json");
  if (!existsSync(p)) throw new Error(`${dir}: no etc/app.json (an app is a tree with a manifest: docs/APPS.md §2)`);
  const json = parseManifest(readFileSync(p, "utf8"));
  const isFile = (rel: string) => existsSync(join(dir, rel)) && statSync(join(dir, rel)).isFile();
  const checked = checkManifest(json, isFile);
  const { root, records } = await hashDir(dir, { ignore: appIgnore });
  return { root, records, checked, read: (rel) => (isFile(rel) ? new Uint8Array(readFileSync(join(dir, rel))) : undefined) };
}

/**
 * Where the app is: a directory, or a git repository URL (`<url>` or
 * `<url>#<rev>`) cloned into a temporary directory.
 */
export function fetchApp(spec: string): string {
  if (existsSync(spec) && statSync(spec).isDirectory()) return resolve(spec);
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(spec)) throw new Error(`${spec}: not a directory or a git URL`);
  const [url, rev] = spec.split("#");
  const dir = join(mkdtempSync(join(tmpdir(), "skein-app-")), "app");
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || `exit ${r.status}`}`);
  };
  git("clone", "-q", ...(rev ? [] : ["--depth", "1"]), url!, dir);
  if (rev) git("-C", dir, "checkout", "-q", rev);
  return dir;
}

// ---------------------------------------------------------------- the instance as the client sees it

/** The view of an instance's store file (the CLI's, the tests'). */
export async function instanceView(store: Store): Promise<InstanceView> {
  let g: Record<string, unknown> | undefined;
  for await (const { entry } of store.log.entries(0)) {
    const c = (entry as { genesis?: CID }).genesis;
    if (c) g = await store.get(c) as Record<string, unknown>;
    break;
  }
  if (!g) throw new Error("the instance's store has no genesis yet");
  const heads = typeof (store as Partial<IndexStore>).heads === "function" ? (store as IndexStore).heads() : [];
  return {
    store,
    identity: g.identity instanceof Uint8Array ? Buffer.from(g.identity).toString("hex") : String(g.identity),
    heads,
    dispatch: (await currentDispatch(store)) ?? [],
  };
}

/** The root holders (hex) as the head `grants` names them (#143; none: an unclaimed image). */
export async function rootOf(store: Store): Promise<string[]> {
  const root = await headTree(store, "grants");
  if (!root) return [];
  const g = await store.get(root).catch(() => undefined) as { kind?: string; roles?: Record<string, Uint8Array[]> } | undefined;
  return g?.kind === "grants" ? (g.roles?.root ?? []).map((k) => Buffer.from(k).toString("hex")) : [];
}

/** The app record a head's root is, if it is one. */
export async function appRecordOf(store: Store, name: string): Promise<{ cid: CID; record: AppRecord } | undefined> {
  const root = await headTree(store, appHead(name));
  if (!root) return undefined;
  const r = await store.get(root).catch(() => undefined) as AppRecord | undefined;
  return r && r.kind === "app" ? { cid: root, record: r } : undefined;
}
