// Program records and module CIDs as the node host makes them. The kernel's
// pins are the truth (kernel-zig/src/programs.zig: the front door, the mail
// program, resolve). The shell is not pinned (#83): its modules are the shell
// app's (shruggr/skein-shell), installed like any app's, and its program
// record is written by that install (src/host/install.ts shellProgram).

import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

export const RAW = 0x55;

/** CIDv1(raw, sha2-256) of a module's bytes: how modules are stored and named. */
export function rawCid(bytes: Uint8Array): CID {
  return CID.createV1(RAW, Digest.create(0x12, createHash("sha256").update(bytes).digest()));
}

/** A wasm binary's kind by its preamble: a core module, a component (#34), or neither. */
export function wasmKind(b: Uint8Array): "module" | "component" | undefined {
  if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return undefined;
  if (b[4] === 1 && b[5] === 0 && b[6] === 0 && b[7] === 0) return "module";
  if (b[4] === 0x0d && b[5] === 0 && b[6] === 1 && b[7] === 0) return "component";
  return undefined;
}

/** A handler program's record inputs when bin/<name>.json gives none (the kernel's handler inputs). */
const HANDLER_INPUTS = { message: "cid", body: "cid", box: "string", sender: "identity" };

/**
 * The program record for bin/<name>.wasm or bin/<name>.cid (its module's CID),
 * with bin/<name>.json's {inputs, services, description} if the tree has one:
 * what a boot puts, and what an app install (install.ts, #72) sends.
 */
export function programRecord(name: string, module: CID, meta: { inputs?: unknown; services?: string[]; description?: string } = {}): Record<string, unknown> {
  return {
    kind: "program", name, code: { wasm: module },
    inputs: meta.inputs ?? HANDLER_INPUTS, services: meta.services ?? [], description: meta.description ?? `${name} (from the system tree)`,
  };
}
