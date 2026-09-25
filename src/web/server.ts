// HTTP: the browser pages and a small JSON API over the same read models.
// No auth: the daemon binds to loopback by default, and POSTs from other
// origins are refused so a web page can't start threads (which run bash).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CID } from "multiformats/cid";
import type { WalletInterface } from "@bsv/sdk";
import { fmt, isCID } from "../cid.ts";
import { NotFound, type Store } from "../store.ts";
import type { Config } from "../config.ts";
import type { NodeOrigin, ThreadOrigin, ThreadState } from "../types.ts";
import { newThread, reply, Refused } from "../actions.ts";
import { Ambiguous, jsonify, listThreads, resolveCid, threadView } from "../view.ts";
import type { Runtime } from "../runtime.ts";
import { blockPage, errorPage, home, threadBody, threadPage } from "./pages.ts";

export interface WebContext {
  store: Store;
  wallet: WalletInterface; // signs the owner's prompts (instance.ts)
  runtime: Runtime;
  config(): Config;
  loopbackOnly?: boolean; // refuse Host headers that aren't loopback (DNS rebinding)
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function webHandler(ctx: WebContext) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://skein");
    const api = url.pathname.startsWith("/api/") || url.pathname === "/wake";
    try {
      guard(req, ctx);
      await route(req, res, url, ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof NotFound ? 404 : e instanceof Ambiguous || e instanceof Refused ? 409 : 500;
      const message = (e as Error).message ?? String(e);
      if (status === 500) console.error(`${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
      if (res.headersSent) return void res.end();
      if (api) send(res, status, { error: message, ...(e instanceof Ambiguous ? { candidates: e.candidates } : {}) });
      else html(res, status, errorPage(status, message));
    }
  };
}

function guard(req: IncomingMessage, ctx: WebContext) {
  const host = req.headers.host ?? "";
  if (ctx.loopbackOnly && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) throw new HttpError(403, `refusing Host ${host}`);
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "cross-site request refused");
    if (origin && origin !== "null" && new URL(origin).host !== host) throw new HttpError(403, `cross-origin request refused (${origin})`);
    if (origin === "null") throw new HttpError(403, "opaque-origin request refused");
  }
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebContext) {
  const { store } = ctx;
  const p = url.pathname;
  const m = (re: RegExp) => p.match(re);
  let g: RegExpMatchArray | null;

  if (req.method === "GET" || req.method === "HEAD") {
    if (p === "/") {
      const config = ctx.config();
      const models = Object.entries(config.providers).flatMap(([name, pc]) => (pc.models ?? []).map((mm) => `${name}/${mm}`));
      return html(res, 200, home({ rows: await listThreads(store, { all: !!url.searchParams.get("all") }), all: !!url.searchParams.get("all"), models, defaultModel: config.defaults?.model, defaultThinking: config.defaults?.thinking }));
    }
    if ((g = m(/^\/t\/([^/]+)$/))) {
      const cid = await resolveCid(store, decodeURIComponent(g[1]));
      const v = await threadView(store, await threadOf(store, cid));
      return html(res, 200, url.searchParams.get("frag") ? threadBody(v) : threadPage(v));
    }
    if ((g = m(/^\/b\/([^/]+)$/))) return html(res, 200, blockPage(await blockData(store, await resolveCid(store, decodeURIComponent(g[1])))));
    if (p === "/api/threads") {
      const state = url.searchParams.get("state")?.split(",").filter(Boolean) as ThreadState[] | undefined;
      const limit = Number(url.searchParams.get("limit")) || undefined;
      return send(res, 200, await listThreads(store, { all: !!url.searchParams.get("all"), state, runner: url.searchParams.get("runner") ?? undefined, limit }));
    }
    if ((g = m(/^\/api\/thread\/([^/]+)$/))) {
      const v = await threadView(store, await resolveCid(store, decodeURIComponent(g[1])));
      const since = url.searchParams.get("since");
      if (since !== null && Number(since) === v.version) {
        return send(res, 200, { version: v.version, changed: false, settled: v.settled, davidWaiting: v.davidWaiting ?? null });
      }
      return send(res, 200, { ...v, changed: true });
    }
    if ((g = m(/^\/api\/block\/([^/]+)$/))) {
      const d = await blockData(store, await resolveCid(store, decodeURIComponent(g[1])));
      return send(res, 200, { ...d, block: jsonify(d.block), refsFrom: jsonify(d.refsFrom), refsTo: jsonify(d.refsTo) });
    }
    throw new HttpError(404, `no page at ${p}`);
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    const form = !String(req.headers["content-type"] ?? "").includes("json");
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
    if (p === "/api/new") {
      // Tool choice by name went with v1's registry; sessions get the loop's default tools until the UI is redone.
      if (body.tools !== undefined && str("tools") !== "") throw new HttpError(501, "choosing tools is not supported in v2 yet: sessions get the loop's default tools");
      const r = await newThread(store, ctx.wallet, { prompt: str("prompt") ?? "", model: str("model"), thinking: str("thinking"), system: str("system") }, ctx.runtime);
      return form ? redirect(res, `/t/${fmt(r.thread)}`) : send(res, 201, { thread: fmt(r.thread), message: fmt(r.message) });
    }
    if (p === "/api/reply") {
      const cid = await resolveCid(store, str("thread") ?? "");
      const r = await reply(store, ctx.wallet, cid, str("text") ?? "", ctx.runtime);
      const back = str("back");
      return form ? redirect(res, back?.startsWith("/t/") ? back : `/t/${fmt(r.thread)}`) : send(res, 200, { thread: fmt(r.thread), message: fmt(r.message) });
    }
    if (p === "/api/wake" || p === "/wake") {
      // Another process put messages in the log: process them now rather than on the next tick.
      void ctx.runtime.poll();
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(req.method === "POST" ? 404 : 405, `${req.method} ${p} not supported`);
}

/** /t/ on a node shows its thread; on anything else that isn't a thread, 404. */
async function threadOf(store: Store, cid: CID): Promise<CID> {
  const b = await store.get<ThreadOrigin | NodeOrigin>(cid);
  if (b.kind === "thread") return cid;
  if (b.kind === "node" && isCID(b.thread)) return b.thread;
  throw new HttpError(404, `${fmt(cid)} is not a thread (see /b/${fmt(cid)})`);
}

async function blockData(store: Store, cid: CID) {
  const block = await store.get(cid);
  const b = block as Record<string, unknown>;
  let origin: CID | undefined;
  try { origin = await store.chains.originOf(cid); } catch { /* a plain block */ }
  const isUpdate = !!origin && !origin.equals(cid);
  let chain: string[] | undefined;
  if (origin && !isUpdate) {
    chain = [];
    for await (const c of store.chains.history(cid)) if (!c.equals(cid)) chain.push(fmt(c));
  }
  const refsOf = origin ?? cid; // edges are keyed by origin
  return {
    cid: fmt(cid), block, isThread: b.kind === "thread",
    origin: isUpdate ? fmt(origin!) : undefined, seq: isUpdate ? (b.seq as number) : undefined, chain,
    refsFrom: await store.edges.refsFrom(refsOf), refsTo: await store.edges.refsTo(cid),
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 1 << 20) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  if (String(req.headers["content-type"] ?? "").includes("json")) {
    try { return JSON.parse(text); } catch { throw new HttpError(400, "invalid JSON"); }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function redirect(res: ServerResponse, to: string) {
  res.writeHead(303, { location: to });
  res.end();
}
