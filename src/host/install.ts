// Installing an app (#72, #76, #77, #79; docs/APPS.md §3): the owner's client. An
// app is a tree (a directory or a git repository) with etc/app.json;
// installing it into an instance is owner-signed messages to the kernel's
// admin boxes — the kernel's own operations on its four tables — nothing else:
//
//   1. objects    the tree's git objects, the modules its bin/*.wasm carry (a
//                 shell program's modules and support files too, #83), a program
//                 record per program, and the **app record** (below)
//                 — ≤ 1 MiB bundles; no bundle names a root (an app never
//                 becomes `main`)
//   2. head       {name: "<app>/app", tree: <the app record>}: the app's root head, under its
//                 own name (owner = the app).
//   3. dispatch   one per row the manifest asks for (#77): {op: "add", row: {transport, address,
//                 prefix?, sender, program: <the role's program record>, fn?, …settings, app}} —
//                 the sender "*" (anyone), "event" (events only), "session", "$owner" → the
//                 owner's key, "$self" → the instance's own (#79: its other apps), "$<provider>"
//                 → the key the instance's address book gives that role, a hex key itself; a
//                 box under the app's (#128: "" or `<app>` → `<app>`, "x" → `<app>/x`), an
//                 http address under /<app>/, a libp2p topic or protocol as written.
//   4. start      the manifest's `start.body`, into the app's box
//
// The **app record** is the head's root: the manifest as installed, so "what
// does this head provide" is one read (`head("<app>/app")`, `get`):
//
//   {kind: "app", name, version, programs: {<role>: <program record CID>},
//    config?, provides, requires, dispatch: [<row as the manifest wrote it: relative addresses, roles>],
//    start?, stop?, description?, tree: <the app's git tree>, state?: <the app's own state>}
//
// `state` is the app's: its handler advances the head to the record with
// `state` replaced (the SDK's app.Call.setState). An install over an earlier
// version carries `state` over, removes the rows the earlier record had and
// the new one does not, and sends `start` again (the restart). Uninstall:
// `stop`, then every row removed; the heads are left.
//
// **Write scope** (#77, #79): an app's programs write only heads under
// `<app>/` (the kernel's rule, by the program record's `app`). There are no
// grants, no alias head, no form before #77.
//
// **Two paths to the tree** (#91; docs/APPS.md §3). This client reads it from
// a directory or clones a repository itself (`readApp`, `fetchApp`:
// `skein plan install`, #124; a coding-session tool). Or the instance already holds
// it: the git app (shruggr/skein-git) cloned one commit into the store by
// hash and answered {tree, app}; `readStoredApp` reads that tree out of the
// store (reads are open), and the same `planInstall` rebuilds the app record
// — whose CID must be the git app's `app` — with nothing left to send but
// `head`, `dispatch` and `start`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CID } from "multiformats/cid";
import { hashDir } from "../client/client.ts";
import { defaultIgnore } from "../dev/scan.ts";
import { currentDispatch, senderBytes } from "../runtime/dispatch.ts";
import { headTree } from "../runtime/heads.ts";
import type { IndexStore } from "../runtime/index-store.ts";
import type { Store } from "../runtime/store.ts";
import { addressBook } from "./deploy.ts";
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
    owner: await ownerOf(store, g),
    identity: g.identity instanceof Uint8Array ? Buffer.from(g.identity).toString("hex") : String(g.identity),
    programs: (g.programs ?? {}) as Record<string, CID>,
    addressBook: await addressBook(store),
    heads,
    // The reader shows a 33-byte sender as hex; the kernel's rows carry bytes (a remove sends the row back).
    dispatch: ((await currentDispatch(store)) ?? []).map((r) => ({ ...r, sender: senderBytes(r.sender) })),
  };
}

/**
 * The instance's owner (hex): its genesis's, else — an image (#89) — the key
 * its claim named (the head `claim` → the claim's body), else "" (an image
 * not claimed yet: nobody may install into it).
 */
export async function ownerOf(store: Store, genesis: Record<string, unknown>): Promise<string> {
  const hex = (k: unknown) => k instanceof Uint8Array ? Buffer.from(k).toString("hex") : typeof k === "string" ? k : "";
  if (genesis.owner !== undefined) return hex(genesis.owner);
  const root = await headTree(store, "claim");
  if (!root) return "";
  const b = await store.get(root).catch(() => undefined) as { owner?: unknown } | undefined;
  return hex(b?.owner);
}

/** The app record a head's root is, if it is one. */
export async function appRecordOf(store: Store, name: string): Promise<{ cid: CID; record: AppRecord } | undefined> {
  const root = await headTree(store, appHead(name));
  if (!root) return undefined;
  const r = await store.get(root).catch(() => undefined) as AppRecord | undefined;
  return r && r.kind === "app" ? { cid: root, record: r } : undefined;
}
