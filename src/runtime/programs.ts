// The programs this runtime starts with. `shell` is the wasm shell (brush +
// uutils coreutils) driven from TypeScript; its record names the two WASI
// modules by CID. `run-handler`, `objects-handler`, `head-handler`, `subscribe-handler` and `loop` are handler programs
// (Go, GOOS=wasip1; programs/, built by scripts/build-programs.sh) stepped
// through the `skein` imports (program.ts). The runtime loads every module
// from the store by CID and never from a disk; `skein-dev install` puts the
// bytes there (the bootstrap side door, docs/OPEN.md). Until then a thread
// errors "module not in store".

import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { encode } from "./cid.ts";
import type { Modules } from "./shell.ts";
import type { Blocks } from "./store.ts";
import { program } from "./records.ts";

export const RAW = 0x55;

/** CIDv1(raw, sha2-256) of a module's bytes: how modules are stored and named. */
export function rawCid(bytes: Uint8Array): CID {
  return CID.createV1(RAW, Digest.create(0x12, createHash("sha256").update(bytes).digest()));
}

/** The modules as committed under wasm/ (see wasm/README.md). A test checks these against the files. */
export const MODULES = {
  brush: CID.parse("bafkreiemwcli2372geseu7l527ivxwjodogng7zoltixf6pfh5ujnpauc4"),
  coreutils: CID.parse("bafkreidohpuc5gyi4xroxlhc367ry5hkpixtabc7sln2tidedeqbwcgese"),
  "run-handler": CID.parse("bafkreiawt6fpfgcnjokta75shlzu7ej3o3jzyon2bqhdu3q5gl7gywezjm"),
  "objects-handler": CID.parse("bafkreid6muh6uqwhrouywofov75uubrpv26ykojydfb5j2x5abpb342al4"),
  "head-handler": CID.parse("bafkreibffmjtkr6q7xalmzia3uzant7kyt6orrpx5l76tbmnmz2wmmso7q"),
  "subscribe-handler": CID.parse("bafkreiclc5brxmakpcaky4asqz4a5sjxuftiir5zfrj7h7lyeabkktmz2e"),
  "loop": CID.parse("bafkreibucy775ondafg447omm5735b6o3ggeas7ggrrqjfpiwtajs4fiuu"),
  // The wallet's state inside the VM (issue #29): Zig, wasm32-wasi (wallet-zig/, built by scripts/build-programs.sh).
  "wallet": CID.parse("bafkreibcgstrnbzzrjii3unfynwt3tj6jo26qe4i5ktiueh7fc6brxke24"),
  // The toolset of issue #13 — single-purpose WASI programs the shell runs
  // beyond brush/coreutils (Modules.extra in shell.ts). find/xargs are two
  // binaries from one build (uutils/findutils); diff and cmp are two names
  // for the one uutils/diffutils multicall binary (same bytes, same CID).
  find: CID.parse("bafkreib7nn5j3hys3m2ux5mzwxnesqzspfou2lng5jcudvnps3g5kpv4bu"),
  xargs: CID.parse("bafkreiaizwk5lqff2b23kpovpsglmct5xconf7n45zlzekyplvnjjjqgju"),
  diff: CID.parse("bafkreifhra2rwueqtn3pqjpjfmobhd6dcijhexr46eyfcnr5hs3gmebv6i"),
  cmp: CID.parse("bafkreifhra2rwueqtn3pqjpjfmobhd6dcijhexr46eyfcnr5hs3gmebv6i"),
  jq: CID.parse("bafkreih226yv4dcowahyziroqms5r6h4k7mliutf2kpjp3klofcskdg56e"),
  which: CID.parse("bafkreicdmerbpermjjw5x26pjokqhwbwbsncfqgdw63zo2e2g6tmm43iye"),
  grep: CID.parse("bafkreihbm7x5gatusjkpo7oxwkh43ltpv7osaw4jaiia46hzl7ua64dvye"),
  tree: CID.parse("bafkreiaubyrhpjhf2n6owdq4xtdemxfu6bbfzs3dcsssjhxnoovsw67yh4"),
  awk: CID.parse("bafkreibop3tyl52wkntqcxwgy5ub2ybfs2hwl725tiixxtinrxlmblhlju"),
  sed: CID.parse("bafkreidwtqxsblyapruappd2uuffd633ti6zgizh5giwiscl34lbuctzcy"),
  // Real git 2.55.0 for wasm32-wasip1 (issue #2; wasm/README.md "git"): its
  // .git/objects is the synthetic object directory of the Zig kernel.
  git: CID.parse("bafkreiak3i7snop2xhiyilewrhcm5jgdjpfwuzk5awjqhd2hafzttwwrxe"),
} as const;

/** The command names of the toolset (issue #13), each mapped to its module in MODULES by the same key. */
const TOOL_NAMES = ["find", "xargs", "diff", "cmp", "jq", "which", "grep", "tree", "awk", "sed", "git"] as const;

/** The `shell` program record. `code.ts` names the TypeScript driver; `modules` the WASI modules it runs. */
export const SHELL_PROGRAM = {
  kind: "program",
  name: "shell",
  code: { ts: "shell" },
  modules: {
    brush: MODULES.brush, coreutils: MODULES.coreutils,
    ...Object.fromEntries(TOOL_NAMES.map((n) => [n, MODULES[n]])),
  },
  inputs: { cmd: "string", tree: "cid", cwd: "string?", env: "map?" },
  services: [],
  description: "Run a bash command in the wasm shell over a tree; result {exitCode, stdout, stderr, tree}.",
} as const;

export const SHELL_CID = encode(SHELL_PROGRAM).cid;

/** A handler program: a WASI module stepped with the `skein` imports. */
export const RUN_HANDLER = program({
  name: "run-handler",
  code: { wasm: MODULES["run-handler"] },
  inputs: { envelope: "cid", body: "cid", box: "string", sender: "identity" },
  services: [],
  description: "The `run` box: read the body {cmd, tree?, cwd?, env?} (no tree: `main`'s, else the empty tree), run the shell over it, reply in `results`.",
});

export const OBJECTS_HANDLER = program({
  name: "objects-handler",
  code: { wasm: MODULES["objects-handler"] },
  inputs: { envelope: "cid", body: "cid", box: "string", sender: "identity" },
  services: [],
  description: "The `objects` box: read the bundle {records: [{cid, bytes}], root?}, store each record; a root becomes `main` if there is none.",
});

export const HEAD_HANDLER = program({
  name: "head-handler",
  code: { wasm: MODULES["head-handler"] },
  inputs: { envelope: "cid", body: "cid", box: "string", sender: "identity" },
  services: [],
  description: "The `head` box: read the body {name, tree}, advance the named head to the tree.",
});

export const SUBSCRIBE_HANDLER = program({
  name: "subscribe-handler",
  code: { wasm: MODULES["subscribe-handler"] },
  inputs: { envelope: "cid", body: "cid", box: "string", sender: "identity" },
  services: [],
  description: "The `subscribe` box: read the body {op, sender?, box, handler}, add or remove the subscription (sender, box) → handler (a program record in the store).",
});

export const LOOP = program({
  name: "loop",
  code: { wasm: MODULES.loop },
  inputs: { envelope: "cid", body: "cid", box: "string", sender: "identity" },
  services: ["infer", "outcomes"],
  description: "The `chat` box: the turn loop. Prompt from the tree's SOUL.md; keeps each turn; asks the `infer` peer; runs `bash` tool calls in the shell and `message` calls as a `chat` to another party (a reply, if the thread already talks with them), resting on their reply; answers the opener with a `chat` reply and awaits theirs.",
});

/**
 * The wallet's state as records (issue #29, phase 1; docs/WALLET.md): the
 * `wallet` box's handler, written in Zig (wallet-zig/). Not in a genesis by
 * default: an instance that wants it subscribes a box to WALLET_CID. Its one
 * attested call is getPublicKey (BRC-29 payee key); it never signs.
 */
export const WALLET = program({
  name: "wallet",
  code: { wasm: MODULES.wallet },
  inputs: { envelope: "cid", body: "cid", box: "string", sender: "identity" },
  services: ["wallet"],
  description: "The `wallet` box: wallet state as records. Body {op: checkpoint|headers|internalize|proof|list, …}: validates headers into our chain, internalizes BRC-29 payments from Atomic BEEF (SPV against our headers), records merkle proofs, lists outputs; advances the `wallet` head to the new state record; prints the result record's CID.",
});
export const WALLET_CID = encode(WALLET).cid;

/** The programs a genesis names, by name. */
export const PROGRAMS = { shell: SHELL_PROGRAM, "run-handler": RUN_HANDLER, "objects-handler": OBJECTS_HANDLER, "head-handler": HEAD_HANDLER, "subscribe-handler": SUBSCRIBE_HANDLER, loop: LOOP } as const;
export const PROGRAM_CIDS: Record<keyof typeof PROGRAMS, CID> = {
  shell: SHELL_CID,
  "run-handler": encode(RUN_HANDLER).cid,
  "objects-handler": encode(OBJECTS_HANDLER).cid,
  "head-handler": encode(HEAD_HANDLER).cid,
  "subscribe-handler": encode(SUBSCRIBE_HANDLER).cid,
  loop: encode(LOOP).cid,
};

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
  const [brush, coreutils, ...tools] = await Promise.all([
    loadModule(blocks, MODULES.brush),
    loadModule(blocks, MODULES.coreutils),
    ...TOOL_NAMES.map((n) => loadModule(blocks, MODULES[n])),
  ]);
  const extra = Object.fromEntries(TOOL_NAMES.map((n, i) => [n, tools[i]]));
  return { brush, coreutils, extra };
}
