// A directory into an instance (#23) and its address book (#40, #70): the
// pieces the owner's messages are built from (#124: src/client/admin.ts
// planDeploy, planPeers; `skein plan deploy|peers`). A deploy is the
// directory's git objects in ≤ 1 MiB bundles to the instance's `objects` box,
// the root tree on the last — the kernel sets `main` from it when there is
// none — then `head {name: "main", tree}` when `main` is another tree. Which
// files go in is `onlyIgnore` (default DEFAULT_ONLY: the personality and its
// skills, #24). The owner's wallet sends them; nothing here does.

import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import { defaultIgnore } from "../dev/scan.ts";
import { headTree } from "../runtime/heads.ts";
import type { Store } from "../runtime/store.ts";

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

/**
 * An address-book entry (#70): how to reach a key — its transport
 * (`mailbox`: a messagebox URL over BRC-103/104; `libp2p`: a peer ID or
 * `topic:<name>`; `local`: a host provider's name) and address, and
 * optionally its handle (#126: no role). The instance keeps them under the head `peers` (programs/resolve);
 * `source` says who wrote one (`genesis`, `admin`: the `peers` box,
 * `resolve`: its own BRC-169 lookup, `claim`).
 */
export interface AddressEntry { key: string; transport: "mailbox" | "libp2p" | "local"; address: string; handle?: string; domain?: string; source?: string }

const hexKey = (k: unknown) => k instanceof Uint8Array ? Buffer.from(k).toString("hex") : typeof k === "string" ? k : "";

/** The row's address book as its store holds it now (empty with no store or no entries). */
export async function addressBook(store: Store | undefined): Promise<AddressEntry[]> {
  if (!store || !(await store.log.tip())) return [];
  const root = await headTree(store, "peers");
  if (!root) return [];
  const t = await store.get(root) as unknown as { peers?: Array<{ key: unknown; peer: CID }> };
  const out: AddressEntry[] = [];
  for (const e of t.peers ?? []) {
    const p = await store.get(e.peer) as unknown as { key: unknown; transport?: AddressEntry["transport"]; address?: string; handle?: string | null; domain?: string | null; source?: string };
    out.push({ key: hexKey(p.key ?? e.key), transport: p.transport ?? "mailbox", address: p.address ?? "", ...(p.handle ? { handle: p.handle } : {}), ...(p.domain ? { domain: p.domain } : {}), ...(p.source ? { source: p.source } : {}) });
  }
  return out;
}
