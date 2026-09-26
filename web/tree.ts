// A directory picked in the browser as git objects, byte for byte what
// src/runtime/tree.ts hashBlob/hashTree and src/dev/scan.ts produce for the
// same files: "blob <len>\0…" / "tree <len>\0…", CIDv1(git-raw, sha1), entries
// ordered by UTF-8 bytes of the name with a directory compared as "name/".
// Browser-native: Uint8Array, TextEncoder and WebCrypto SHA-1 (no Buffer).
//
// What the browser cannot see: file modes (every file is 100644; the CLI writes
// 100755 for an executable) and symlinks (the picker follows them; the CLI
// stores 120000 with the link target). Empty directories vanish in both.

import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import type { Rec } from "../src/client/bundle.ts";

export const GIT_RAW = 0x78;
const SHA1 = 0x11;

export type FileMode = "100644" | "100755" | "120000";
export interface PickedFile { path: string; bytes: Uint8Array; mode?: FileMode }

const utf8 = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function sha1Cid(object: Uint8Array): Promise<CID> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", object as Uint8Array<ArrayBuffer>));
  return CID.createV1(GIT_RAW, Digest.create(SHA1, d));
}

const header = (type: "blob" | "tree", len: number) => utf8.encode(`${type} ${len}\0`);

export async function hashBlob(bytes: Uint8Array): Promise<{ cid: CID; object: Uint8Array }> {
  const object = concat([header("blob", bytes.length), bytes]);
  return { cid: await sha1Cid(object), object };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export interface TreeEntry { mode: FileMode | "40000"; name: string; cid: CID }

export async function hashTree(entries: TreeEntry[]): Promise<{ cid: CID; object: Uint8Array }> {
  const seen = new Set<string>();
  const keyed = entries.map((e) => {
    if (!e.name || e.name.includes("/") || e.name.includes("\0")) throw new Error(`bad entry name: ${JSON.stringify(e.name)}`);
    if (seen.has(e.name)) throw new Error(`duplicate entry: ${e.name}`);
    seen.add(e.name);
    // git orders as if a directory's name ended in "/" (so "foo.txt" < "foo" dir < "foo0").
    return { e, key: utf8.encode(e.mode === "40000" ? `${e.name}/` : e.name) };
  });
  keyed.sort((a, b) => compareBytes(a.key, b.key));
  const parts: Uint8Array[] = [];
  for (const { e } of keyed) parts.push(utf8.encode(`${e.mode} ${e.name}\0`), e.cid.multihash.digest);
  const body = concat(parts);
  const object = concat([header("tree", body.length), body]);
  return { cid: await sha1Cid(object), object };
}

/** src/dev/scan.ts defaultIgnore, applied to every segment of a relative path. */
export function ignored(rel: string): boolean {
  return rel.split("/").some((s) => s === ".git" || s === "node_modules");
}

/**
 * A picked directory's path relative to the directory itself: the picker's
 * webkitRelativePath starts with the chosen directory's own name.
 */
export function relativeToPicked(webkitRelativePath: string): string {
  const i = webkitRelativePath.indexOf("/");
  return i < 0 ? webkitRelativePath : webkitRelativePath.slice(i + 1);
}

interface Dir { dirs: Map<string, Dir>; files: Map<string, PickedFile> }

/** Hash files (paths "/"-separated, relative to the root) into git objects: [root, records]. */
export async function hashFiles(files: Iterable<PickedFile>): Promise<{ root: CID; records: Rec[] }> {
  const top: Dir = { dirs: new Map(), files: new Map() };
  for (const f of files) {
    const segs = f.path.split("/").filter(Boolean);
    if (!segs.length) throw new Error(`bad path: ${JSON.stringify(f.path)}`);
    let d = top;
    for (const s of segs.slice(0, -1)) {
      let next = d.dirs.get(s);
      if (!next) d.dirs.set(s, (next = { dirs: new Map(), files: new Map() }));
      d = next;
    }
    d.files.set(segs[segs.length - 1]!, f);
  }
  const records = new Map<string, Rec>();
  const put = (cid: CID, bytes: Uint8Array) => { if (!records.has(cid.toString())) records.set(cid.toString(), { cid, bytes }); };
  const rec = async (d: Dir): Promise<CID> => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of d.files) {
      const { cid, object } = await hashBlob(f.bytes);
      put(cid, object);
      entries.push({ mode: f.mode ?? "100644", name, cid });
    }
    for (const [name, sub] of d.dirs) entries.push({ mode: "40000", name, cid: await rec(sub) });
    const { cid, object } = await hashTree(entries);
    put(cid, object);
    return cid;
  };
  const root = await rec(top);
  return { root, records: [...records.values()] };
}

/** Blobs before trees and the root tree last (SkeinClient.importDir's order). */
export function importOrder(root: CID, records: Rec[]): Rec[] {
  const rootKey = root.toString();
  const rank = (r: Rec) => (r.cid.toString() === rootKey ? 2 : new TextDecoder().decode(r.bytes.subarray(0, 5)) === "tree " ? 1 : 0);
  return [...records].sort((a, b) => rank(a) - rank(b));
}
