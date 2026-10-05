// Vectors for the format-2 unit test (issue #33, src/tests.zig): made by the
// router's TypeScript (src/envelope-cbor.ts, src/host/genesis.ts), checked by
// the kernel (genesis, entries) and src/envelope-vectors.test.ts (the
// envelopes). Writes test/format2.json.
//
//   node --experimental-strip-types --no-warnings kernel-zig/test/format2.ts

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { cborSignedPart, sealCbor } from "../../src/envelope-cbor.ts";
import { genesis2 } from "../../src/host/genesis.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const a = new PrivateKey("11".repeat(32), 16), b = new PrivateKey("22".repeat(32), 16);
const body = dagCbor.encode({ text: "hi" });
const env = await sealCbor(ephemeralWallet(a), { recipient: { identityKey: b.toPublicKey().toString(), handle: "b", domain: "localhost" }, body, created: "2026-09-28T00:00:00.000Z" });
const signed = cborSignedPart(env);
const cid = CID.parse("bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
const programs = { frontdoor: cid, messagebox: cid, resolve: cid };
const g = genesis2({ identity: a.toPublicKey().toString(), owner: b.toPublicKey().toString(), handle: "x", domain: "localhost", infer: b.toPublicKey().toString() }, programs);
const entry2 = { kind: "log", prev: null, n: 0, time: [1, 2], genesis: cid };
const out = {
  envelope: { signed: hex(dagCbor.encode(signed)), full: hex(dagCbor.encode(env)), body: hex(body), ok: true },
  tampered: hex(dagCbor.encode({ ...signed, created: "2000-01-01T00:00:00.000Z" })),
  genesis: hex(dagCbor.encode(g)),
  genesisWithHost: hex(dagCbor.encode({ ...g, host: g.identity })),
  entry: hex(dagCbor.encode(entry2)),
  entrySigned: hex(dagCbor.encode({ ...entry2, sig: new Uint8Array(70) })),
};
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "format2.json"), `${JSON.stringify(out, null, 1)}\n`);
