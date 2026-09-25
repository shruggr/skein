// The runtime's message edge: a unix socket (default $SKEIN_HOME/runtime.sock).
// Frames are a 4-byte big-endian length and a dag-cbor value, both ways.
//
// Peer → runtime: signed message records. The first must be a hello,
//   { kind: "message", from: P, seq: 0, body: { kind: "hello", identity: P }, … }
// signed by P. It is a handshake, not an input: it is verified and never
// logged. Every later frame must be a message signed by P (the identity that
// said hello); it is then stored, appended to the log and processed.
//
// Runtime → peer: message records addressed to P (`to: P`), and control frames
//   { kind: "welcome", runtime: <identity>, next: <P's next seq> }
//   { kind: "admitted", message: <cid>, entry: <log entry cid> }
//   { kind: "rejected", reason, message?: <cid> }
// Messages to an identity with no connection are held (they are already
// recorded in the store) and delivered when it says hello.
//
// This is the only file in the runtime that may import node:net.

import { createServer, type Server, type Socket } from "node:net";
import type { CID } from "multiformats/cid";
import { decode, encode } from "./cid.ts";
import { isMessage, verifyMessageSync, type Identity, type Message } from "./records.ts";
import { Rejected } from "./store.ts";

export const MAX_FRAME = 256 << 20;

export type Control =
  | { kind: "welcome"; runtime: Identity; next: number }
  | { kind: "admitted"; message: CID; entry: CID }
  | { kind: "rejected"; reason: string; message?: CID };

export function encodeFrame(value: unknown): Uint8Array {
  const body = encode(value).bytes;
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

/** Reassembles frames from stream chunks. */
export class FrameReader {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): unknown[] {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    this.buf = joined;
    const out: unknown[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(0);
      if (len > MAX_FRAME) throw new Error(`frame of ${len} bytes exceeds ${MAX_FRAME}`);
      if (this.buf.length < 4 + len) break;
      out.push(decode(this.buf.subarray(4, 4 + len)));
      this.buf = this.buf.slice(4 + len);
    }
    return out;
  }
}

export function isHello(m: Message): boolean {
  const b = m.body as { kind?: unknown; identity?: unknown } | null;
  return !!b && b.kind === "hello" && b.identity === m.from;
}

/** What the transport needs from the runtime. */
export interface TransportHost {
  identity: string;
  admit(m: Message): Promise<CID>;
  nextSeq(identity: string): Promise<number>;
  nameOf?(identity: string): string;
  log?(line: string): void;
}

export class Transport {
  private readonly host: TransportHost;
  private readonly conns = new Map<string, Socket>();
  private readonly held = new Map<string, Message[]>();
  private server?: Server;

  constructor(host: TransportHost) {
    this.host = host;
  }

  listen(path: string): Promise<void> {
    const server = createServer((s) => this.accept(s));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
  }

  /** Stop listening and drop every connection. The socket file is removed by the server on close. */
  close(): Promise<void> {
    for (const s of this.conns.values()) s.destroy();
    this.conns.clear();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Deliver a message to its `to`, or hold it until that identity connects. */
  send(m: Message): void {
    if (!m.to) return;
    const s = this.conns.get(m.to);
    if (s && !s.destroyed) { s.write(encodeFrame(m)); return; }
    const q = this.held.get(m.to) ?? [];
    if (!q.some((x) => encode(x).cid.equals(encode(m).cid))) q.push(m);
    this.held.set(m.to, q);
  }

  /** Messages waiting for an identity to connect. */
  heldFor(identity: string): Message[] { return [...(this.held.get(identity) ?? [])]; }

  connected(identity: string): boolean { return this.conns.has(identity); }

  private say(line: string) { this.host.log?.(line); }

  private accept(s: Socket): void {
    const reader = new FrameReader();
    let who: string | undefined;
    let queue = Promise.resolve();
    const reject = (reason: string, message?: CID, close = false) => {
      s.write(encodeFrame(message ? { kind: "rejected", reason, message } : { kind: "rejected", reason }));
      if (close) s.end();
    };
    s.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try { frames = reader.push(chunk); } catch (e) { reject(`bad frame: ${(e as Error).message}`, undefined, true); return; }
      // Frames from one connection are handled in order.
      for (const f of frames) queue = queue.then(() => this.frame(s, f, who, (id) => { who = id; }, reject)).catch((e) => this.say(`transport: ${(e as Error).message}`));
    });
    s.on("error", () => {});
    s.on("close", () => {
      if (who && this.conns.get(who) === s) {
        this.conns.delete(who);
        this.say(`peer ${this.name(who)} disconnected`);
      }
    });
  }

  private async frame(s: Socket, f: unknown, who: string | undefined, setWho: (id: string) => void, reject: (r: string, m?: CID, close?: boolean) => void): Promise<void> {
    if (!isMessage(f) || !verifyMessageSync(f)) { reject(isMessage(f) ? "bad-signature" : "not a message", isMessage(f) ? encode(f).cid : undefined, !who); return; }
    const cid = encode(f).cid;
    if (!who) {
      if (!isHello(f)) { reject("hello required", cid, true); return; }
      const id = f.from;
      this.conns.get(id)?.destroy(); // a newer connection for the same identity replaces the old
      this.conns.set(id, s);
      setWho(id);
      s.write(encodeFrame({ kind: "welcome", runtime: this.host.identity, next: await this.host.nextSeq(id) }));
      this.say(`peer ${this.name(id)} connected`);
      const q = this.held.get(id);
      if (q?.length) {
        this.held.delete(id);
        for (const m of q) s.write(encodeFrame(m));
      }
      return;
    }
    if (f.from !== who) { reject("wrong-sender: signed by another identity than the one that said hello", cid); return; }
    if (isHello(f)) return;
    try {
      const entry = await this.host.admit(f);
      s.write(encodeFrame({ kind: "admitted", message: cid, entry }));
    } catch (e) {
      reject(e instanceof Rejected ? e.reason : `refused: ${(e as Error).message}`, cid);
    }
  }

  private name(id: string) { return this.host.nameOf?.(id) ?? id.slice(0, 10); }
}
