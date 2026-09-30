// The router's control socket (#60 follow-up): a Unix socket at
// $SKEIN_HOME/host.sock, mode 0600 — owner-only by file permissions, and no
// HTTP route leads to it. A running router listens on it so that a local
// command can reach the kernels it already holds: a store has one kernel, and
// a second process opening it would fork the log.
//
// The protocol is one JSON line each way, and it carries one request:
//
//   {"op": "event", "handle": h, "box": b, "event": {…}}   → {"ok": true, "entry": "<cid>"} | {"ok": false, "error": "…"}
//
// `event` is `skein-host event` (cli.ts): the router admits it through
// Router.admitEvent, as its clock admits a job's firing (cron.ts).

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";

export const CONTROL_SOCKET = "host.sock";

export interface ControlRequest { op: "event"; handle: string; box: string; event: Record<string, unknown> }
export type ControlAnswer = { ok: true; entry: string } | { ok: false; error: string };

/** What the socket's owner does with a request (the router: admitEvent). */
export interface ControlHandler { event(handle: string, box: string, event: Record<string, unknown>): Promise<string> }

const MAX_LINE = 1 << 20;

/** A request line, checked. */
function requestOf(line: string): ControlRequest {
  let r: unknown;
  try { r = JSON.parse(line); } catch { throw new Error("not JSON"); }
  const o = r as Partial<ControlRequest> | null;
  if (!o || typeof o !== "object" || o.op !== "event") throw new Error("want {op: \"event\", handle, box, event}");
  if (typeof o.handle !== "string" || !o.handle || typeof o.box !== "string" || !o.box) throw new Error("an event names its instance (handle) and its box");
  if (!o.event || typeof o.event !== "object" || Array.isArray(o.event)) throw new Error("the event is a JSON object");
  return o as ControlRequest;
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
