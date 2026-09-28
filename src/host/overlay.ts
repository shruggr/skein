// The overlay wire contract on the router (issue #36): BRC-22 submit and
// BRC-24 lookup, and the TS overlay engine's listing/documentation routes,
// answered by the instances that serve them (programs/overlay). Unauthenticated,
// as overlay-express is.
//
//   POST /submit      body BEEF (application/octet-stream), X-Topics (comma list or JSON array),
//                     x-includes-off-chain-values: true → VarInt(len) ‖ BEEF ‖ off-chain values
//                     → the STEAK {topic: {outputsToAdmit, coinsToRetain, coinsRemoved}}
//   POST /lookup      {service, query} (JSON) → {type: "output-list", outputs: [{beef, outputIndex, context?}]}
//                     X-Aggregation: yes → the compact octet-stream form (count, [txid, index, context], BEEF)
//   GET  /listTopicManagers, /listLookupServiceProviders            {name: {name, shortDescription}}
//   GET  /getDocumentationForTopicManager?manager=…, /getDocumentationForLookupServiceProvider?lookupService=…
//
// Which instance serves what is its genesis config (etc/config.json of its
// system tree): defaults.overlayTopics / overlayLookups, JSON {name: program}.
// A request is one plain entry into each serving instance — {kind: "submit",
// beef, topics, offChainValues?} in box `submit`, {kind: "lookup", service,
// query} in box `lookup` — admitted, run to rest (`idle`), and answered from
// the result record the thread it launched keeps (the store read beside the
// kernel, as the explorer does). Documentation and listings are the program
// records' `description` (bin/<name>.json), read without running anything.
// Not built: BRC-88 SHIP/SLAP advertisement, sync between overlay nodes (GASP).

import type { IncomingMessage, ServerResponse } from "node:http";
import { Beef, Utils } from "@bsv/sdk";
import type { CID } from "multiformats/cid";
import { CID as CIDClass } from "multiformats/cid";
import { decode } from "../runtime/cid.ts";
import { openStoreFile } from "../runtime/index-store.ts";
import { send, type AppResponse } from "./auth.ts";
import { admit2 } from "./genesis.ts";
import type { Kernel } from "./kernel.ts";
import type { Router } from "./router.ts";

type Obj = Record<string, unknown>;
interface Served { topics: Record<string, string>; lookups: Record<string, string>; programs: Record<string, CID> }

const error = (status: number, message: string): AppResponse => ({ status, body: { status: "error", message } });

/** X-Topics: a JSON array of names, or (the SDK's form) a comma-separated list. */
export function parseTopics(header: string): string[] {
  const v = header.trim();
  const parsed: unknown = v.startsWith("[") ? JSON.parse(v) : v.split(",").map((t) => t.trim());
  if (!Array.isArray(parsed) || parsed.some((t) => typeof t !== "string" || !t)) throw new Error("Invalid x-topics header: expected a comma-separated list or JSON string array");
  return parsed as string[];
}

/** JSON → dag-cbor-safe: integers stay numbers; non-integral numbers are refused (dag-cbor floats are not canonical here). */
function cborSafe(v: unknown): unknown {
  if (typeof v === "number" && !Number.isInteger(v)) throw new Error("the query has a non-integral number");
  if (Array.isArray(v)) return v.map(cborSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, cborSafe(x)]));
  return v;
}

export class OverlayRoutes {
  private readonly served = new Map<string, Served>();
  private readonly views = new Map<string, ReturnType<typeof openStoreFile>>();
  private readonly router: Router;
  constructor(router: Router) { this.router = router; }

  close(): void { for (const v of this.views.values()) v.close(); this.views.clear(); }

  /** What an instance serves (its genesis: immutable, so read once). */
  private async servedBy(handle: string): Promise<Served> {
    const had = this.served.get(handle);
    if (had) return had;
    const k = (await this.router.hydrate(handle)).kernel;
    const g = await k.genesis() as { defaults?: Record<string, string>; programs?: Record<string, CID> };
    const json = (s?: string) => { try { const o = JSON.parse(s ?? "{}"); return o && typeof o === "object" ? o as Record<string, string> : {}; } catch { return {}; } };
    const s = { topics: json(g.defaults?.overlayTopics), lookups: json(g.defaults?.overlayLookups), programs: g.programs ?? {} };
    this.served.set(handle, s);
    return s;
  }

  /** Every enabled instance serving a name of this kind. */
  private async servers(kind: "topics" | "lookups"): Promise<Array<{ handle: string; served: Served }>> {
    const out = [];
    for (const row of this.router.o.db.list("enabled")) {
      try {
        const served = await this.servedBy(row.handle);
        if (Object.keys(served[kind]).length) out.push({ handle: row.handle, served });
      } catch { /* not startable: serves nothing */ }
    }
    return out;
  }

  /** The result record of the thread `event` launched in `handle`, once it has come to rest. */
  private async resultOf(handle: string, event: CID): Promise<Obj> {
    let view = this.views.get(handle);
    if (!view) {
      view = openStoreFile(this.router.o.db.get(handle)!.store, { readOnly: true });
      this.views.set(handle, view);
    }
    for (let i = 0; i < 200; i++) {
      const launched = (await view.edges.refsTo(event)).find((r) => r.rel === "launched-by") as { from?: CID } | undefined;
      if (launched?.from) {
        const u = decode<Obj>(await view.bytes(await view.chains.tip(launched.from)));
        if (u.state === "finished") {
          const out = Buffer.from((u.result as { stdout: Uint8Array }).stdout).toString().trim();
          return decode<Obj>(await view.bytes(CIDClass.decode(Buffer.from(out, "hex"))));
        }
        if (u.state === "errored") throw new Error(String((u.error as Obj | undefined)?.message ?? "the overlay program failed"));
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no answer from ${handle}: is box submit/lookup subscribed to the overlay program?`);
  }

  /** One plain entry into `handle`, run to rest, and its result record. */
  private async call(handle: string, box: string, event: Obj): Promise<Obj> {
    return await this.router.serial(handle, async () => {
      const k: Kernel = (await this.router.hydrate(handle)).kernel;
      const cid = await k.store.put(event as never);
      await admit2(k, { box, event: cid } as never, {}, this.router.nowStamp());
      await k.idle();
      return await this.resultOf(handle, cid);
    });
  }

  // ------------------------------------------------------------ the routes

  async submit(topics: string[], beef: Uint8Array, offChainValues?: Uint8Array): Promise<AppResponse> {
    const steak: Obj = {};
    for (const { handle, served } of await this.servers("topics")) {
      const mine = topics.filter((t) => served.topics[t] !== undefined);
      if (!mine.length) continue;
      const r = await this.call(handle, "submit", { kind: "submit", beef, topics: mine, ...(offChainValues ? { offChainValues } : {}) });
      if (typeof r.error === "string") return error(400, r.error);
      // In the order overlay-express answers (dag-cbor sorted the keys).
      for (const [t, i] of Object.entries(r.steak as Record<string, Obj>)) if (steak[t] === undefined) steak[t] = { outputsToAdmit: i.outputsToAdmit, coinsToRetain: i.coinsToRetain, coinsRemoved: i.coinsRemoved };
    }
    return { status: 200, body: steak };
  }

  async lookup(service: string, query: unknown, aggregate: boolean): Promise<AppResponse> {
    const server = (await this.servers("lookups")).find((s) => s.served.lookups[service] !== undefined);
    if (!server) return error(400, `Lookup service not supported: ${service}`);
    const r = await this.call(server.handle, "lookup", { kind: "lookup", service, query: cborSafe(query) ?? null });
    if (typeof r.error === "string") return error(400, r.error);
    const view = this.views.get(server.handle)!;
    const ans = decode<Obj>(await view.bytes(r.answer as CID));
    if (ans.type !== "output-list") return { status: 200, body: { type: ans.type, result: ans.result } };
    const outs = ans.outputs as Array<{ beef: Uint8Array; outputIndex: number; context?: Uint8Array }>;
    if (!aggregate) {
      return { status: 200, body: { type: "output-list", outputs: outs.map((o) => ({ beef: [...o.beef], outputIndex: o.outputIndex, ...(o.context ? { context: [...o.context] } : {}) })) } };
    }
    // The compact form (overlay-express): count, each [txid, index, context], then one BEEF of them all.
    const w = new Utils.Writer();
    const all = new Beef();
    w.writeVarIntNum(outs.length);
    for (const o of outs) {
      const b = Beef.fromBinary([...o.beef]);
      const txid = b.atomicTxid ?? b.txs.at(-1)!.txid;
      w.write(Utils.toArray(txid, "hex"));
      w.writeVarIntNum(o.outputIndex);
      w.writeVarIntNum(o.context?.length ?? 0);
      if (o.context?.length) w.write([...o.context]);
      all.mergeBeef(b);
    }
    w.write(all.toBinary());
    return { status: 200, body: new Uint8Array(w.toArray()), type: "application/octet-stream" };
  }

  private async listing(kind: "topics" | "lookups"): Promise<Obj> {
    const out: Obj = {};
    for (const { handle, served } of await this.servers(kind)) {
      for (const [name, program] of Object.entries(served[kind])) {
        if (out[name]) continue;
        const d = await this.description(handle, served, program);
        out[name] = { name, shortDescription: d.split("\n")[0]!.trim() };
      }
    }
    return out;
  }

  private async description(handle: string, served: Served, program: string): Promise<string> {
    const p = served.programs[program];
    if (!p) return "";
    const rec = await (await this.router.hydrate(handle)).kernel.store.get(p) as { description?: string };
    return rec.description ?? "";
  }

  private async documentation(kind: "topics" | "lookups", name: string): Promise<AppResponse> {
    for (const { handle, served } of await this.servers(kind)) {
      const program = served[kind][name];
      if (program !== undefined) return { status: 200, type: "text/markdown", body: await this.description(handle, served, program) };
    }
    return error(400, `${kind === "topics" ? "Topic manager" : "Lookup service"} not found: ${name}`);
  }

  /** Answer the request if it is an overlay route; false otherwise (the router carries on). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const p = url.pathname;
    const reply = (f: () => Promise<AppResponse>) => {
      f().then((r) => send(res, r), (e: Error) => { if (!res.headersSent) send(res, error(400, e.message)); });
    };
    if (req.method === "GET") {
      switch (p) {
        case "/listTopicManagers": reply(async () => ({ status: 200, body: await this.listing("topics") })); return true;
        case "/listLookupServiceProviders": reply(async () => ({ status: 200, body: await this.listing("lookups") })); return true;
        case "/getDocumentationForTopicManager": reply(() => this.documentation("topics", url.searchParams.get("manager") ?? "")); return true;
        case "/getDocumentationForLookupServiceProvider": reply(() => this.documentation("lookups", url.searchParams.get("lookupService") ?? "")); return true;
      }
      return false;
    }
    if (req.method !== "POST" || (p !== "/submit" && p !== "/lookup")) return false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => reply(async () => {
      const body = new Uint8Array(Buffer.concat(chunks));
      if (p === "/submit") {
        const th = req.headers["x-topics"];
        if (typeof th !== "string") return error(400, "Missing x-topics header");
        const topics = parseTopics(th);
        if (!body.length) return error(400, "Missing or empty BEEF body");
        let beef = body, off: Uint8Array | undefined;
        if (req.headers["x-includes-off-chain-values"] === "true") {
          const r = new Utils.Reader([...body]);
          const n = r.readVarIntNum();
          beef = new Uint8Array(r.read(n));
          off = new Uint8Array(r.read());
        }
        return await this.submit(topics, beef, off);
      }
      let q: { service?: unknown; query?: unknown };
      try { q = JSON.parse(new TextDecoder().decode(body)); } catch { return error(400, "Invalid request: the body is not JSON"); }
      if (typeof q.service !== "string" || q.query === undefined) return error(400, 'Invalid request: body must contain "service" (string) and "query" fields');
      return await this.lookup(q.service, q.query, req.headers["x-aggregation"] === "yes");
    }));
    return true;
  }
}
