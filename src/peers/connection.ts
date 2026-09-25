// A peer's side of the runtime socket (see src/runtime/transport.ts): connect,
// say hello as an identity, then send signed messages and receive the ones
// addressed to that identity. Used by skein-dev and future peers.

import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import { signMessage, type Message } from "../runtime/records.ts";
import { encodeFrame, FrameReader, type Control } from "../runtime/transport.ts";
import type { Ref } from "../runtime/types.ts";
import type { Signer } from "../wallet.ts";

export const skeinHome = () => process.env.SKEIN_HOME || join(homedir(), ".skein");
export const socketPath = () => process.env.SKEIN_SOCKET || join(skeinHome(), "runtime.sock");

export interface Connection {
  identity: string;
  runtime: string;
  /** Sign `body` at this identity's next seq, send it, and resolve when the runtime admits (or rejects) it. */
  send(body: unknown, o?: { to?: string; refs?: Ref[] }): Promise<{ message: Message; cid: CID; entry: CID }>;
  /** Send an already-signed message as is (tests: forged or foreign messages). */
  sendRaw(m: Message): void;
  /** Called for every message the runtime delivers. */
  onMessage(fn: (m: Message) => void): void;
  /** Called for every control frame. */
  onControl(fn: (c: Control) => void): void;
  close(): void;
  closed: Promise<void>;
}

export async function connectPeer(signer: Signer, path = socketPath()): Promise<Connection> {
  const sock: Socket = await new Promise((resolve, reject) => {
    const s = connect(path);
    s.once("connect", () => { s.off("error", reject); resolve(s); });
    s.once("error", reject);
  });
  const reader = new FrameReader();
  const messageFns: Array<(m: Message) => void> = [];
  const early: Message[] = [];
  const controlFns: Array<(c: Control) => void> = [];
  const waiting = new Map<string, { resolve(e: CID): void; reject(e: Error): void }>();
  let welcome: (c: Extract<Control, { kind: "welcome" }>) => void;
  let failHello: (e: Error) => void;
  const welcomed = new Promise<Extract<Control, { kind: "welcome" }>>((res, rej) => { welcome = res; failHello = rej; });
  const closed = new Promise<void>((res) => sock.once("close", () => res()));
  closed.then(() => {
    failHello(new Error("connection closed before welcome"));
    for (const w of waiting.values()) w.reject(new Error("connection closed"));
  });

  sock.on("data", (chunk: Buffer) => {
    for (const f of reader.push(chunk)) {
      const c = f as Control | Message;
      if (c.kind === "message") {
        // Held messages can arrive right behind the welcome, before anyone has subscribed: keep them.
        if (!messageFns.length) early.push(c as Message);
        for (const fn of messageFns) fn(c as Message);
        continue;
      }
      const ctl = c as Control;
      if (ctl.kind === "welcome") welcome(ctl);
      if (ctl.kind === "admitted") { waiting.get(ctl.message.toString())?.resolve(ctl.entry); waiting.delete(ctl.message.toString()); }
      if (ctl.kind === "rejected") {
        if (!ctl.message) failHello(new Error(`rejected: ${ctl.reason}`));
        else { waiting.get(ctl.message.toString())?.reject(new Error(`rejected: ${ctl.reason}`)); waiting.delete(ctl.message.toString()); }
      }
      for (const fn of controlFns) fn(ctl);
    }
  });
  sock.on("error", () => {});

  const hello = await signMessage(signer, { seq: 0, at: Date.now(), body: { kind: "hello", identity: signer.identity } });
  sock.write(encodeFrame(hello));
  const w = await welcomed;
  let seq = w.next;

  return {
    identity: signer.identity,
    runtime: w.runtime,
    async send(body, o = {}) {
      const message = await signMessage(signer, { to: o.to ?? w.runtime, seq: seq++, at: Date.now(), body, refs: o.refs });
      const cid = encode(message).cid;
      const entry = new Promise<CID>((resolve, reject) => waiting.set(cid.toString(), { resolve, reject }));
      sock.write(encodeFrame(message));
      return { message, cid, entry: await entry };
    },
    sendRaw(m) { sock.write(encodeFrame(m)); },
    onMessage(fn) {
      messageFns.push(fn);
      for (const m of early.splice(0)) fn(m);
    },
    onControl(fn) { controlFns.push(fn); },
    close() { sock.end(); },
    closed,
  };
}
