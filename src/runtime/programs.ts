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
  "wallet": CID.parse("bafkreidvaavm5dzyacfnjwizqyoi4hgcmljadxbatwevftmzhdv4xlsf3e"),
} as const;

/** The wallet program record's description (also the default image's bin/wallet.json: the same record, #116). */
export const WALLET_DESCRIPTION = "The wallet (#29, #79, #116: core): its own records under wallet/ over the chain app's chain/state. A message's body {op: internalize|createAction|signAction|list, …} (BRC-100's; every transaction ingested at the chain app); the kernel's pay step, args {pay: {to, x, checkpoint}} (#130: X sats, or all it has if less, to the host, the state record committed in a 0-sat OP_RETURN output, emitted as the event `payment`). Prints the result record's CID.";

/**
 * The wallet's state as records (issue #29; docs/WALLET.md): the `wallet`
 * box's handler, written in Zig (programs/wallet, over the SDK's wallet library). In the default image
 * by CID (#116, #130: images/default/bin/wallet.cid and wallet.json — this very record): every skein made
 * from it pays its host from it. A code genesis has none: an instance that wants it subscribes a box to
 * its record's CID (an owner's box).
 */
export const WALLET = program({
  name: "wallet",
  code: { wasm: MODULES.wallet },
  inputs: { envelope: "cid", body: "cid", box: "string", sender: "identity", event: "cid" },
  services: ["wallet", "http"],
  description: WALLET_DESCRIPTION,
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
