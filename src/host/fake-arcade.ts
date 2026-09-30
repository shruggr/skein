// A fake Arcade (bsv-blockchain/arcade) for the tests (#58): its API on one
// port — POST /tx (Extended Format or raw bytes; 202 {txid, status,
// txStatus: "RECEIVED"}, a duplicate echoing its current status, 400 with a
// reason, 503 + Retry-After under "backpressure"), GET /tx/:txid (404 for a
// txid it never took) — and its SSE service on another: GET
// /events?callbackToken=<token>, every transaction submitted under the
// token, ids increasing (nanosecond timestamps, as Arcade's), `Last-Event-ID`
// replaying what came after it, the current status of each transaction
// without one. The test drives the statuses (`emit`); Arcade's webhook is the
// test's to post.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Transaction } from "@bsv/sdk";

export interface ArcadeStatus { txStatus: string; merklePath?: string; blockHash?: string; blockHeight?: number }
interface Logged { id: string; token: string; data: Record<string, unknown> }

export class FakeArcade {
  url = "";
  eventsUrl = "";
  /** "ok"; "reject": a 400 with a reason; "busy": 503 + Retry-After (not taken). */
  mode: "ok" | "reject" | "busy" = "ok";
  readonly txs = new Map<string, ArcadeStatus & { token: string }>();
  readonly posts: Uint8Array[] = [];
  readonly postHeaders: Array<Record<string, string | string[] | undefined>> = [];
  readonly gets: string[] = [];
  /** The Last-Event-ID of each SSE connection, in order (undefined: none sent). */
  readonly connects: Array<string | undefined> = [];
  private log: Logged[] = [];
  private conns: Array<{ res: ServerResponse; token: string }> = [];
  private clock = 1_790_000_000_000_000_000n;
  private servers: Server[] = [];

  static async start(): Promise<FakeArcade> {
    const a = new FakeArcade();
    const api = createServer((req, res) => void a.api(req, res));
    const events = createServer((req, res) => a.events(req, res));
    for (const s of [api, events]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    a.servers = [api, events];
    a.url = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    a.eventsUrl = `http://127.0.0.1:${(events.address() as { port: number }).port}/events`;
    return a;
  }

  /** The transaction Arcade received in a POST body: Extended Format, else raw. */
  static txOf(body: Uint8Array): Transaction {
    try { return Transaction.fromEF([...body]); } catch { return Transaction.fromBinary([...body]); }
  }

  private async api(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = new Uint8Array(Buffer.concat(chunks));
    const send = (status: number, v: unknown, h: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...h }); res.end(JSON.stringify(v)); };
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "POST" && path === "/tx") {
      this.posts.push(body);
      this.postHeaders.push({ ...req.headers });
      if (this.mode === "busy") return send(503, { status: 503, title: "Service Unavailable", detail: "backpressure" }, { "retry-after": "1" });
      let tx: Transaction;
      try { tx = FakeArcade.txOf(body); } catch (e) { return send(400, { status: 400, reason: `not a transaction: ${(e as Error).message}` }); }
      const txid = tx.id("hex");
      if (this.mode === "reject") return send(400, { status: 400, txid, reason: "rejected by the test" });
      const had = this.txs.get(txid);
      if (had) return send(202, { txid, status: 202, txStatus: had.txStatus });
      this.txs.set(txid, { txStatus: "RECEIVED", token: String(req.headers["x-callbacktoken"] ?? "") });
      return send(202, { txid, status: 202, txStatus: "RECEIVED" });
    }
    const m = /^\/tx\/([0-9a-f]{64})$/.exec(path);
    if (req.method === "GET" && m) {
      this.gets.push(m[1]!);
      const t = this.txs.get(m[1]!);
      if (!t) return send(404, { status: 404, title: "Not Found", detail: "transaction not found" });
      return send(200, { txid: m[1], txStatus: t.txStatus, status: t.txStatus, blockHash: t.blockHash ?? null, blockHeight: t.blockHeight ?? 0, merklePath: t.merklePath ?? null, extraInfo: "" });
    }
    send(404, { status: 404, title: "Not Found" });
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/events") { res.writeHead(404).end(); return; }
    const token = u.searchParams.get("callbackToken") ?? "";
    const last = req.headers["last-event-id"] as string | undefined;
    this.connects.push(last);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": keepalive\n\n");
    const mine = this.log.filter((e) => e.token === token);
    if (last !== undefined) {
      for (const e of mine) if (BigInt(e.id) > BigInt(last)) this.write(res, e);
    } else {
      // No id: the current status of every transaction under the token.
      const latest = new Map<string, Logged>();
      for (const e of mine) latest.set(String(e.data.txid), e);
      for (const e of latest.values()) this.write(res, e);
    }
    const c = { res, token };
    this.conns.push(c);
    res.on("close", () => { this.conns = this.conns.filter((x) => x !== c); });
  }

  private write(res: ServerResponse, e: Logged): void {
    res.write(`id: ${e.id}\nevent: status\ndata: ${JSON.stringify(e.data)}\n\n`);
  }

  /** A status for a transaction Arcade took: recorded, and streamed to its token's connections. The event's id. */
  emit(txid: string, s: ArcadeStatus): string {
    const t = this.txs.get(txid);
    if (!t) throw new Error(`the fake Arcade never took ${txid}`);
    // Its status now (a reorg's SEEN_ON_NETWORK drops the block and the path).
    this.txs.set(txid, { token: t.token, ...s });
    this.clock += 1_000_000n;
    const e: Logged = { id: String(this.clock), token: t.token, data: { timestamp: new Date().toISOString(), txid, ...s } };
    this.log.push(e);
    for (const c of this.conns) if (c.token === t.token) this.write(c.res, e);
    return e.id;
  }

  /** The body Arcade would post to a webhook for the last status of `txid`. */
  webhookBody(txid: string): Record<string, unknown> {
    const e = this.log.filter((x) => x.data.txid === txid).at(-1);
    if (!e) throw new Error(`no status for ${txid}`);
    return e.data;
  }

  /** Open SSE connections. */
  get streams(): number { return this.conns.length; }

  /** Drop every SSE connection (a network blip). */
  drop(): void { for (const c of this.conns) c.res.end(); this.conns = []; }

  async close(): Promise<void> {
    this.drop();
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
  }
}
