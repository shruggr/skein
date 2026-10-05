// Fixtures for the Zig kernel's unit tests (src/tests.zig; the envelope by
// src/envelope-vectors.test.ts), made by the
// TypeScript formats (src/runtime): dag-cbor encodings and CIDs, the canonical
// form of non-canonical input, "anyone" signatures (log entries, envelopes),
// JCS, the entropy stream, a shell program record's shape (#83), the fixed origins
// (#77: the dispatch chain's). Regenerate with
//   node --experimental-strip-types --no-warnings kernel-zig/test/fixtures.ts > kernel-zig/test/fixtures.json
// (the keys are fixed, so the output is stable).

import { PrivateKey } from "@bsv/sdk";
import * as cborg from "cborg";
import { CID } from "multiformats/cid";
import { decode, encode } from "../../src/runtime/cid.ts";
import { canonical, jcs, verify } from "../../src/runtime/envelope.ts";
import { sign } from "../../src/envelope.ts";
import { signAnyone, verifyAnyone } from "../../src/runtime/identity.ts";
import { entryBytes, LOG_KEY_ID, LOG_PROTOCOL } from "../../src/runtime/log.ts";
import { MODULES, WALLET } from "../../src/runtime/programs.ts";
import { headOrigin } from "../../src/runtime/heads.ts";
import { dispatchOrigin } from "../../src/runtime/dispatch.ts";
import { entropy } from "../../src/runtime/syscalls.ts";
import { EMPTY_TREE } from "../../src/runtime/tree.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// A shell program record's shape (#83: the shell app's install writes one; src/host/install.ts shellProgram), over a stand-in module.
const SHELL_PROGRAM = {
  kind: "program", name: "shell", code: { ts: "shell" },
  modules: { brush: MODULES.wallet, coreutils: MODULES.wallet, node: MODULES.wallet },
  support: { python: { mount: "/opt/skein/python", files: { "lib/python314.zip": MODULES.wallet }, env: { PYTHONHOME: "/opt/skein/python", PYTHONDONTWRITEBYTECODE: "1" } } },
  inputs: { cmd: "string", tree: "cid", cwd: "string?", env: "map?" }, services: [],
  description: "Run a bash command in the wasm shell over a tree; result {exitCode, stdout, stderr, tree}.", app: "shell",
};
const SHELL_CID = encode(SHELL_PROGRAM).cid;

const values: unknown[] = [
  null, true, false, 0, 1, -1, 23, 24, 255, 256, 65535, 65536, 2 ** 32, 2 ** 53 - 1, -(2 ** 53) + 1, 1.5, -0.25, 1e300, 2 ** 53, 0.1,
  "", "a", "héllo ☃ 𝄞", new Uint8Array([0, 1, 2, 255]), [1, [2, [3]]], {},
  { b: 1, a: 2, aa: 3, "": 4, "é": 5, z: { y: [null, "x"] } },
  { kind: "log", prev: null, n: 0, time: [1_790_000_000, 250_000_000], genesis: MODULES.wallet, sig: new Uint8Array([48, 1]) },
  SHELL_PROGRAM, WALLET,
];

const cbor = values.map((v) => { const { cid, bytes } = encode(v); return { hex: hex(bytes), cid: cid.toString() }; });

// Non-canonical input a program might hand `put`: unsorted keys, floats that
// are integers, float16/32, undefined, long-form lengths → what the TS put() stores.
const raw: Uint8Array[] = [
  cborg.encode({ z: 1, a: 2 }, { mapSorter: () => 0 }),
  Uint8Array.from([0xfb, 0x40, 0x08, 0, 0, 0, 0, 0, 0]),                   // 3.0 as float64
  Uint8Array.from([0xf9, 0x3e, 0x00]),                                      // 1.5 as float16
  Uint8Array.from([0xfa, 0x3f, 0xc0, 0, 0]),                                // 1.5 as float32
  Uint8Array.from([0xfb, 0x80, 0, 0, 0, 0, 0, 0, 0]),                       // -0.0
  Uint8Array.from([0xa1, 0x61, 0x78, 0xf7]),                                // {x: undefined}
  Uint8Array.from([0x1b, 0x00, 0x20, 0, 0, 0, 0, 0, 0]),                    // 2^53 (a BigInt in JS)
  Uint8Array.from([0x63, 0x61, 0xff, 0x62]),                                // invalid UTF-8
];
const normalize = raw.map((b) => ({ in: hex(b), out: hex(encode(decode(b)).bytes) }));
const reject = [
  Uint8Array.from([0x18, 0x01]),               // non-minimal int
  Uint8Array.from([0x9f, 0xff]),               // indefinite array
  Uint8Array.from([0xc1, 0x00]),               // tag 1
  Uint8Array.from([0xa2, 0x61, 0x61, 1, 0x61, 0x61, 2]), // duplicate key
  Uint8Array.from([0x01, 0x02]),               // trailing bytes
  Uint8Array.from([0xf9, 0x7e, 0x00]),         // NaN
].map((b) => { let ok = true; try { decode(b); } catch { ok = false; } if (ok) throw new Error(`expected reject ${hex(b)}`); return hex(b); });

// "anyone" signatures by fixed keys.
const hostKey = new PrivateKey(0x1234567n.toString(16), 16);
const host = ephemeralWallet(hostKey);
const hostId = (await host.getPublicKey({ identityKey: true })).publicKey;
const entry = { kind: "log" as const, prev: null, n: 0, time: [1_790_000_000, 250_000_000] as [number, number], genesis: SHELL_CID };
const eb = entryBytes(entry as never);
const esig = await signAnyone(host, LOG_PROTOCOL, LOG_KEY_ID, eb);
const signatures = [
  { identity: hostId, level: 2, name: "skein log", keyId: "1", data: hex(eb), sig: hex(esig), ok: verifyAnyone(hostId, LOG_PROTOCOL, LOG_KEY_ID, eb, esig) },
  { identity: hostId, level: 2, name: "skein log", keyId: "1", data: hex(eb.map((x, i) => (i === 3 ? x ^ 1 : x))), sig: hex(esig), ok: false },
];

const inst = ephemeralWallet(new PrivateKey(0x7654321n.toString(16), 16));
const rcpt = (await ephemeralWallet(new PrivateKey(0x99n.toString(16), 16)).getPublicKey({ identityKey: true })).publicKey;
const body = encode({ text: "hi", replyTo: SHELL_CID }).bytes;
const signed = await sign(inst, { recipient: { identityKey: rcpt, handle: "david", domain: "localhost" }, sender: { handle: "skein", domain: "localhost" }, body, created: "2026-09-27T12:00:00.000Z" });
const envelope = { signed: hex(encode(signed).bytes), jcs: canonical(signed), ok: verify(signed) };

const jcsCases = [{ b: [1, 2.5, "x\n\u0001\"\\"], a: null, "é": true, "\u{1D11E}": 1, "": 2 }].map((v) => ({ hex: hex(encode(v).bytes), jcs: jcs(v) }));

const e1 = CID.parse("bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
const ent = { entry: e1.toString(), thread: SHELL_CID.toString(), bytes: hex(entropy(e1, SHELL_CID)(100)) };

const cids = {
  headMain: headOrigin("main").toString(),
  dispatch: dispatchOrigin().toString(),
  emptyTree: EMPTY_TREE.toString(),
};

process.stdout.write(JSON.stringify({ cbor, normalize, reject, signatures, envelope, jcs: jcsCases, entropy: ent, cids }, null, 1) + "\n");
