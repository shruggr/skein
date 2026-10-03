// The pinned modules as the node host names them: the wallet, by the CID of
// its bytes under wasm/. `skein-dev install` puts them into a store file (the
// bootstrap side door, docs/OPEN.md). The kernel's pins are the truth
// (kernel-zig/src/programs.zig, which also pins the handler programs: the
// front door, the messagebox, resolve); a test checks these against the
// committed files. The shell is not pinned (#83): its modules are the shell
// app's (shruggr/skein-shell), installed like any app's, and its program
// record is written by that install (src/host/install.ts shellProgram).

import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { program } from "./records.ts";

export const RAW = 0x55;

/** CIDv1(raw, sha2-256) of a module's bytes: how modules are stored and named. */
export function rawCid(bytes: Uint8Array): CID {
  return CID.createV1(RAW, Digest.create(0x12, createHash("sha256").update(bytes).digest()));
}

/** The modules as committed under wasm/ (see wasm/README.md). A test checks these against the files. */
export const MODULES = {
  // The wallet's state inside the VM (issue #29): Zig, wasm32-wasi (programs/wallet over the SDK's wallet library, built by scripts/build-programs.sh).
  "wallet": CID.parse("bafkreihjdj7o75mnffyk362rzabszndywo4yoyjq4r7yvtmu3cv4ff3qhq"),
} as const;

/**
 * The wallet's state as records (issue #29; docs/WALLET.md): the `wallet`
 * box's handler, written in Zig (programs/wallet, over the SDK's wallet library). Not in a genesis by default:
 * an instance that wants it subscribes a box to its record's CID (an owner's
 * box, and a sender-less box for plain header/proof/status entries).
 */
export const WALLET = program({
  name: "wallet",
  code: { wasm: MODULES.wallet },
  inputs: { envelope: "cid", body: "cid", box: "string", sender: "identity", event: "cid" },
  services: ["wallet", "http"],
  description: "The `wallet` box: wallet state as records. Body {op: headers|internalize|proof|createAction|signAction|list, …}, or a plain header/proof/status entry: validates headers into our chain from the network's genesis, internalizes BRC-29 payments from Atomic BEEF (SPV against our headers), builds and signs spends through the oracle, broadcasts to ARC over http and awaits the status, records merkle proofs, lists outputs; advances the `wallet` head to the new state record; prints the result record's CID.",
});

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
