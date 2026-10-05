// Named heads (docs/VM.md, "Heads"): a chain per name, origin
//
//   { kind: "head", name }
//
// and one update per move, { tree, owner, thread, input, at } (the store adds
// origin, prev, seq). The origin is the name's record, so a head is found by
// encoding it; a name never moved has no chain. Only the kernel writes heads
// (kernel-zig/src/heads.zig advanceHead): a program's step says so (the
// `advance` import) and that step ends without error, or a kernel operation
// does; the update names the thread and the log entry, so replay writes the
// same chain. This side reads them. `main` is the tree `chat` and `run` start
// from when they name none.

import type { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { NotFound, type Store } from "./store.ts";
import type { Ms } from "./types.ts";

export type HeadOrigin = { kind: "head"; name: string };
export type HeadUpdate = {
  origin: CID; prev: CID; seq: number; tree: CID;
  /** The app the head's name is under (#77): `<app>/…` → `<app>`; a bare name is its own (heads.zig ownerOf). */
  owner: string;
  /** Null: moved by the genesis (a system tree, #4) or a kernel operation (#77), not a thread. */
  thread?: CID | null;
  input: CID; at: Ms;
};

export const MAIN = "main";

export const isHeadName = (x: unknown): x is string => typeof x === "string" && x !== "" && !/[\s\0]/.test(x);

/** The head's chain origin: the same CID in every store. */
export function headOrigin(name: string): CID {
  if (!isHeadName(name)) throw new TypeError(`head: bad name ${JSON.stringify(name)}`);
  return encode({ kind: "head", name } satisfies HeadOrigin).cid;
}

/** The tree a head names now, or undefined if it has never moved. */
export async function headTree(store: Store, name: string): Promise<CID | undefined> {
  const origin = headOrigin(name);
  let tip: CID;
  try { tip = await store.chains.tip(origin); } catch (e) { if (e instanceof NotFound) return undefined; throw e; }
  return tip.equals(origin) ? undefined : treeOf(store, tip);
}

const treeOf = async (store: Store, update: CID): Promise<CID> => ((await store.get(update)) as unknown as HeadUpdate).tree;
