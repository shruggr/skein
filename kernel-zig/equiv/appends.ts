// The kernel appends (#163): the host hands over an arrival's body and its
// stamp, and the kernel assigns its `prev` and `n` on admit. N arrivals into
// one instance at once — none queued behind another on the host side (the
// router's `serial` is bypassed: the kernel's own `admit`, as the HTTP front
// door and libp2p inbound call it) — on the per-process kernel (`serve`, a
// SQLite file) and on the one-process kernel (`skein-kernel host`, a RocksDB
// set). Each run: all N land, the log's `n` strictly increasing from the
// genesis with each `prev` the entry before, every arrival's record named by
// exactly one entry (no record block left without its entry: before #163 the
// loser of a race had its record stored and its entry refused), and a frame
// naming `prev`/`n` refused.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/appends.ts

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { encode } from "../../src/runtime/cid.ts";
import type { Stamp } from "../../src/runtime/syscalls.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Router } from "../../src/host/router.ts";
import { fakeDiscovery } from "../../src/host/fake-discovery.ts";
import { Signer } from "../../src/host/signer.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const N = Number(process.env.SKEIN_EQUIV_APPENDS_N ?? 200);
const TIME: Stamp = [1_800_000_000, 0];

type Entry = { kind: string; prev: CID | null; n: number; time: Stamp; event?: CID; genesis?: CID };

async function run(backend: "sqlite" | "rocksdb"): Promise<void> {
  const home = await fs.mkdtemp(join(tmpdir(), `skein-kz-appends-${backend}-`));
  const db = new HostDb(join(home, "host.db"));
  const key = new PrivateKey("a99e4d5", 16);
  const rocks = join(home, "store-rocksdb");
  db.add("app", { store: backend === "rocksdb" ? `rocksdb:${rocks}` : join(home, "instances", "app", "runtime.db"), identity: key.toPublicKey().toString(), domain: "localhost" });
  const router: Router = new Router({
    db, walletFor: () => ephemeralWallet(key), home, idleMs: 0, port: 4998, now: () => TIME,
    owner: new PrivateKey("0bee", 16).toPublicKey().toString(), providerKeyFor: (x) => new Signer(new PrivateKey("a77e57", 16)).providerKey(x),
    discovery: fakeDiscovery(db, () => router), cron: false,
    kernel: { command: kernel, env: { SKEIN_HOME: home } },
    ...(backend === "rocksdb" ? { rocksStore: rocks } : {}),
    log: (s, l) => { if (process.env.VERBOSE) process.stdout.write(`  | [${s}] ${l}\n`); },
  });
  try {
    const l = await router.hydrate("app");
    await router.settled();
    const k = l.kernel;
    const base = (await k.store.get((await k.store.log.tip())!)) as unknown as Entry;
    // N arrivals at once, each with its own record beside it (the door puts it), none queued on the host side.
    // The stamps run backwards (the host's clock behind the tip): the kernel raises each to its tip's.
    const records = Array.from({ length: N }, (_, i) => ({ kind: "arrival", i, backend }));
    const t0 = performance.now();
    const got = await Promise.allSettled(records.map((r, i) => k.admit({ box: "arrivals", event: encode(r).cid }, { event: r }, [TIME[0] + N - i, 0])));
    const ms = performance.now() - t0;
    await router.settled();
    const failed = got.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    check(failed.length === 0, `${backend}: ${N} concurrent admits, all answered with an entry (${ms.toFixed(0)} ms)${failed.length ? `: ${failed.length} refused, e.g. ${(failed[0].reason as Error).message}` : ""}`);
    // Walk the log back from the tip.
    const chain: Array<{ cid: CID; e: Entry }> = [];
    for (let c: CID | null | undefined = await k.store.log.tip(); c; ) {
      const e = await k.store.get(c) as unknown as Entry;
      chain.unshift({ cid: c, e });
      c = e.prev;
    }
    check(chain[0]?.e.n === 0 && !!chain[0]?.e.genesis, `${backend}: the log walks back to its genesis (${chain.length} entries)`);
    check(chain.every((x, i) => x.e.n === i && (i === 0 ? x.e.prev === null : x.e.prev!.equals(chain[i - 1].cid))), `${backend}: n strictly increasing by one, each prev the entry before`);
    const tail = chain.filter((x) => x.e.n > base.n);
    check(tail.length === N, `${backend}: ${N} new entries after the tip at #${base.n} (${tail.length})`);
    const stampNs = (s: Stamp) => BigInt(s[0]) * 1_000_000_000n + BigInt(s[1]);
    check(chain.every((x, i) => i === 0 || stampNs(x.e.time) >= stampNs(chain[i - 1].e.time)), `${backend}: stamps never before the entry before (the kernel raised a stamp behind its tip)`);
    const named = new Map<string, number>();
    for (const x of tail) if (x.e.event) named.set(x.e.event.toString(), (named.get(x.e.event.toString()) ?? 0) + 1);
    const ids = records.map((r) => encode(r).cid);
    check(ids.every((c) => named.get(c.toString()) === 1), `${backend}: every arrival's record named by exactly one entry (no record without its entry)`);
    check(got.every((x, i) => x.status === "fulfilled" && tail.some((t) => t.cid.equals(x.value) && t.e.event!.equals(ids[i]))), `${backend}: each admit answered the CID of the entry naming its record`);
    let present = 0;
    for (const c of ids) if (await k.store.has(c)) present++;
    check(present === N, `${backend}: every record's block in the store (${present}/${N})`);
    // One way in: a frame that names prev or n is refused, nothing written.
    const tip = await k.store.log.tip();
    const extra = { kind: "arrival", i: -1, backend };
    for (const field of ["prev", "n"] as const) {
      const body = { box: "arrivals", event: encode(extra).cid, ...(field === "prev" ? { prev: tip } : { n: 999 }) };
      const r = await k.call("admit", { entry: { ...body, time: TIME }, event: extra }).then(() => "admitted", (e: Error) => e.message);
      check(/is the kernel's to write/.test(r), `${backend}: an admit frame naming \`${field}\` refused (${r})`);
    }
    check((await k.store.log.tip())!.equals(tip!), `${backend}: … nothing written`);
    process.stdout.write(`timing: ${backend}: ${N} concurrent admits ${ms.toFixed(0)} ms\n`);
  } finally {
    await router.stop();
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  }
}

for (const b of (process.env.SKEIN_EQUIV_APPENDS_BACKENDS ?? "sqlite,rocksdb").split(",") as Array<"sqlite" | "rocksdb">) await run(b);
process.stdout.write(failures ? `${failures} FAILED\n` : "all ok\n");
process.exit(failures ? 1 : 0);
