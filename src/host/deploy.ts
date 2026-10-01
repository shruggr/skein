// Deployment via `objects` (#23): the host sends an agent's directory into its
// instance exactly as `bin/skein import` does — git objects in ≤ 1 MiB bundles
// to the instance's `objects` box, the root tree on the last one — sent as
// the owner, the identity the genesis's dispatch rows take `objects` (and `head`) from, as
// raw BRC-33 on the owner's BRC-104 session with the instance's front door
// (#40: src/client/raw.ts). So the personality arrives as a message, admitted
// as a log entry. The first root sets `main` (the kernel's `objects` operation does that when
// there is none); a redeploy of a changed directory then moves `main` through
// the `head` box, so a new conversation starts from the new tree.
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
import { headTree, MAIN } from "../runtime/heads.ts";
import { rootIdentity } from "../runtime/identity.ts";
import { short } from "../runtime/log.ts";
import type { Store } from "../runtime/store.ts";
import { hashBlob, hashTree, readTree, type TreeBlocks } from "../runtime/tree.ts";
import type { WalletInterface } from "../wallet.ts";
import type { InstanceRow } from "./instances.ts";

/** Where the owner's messages to the row's instance go: its front door (RawBox), or a test's stand-in. */
export interface Outbox { send(recipient: string, box: string, body: Uint8Array): Promise<unknown> }

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
  /** The owner's wallet: its identity is checked against the genesis. */
  owner: WalletInterface;
  /** The owner's session with the row's instance. */
  box: Outbox;
  /**
   * The instance's store, read only, if it exists: its genesis must name this
   * owner and the row's identity; records it already has are not sent; its
   * `main` says whether a `head` move is needed.
   */
  store?: Store;
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
 * Change the row's instance's dispatch table as the owner (#77): one envelope
 * to box `dispatch`, the kernel's `dispatch` operation (body {op, row},
 * client.ts dispatchBody) — what a changed row sends, instead of a new
 * genesis. Queued in the messagebox like a deploy; the store, if given, is
 * checked as for one.
 */
export async function dispatchRow(o: { row: InstanceRow; owner: WalletInterface; box: Outbox; store?: Store }, body: Record<string, unknown>): Promise<void> {
  await checked(o);
  await o.box.send(o.row.identity!, "dispatch", dagCbor.encode(body));
}

/**
 * An address-book entry (#70): how to reach a key — its transport
 * (`mailbox`: a messagebox URL over BRC-103/104; `libp2p`: a peer ID or
 * `topic:<name>`; `local`: a host provider's name) and address, the provider
 * role it plays (`fetch`, `libp2p`, `waker`, `broadcast`), and optionally its
 * handle. The instance keeps them under the head `peers` (programs/resolve);
 * `source` says who wrote one (`genesis`, `admin`: the `peers` box,
 * `resolve`: its own BRC-169 lookup, `claim`).
 */
export interface AddressEntry { key: string; transport: "mailbox" | "libp2p" | "local"; address: string; role?: string; handle?: string; domain?: string; source?: string }

const hexKey = (k: unknown) => k instanceof Uint8Array ? Buffer.from(k).toString("hex") : typeof k === "string" ? k : "";

/** The row's address book as its store holds it now (empty with no store or no entries). */
export async function addressBook(store: Store | undefined): Promise<AddressEntry[]> {
  if (!store || !(await store.log.tip())) return [];
  const root = await headTree(store, "peers");
  if (!root) return [];
  const t = await store.get(root) as unknown as { peers?: Array<{ key: unknown; peer: CID }> };
  const out: AddressEntry[] = [];
  for (const e of t.peers ?? []) {
    const p = await store.get(e.peer) as unknown as { key: unknown; transport?: AddressEntry["transport"]; address?: string; role?: string | null; handle?: string | null; domain?: string | null; source?: string };
    out.push({ key: hexKey(p.key ?? e.key), transport: p.transport ?? "mailbox", address: p.address ?? "", ...(p.role ? { role: p.role } : {}), ...(p.handle ? { handle: p.handle } : {}), ...(p.domain ? { domain: p.domain } : {}), ...(p.source ? { source: p.source } : {}) });
  }
  return out;
}

/**
 * Write the row's address book as the owner (#40, #70): one message to its
 * `peers` box per change — {op: "add", key, transport, address, role?,
 * handle?, domain?} or {op: "remove", key} — the admin's configuration,
 * admitted and applied by the instance's resolve program. An add identical to
 * the entry the store already has, or a remove of a key it does not have, is
 * not sent. Returns what was sent.
 */
export async function writeAddresses(o: { row: InstanceRow; owner: WalletInterface; box: Outbox; store?: Store }, changes: Array<({ op: "add" } & AddressEntry) | { op: "remove"; key: string }>): Promise<Array<"sent" | "unchanged">> {
  const store = await checked(o);
  const book = await addressBook(store);
  const out: Array<"sent" | "unchanged"> = [];
  for (const c of changes) {
    if (!/^0[23][0-9a-f]{64}$/.test(c.key)) throw new Error(`${c.key}: not an identity key (hex)`);
    const have = book.find((e) => e.key === c.key);
    const same = c.op === "remove" ? !have : have?.transport === c.transport && have.address === c.address && have.role === c.role && have.handle === c.handle && have.domain === c.domain;
    if (same) { out.push("unchanged"); continue; }
    const body = c.op === "remove"
      ? { op: "remove", key: Uint8Array.from(Buffer.from(c.key, "hex")) }
      : { op: "add", key: Uint8Array.from(Buffer.from(c.key, "hex")), transport: c.transport, address: c.address, ...(c.role ? { role: c.role } : {}), ...(c.handle ? { handle: c.handle } : {}), ...(c.domain ? { domain: c.domain } : {}) };
    await o.box.send(o.row.identity!, "peers", dagCbor.encode(body));
    out.push("sent");
  }
  return out;
}

/** The genesis checks; the store if it has a log. */
async function checked(o: { row: InstanceRow; owner: WalletInterface; store?: Store }): Promise<Store | undefined> {
  const { row } = o;
  if (!row.identity) throw new Error(`${row.handle}: no identity yet (scripts/host/instance.sh, or \`skein-host run\` once)`);
  const me = await rootIdentity(o.owner);
  const store = o.store && (await o.store.log.tip()) ? o.store : undefined;
  if (store) {
    // The kernel's genesis keeps keys as bytes; index-store's reader shows them as hex.
    const g = await (async () => {
      for await (const { entry } of store.log.entries()) if (entry.genesis) return await store.get<{ kind: string; owner: string; identity: string }>(entry.genesis);
      throw new Error(`${row.handle}: its store's log has no genesis`);
    })();
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
async function ship(o: { row: InstanceRow; owner: WalletInterface; box: Outbox }, store: Store | undefined, root: CID, m: Map<string, Rec>): Promise<Deployed> {
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
  const send = (box: string, body: Uint8Array) => o.box.send(row.identity!, box, body);
  for (const b of bundles) await send("objects", b);
  if (head) await send("head", dagCbor.encode({ name: MAIN, tree: root as CID }));
  return { ...done, unchanged: false, records, bundles: bundles.length, head };
}
