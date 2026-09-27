// Deployment via `objects` (#23): the host sends an agent's directory into its
// instance exactly as `bin/skein import` does — git objects in ≤ 1 MiB bundles
// to the instance's `objects` box, the root tree on the last one — signed by
// the owner, the identity the genesis subscribes to `objects` (and `head`). So
// the personality arrives as a signed message, admitted as a host-signed log
// entry. The first root sets `main` (objects-handler does that when there is
// none); a redeploy of a changed directory then moves `main` through the
// `head` box, so a new conversation starts from the new tree. The messagebox
// queues all of it until the instance's delivery collects it: running or not
// does not matter here.
//
// The host adds files of its own at the tree's root (`files`): ROSTER.md
// (#27), generated from host.db, never written into the directory. They are
// part of the root, so a roster change alone is a changed tree. deployFiles
// does that without the directory: the row's deployed tree, from the
// instance's store, with only those root files replaced.

import { lstatSync } from "node:fs";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import type { Rec } from "../client/bundle.ts";
import { hashDir, recordBundles } from "../client/client.ts";
import { defaultIgnore } from "../dev/scan.ts";
import { isoTime, seal } from "../envelope.ts";
import { headTree, MAIN } from "../runtime/heads.ts";
import { rootIdentity } from "../runtime/identity.ts";
import { genesisOf, short } from "../runtime/log.ts";
import type { Store } from "../runtime/store.ts";
import { hashBlob, hashTree, readTree, type TreeBlocks } from "../runtime/tree.ts";
import type { WalletInterface } from "../wallet.ts";
import type { InstanceRow } from "./instances.ts";
import type { MessageBox } from "./messagebox.ts";

/** What goes in by default: the personality and its file-only skills (#24), not the code around them. */
export const DEFAULT_ONLY = ["SOUL.md", "IDENTITY.md", "skills"];

const segment = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);

/**
 * scan's `ignore` for `--only`: a path is kept if a pattern names it or a
 * directory above it (a pattern naming a directory takes all of it), or if it
 * is a directory on the way to what a pattern names. Patterns are
 * "/"-separated from the directory's root, `*` and `?` within one segment.
 * .git and node_modules are never kept.
 */
export function onlyIgnore(dir: string, patterns: string[]): (rel: string) => boolean {
  const pats = patterns.map((p) => p.split("/").filter(Boolean).map(segment)).filter((p) => p.length);
  return (rel) => {
    if (defaultIgnore(rel)) return true;
    const segs = rel.split("/");
    for (const p of pats) {
      if (!p.slice(0, segs.length).every((re, i) => re.test(segs[i]!))) continue;
      if (segs.length >= p.length) return false;
      if (lstatSync(join(dir, rel)).isDirectory()) return false;
    }
    return true;
  };
}

export interface DeployOptions {
  row: InstanceRow;
  dir: string;
  /** Patterns (onlyIgnore); default DEFAULT_ONLY. */
  only?: string[];
  /** The owner's wallet: signs and encrypts every envelope. */
  owner: WalletInterface;
  /** A messagebox session as the owner. */
  box: MessageBox;
  /**
   * The instance's store, read only, if it exists: its genesis must name this
   * owner and the row's identity; records it already has are not sent; its
   * `main` says whether a `head` move is needed.
   */
  store?: Store;
  /** The clock for envelope `created` (ms). */
  now?: () => number;
  /**
   * Files the host sets at the tree's root, over what the directory has:
   * contents, or null for none (removed if the directory has one).
   */
  files?: Record<string, string | Uint8Array | null>;
}

export interface Deployed {
  root: string;
  /** The row's tree already was this root (and the store, if any, has it): nothing sent. */
  unchanged: boolean;
  /** Records sent, in `bundles` envelopes to `objects`. */
  records: number;
  bundles: number;
  /** A `head` {name: "main", tree: root} was sent after them. */
  head: boolean;
}

/** Send `dir` (filtered, plus `files`) into the row's instance. The caller records `root` as the row's `tree`. */
export async function deploy(o: DeployOptions): Promise<Deployed> {
  const store = await checked(o);
  const { root, records } = await hashDir(o.dir, { ignore: onlyIgnore(o.dir, o.only ?? DEFAULT_ONLY) });
  const m = new Map(records.map((r) => [r.cid.toString(), r]));
  return ship(o, store, await setFiles(memoryBlocks(m), root, o.files), m);
}

export type DeployFilesOptions = Omit<DeployOptions, "dir" | "only" | "store" | "files"> & {
  /** The instance's store: it must hold the row's `tree`. */
  store: Store;
  files: Record<string, string | Uint8Array | null>;
};

/**
 * The row's deployed tree (its `tree`, read from the instance's store) with
 * `files` set at its root — no directory needed. Only the new objects go.
 */
export async function deployFiles(o: DeployFilesOptions): Promise<Deployed> {
  const store = await checked(o);
  if (!o.row.tree) throw new Error(`${o.row.handle}: never deployed (no tree)`);
  const base = CID.parse(o.row.tree);
  if (!store || !(await store.has(base))) throw new Error(`${o.row.handle}: its store does not have the deployed tree ${o.row.tree} (yet): deploy the directory instead`);
  const m = new Map<string, Rec>();
  const mem = memoryBlocks(m);
  const blocks: TreeBlocks = { has: async (c) => (await mem.has(c)) || store.has(c), bytes: async (c) => ((await mem.has(c)) ? mem.bytes(c) : store.bytes(c)), putBlock: mem.putBlock };
  return ship(o, store, await setFiles(blocks, base, o.files), m);
}

/**
 * Change the row's instance's subscriptions as the owner (#3): one `subscribe`
 * envelope (body {op, sender?, box, handler}, client.ts subscribeBody) — what
 * a changed rule sends, instead of a new genesis. Queued in the messagebox
 * like a deploy; the store, if given, is checked as for one.
 */
export async function subscribeRow(o: { row: InstanceRow; owner: WalletInterface; box: MessageBox; store?: Store; now?: () => number }, body: Record<string, unknown>): Promise<void> {
  await checked(o);
  const { row } = o;
  const env = await seal(o.owner, { recipient: { identityKey: row.identity!, handle: row.handle, domain: row.domain }, body: dagCbor.encode(body), created: isoTime((o.now ?? Date.now)()) });
  await o.box.send({ recipient: row.identity!, box: "subscribe", body: env });
}

/** The genesis checks; the store if it has a log. */
async function checked(o: { row: InstanceRow; owner: WalletInterface; store?: Store }): Promise<Store | undefined> {
  const { row } = o;
  if (!row.identity) throw new Error(`${row.handle}: no identity yet (scripts/host/instance.sh, or \`skein-host run\` once)`);
  const me = await rootIdentity(o.owner);
  const store = o.store && (await o.store.log.tip()) ? o.store : undefined;
  if (store) {
    const g = await genesisOf(store);
    if (g.owner !== me) throw new Error(`${row.handle}: the owner wallet is ${short(me)}, but the instance's genesis owner is ${short(g.owner)}: it would not admit these`);
    if (g.identity !== row.identity) throw new Error(`${row.handle}: the store's identity ${short(g.identity)} is not the row's ${short(row.identity)}`);
  }
  return store;
}

function memoryBlocks(m: Map<string, Rec>): TreeBlocks {
  return {
    has: async (cid) => m.has(cid.toString()),
    bytes: async (cid) => { const r = m.get(cid.toString()); if (!r) throw new Error(`missing ${cid}`); return r.bytes; },
    putBlock: async (cid, bytes) => { m.set(cid.toString(), { cid, bytes }); },
  };
}

/** `root` with `files` set (or removed) at its top; new objects go into `blocks`. */
async function setFiles(blocks: TreeBlocks, root: CID, files: DeployOptions["files"]): Promise<CID> {
  const names = Object.keys(files ?? {});
  if (!names.length) return root;
  const entries = (await readTree(blocks, root)).filter((e) => !names.includes(e.name));
  for (const name of names) {
    const v = files![name];
    if (v === null || v === undefined) continue;
    const { cid, object } = hashBlob(typeof v === "string" ? new TextEncoder().encode(v) : v);
    await blocks.putBlock(cid, object);
    entries.push({ mode: "100644", name, cid });
  }
  const { cid, object } = hashTree(entries);
  await blocks.putBlock(cid, object);
  return cid;
}

/** Send the tree `root` (its objects: `m`, less what the store has) unless it is the row's tree already; `head` if main must move. */
async function ship(o: { row: InstanceRow; owner: WalletInterface; box: MessageBox; now?: () => number }, store: Store | undefined, root: CID, m: Map<string, Rec>): Promise<Deployed> {
  const { row } = o;
  const done: Deployed = { root: root.toString(), unchanged: true, records: 0, bundles: 0, head: false };
  // Unchanged: the row's tree, and the store (if there is one) has it — a store
  // that does not was reset, or has not admitted it yet: send it (again).
  if (row.tree === done.root && !(store && !(await store.has(root)))) return done;
  // Only what `root` reaches: setFiles leaves the directory's own root behind.
  const reach = new Map<string, Rec>();
  const visit = async (cid: CID) => {
    const r = m.get(cid.toString());
    if (!r || reach.has(cid.toString())) return;
    reach.set(cid.toString(), r);
    if (new TextDecoder().decode(r.bytes.subarray(0, 5)) === "tree ") for (const e of await readTree(memoryBlocks(m), cid)) await visit(e.cid);
  };
  await visit(root);
  const { records, bundles } = await recordBundles(root, [...reach.values()], { skip: store ? (c) => store.has(c) : undefined });

  const main = store ? await headTree(store, MAIN) : undefined;
  // objects-handler sets main only when there is none: once one exists (or an
  // earlier deploy is on its way to setting it), moving it is `head`'s job.
  const head = !main?.equals(root) && (main !== undefined || row.tree !== null);
  const recipient = { identityKey: row.identity!, handle: row.handle, domain: row.domain };
  const clock = o.now ?? Date.now;
  let last = 0;
  const send = async (box: string, body: Uint8Array) => {
    last = Math.max(clock(), last + 1); // strictly increasing: delivery admits in `created` order
    const env = await seal(o.owner, { recipient, body, created: isoTime(last) });
    await o.box.send({ recipient: row.identity!, box, body: env });
  };
  for (const b of bundles) await send("objects", b);
  if (head) await send("head", dagCbor.encode({ name: MAIN, tree: root as CID }));
  return { ...done, unchanged: false, records, bundles: bundles.length, head };
}
