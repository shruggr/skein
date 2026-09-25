// Test helpers shared across directories. Not part of the runtime.

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

import { readFile } from "node:fs/promises";
import { MODULES, loadShellModules } from "./runtime/programs.ts";
import type { Modules } from "./runtime/shell.ts";
import type { Blocks } from "./runtime/store.ts";

const WASM = new URL("../wasm/", import.meta.url);

/** Put the shell's wasm modules into a store, as skein-dev install does. */
export async function installWasm(store: Pick<Blocks, "putBlock">): Promise<void> {
  for (const [name, cid] of Object.entries(MODULES)) await store.putBlock(cid, await readFile(new URL(`${name}.wasm`, WASM)));
}

/** The shell's modules compiled from wasm/, for tests that run the shell without a store. */
export async function wasmModules(): Promise<Modules> {
  const bytes = new Map<string, Uint8Array>();
  for (const [name, cid] of Object.entries(MODULES)) bytes.set(cid.toString(), await readFile(new URL(`${name}.wasm`, WASM)));
  return loadShellModules({ bytes: async (c) => bytes.get(c.toString())! });
}
