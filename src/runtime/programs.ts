// The programs this runtime can run. For now exactly one, `shell`: the wasm
// shell (brush + uutils coreutils) driven from TypeScript (the loop program is
// a later phase). Its record names the two WASI modules by CID; the runtime
// loads them from the store and never from a disk. Whoever administers the
// instance puts the module bytes into the store (skein-dev does it as a
// stand-in for the client); until then a shell thread errors "module not in
// store".

import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { encode } from "./cid.ts";
import type { Modules } from "./shell.ts";
import type { Blocks } from "./store.ts";

export const RAW = 0x55;

/** CIDv1(raw, sha2-256) of a module's bytes: how modules are stored and named. */
export function rawCid(bytes: Uint8Array): CID {
  return CID.createV1(RAW, Digest.create(0x12, createHash("sha256").update(bytes).digest()));
}

/** The modules as committed under wasm/ (see wasm/README.md). A test checks these against the files. */
export const MODULES = {
  brush: CID.parse("bafkreiemwcli2372geseu7l527ivxwjodogng7zoltixf6pfh5ujnpauc4"),
  coreutils: CID.parse("bafkreidohpuc5gyi4xroxlhc367ry5hkpixtabc7sln2tidedeqbwcgese"),
} as const;

/** The `shell` program record. `code.ts` names the TypeScript driver; `modules` the WASI modules it runs. */
export const SHELL_PROGRAM = {
  kind: "program",
  name: "shell",
  code: { ts: "shell" },
  modules: { brush: MODULES.brush, coreutils: MODULES.coreutils },
  inputs: { cmd: "string", tree: "cid", cwd: "string?", env: "map?" },
  services: ["clock"],
  description: "Run a bash command in the wasm shell over a tree; result {exitCode, stdout, stderr, tree}.",
} as const;

export const SHELL_CID = encode(SHELL_PROGRAM).cid;

export interface ShellArgs {
  cmd: string;
  tree: CID;
  cwd?: string;
  env?: Record<string, string>;
}

export function isShellArgs(x: unknown): x is ShellArgs {
  const a = x as Partial<ShellArgs> | null;
  return !!a && typeof a.cmd === "string" && CID.asCID(a.tree) !== null
    && (a.cwd === undefined || typeof a.cwd === "string")
    && (a.env === undefined || (typeof a.env === "object" && a.env !== null && Object.values(a.env).every((v) => typeof v === "string")));
}

const compiled = new Map<string, Promise<WebAssembly.Module>>();

/** Compile a module from the store by CID (cached per process). Verifies the bytes hash to the CID. */
export function loadModule(blocks: Pick<Blocks, "bytes">, cid: CID): Promise<WebAssembly.Module> {
  const k = cid.toString();
  let m = compiled.get(k);
  if (!m) {
    m = (async () => {
      let bytes: Uint8Array;
      try { bytes = await blocks.bytes(cid); } catch { throw new Error(`module not in store: ${k} (skein-dev install puts it there)`); }
      if (!rawCid(bytes).equals(cid)) throw new Error(`module ${k}: bytes do not match the CID`);
      return WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
    })();
    m.catch(() => compiled.delete(k));
    compiled.set(k, m);
  }
  return m;
}

export async function loadShellModules(blocks: Pick<Blocks, "bytes">): Promise<Modules> {
  const [brush, coreutils] = await Promise.all([loadModule(blocks, MODULES.brush), loadModule(blocks, MODULES.coreutils)]);
  return { brush, coreutils };
}
