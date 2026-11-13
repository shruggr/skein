// The router's control socket (#60 follow-up): a Unix socket at
// $SKEIN_HOME/host.sock, mode 0600 — owner-only by file permissions, and no
// HTTP route leads to it. A running router listens on it so that a local
// command can reach the kernels it already holds: a store has one kernel, and
// a second process opening it would fork the log.
//
// The protocol is one JSON line each way, and it carries one request:
//
//   {"op": "message", "handle": h, "request": "<base64>"}
//        → {"ok": true, "entry": "<cid>", "status": n, "body": "<base64>"} | {"ok": false, "error": "…"}
//
// `request` (skein next, SPEC.md section 2) is a request record the client `skein` signed in its own
// process (src/client/raw.ts signRequest, the `signed` scheme: the operator's key), its dag-cbor,
// delivered on the host machine. The router hands it to the instance (Router.messageLocal: CHECK then
// COMMIT); the router signs nothing. The answer is the entry and the handler's (or the kernel
// operation's) answer, once it came to rest; a refusal (nothing written) is an error.

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";

export const CONTROL_SOCKET = "host.sock";

export type ControlRequest = { op: "message"; handle: string; request: string };
export type ControlAnswer = { ok: true; entry: string; status: number; body: string } | { ok: false; error: string };

/** What the socket's owner does with a request (the router: messageLocal). */
export interface ControlHandler {
  /** A signed request record for `handle` (its dag-cbor): CHECK then COMMIT (Router.messageLocal) → the entry and the answer. */
  message(handle: string, request: Uint8Array): Promise<{ entry: string; status: number; body: Uint8Array }>;
}

/** The longest request line: ours to choose (#142) — an objects request carries a module whole (base64), so 64 MiB. */
export const MAX_LINE = 64 << 20;

/** A request line, checked. */
function requestOf(line: string): ControlRequest {
  let r: unknown;
  try { r = JSON.parse(line); } catch { throw new Error("not JSON"); }
  const o = r as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.op !== "message") throw new Error("want {op: \"message\", handle, request}");
  if (typeof o.handle !== "string" || !o.handle) throw new Error("a message names its instance (handle)");
  if (typeof o.request !== "string") throw new Error("a message carries `request`: a signed request record's dag-cbor, base64");
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
    h.message(req.handle, Buffer.from(req.request, "base64")).then((a) => reply({ ok: true, entry: a.entry, status: a.status, body: Buffer.from(a.body).toString("base64") }), (e: Error) => reply({ ok: false, error: e.message }));
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
