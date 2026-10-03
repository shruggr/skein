// The router's control socket (#60 follow-up): a Unix socket at
// $SKEIN_HOME/host.sock, mode 0600 — owner-only by file permissions, and no
// HTTP route leads to it. A running router listens on it so that a local
// command can reach the kernels it already holds: a store has one kernel, and
// a second process opening it would fork the log.
//
// The protocol is one JSON line each way, and it carries one request:
//
//   {"op": "event", "handle": h, "box": b, "event": {…}}   → {"ok": true, "entry": "<cid>"} | {"ok": false, "error": "…"}
//   {"op": "claim", "handle": h, "owner": hex, "messagebox"?: url, "name"?: "h@d"}
//                                                          → {"ok": true, "entry": "<cid>", "claimed": bool} | {"ok": false, "error": "…"}
//
// `event` is `skein-host event` (cli.ts): the router sends it as a message
// from its cron provider, a tick due now (Router.cronEvent, #69). `claim` is
// `skein-host claim` (#89): the router's instance manager sends the claim
// into an image (Router.claim).

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";

export const CONTROL_SOCKET = "host.sock";

export type ControlRequest =
  | { op: "event"; handle: string; box: string; event: Record<string, unknown> }
  | { op: "claim"; handle: string; owner: string; messagebox?: string; name?: string };
export type ControlAnswer = { ok: true; entry: string; claimed?: boolean } | { ok: false; error: string };

/** What the socket's owner does with a request (the router: cronEvent, claim). */
export interface ControlHandler {
  event(handle: string, box: string, event: Record<string, unknown>): Promise<string>;
  claim?(handle: string, owner: string, o: { messagebox?: string; name?: string }): Promise<{ entry: string; claimed: boolean }>;
}

const MAX_LINE = 1 << 20;

/** A request line, checked. */
function requestOf(line: string): ControlRequest {
  let r: unknown;
  try { r = JSON.parse(line); } catch { throw new Error("not JSON"); }
  const o = r as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || (o.op !== "event" && o.op !== "claim")) throw new Error("want {op: \"event\", handle, box, event} or {op: \"claim\", handle, owner, messagebox?, name?}");
  if (o.op === "claim") {
    if (typeof o.handle !== "string" || !o.handle || typeof o.owner !== "string" || !/^0[23][0-9a-f]{64}$/.test(o.owner)) throw new Error("a claim names its instance (handle) and the owner's key (hex)");
    if ((o.messagebox !== undefined && typeof o.messagebox !== "string") || (o.name !== undefined && typeof o.name !== "string")) throw new Error("a claim's messagebox and name are text");
    return o as unknown as ControlRequest;
  }
  if (typeof o.handle !== "string" || !o.handle || typeof o.box !== "string" || !o.box) throw new Error("an event names its instance (handle) and its box");
  if (!o.event || typeof o.event !== "object" || Array.isArray(o.event)) throw new Error("the event is a JSON object");
  return o as unknown as ControlRequest;
}

/**
 * Listen on `path`: a socket left by a router that is gone is replaced; one
 * that answers is another router's, and this one refuses to start on it.
 */
export async function listenControl(path: string, h: ControlHandler): Promise<Server> {
  if (existsSync(path)) {
    if (await answers(path)) throw new Error(`${path}: another router answers on it`);
    unlinkSync(path);
  }
  const server = createServer((s) => serveOne(s, h));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(path, 0o600);
  return server;
}

/** Close the socket and remove its file. */
export async function closeControl(server: Server, path: string): Promise<void> {
  await new Promise<void>((r) => server.close(() => r()));
  try { unlinkSync(path); } catch { /* gone already */ }
}

function serveOne(s: Socket, h: ControlHandler): void {
  let buf = "";
  let done = false;
  const reply = (a: ControlAnswer) => { if (done) return; done = true; s.end(`${JSON.stringify(a)}\n`); };
  s.setEncoding("utf8");
  s.on("error", () => {});
  s.on("data", (d: string) => {
    if (done) return;
    buf += d;
    const nl = buf.indexOf("\n");
    if (nl < 0) { if (buf.length > MAX_LINE) reply({ ok: false, error: "request too long" }); return; }
    let req: ControlRequest;
    try { req = requestOf(buf.slice(0, nl)); } catch (e) { reply({ ok: false, error: (e as Error).message }); return; }
    if (req.op === "claim") {
      if (!h.claim) { reply({ ok: false, error: "this router takes no claims" }); return; }
      h.claim(req.handle, req.owner, { messagebox: req.messagebox, name: req.name }).then((c) => reply({ ok: true, entry: c.entry, claimed: c.claimed }), (e: Error) => reply({ ok: false, error: e.message }));
      return;
    }
    h.event(req.handle, req.box, req.event).then((entry) => reply({ ok: true, entry }), (e: Error) => reply({ ok: false, error: e.message }));
  });
}

/** Whether something answers on the socket at `path` (connects). */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(path);
    c.once("connect", () => { c.destroy(); resolve(true); });
    c.once("error", () => resolve(false));
  });
}

/**
 * Send one request to the router on `path`. Undefined if no router answers
 * there (no socket, or one left by a router that is gone); its answer otherwise.
 */
export function controlRequest(path: string, req: ControlRequest, timeoutMs = 60_000): Promise<ControlAnswer | undefined> {
  if (!existsSync(path)) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const c = createConnection(path);
    let buf = "";
    let connected = false;
    const t = setTimeout(() => { c.destroy(); reject(new Error(`${path}: no answer in ${timeoutMs} ms`)); }, timeoutMs);
    c.setEncoding("utf8");
    c.once("connect", () => { connected = true; c.write(`${JSON.stringify(req)}\n`); });
    c.on("data", (d: string) => { buf += d; });
    c.once("end", () => {
      clearTimeout(t);
      try { resolve(JSON.parse(buf.split("\n")[0]!) as ControlAnswer); } catch { reject(new Error(`${path}: a malformed answer`)); }
    });
    c.once("error", (e) => {
      clearTimeout(t);
      // Not there, or nobody listening: no router answers on it.
      if (!connected) resolve(undefined); else reject(e);
    });
  });
}
