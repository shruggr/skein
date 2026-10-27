// equiv/lmdb.ts's direct hand on an LMDB environment (#96, #133), in a
// process of its own (LMDB: one open of an environment per process; the
// driver's own process reads it through src/host/stores.ts).
//
//   lmdb-env.ts chain-put <env dir> <cid hex> <bytes hex>   a block under the chain's set, host/chain (what the
//                                                             host's chain service will write, #156; nothing else does)
//   lmdb-env.ts sizes <env dir> <set>…                      per set: its size counter, and the sum of its members' bytes
//
// The test's only writer besides the kernels. lmdb-js's data-v1 build (LMDB 0.9.x).

import { createRequire } from "node:module";

const lmdb = createRequire(import.meta.url)("lmdb") as { open(o: Record<string, unknown>): { openDB(o: Record<string, unknown>): Db; close(): Promise<void> } };
type Db = { get(k: Uint8Array): Buffer | undefined; doesExist(k: Uint8Array): boolean; putSync(k: Uint8Array, v: Uint8Array): void; getKeys(o: { start: Uint8Array; end: Uint8Array }): Iterable<Buffer> };
const [cmd, dir, ...rest] = process.argv.slice(2);
const env = lmdb.open({ path: dir, noSubdir: false, maxDbs: 4, maxReaders: 4096, mapSize: 2 ** 40, overlappingSync: false, readOnly: cmd !== "chain-put" });
const db = (name: string) => env.openDB({ name, encoding: "binary", keyEncoding: "binary" });
const blocks = db("blocks"), members = db("members"), pointers = db("pointers");
const prefix = (set: string) => Buffer.concat([Buffer.from(set), Buffer.from([0])]);

if (cmd === "chain-put") {
  const [cidHex, bytesHex] = rest;
  const cid = Buffer.from(cidHex!, "hex"), bytes = Buffer.from(bytesHex!, "hex");
  if (!blocks.doesExist(cid)) blocks.putSync(cid, bytes);
  members.putSync(Buffer.concat([prefix("host/chain"), cid]), Buffer.alloc(0));
  process.stdout.write("ok\n");
} else if (cmd === "sizes") {
  const out: Record<string, { size: number; sum: number; members: number }> = {};
  for (const set of rest) {
    const p = prefix(set);
    const end = Buffer.from(p); end[end.length - 1]++;
    let sum = 0, n = 0;
    for (const k of members.getKeys({ start: p, end })) { n++; sum += blocks.get(k.subarray(p.length))?.length ?? 0; }
    const s = pointers.get(Buffer.concat([p, Buffer.from("size")]));
    out[set] = { size: s ? Number(s.readBigUInt64BE(0)) : 0, sum, members: n };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
} else {
  process.stderr.write("usage: lmdb-env.ts chain-put <dir> <cid hex> <bytes hex> | sizes <dir> <set>…\n");
  process.exit(2);
}
await env.close();
