// Named heads (docs/VM.md, "Heads"): a chain per name, origin
//
//   { kind: "head", name }
//
// and one update per move, { tree, thread, input, at } (the store adds origin,
// prev, seq). The origin is the name's record, so a head is found by encoding
// it; a name never moved has no chain. A head moves only when a program's step
// says so (the `advance` import) and that step ends without error; the update
// names the thread and the log entry, so replay writes the same chain.
// `main` is the tree `chat` and `run` start from when they name none.

import type { CID } from "multiformats/cid";
import { encode } from "./cid.ts";
import { NotFound, type Store } from "./store.ts";
import type { Ms } from "./types.ts";

export type HeadOrigin = { kind: "head"; name: string };
export type HeadUpdate = { origin: CID; prev: CID; seq: number; tree: CID; thread: CID; input: CID; at: Ms };

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

/**
 * Move a head to `tree` (which must be in the store), as the step of `thread`
 * over log entry `input` at `at`. Moving it to the tree it already names
 * writes nothing and returns the current update.
 */
export async function advanceHead(store: Store, name: string, tree: CID, by: { thread: CID; input: CID; at: Ms }): Promise<CID> {
  if (!isHeadName(name)) throw new TypeError(`head: bad name ${JSON.stringify(name)}`);
  if (!(await store.has(tree))) throw new Error(`head ${name}: tree ${tree} is not in the store`);
  const origin = await store.chains.open({ kind: "head", name } satisfies HeadOrigin);
  const tip = await store.chains.tip(origin);
  if (!tip.equals(origin) && (await treeOf(store, tip)).equals(tree)) return tip;
  return store.chains.append(origin, { tree, thread: by.thread, input: by.input, at: by.at });
}

const treeOf = async (store: Store, update: CID): Promise<CID> => ((await store.get(update)) as unknown as HeadUpdate).tree;
