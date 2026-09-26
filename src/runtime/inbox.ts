// The instance's edge to the host's messagebox (docs/MESSAGES.md): the one
// file under src/runtime that talks to the network. It is the runtime's own
// tooling, host-side by definition, and isolation.test.ts allows it by name:
// it may import ../envelope.ts (outside src/runtime) and use a timer to poll.
// Nothing inside the machine calls it; it calls the runtime's admission and
// receives its emits.
//
// In: for every box the subscriptions route, list the instance's messages
// and, in order, for each one:
//   parse the BRC-169 envelope from the BRC-33 body (sent with the messagebox
//   client's body encryption off); verify its signature; reject it if the
//   messagebox's authenticated sender is not envelope.sender.identityKey, if
//   `created` is outside the freshness window (±$SKEIN_FRESHNESS_MS of the
//   runtime's clock, default 10 minutes), if it is not addressed to this
//   instance, or if its record CID is already admitted; decrypt the content
//   through the instance wallet (the wire encryption ends here) and check it
//   against the signed contentHash; admit the signed part and the plaintext
//   body with its box (a signed log entry); acknowledge. A rejection is logged
//   and acknowledged too, so it does not come back.
//
// Out: an emit (scheduler.ts) is signed through the instance wallet during the
// step that emits it (so the program learns its CID and can await a reply
// naming it), then encrypted to its recipient and sent to its box once the
// step is recorded.

import { MessageBoxClient } from "@bsv/message-box-client";
import type { WalletInterface } from "@bsv/sdk";
import { brc78Decode, encryptContent, isEnvelope, isoTime, open, sign, signedPart, verify, type Envelope, type Signed } from "../envelope.ts";
import { decode, encode } from "./cid.ts";
import { now as clockNow, short, stampMs } from "./log.ts";
import type { Emit } from "./records.ts";
import type { Runtime, Outbound } from "./scheduler.ts";
import { Rejected } from "./store.ts";
import type { Stamp } from "./syscalls.ts";
import type { Ms } from "./types.ts";

// ---------------------------------------------------------------- the messagebox

/** One listed message: BRC-33 fields as the messagebox reports them. */
export interface Listed { messageId: string; sender?: string; body: unknown; created_at?: string }

/** The part of a BRC-33 messagebox the edge uses, as one identity. */
export interface MessageBox {
  list(box: string): Promise<Listed[]>;
  ack(ids: string[]): Promise<void>;
  send(m: { recipient: string; box: string; body: object }): Promise<void>;
}

/**
 * @bsv/message-box-client against the host at `host` (e.g.
 * http://127.0.0.1:8100/messagebox), authenticated (BRC-103/104) as `wallet`.
 * Always passes the host explicitly: otherwise the client looks recipients up
 * on the mainnet overlay. Body encryption is off (the envelope is the encryption).
 */
export function messageBoxClient(wallet: WalletInterface, host: string, originator = "skein"): MessageBox {
  const mb = new MessageBoxClient({ host, walletClient: wallet, originator });
  return {
    async list(box) {
      const ms = await mb.listMessagesLite({ messageBox: box, host });
      return ms.map((m) => ({ messageId: m.messageId, sender: m.sender, body: m.body, created_at: m.created_at }));
    },
    async ack(ids) { if (ids.length) await mb.acknowledgeMessage({ messageIds: ids, host }); },
    async send(m) {
      await mb.sendMessage({ recipient: m.recipient, messageBox: m.box, body: m.body as Record<string, unknown>, skipEncryption: true }, host);
    },
  };
}

// ---------------------------------------------------------------- the edge

export interface EdgeOptions {
  runtime: Runtime;
  /** The instance wallet: decrypts inbound content, signs and encrypts outbound envelopes. */
  wallet: WalletInterface;
  box: MessageBox;
  /** Accept `created` within ±this of the runtime's clock. Default 10 minutes. */
  freshnessMs?: number;
  /** Handles for outbound recipients the emit record does not name (e.g. the owner's). */
  handles?: Record<string, { handle: string; domain: string }>;
  log?: (line: string) => void;
  /** Tests: the clock freshness is judged by. Default log.ts's. */
  now?: () => Stamp;
}

export type Screened = { ok: true; envelope: Envelope; body: Uint8Array } | { ok: false; reason: string };

export class Edge {
  private readonly o: EdgeOptions;
  private readonly say: (line: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<unknown>;
  readonly freshnessMs: number;

  constructor(o: EdgeOptions) {
    this.o = o;
    this.say = o.log ?? (() => {});
    this.freshnessMs = o.freshnessMs ?? 10 * 60_000;
  }

  /** Poll every `ms` until stop(). */
  start(ms = 1000): void {
    const tick = () => { if (!this.polling) this.polling = this.poll().catch((e) => this.say(`inbox: ${(e as Error).message}`)).finally(() => { this.polling = undefined; }); };
    tick();
    this.timer = setInterval(tick, ms);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.polling;
  }

  /**
   * Collect every routed box once: admit what passes, acknowledge everything.
   * Messages from all boxes are admitted in the sender's order (envelope
   * `created`, then the messagebox's arrival time), so an `objects` bundle
   * sent before a `run` over it is admitted first. Returns what was admitted.
   */
  async poll(): Promise<Array<{ box: string; envelope: string; entry: string }>> {
    const admitted: Array<{ box: string; envelope: string; entry: string }> = [];
    const all: Array<{ box: string; m: Listed; key: string }> = [];
    for (const box of await this.o.runtime.boxes()) for (const m of await this.o.box.list(box)) all.push({ box, m, key: `${createdOf(m.body)} ${m.created_at ?? ""}` });
    all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const { box, m } of all) {
      try {
        const r = await this.ingest(box, m);
        if (r) admitted.push({ box, ...r });
      } catch (e) {
        this.say(`inbox ${box} ${m.messageId}: ${(e as Error).message} (left unacknowledged)`);
        continue;
      }
      await this.o.box.ack([m.messageId]);
    }
    return admitted;
  }

  /** Screen one message (docs/MESSAGES.md, "Replay protection") and decrypt it through the wallet. */
  async screen(m: Listed): Promise<Screened> {
    let env: unknown = m.body;
    try {
      for (let i = 0; i < 2 && typeof env === "string"; i++) env = JSON.parse(env);
    } catch {
      return { ok: false, reason: "body is not JSON" };
    }
    if (!isEnvelope(env)) return { ok: false, reason: "body is not a BRC-169 envelope" };
    if (!verify(env)) return { ok: false, reason: "envelope signature does not verify" };
    if (m.sender !== undefined && m.sender !== env.sender.identityKey) {
      return { ok: false, reason: `messagebox sender ${short(m.sender)} is not envelope.sender ${short(env.sender.identityKey)}` };
    }
    const created = Date.parse(env.created);
    const nowMs = stampMs((this.o.now ?? clockNow)());
    if (!Number.isFinite(created) || Math.abs(nowMs - created) > this.freshnessMs) {
      return { ok: false, reason: `created ${env.created} is outside ±${this.freshnessMs} ms of now` };
    }
    const { publicKey: me } = await this.o.wallet.getPublicKey({ identityKey: true });
    try {
      if (brc78Decode(Buffer.from(env.content, "base64")).recipient !== me) return { ok: false, reason: "not addressed to this instance" };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    const id = encode(signedPart(env)).cid;
    if (await this.o.runtime.store.log.byEnvelope(id)) return { ok: false, reason: `envelope ${short(id)} was already admitted` };
    let body: Uint8Array;
    try {
      body = (await open(this.o.wallet, env)).body;
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    try {
      if (!Buffer.from(encode(decode(body)).bytes).equals(body)) return { ok: false, reason: "the body is not canonical dag-cbor" };
    } catch {
      return { ok: false, reason: "the body is not dag-cbor" };
    }
    return { ok: true, envelope: env, body };
  }

  /** Screen, decrypt, admit. Undefined when rejected (logged). */
  async ingest(box: string, m: Listed): Promise<{ envelope: string; entry: string } | undefined> {
    const s = await this.screen(m);
    if (!s.ok) { this.say(`inbox ${box} ${m.messageId}: rejected: ${s.reason}`); return undefined; }
    try {
      const { entry, envelope } = await this.o.runtime.admitEnvelope(signedPart(s.envelope), box, s.body);
      this.say(`inbox ${box} ${m.messageId}: admitted ${short(envelope)} as ${short(entry)}`);
      return { envelope: envelope.toString(), entry: entry.toString() };
    } catch (e) {
      if (e instanceof Rejected && e.reason === "duplicate-envelope") { this.say(`inbox ${box} ${m.messageId}: rejected: already admitted`); return undefined; }
      throw e;
    }
  }

  /**
   * The runtime's outbox, part 1: sign an emit's envelope (its signed part,
   * contentHash and all) through the instance wallet, during the step that
   * emits it (the scheduler records it as an attested answer, so its CID is
   * known before the step ends). `created` is the step's `at`.
   */
  async seal(e: Emit, bytes: Uint8Array, at: Ms): Promise<Signed> {
    const g = this.o.runtime.genesis!;
    const named = e.handle ? { handle: e.handle, domain: e.domain ?? g.domain } : this.o.handles?.[e.to] ?? { handle: e.to.slice(0, 16), domain: g.domain };
    return sign(this.o.wallet, {
      recipient: { identityKey: e.to, ...named },
      sender: { handle: g.handle, domain: g.domain },
      body: bytes,
      created: isoTime(at),
    });
  }

  /** The runtime's outbox, part 2: encrypt the body to the recipient and send the envelope, once the step is recorded. */
  async send(o: Outbound): Promise<void> {
    const content = await encryptContent(this.o.wallet, o.to, o.bytes);
    await this.o.box.send({ recipient: o.to, box: o.box, body: { ...o.envelope, content } });
    this.say(`outbox ${o.box} → ${short(o.to)}: ${short(o.cid)} (emit ${short(o.emit)})`);
  }
}

/** An envelope body's `created` as a sortable key (ms since the epoch, zero-padded); "" if unreadable. */
function createdOf(body: unknown): string {
  try {
    let v = body;
    for (let i = 0; i < 2 && typeof v === "string"; i++) v = JSON.parse(v);
    const c = (v as { created?: unknown } | null)?.created;
    const ms = typeof c === "string" ? Date.parse(c) : NaN;
    return Number.isFinite(ms) ? String(ms).padStart(16, "0") : "";
  } catch {
    return "";
  }
}
