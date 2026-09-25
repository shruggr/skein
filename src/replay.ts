// Replay: the determinism check from docs/VM.md. Feed an instance's log, in
// order, to a fresh runtime with no services and the same wallet; every chain
// must come out byte-identical. Service replies are already in the log, and
// the messages the runtime emits are recognised by CID as ones it has just
// produced again. A message the log has at a (from, seq) the replay produced
// differently is a divergence and throws.

import type { WalletInterface } from "@bsv/sdk";
import { fmt } from "./cid.ts";
import { memoryStore } from "./memory.ts";
import { initInstance, type InstanceOptions } from "./instance.ts";
import { isGenesis, type Message, type Program } from "./records.ts";
import { Runtime } from "./runtime.ts";
import { Rejected, type Store } from "./store.ts";

export class Diverged extends Error {}

export async function replay(messages: Message[], programs: Program[], wallet: WalletInterface, o: Omit<InstanceOptions, "at" | "runtime"> = {}): Promise<Store> {
  const store = memoryStore();
  for (const p of programs) await store.put(p);
  const rt = new Runtime(store, { wallet, services: [], log: () => {} });
  const g = messages.find((m) => isGenesis(m.body));
  await initInstance(store, wallet, { ...o, at: g ? (g.body as { at: number }).at : undefined, runtime: rt });
  for (const [i, m] of messages.entries()) {
    try {
      await rt.ingest(m);
    } catch (e) {
      if (e instanceof Rejected && e.reason === "duplicate-seq") throw new Diverged(`log message ${i} (${e.message}): replay produced a different record at that seq`);
      throw e;
    }
  }
  await rt.idle();
  return store;
}

/** An instance's log as records, in order. */
export async function logOf(store: Store): Promise<Message[]> {
  const out: Message[] = [];
  for await (const { cid } of store.log()) out.push(await store.get<Message>(cid));
  return out;
}

/** Chains whose tips differ between `a` and `b` (threads and nodes of `a`), as "origin: tipA ≠ tipB". Empty = identical. */
export async function tipDiff(a: Store, b: Store): Promise<string[]> {
  const out: string[] = [];
  for (const kind of ["thread", "node"] as const) {
    for await (const origin of a.edges.query({ kind })) {
      const ta = await a.chains.tip(origin);
      const tb = await b.chains.tip(origin).catch(() => undefined);
      if (!tb || !tb.equals(ta)) out.push(`${kind} ${fmt(origin)}: ${fmt(ta)} ≠ ${tb ? fmt(tb) : "missing"}`);
    }
  }
  return out;
}
