// The owner's admin messages (#124): building them is a library, sending them
// is any BRC-100 wallet's job. Installing an app, removing it, a dispatch
// row, an address-book entry, a directory into `main` — each is a few
// messages from the owner to the kernel's admin boxes (docs/MESSAGES.md "The
// dispatch table and the kernel's operations": objects, head, dispatch,
// peers) and the app's own box (start/stop). The management page builds the
// same messages with the same code (src/host/plan.ts) and sends them with the
// browser's wallet; nothing here signs.
//
// A message is one BRC-33 `/sendMessage` request body, as JSON:
//
//   {"message": {"recipient": "<the instance's identity key, hex>",
//                "messageBox": "<box>", "body": <the body, DAG-JSON>}}
//
// (the messagebox reads a JSON body as DAG-JSON: `{"/": "<cid>"}` a link,
// `{"/": {"bytes": "<base64>"}}` bytes; programs/messagebox). The wallet
// POSTs each, in order, to `<the instance's origin>/sendMessage` over a
// BRC-104 session, so the sender is the wallet's identity and the instance
// admits it by its owner's admin rows. From a shell:
//
//   for f in plan/[0-9]*.json; do 1sat authfetch POST <origin>/sendMessage --body @"$f" || break; done
//
// `skein plan …` writes the files (src/client/admin-cli.ts); `skein send`
// runs that loop.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagJson from "@ipld/dag-json";
import type { CID } from "multiformats/cid";
import { type Rec } from "./bundle.ts";
import { dispatchBody, handlerCid, hashDir, recordBundles, senderKey } from "./client.ts";
import { dispatchOrigin, fold, type DispatchRow } from "../runtime/dispatch.ts";
import { MAIN } from "../runtime/heads.ts";
import { DEFAULT_ONLY, onlyIgnore, type AddressEntry } from "../host/deploy.ts";
import { describe, planInstall, planUninstall, sendInstall, sendUninstall, type AppTree, type InstanceView } from "../host/plan.ts";
import type { Objects } from "../host/boot.ts";

/** One admin message: the box and the body (a record value: what the kernel's operation takes). */
export interface AdminMessage { box: string; body: unknown }

/** What `skein plan` writes: the prompt (what the messages do, as the page shows it), the recipient, the messages in order. */
export interface AdminPlan { prompt: string[]; recipient: string; messages: AdminMessage[] }

const isKey = (s: string) => /^0[23][0-9a-f]{64}$/.test(s);
const keyBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

/**
 * The largest JSON body the 1sat CLI's BRC-104 client sends (`1sat authfetch`: @bsv/sdk's AuthFetch with
 * its default message cap; a body over about 4 MiB is refused before it is sent, "Authentication message
 * exceeds the byte limit"). Other wallets have their own limits; the instance takes larger ones.
 */
export const AUTHFETCH_BODY_LIMIT = 4_000_000;

/** The messages whose JSON body is over `limit` bytes (a module larger than about 3 MB travels alone in one). */
export function oversized(p: AdminPlan, limit = AUTHFETCH_BODY_LIMIT): Array<{ index: number; box: string; bytes: number }> {
  const out: Array<{ index: number; box: string; bytes: number }> = [];
  p.messages.forEach((m, index) => { const bytes = Buffer.byteLength(messageJson(p.recipient, m)); if (bytes > limit) out.push({ index, box: m.box, bytes }); });
  return out;
}

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

/** A manifest's `config` with `over` merged in: per program, its keys over the manifest's. */
export function mergeConfig(base: Record<string, unknown> | undefined, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, x] of Object.entries(over)) {
    const b = out[k];
    out[k] = x && typeof x === "object" && !Array.isArray(x) && b && typeof b === "object" && !Array.isArray(b) ? { ...b as Record<string, unknown>, ...x as Record<string, unknown> } : x;
  }
  return out;
}

/**
 * Install (or upgrade) the app `tree` into the instance `view` reads (docs/APPS.md §3): objects (≤ 1 MiB
 * bundles), the head `<app>/app`, a dispatch message per row that changes, the start. `config` is merged
 * over the manifest's (one level deep per program). `modules`: where a `bin/<x>.cid` module the instance
 * lacks is found (this repo's wasm/ directory, boot.ts wasmDirObjects).
 */
export async function planInstallApp(tree: AppTree, view: InstanceView, o: { config?: Record<string, unknown>; modules?: Objects } = {}): Promise<AdminPlan & { app: string; version: string; recordCid: CID }> {
  if (o.config) tree.checked.manifest.config = mergeConfig(tree.checked.manifest.config, o.config);
  const plan = await planInstall(tree, view, { modules: o.modules ?? { get: async () => undefined } });
  const messages = await collect((send) => sendInstall(plan, send));
  return { prompt: describe(plan), recipient: view.identity, messages, app: plan.app, version: plan.version, recordCid: plan.recordCid };
}

/** Uninstall: the app's `stop`, then every row the table holds for it removed; its heads are left. */
export async function planUninstallApp(name: string, view: InstanceView): Promise<AdminPlan> {
  const p = await planUninstall(name, view);
  const messages = await collect((send) => sendUninstall(p, send));
  const prompt = [`uninstall ${name} ${p.record.version}${p.stop ? ` · stop ${JSON.stringify(p.stop)}` : ""} · dispatch remove ×${p.rows.length} · head ${name}/app left`, ...p.rows.map((r) => `    dispatch remove ${r.row.transport} ${r.row.address}${r.row.prefix ? "*" : ""} from ${r.label}`)];
  return { prompt, recipient: view.identity, messages };
}

/** An http row's own parts (#125): `prefix`, the handler's `fn`, and its settings (a file server's `root`, `index`), carried to it as `match`. */
export interface HttpRowArgs { prefix?: boolean; fn: string; settings?: Record<string, unknown> }

/** The fields of a row that are not a handler's settings. */
const ROW_FIELDS = ["transport", "address", "prefix", "sender", "program", "fn", "app", "optional"];

/**
 * One row of the dispatch table (#77): a mailbox row `{op, row: {transport: "mailbox", address: box,
 * sender, program}}`, or with `http` an http row `{transport: "http", address: <path>, prefix?, sender,
 * program, fn, …settings}` (#125: the owner's own row, such as the site at `/`: no `app`, so an app's
 * upgrade or uninstall leaves it). The handler is a program record CID or a name the instance's genesis
 * gives (`programs`); the sender anyone when absent, `session` (http only), or an identity key in hex.
 */
export function planDispatch(recipient: string, a: { op: "add" | "remove"; sender?: string; box: string; handler: string; http?: HttpRowArgs }, programs: Record<string, CID> = {}): AdminPlan {
  if (!a.http) {
    if (a.sender === "session") throw new Error("sender session: an http row's (--http)");
    const body = dispatchBody(a, programs);
    return { prompt: [`dispatch ${a.op} mailbox ${a.box} from ${a.sender ?? "anyone"} → ${a.handler} (${String(body.row.program)})`], recipient, messages: [{ box: "dispatch", body }] };
  }
  const h = a.http;
  if (!a.box.startsWith("/") || /[\\\0?#]/.test(a.box) || a.box.split("/").some((x) => x === "." || x === "..")) throw new Error(`http address ${JSON.stringify(a.box)}: a path (from /, no ".", "..", query or fragment)`);
  if (!h.fn) throw new Error("an http row names its handler's function (--fn)");
  const settings = h.settings ?? {};
  const bad = Object.keys(settings).filter((k) => ROW_FIELDS.includes(k));
  if (bad.length) throw new Error(`--settings: ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} the row's own, not a setting`);
  const program = handlerCid(a.handler, programs);
  const sender = a.sender === undefined ? "*" : a.sender === "session" ? "session" : senderKey(a.sender);
  const row = { ...settings, transport: "http", address: a.box, ...(h.prefix ? { prefix: true } : {}), sender, program, fn: h.fn };
  const shown = Object.entries(settings).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
  return {
    prompt: [`dispatch ${a.op} http ${a.box}${h.prefix ? "*" : ""} from ${a.sender ?? "anyone"} → ${a.handler}.${h.fn} (${String(program)})${shown ? ` (${shown})` : ""}`],
    recipient, messages: [{ box: "dispatch", body: { op: a.op, row } }],
  };
}

/**
 * The claim (#89, #127): one message in box `claim` to an image whose claim
 * row admits anyone — its sender (the wallet that sends it) is the owner;
 * the body carries only the owner's mailbox entry, if any.
 */
export function planClaim(recipient: string, o: { messagebox?: string; handle?: string; domain?: string } = {}): AdminPlan {
  const body = { ...(o.messagebox ? { messagebox: o.messagebox } : {}), ...(o.handle ? { handle: o.handle, ...(o.domain ? { domain: o.domain } : {}) } : {}) };
  return { prompt: [`claim ${recipient}: its owner becomes the key that sends this${o.messagebox ? ` · messagebox ${o.messagebox}` : ""}${o.handle ? ` (@${o.handle}${o.domain ? `@${o.domain}` : ""})` : ""}`], recipient, messages: [{ box: "claim", body }] };
}

/** The host's terms as it publishes them (/.well-known/skein-host `billing`, #130). */
export interface HostTerms { key: string; x: number; rates?: Record<string, number> }

/**
 * The host row (#130): the owner's grant of a host and its rates — one `dispatch` message adding (or
 * removing) the kernel row {mailbox, billing, sender: <the host's key>, kernel, tick, x, rates}. The
 * first such row is the host's; the kernel bills by it, the host ticks it. Removing it ends billing.
 */
export function planHost(recipient: string, op: "add" | "remove", t: HostTerms): AdminPlan {
  if (!isKey(t.key)) throw new Error(`${t.key}: not the host's key (hex)`);
  if (op === "add" && (!Number.isSafeInteger(t.x) || t.x < 1)) throw new Error("x: the sats the skein prepays at a time (a whole number ≥ 1)");
  const rates = Object.fromEntries(Object.entries(t.rates ?? {}).map(([k, v]) => {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`rates.${k}: a whole number of sats`);
    return [k, v];
  }));
  const row = { transport: "mailbox", address: "billing", sender: keyBytes(t.key), program: "kernel", fn: "tick", ...(op === "add" ? { x: t.x, ...(Object.keys(rates).length ? { rates } : {}) } : {}) };
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
 * A read of the instance's explorer (`/explore…`; the owner's, #121): the answer DAG-JSON decoded, undefined
 * for a 404. The CLI's goes through the wallet (`1sat authfetch GET`, authfetchReader); a test's through a
 * session of its own.
 */
export type ExplorerRead = (path: string) => Promise<unknown>;

/**
 * The instance as the install plan reads it (plan.ts InstanceView), from its explorer: heads, the genesis
 * (identity, programs, owner), the claim, the address book, the dispatch table, and the store by CID —
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
  const genesis = (first?.genesis ? await record(first.genesis) : {}) as { identity?: unknown; programs?: Record<string, CID>; owner?: unknown };
  const claim = head("claim") ? await record(head("claim")!) as { owner?: unknown } | undefined : undefined;
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
    owner: genesis.owner !== undefined ? hex(genesis.owner) : hex(claim?.owner),
  };
}

/** The command that does BRC-104 requests with the owner's wallet: $SKEIN_AUTHFETCH (words), default `1sat authfetch`. */
export function authfetchCommand(vars: Record<string, string | undefined> = process.env): string[] {
  return (vars.SKEIN_AUTHFETCH || "1sat authfetch").split(/\s+/).filter(Boolean);
}

/** Run `<authfetch> <method> <url> [--body @file] --json`: the status and the body text (1sat's --json output). */
function authfetch(cmd: string[], method: string, url: string, bodyFile?: string): { status: number; text: string; raw: string } {
  const r = spawnSync(cmd[0]!, [...cmd.slice(1), method, url, ...(bodyFile ? ["--body", `@${bodyFile}`] : []), "--json"], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error) throw new Error(`${cmd.join(" ")}: ${r.error.message}`);
  // 1sat prints dotenv notices ("◇ injected env …") on stdout before its JSON.
  const out = r.stdout.split("\n").filter((l) => !l.startsWith("◇")).join("\n").trim();
  const at = out.indexOf("{");
  let v: { status?: number; body?: unknown } = {};
  try { v = JSON.parse(at >= 0 ? out.slice(at) : out); } catch { /* below */ }
  if (typeof v.status !== "number") throw new Error(`${cmd.join(" ")} ${method} ${url}: exit ${r.status}: ${(r.stderr.trim() || out).slice(0, 400)}`);
  return { status: v.status, text: typeof v.body === "string" ? v.body : JSON.stringify(v.body), raw: out };
}

/** The explorer at `origin`, read through the wallet's command (authfetchCommand). */
export function authfetchReader(origin: string, cmd = authfetchCommand()): ExplorerRead {
  const base = origin.replace(/\/+$/, "");
  return async (path) => {
    const r = authfetch(cmd, "GET", `${base}/explore${path}`);
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new Error(`GET ${base}/explore${path}: ${r.status} ${r.text.slice(0, 200)}${r.status === 403 ? " (the explorer is the owner's: is this wallet the instance's owner?)" : ""}`);
    return dagJson.decode(new TextEncoder().encode(r.text));
  };
}

// ---------------------------------------------------------------- the files

/** The numbered message files of a plan directory, in order. */
export function planFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => /^\d+-[^/]+\.json$/.test(f)).sort().map((f) => join(dir, f));
}

/**
 * Write a plan into `dir` (emptied of an earlier plan's files): `prompt.txt` and one `/sendMessage` body per
 * message, `001-objects.json`, `002-head.json`, …. The file names.
 */
export function writePlan(dir: string, p: AdminPlan): string[] {
  mkdirSync(dir, { recursive: true });
  for (const f of existsSync(dir) ? planFiles(dir) : []) rmSync(f);
  writeFileSync(join(dir, "prompt.txt"), `${p.prompt.join("\n")}\n`);
  const width = Math.max(3, String(p.messages.length).length);
  return p.messages.map((m, i) => {
    const f = join(dir, `${String(i + 1).padStart(width, "0")}-${m.box.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    writeFileSync(f, messageJson(p.recipient, m));
    return f;
  });
}

/** What one delivery answered. */
export interface Delivered { file: string; status: number; text: string }

/**
 * Deliver a plan directory's files in order with `post` (the wallet's BRC-104 POST of the file's JSON to
 * `<origin>/sendMessage`); stops at the first answer that is not 2xx, which is the last in the list.
 */
export async function deliver(files: string[], post: (json: string, file: string) => Promise<{ status: number; text: string }>, each?: (d: Delivered) => void): Promise<Delivered[]> {
  const out: Delivered[] = [];
  for (const file of files) {
    const r = await post(readFileSync(file, "utf8"), file);
    const d = { file, ...r };
    out.push(d);
    each?.(d);
    if (r.status < 200 || r.status > 299) break;
  }
  return out;
}

/** The wallet's command as `deliver`'s post: `<authfetch> POST <origin>/sendMessage --body @<file>`. */
export function authfetchPoster(origin: string, cmd = authfetchCommand()): (json: string, file: string) => Promise<{ status: number; text: string }> {
  const url = `${origin.replace(/\/+$/, "")}/sendMessage`;
  return async (_json, file) => { const r = authfetch(cmd, "POST", url, file); return { status: r.status, text: r.text }; };
}
