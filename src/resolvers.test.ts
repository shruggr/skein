import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encode, fmt } from "./cid.ts";
import { createResolvers } from "./resolvers.ts";
import { openStore } from "./sqlite.ts";

test("resolvers: skein, file, unknown scheme, custom", async () => {
  const s = openStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "skein-"));
  try {
    const r = createResolvers(s);
    const value = { kind: "page", markdown: "# hi" };
    const cid = await s.put(value);

    const got = await r.resolve(`skein://${fmt(cid)}#L1`);
    assert.ok(got.ok);
    assert.deepEqual(got.bytes, encode(value).bytes);
    assert.equal(got.contentType, "application/vnd.ipld.dag-cbor");
    assert.ok((await r.resolve(`skein:${fmt(cid)}`)).ok);

    const absent = await r.resolve(`skein://${fmt(encode({ nope: 1 }).cid)}`);
    assert.ok(!absent.ok && absent.reason === "not-found");
    const bad = await r.resolve("skein://garbage");
    assert.ok(!bad.ok && bad.reason === "not-found");

    const file = join(dir, "a.txt");
    writeFileSync(file, "hello");
    const f = await r.resolve(pathToFileURL(file));
    assert.ok(f.ok && new TextDecoder().decode(f.bytes) === "hello");
    const nf = await r.resolve(pathToFileURL(join(dir, "missing")));
    assert.ok(!nf.ok && nf.reason === "not-found");

    const u = await r.resolve("git-raw:abc");
    assert.ok(!u.ok && u.reason === "unknown-scheme");

    r.register("git-raw:", async () => { throw new Error("offline"); });
    const down = await r.resolve("git-raw:abc");
    assert.ok(!down.ok && down.reason === "unreachable" && down.message === "offline");
  } finally {
    await s.close(); rmSync(dir, { recursive: true, force: true });
  }
});
