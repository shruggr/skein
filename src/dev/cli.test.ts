// skein-dev replay: re-derive a store from its log alone, with no wallet,
// and compare it against the live one.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import { bundlesOf, instance, send } from "../testkit.ts";
import { replay } from "./cli.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-cli-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "src"));
  await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
  return dir;
}

test("skein-dev replay: a fresh store rebuilt from the log alone matches state hash, thread tips and head tips", async (t) => {
  const dir = await fixture(t);
  const i = await instance();
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await send(i, "objects", b);
  await send(i, "run", { cmd: "ls", tree: root });
  await i.delivery.poll();
  await i.rt.idle();

  const lines: string[] = [];
  const errs: string[] = [];
  const env = { out: (l: string) => lines.push(l), err: (l: string) => errs.push(l), write: () => {} };
  const code = await replay(i.store, env);
  assert.equal(code, 0, [...lines, ...errs].join("\n"));
  assert.deepEqual(errs, []);
  assert.match(lines[0], /^state\s+\S+ == \S+$/);
  assert.match(lines[1], /^threads (\d+)\/\1 match · heads (\d+)\/\2 match$/);
  assert.ok(!lines[1].startsWith("threads 0/0"), "the fixture launches at least one thread");
});

test("skein-dev replay: a thread tip that drifted from the log (not derivable by replay) is reported and fails", async (t) => {
  const dir = await fixture(t);
  const i = await instance();
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await send(i, "objects", b);
  await send(i, "run", { cmd: "ls", tree: root });
  await i.delivery.poll();
  await i.rt.idle();

  const threads: CID[] = [];
  for await (const th of i.store.edges.query({ kind: "thread" })) threads.push(th);
  assert.ok(threads.length > 0, "the fixture launches at least one thread");
  // An update the log never produced: replay can never reconstruct it, so the tips must differ.
  await i.store.chains.append(threads[0]!, { at: 0, bogus: true });

  const lines: string[] = [];
  const errs: string[] = [];
  const env = { out: (l: string) => lines.push(l), err: (l: string) => errs.push(l), write: () => {} };
  const code = await replay(i.store, env);
  assert.equal(code, 1);
  assert.ok(errs.some((l) => l.startsWith("thread ")), errs.join("\n"));
});
