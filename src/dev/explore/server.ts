// `skein-explore [port]`: a read-only graph explorer over the runtime's store
// file, for the developer (default http://localhost:4500, 127.0.0.1;
// SKEIN_WEB_HOST to bind elsewhere). OUTSIDE the machine, and a separate server
// from web/serve.ts (the browser client): it opens the SQLite file read-only
// beside a live runtime and renders pages from it. No forms, no writes.
//
//   /                  the instance: identity, genesis, heads, subscriptions, boxes
//   /log[?before=n]    the input log, newest first
//   /e/<entry>         one log entry: envelope metadata, body, routing, threads
//   /threads[?program=&state=]
//   /t/<thread>        a thread's origin and steps (?frag=1 the body, ?tip=1 for polling)
//   /r/<cid>[?p=path]  any record: dag-cbor as JSON, git trees browsable, raw blocks
//   /h/<name>          a head's moves

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CID } from "multiformats/cid";
import { parse } from "../../runtime/cid.ts";
import { openStore } from "../../runtime/sqlite.ts";
import { NotFound, type Store } from "../../runtime/store.ts";
import { dbPath, resolveCid } from "../cli.ts";
import { entryPage, errorPage, headPage, logPage, overview, recordPage, threadBody, threadPage, threadsPage, tipOf } from "./pages.ts";
import { load } from "./view.ts";

export interface Response { status: number; type: string; body: string }

const html = (body: string, status = 200): Response => ({ status, type: "text/html; charset=utf-8", body });

/** One GET, rendered. Separate from HTTP so tests can call it on a memory store. */
export async function render(store: Store, url: URL): Promise<Response> {
  const p = url.pathname;
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  let g: RegExpMatchArray | null;
  try {
    const w = await load(store);
    const cidOf = async (s: string): Promise<CID> => {
      try { return parse(s); } catch { /* a suffix, where the store can look one up */ }
      if ("findByPrefix" in store) return resolveCid(store as Store & { findByPrefix(p: string): Promise<CID[]> }, s);
      throw new NotFound(s);
    };
    if (p === "/") return html(await overview(w));
    if (p === "/log") return html(logPage(w, q("before") ? Number(q("before")) : undefined));
    if (p === "/threads") return html(threadsPage(w, { program: q("program"), state: q("state") }));
    if ((g = p.match(/^\/e\/([^/]+)$/))) {
      const s = decodeURIComponent(g[1]);
      const byN = /^\d+$/.test(s) ? w.log[Number(s)]?.cid : undefined;
      return html(await entryPage(w, byN ?? await cidOf(s)));
    }
    if ((g = p.match(/^\/t\/([^/]+)$/))) {
      const cid = await cidOf(decodeURIComponent(g[1]));
      const t = w.byThread.get(cid.toString());
      if (!t) return html(errorPage(404, `${cid} is not a thread (see /r/${cid})`), 404);
      if (q("tip")) return { status: 200, type: "application/json", body: JSON.stringify({ tip: tipOf(t), state: t.state, live: ["new", "running", "waiting"].includes(t.state) }) };
      return html(q("frag") ? await threadBody(w, t) : await threadPage(w, t));
    }
    if ((g = p.match(/^\/r\/([^/]+)$/))) return html(await recordPage(w, await cidOf(decodeURIComponent(g[1])), q("p")));
    if ((g = p.match(/^\/h\/([^/]+)$/))) return html(await headPage(w, decodeURIComponent(g[1])));
    return html(errorPage(404, `no page at ${p}`), 404);
  } catch (e) {
    const nf = e instanceof NotFound || /not (a log entry|found)|no thread matches|ambiguous/.test((e as Error).message);
    if (!nf) console.error(`GET ${url.pathname}${url.search}: ${(e as Error).stack ?? e}`);
    return html(errorPage(nf ? 404 : 500, e instanceof NotFound ? `not in this store: ${e.cid}` : (e as Error).message), nf ? 404 : 500);
  }
}

export function serve(store: Store, port: number, host = "127.0.0.1") {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end("read-only"); return; }
    const r = await render(store, new URL(req.url ?? "/", "http://explore"));
    res.writeHead(r.status, { "content-type": r.type, "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : r.body);
  }).listen(port, host);
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 4500);
  const store = openStore(dbPath(), { readOnly: true });
  serve(store, port, process.env.SKEIN_WEB_HOST ?? "127.0.0.1").on("listening", () => console.log(`skein explore: http://localhost:${port} (${dbPath()}, read-only)`));
}
