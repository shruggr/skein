// The pinned modules as the node host names them: the shell's WASI modules
// (brush, uutils coreutils, the toolset, the script runtimes), the wallet, and
// the support files the shell's programs read, each by the CID of its bytes
// under wasm/. `skein-dev install` puts them into a store file (the bootstrap
// side door, docs/OPEN.md). The kernel's pins are the truth
// (kernel-zig/src/programs.zig, which also pins the handler programs); a test
// checks these against the committed files, and the Zig unit tests check the
// shell's program record against the kernel's (kernel-zig/test/fixtures.json).

import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { encode } from "./cid.ts";
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
  // The wallet's state inside the VM (issue #29): Zig, wasm32-wasi (wallet-zig/, built by scripts/build-programs.sh).
  "wallet": CID.parse("bafkreifpnghkfciqsqhar2n5o7xj5qdthpi7gxnsji5nklicyluhtdkxkm"),
  // The toolset of issue #13 — single-purpose WASI programs the shell runs
  // beyond brush/coreutils. find/xargs are two binaries from one build
  // (uutils/findutils); diff and cmp are two names for the one
  // uutils/diffutils multicall binary (same bytes, same CID).
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
  // Script runtimes (issue #25): QuickJS-ng (also run as `node`, a small
  // shim) and CPython on WASI (also `python3`); its stdlib is FILES below.
  qjs: CID.parse("bafkreig4lw4ceuhl5qvzr43ketajajhkexgqmg6et2rpjlx66dvavw6zwe"),
  python: CID.parse("bafkreid5irpih6ehtwxvg2jf556f4bupz2p54c5n746i5r5spxpta2i42m"),
} as const;

/** Support files the shell's programs read (raw blocks, like the modules), each committed as wasm/<name>. */
export const FILES = {
  "python314.zip": CID.parse("bafkreigogn32gek27rar2k5pacj2knivlobbjc6tip25qki3hjr3d2v5ce"),
} as const;

/** The command names of the toolset (issue #13), each mapped to its module in MODULES by the same key. */
const TOOL_NAMES = ["find", "xargs", "diff", "cmp", "jq", "which", "grep", "tree", "awk", "sed", "git", "qjs", "python"] as const;
/** More command names for a module already in TOOL_NAMES (issue #25): `node` is qjs with its node shim (it checks argv[0]). */
const TOOL_ALIASES = { node: "qjs", python3: "python" } as const;
/**
 * Python's stdlib, mounted read-only for python processes only at
 * PYTHON_HOME (a stored zip: the WASI build has no zlib). PYTHONHOME points
 * there; PYTHONDONTWRITEBYTECODE keeps __pycache__ out of the tree.
 */
const PYTHON_HOME = "/opt/skein/python";
const PYTHON_FILES = { "lib/python314.zip": FILES["python314.zip"] } as const;
const PYTHON_ENV = { PYTHONHOME: PYTHON_HOME, PYTHONDONTWRITEBYTECODE: "1" } as const;

/** The `shell` program record (the kernel's programs.zig builds the same bytes): `modules` names the WASI modules it runs. */
export const SHELL_PROGRAM = {
  kind: "program",
  name: "shell",
  code: { ts: "shell" },
  modules: {
    brush: MODULES.brush, coreutils: MODULES.coreutils,
    ...Object.fromEntries(TOOL_NAMES.map((n) => [n, MODULES[n]])),
    ...Object.fromEntries(Object.entries(TOOL_ALIASES).map(([a, n]) => [a, MODULES[n]])),
  },
  support: {
    python: { mount: PYTHON_HOME, files: PYTHON_FILES, env: PYTHON_ENV },
    python3: { mount: PYTHON_HOME, files: PYTHON_FILES, env: PYTHON_ENV },
  },
  inputs: { cmd: "string", tree: "cid", cwd: "string?", env: "map?" },
  services: [],
  description: "Run a bash command in the wasm shell over a tree; result {exitCode, stdout, stderr, tree}.",
} as const;

export const SHELL_CID = encode(SHELL_PROGRAM).cid;

/**
 * The wallet's state as records (issue #29; docs/WALLET.md): the `wallet`
 * box's handler, written in Zig (wallet-zig/). Not in a genesis by default:
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
