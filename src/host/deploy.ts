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

import { lstatSync } from "node:fs";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { dirBundles } from "../client/client.ts";
import { defaultIgnore } from "../dev/scan.ts";
import { isoTime, seal } from "../envelope.ts";
import { headTree, MAIN } from "../runtime/heads.ts";
import { rootIdentity } from "../runtime/identity.ts";
import { genesisOf, short } from "../runtime/log.ts";
import type { Store } from "../runtime/store.ts";
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
}

export interface Deployed {
  root: string;
  /** The row's tree already was this root: nothing sent. */
  unchanged: boolean;
  /** Records sent, in `bundles` envelopes to `objects`. */
  records: number;
  bundles: number;
  /** A `head` {name: "main", tree: root} was sent after them. */
  head: boolean;
}

/** Send `dir` (filtered) into the row's instance. The caller records `root` as the row's `tree`. */
export async function deploy(o: DeployOptions): Promise<Deployed> {
  const { row } = o;
  if (!row.identity) throw new Error(`${row.handle}: no identity yet (scripts/host/instance.sh, or \`skein-host run\` once)`);
  const me = await rootIdentity(o.owner);
  const store = o.store && (await o.store.log.tip()) ? o.store : undefined;
  if (store) {
    const g = await genesisOf(store);
    if (g.owner !== me) throw new Error(`${row.handle}: the owner wallet is ${short(me)}, but the instance's genesis owner is ${short(g.owner)}: it would not admit these`);
    if (g.identity !== row.identity) throw new Error(`${row.handle}: the store's identity ${short(g.identity)} is not the row's ${short(row.identity)}`);
  }
  const ignore = onlyIgnore(o.dir, o.only ?? DEFAULT_ONLY);
  const { root, records, bundles } = await dirBundles(o.dir, { ignore, skip: store ? (c) => store.has(c) : undefined });
  const done: Deployed = { root: root.toString(), unchanged: true, records: 0, bundles: 0, head: false };
  if (row.tree === done.root) return done;

  const main = store ? await headTree(store, MAIN) : undefined;
  // objects-handler sets main only when there is none: once one exists (or an
  // earlier deploy is on its way to setting it), moving it is `head`'s job.
  const head = !main?.equals(root) && (main !== undefined || row.tree !== null);
  const recipient = { identityKey: row.identity, handle: row.handle, domain: row.domain };
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
