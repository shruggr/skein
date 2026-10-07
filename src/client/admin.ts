// Root's admin messages (#124, #142, #143): building them is a library — installing an app, removing it,
// a route, a read route, an address-book entry, the host row, a directory into `main`, a grant — each a
// few messages from root to the kernel's admin boxes (docs/MESSAGES.md "The dispatch table and the
// kernel's operations": objects, head, dispatch, peers, grant) and the app's own box (start/stop). The
// management page builds the same messages with the same code (src/host/plan.ts) and sends them with the
// browser's wallet. The client `skein` (admin-cli.ts) signs them with the operator's key and delivers them
// (target.ts): over the host's control socket on the host machine, else on one BRC-104 session.
//
// A message is a box and a body (a record value: what the kernel's operation takes). `messageJson` is its
// BRC-33 `/sendMessage` JSON form (what `--dry-run` prints):
//
//   {"message": {"recipient": "<the instance's identity key, hex>", "messageBox": "<box>", "body": <the body, DAG-JSON>}}

import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import type { CID } from "multiformats/cid";
import { type Rec } from "./bundle.ts";
import { dispatchBody, handlerCid, hashDir, recordBundles } from "./client.ts";
import { dispatchOrigin, fold, type DispatchRow } from "../runtime/dispatch.ts";
import { MAIN } from "../runtime/heads.ts";
import { DEFAULT_ONLY, onlyIgnore, type AddressEntry } from "../host/deploy.ts";
import { appHead, describe, mergeConfig, planInstall, planRootRoute, planUninstall, sendInstall, sendUninstall, type AppRecord, type AppTree, type InstanceView } from "../host/plan.ts";
import { lookup, readBlob } from "../runtime/tree.ts";

import type { Objects } from "../host/boot.ts";

/** One admin message: the box and the body (a record value: what the kernel's operation takes). */
export interface AdminMessage { box: string; body: unknown }

/** What the admin commands build: the prompt (what the messages do, as the page shows it), the recipient, the messages in order. */
export interface AdminPlan { prompt: string[]; recipient: string; messages: AdminMessage[] }

const isKey = (s: string) => /^0[23][0-9a-f]{64}$/.test(s);
const keyBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

/** A message as the `/sendMessage` JSON body. */
export function messageJson(recipient: string, m: AdminMessage): string {
  return new TextDecoder().decode(dagJson.encode({ message: { recipient, messageBox: m.box, body: m.body } }));
}

/** Messages as `send(box, bytes)` calls make them (plan.ts sendInstall, sendUninstall), collected. */
async function collect(run: (send: (box: string, body: Uint8Array) => Promise<void>) => Promise<unknown>): Promise<AdminMessage[]> {
  const out: AdminMessage[] = [];
  await run(async (box, body) => { out.push({ box, body: dagCbor.decode(body) }); });
  return out;
}

/**
 * Install (or upgrade) the app `tree` into the instance `view` reads (docs/APPS.md §3): objects (≤ 1 MiB
 * bundles), the head `<app>/app`, a dispatch message per row that changes, the start. `config` is merged
 * over the manifest's (one level deep per program). `modules`: where a `bin/<x>.cid` module the instance
 * lacks is found (this repo's wasm/ directory, boot.ts wasmDirObjects).
 */
export async function planInstallApp(tree: AppTree, view: InstanceView, o: { config?: Record<string, unknown>; modules?: Objects } = {}): Promise<AdminPlan & { app: string; version: string; recordCid: CID; record: AppRecord }> {
  if (o.config) tree.checked.manifest.config = mergeConfig(tree.checked.manifest.config, o.config);
  const plan = await planInstall(tree, view, { modules: o.modules ?? { get: async () => undefined } });
  const messages = await collect((send) => sendInstall(plan, send));
  return { prompt: describe(plan), recipient: view.identity, messages, app: plan.app, version: plan.version, recordCid: plan.recordCid, record: plan.record };
}

/** Uninstall: the app's `stop`, then every route the table holds for it removed; its heads are left. */
export async function planUninstallApp(name: string, view: InstanceView): Promise<AdminPlan> {
  const p = await planUninstall(name, view);
  const messages = await collect((send) => sendUninstall(p, send));
  const prompt = [`uninstall ${name} ${p.record.version}${p.stop ? ` · stop ${JSON.stringify(p.stop)}` : ""} · dispatch remove ×${p.rows.length} · head ${name}/app left`, ...p.rows.map((r) => `    dispatch remove ${r.row.transport} ${r.row.address}${r.row.prefix ? " prefix" : ""}`)];
  return { prompt, recipient: view.identity, messages };
}

/** An http route's own parts (#125, #143): `prefix`, its `filters`, the handler's `fn`, and its settings (a file server's `root`, `index`), carried to it as `match`. */
export interface HttpRowArgs { prefix?: boolean; fn: string; filters?: string[]; settings?: Record<string, unknown> }

/** The fields of a route that are not a handler's settings. */
const ROW_FIELDS = ["transport", "address", "prefix", "filters", "sender", "program", "fn", "app", "optional"];

/**
 * One route of the route table (#77, #143): a mailbox route `{op, row: {transport: "mailbox", address:
 * box, program}}`, or with `http` an http route `{transport: "http", address: <path>, prefix?, filters?,
 * program, fn, …settings}` (#125: root's own route, such as the site at `/`: no `app`, so an app's
 * upgrade or uninstall leaves it). The handler is a program record CID or a name the instance's genesis
 * gives (`programs`). No sender (#143).
 */
export function planDispatch(recipient: string, a: { op: "add" | "remove"; sender?: string; box: string; handler: string; http?: HttpRowArgs }, programs: Record<string, CID> = {}): AdminPlan {
  if (a.sender !== undefined) throw new Error("--sender: gone (#143) — a route has no sender; gate the function with a role and grant it");
  if (!a.http) {
    const body = dispatchBody(a, programs);
    return { prompt: [`dispatch ${a.op} mailbox ${a.box} → ${a.handler} (${String(body.row.program)})`], recipient, messages: [{ box: "dispatch", body }] };
  }
  const h = a.http;
  if (!a.box.startsWith("/") || /[\\\0?#]/.test(a.box) || a.box.split("/").some((x) => x === "." || x === "..")) throw new Error(`http address ${JSON.stringify(a.box)}: a path (from /, no ".", "..", query or fragment)`);
  if (!h.fn) throw new Error("an http route names its handler's function (--fn)");
  const settings = h.settings ?? {};
  const bad = Object.keys(settings).filter((k) => ROW_FIELDS.includes(k));
  if (bad.length) throw new Error(`--settings: ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} the route's own, not a setting`);
  const program = handlerCid(a.handler, programs);
  const row = { ...settings, transport: "http", address: a.box, ...(h.prefix ? { prefix: true } : {}), ...(h.filters?.length ? { filters: h.filters } : {}), program, fn: h.fn };
  const shown = Object.entries(settings).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
  return {
    prompt: [`dispatch ${a.op} http ${a.box}${h.prefix ? " prefix" : ""}${h.filters?.length ? ` [${h.filters.join(", ")}]` : ""} → ${a.handler}.${h.fn} (${String(program)})${shown ? ` (${shown})` : ""}`],
    recipient, messages: [{ box: "dispatch", body: { op: a.op, row } }],
  };
}

/**
 * Root's own read route (#135, #143): one path answered by a filter — `<app>.<filter>`, a function an
 * installed app declares under `filters` — for anyone, signed or not, nothing logged: one `dispatch`
 * message adding (removing) the route {transport: "http", address, prefix?, filters: [<filter>],
 * …settings}. E.g. the site at the root: the filter `site.get`, `--prefix`, settings {"root": "www"}.
 */
export async function planReads(view: InstanceView, a: { op: "add" | "remove"; path: string; filter: string; prefix?: boolean; settings?: Record<string, unknown> }): Promise<AdminPlan> {
  if (!a.path.startsWith("/") || /[\\\0?#]/.test(a.path) || a.path.split("/").some((x) => x === "." || x === "..")) throw new Error(`read ${JSON.stringify(a.path)}: a path (from /, no ".", "..", query or fragment)`);
  const settings = a.settings ?? {};
  const bad = Object.keys(settings).filter((k) => ROW_FIELDS.includes(k));
  if (bad.length) throw new Error(`--settings: ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} the route's own, not a setting`);
  const row = { ...settings, transport: "http", address: a.path, ...(a.prefix ? { prefix: true } : {}), filters: [a.filter] } as DispatchRow;
  const p = await planRootRoute(view, a.op, row);
  return { prompt: p.prompt, recipient: view.identity, messages: p.rows.map((r) => ({ box: "dispatch", body: { op: r.op, row: r.row } })) };
}

/**
 * The claim (#89, #127, #143): one message in box `claim` to an image (its claim route takes anyone) —
 * its sender (the wallet that sends it) is granted root; the body carries only the claimant's
 * mailbox entry, if any.
 */
export function planClaim(recipient: string, o: { messagebox?: string; handle?: string; domain?: string } = {}): AdminPlan {
  const body = { ...(o.messagebox ? { messagebox: o.messagebox } : {}), ...(o.handle ? { handle: o.handle, ...(o.domain ? { domain: o.domain } : {}) } : {}) };
  return { prompt: [`claim ${recipient}: root to the key that sends this${o.messagebox ? ` · messagebox ${o.messagebox}` : ""}${o.handle ? ` (@${o.handle}${o.domain ? `@${o.domain}` : ""})` : ""}`], recipient, messages: [{ box: "claim", body }] };
}

/** The host's terms as it publishes them (/.well-known/skein-host `billing`, #130). */
export interface HostTerms { key: string; x: number; rates?: Record<string, number> }

/**
 * The host row (#130): root's choice of a host and its rates — one `dispatch` message adding (or
 * removing) the kernel route {mailbox, billing, host: <the host's key>, kernel, tick, x, rates} (#143:
 * the host's key a setting, no sender). The first such route is the host's; the kernel bills by it,
 * the host ticks it. Removing it ends billing.
 */
export function planHost(recipient: string, op: "add" | "remove", t: HostTerms): AdminPlan {
  if (!isKey(t.key)) throw new Error(`${t.key}: not the host's key (hex)`);
  if (op === "add" && (!Number.isSafeInteger(t.x) || t.x < 1)) throw new Error("x: the sats the skein prepays at a time (a whole number ≥ 1)");
  const rates = Object.fromEntries(Object.entries(t.rates ?? {}).map(([k, v]) => {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`rates.${k}: a whole number of sats`);
    return [k, v];
  }));
  const row = { transport: "mailbox", address: "billing", host: keyBytes(t.key), program: "kernel", fn: "tick", ...(op === "add" ? { x: t.x, ...(Object.keys(rates).length ? { rates } : {}) } : {}) };
  const shown = Object.entries(rates).map(([k, v]) => `${k} ${v}`).join(", ");
  return {
    prompt: [op === "add" ? `host ${t.key}: bills this skein — x ${t.x} sats a block${shown ? `, rates ${shown}` : ""} (#130: the skein pays it from its own wallet, ahead)` : `host ${t.key}: removed (nothing is billed)`],
    recipient, messages: [{ box: "dispatch", body: { op, row } }],
  };
}

export type PeerChange = ({ op: "add" } & AddressEntry) | { op: "remove"; key: string };

/** Address-book changes (#40, #70): one message to `peers` each. */
export function planPeers(recipient: string, changes: PeerChange[]): AdminPlan {
  const messages: AdminMessage[] = [];
  const prompt: string[] = [];
  for (const c of changes) {
    if (!isKey(c.key)) throw new Error(`${c.key}: not an identity key (hex)`);
    if (c.op === "remove") {
      messages.push({ box: "peers", body: { op: "remove", key: keyBytes(c.key) } });
      prompt.push(`peers remove ${c.key}`);
      continue;
    }
    messages.push({ box: "peers", body: { op: "add", key: keyBytes(c.key), transport: c.transport, address: c.address, ...(c.handle ? { handle: c.handle } : {}), ...(c.domain ? { domain: c.domain } : {}) } });
    prompt.push(`peers add ${c.key} → ${c.transport} ${c.address}${c.handle ? ` (@${c.handle}${c.domain ? `@${c.domain}` : ""})` : ""}`);
  }
  return { prompt, recipient, messages };
}

/**
 * A directory into the instance's `main` (#23): its git objects in ≤ 1 MiB bundles to `objects`, the root
 * on the last (the kernel sets `main` when there is none), then `head {name: "main", tree}` when `main` is
 * another tree. `only` filters the directory (deploy.ts onlyIgnore; default DEFAULT_ONLY; [] for all of it).
 * Records the view's store has are not sent. With no view (`recipient` alone) everything is sent, and the head.
 */
export async function planDeploy(dir: string, target: InstanceView | { identity: string }, o: { only?: string[] } = {}): Promise<AdminPlan & { root: CID }> {
  const only = o.only ?? DEFAULT_ONLY;
  const { root, records } = await hashDir(dir, only.length ? { ignore: onlyIgnore(dir, only) } : {});
  const view = "store" in target ? target as InstanceView : undefined;
  const { records: n, bundles } = await recordBundles(root, records as Rec[], view ? { skip: (c) => view.store.has(c) } : {});
  const main = view?.heads.find((h) => h.name === MAIN)?.root;
  const head = !view || (main !== undefined && !main.equals(root));
  const messages: AdminMessage[] = bundles.map((b) => ({ box: "objects", body: dagCbor.decode(b) }));
  if (head) messages.push({ box: "head", body: { name: MAIN, tree: root } });
  const prompt = [`deploy ${dir} → main ${root}${main?.equals(root) ? " (main is this tree already)" : ""}`, `  messages  objects ×${bundles.length} (${n} records)${head ? " · head main" : ""}`];
  return { prompt, recipient: target.identity, messages, root };
}

// ---------------------------------------------------------------- the instance, read through its explorer

/**
 * A read of the instance's explorer (`/explore…`; root's, #121, #143): the answer DAG-JSON decoded, undefined
 * for a 404 — the client's on its BRC-104 session (target.ts remoteTarget).
 */
export type ExplorerRead = (path: string) => Promise<unknown>;

/**
 * The instance as the install plan reads it (plan.ts InstanceView), from its explorer: heads, the genesis
 * (identity, programs), the address book, the route table, and the store by CID —
 * what the management page's view reads (shruggr/skein-site www/app.js `Skein.view`).
 */
export async function explorerView(read: ExplorerRead): Promise<InstanceView> {
  const records = new Map<string, unknown>();
  const record = async (cid: CID | string): Promise<unknown> => {
    const k = cid.toString();
    if (!records.has(k)) records.set(k, await read(`/record/${k}`));
    return records.get(k);
  };
  const top = await read("") as { heads?: Record<string, CID> } | undefined;
  if (!top) throw new Error("the explorer answered nothing (is it a skein?)");
  const heads = Object.entries(top.heads ?? {}).map(([name, root]) => ({ name, root }));
  const head = (name: string) => heads.find((x) => x.name === name)?.root;
  const first = (await read("/log?before=1&limit=1") as { entries?: Array<{ record?: { genesis?: CID } }> } | undefined)?.entries?.[0]?.record;
  const genesis = (first?.genesis ? await record(first.genesis) : {}) as { identity?: unknown; programs?: Record<string, CID> };
  const hex = (k: unknown) => (k instanceof Uint8Array ? Buffer.from(k).toString("hex") : typeof k === "string" ? k : "");
  const book: AddressEntry[] = [];
  if (head("peers")) {
    for (const e of ((await record(head("peers")!)) as { peers?: Array<{ key?: unknown; peer: CID }> })?.peers ?? []) {
      const p = await record(e.peer) as { key?: unknown; transport?: AddressEntry["transport"]; address?: string; handle?: string; domain?: string; source?: string };
      book.push({ key: hex(p.key ?? e.key), transport: p.transport ?? "mailbox", address: p.address ?? "", ...(p.handle ? { handle: p.handle } : {}), ...(p.domain ? { domain: p.domain } : {}), ...(p.source ? { source: p.source } : {}) });
    }
  }
  const chain = await read(`/thread/${dispatchOrigin()}`) as { updates?: Array<{ record?: { op: "add" | "remove"; row: DispatchRow } }> } | undefined;
  const dispatch = fold((chain?.updates ?? []).map((u) => u.record!).filter((u) => u && u.row));
  const store = {
    get: async (cid: CID) => { const v = await record(cid); if (v === undefined) throw new Error(`not found: ${cid}`); return v; },
    has: async (cid: CID) => (await record(cid)) !== undefined,
    bytes: async (cid: CID) => { const v = await record(cid); if (!(v instanceof Uint8Array)) throw new Error(`not found: ${cid}`); return v; },
    putBlock: async () => {},
  } as unknown as InstanceView["store"];
  return {
    store, heads, dispatch, addressBook: book,
    identity: hex(genesis.identity), programs: genesis.programs ?? {},
  };
}

/**
 * A grant (#142, #143; `skein-host grant`): the kernel's `grant` operation — `role` (root by default,
 * or an app's `<app>.<role>`) to `key`, or with `remove` from it. One message to box `grant`, sent by
 * root. Nothing is sent when the grants already say so.
 */
export async function planGrant(view: InstanceView, key: string, o: { role?: string; remove?: boolean } = {}): Promise<AdminPlan> {
  if (!isKey(key)) throw new Error(`${key}: not an identity key (hex)`);
  const role = o.role ?? "root";
  if (role !== "root" && !/^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9_-]*$/.test(role)) throw new Error(`${role}: a role is root or <app>.<role> (user is any principal: never granted)`);
  const op = o.remove ? "remove" : "add";
  const root = view.heads.find((h) => h.name === "grants")?.root;
  const g = root ? await view.store.get(root).catch(() => undefined) as { roles?: Record<string, unknown[]> } | undefined : undefined;
  const holds = (g?.roles?.[role] ?? []).some((k) => (k instanceof Uint8Array ? Buffer.from(k).toString("hex") : String(k)) === key);
  if (holds === (op === "add")) return { prompt: [`grant ${op} ${role} ${key}: the grants say so already`], recipient: view.identity, messages: [] };
  return { prompt: [`grant ${op} ${role} ${key}`], recipient: view.identity, messages: [{ box: "grant", body: { op, role, principal: keyBytes(key) } }] };
}

/** One app the management page offers (the site's www/catalog.json): a repository and a commit. */
export interface CatalogEntry { name: string; version?: string; url: string; hash: string; image?: string; description?: string }

/** The catalog in the instance's own site tree (its app `site`: www/catalog.json), and the names in it. */
export async function catalogOf(view: InstanceView): Promise<CatalogEntry[]> {
  const head = view.heads.find((h) => h.name === appHead("site"))?.root;
  const rec = head ? await view.store.get(head).catch(() => undefined) as AppRecord | undefined : undefined;
  if (rec?.kind !== "app") throw new Error("the instance has no site app (site/app): no catalog to name an app from; give <url>#<commit>");
  const leaf = await lookup(view.store as never, rec.tree, "www/catalog.json");
  if (!leaf) throw new Error(`the site app ${rec.version} has no www/catalog.json`);
  const c = JSON.parse(new TextDecoder().decode(await readBlob(view.store as never, leaf.cid))) as { apps?: CatalogEntry[] };
  return (c.apps ?? []).filter((e) => e && typeof e.name === "string" && typeof e.url === "string" && /^[0-9a-f]{40}$/i.test(e.hash ?? ""));
}
