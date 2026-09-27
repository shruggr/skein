// The messagebox delivery provider (docs/MESSAGES.md): one provider of the
// instance's message interface, for the local `1sat serve` host. Outside the
// machine: main.ts, the kernel configuration, wires it to a runtime; the
// runtime never calls a messagebox and holds no session. It holds the
// instance wallet (the messagebox session is the instance's identity, and
// inbound wire encryption ends here) and the host wallet (it signs what it
// delivers).
//
// In: for every box the subscriptions route, list the instance's messages
// and, in order, for each one:
//   parse the BRC-169 envelope from the BRC-33 body (sent with the messagebox
//   client's body encryption off); verify its signature; reject it if the
//   messagebox's authenticated sender is not envelope.sender.identityKey, if
//   it is not addressed to this instance, or if its record CID is already
//   admitted; decrypt the content through the instance wallet and check it
//   against the signed contentHash; build the log entry — the signed part, the
//   plaintext body, the box, the host's arrival stamp — sign it with the host
//   wallet and admit it (Runtime.admit); acknowledge. A rejection is logged
//   and acknowledged too, so it does not come back. Freshness is not judged
//   here: the entry carries the sender's `created` and the arrival stamp, and
//   the instance decides from those if it decides at all.
//
// Out: an emit (scheduler.ts) is a complete envelope — the program signed it
// and encrypted its content to the recipient through the instance wallet,
// inside the step — so once the step is recorded it is handed here and sent to
// its box as it is: this side makes no wallet call. A send that fails is kept
// and tried again at the next poll: delivery is this provider's business, and
// nothing about it goes back into the instance.

import { MessageBoxClient } from "@bsv/message-box-client";
import type { WalletInterface } from "@bsv/sdk";
import { brc78Decode, isEnvelope, open, signedPart, verify, type Envelope } from "../envelope.ts";
import { decode, encode } from "../runtime/cid.ts";
import type { KeyWallet } from "../runtime/identity.ts";
import { short } from "../runtime/log.ts";
import type { Runtime, Outbound } from "../runtime/scheduler.ts";
import { Rejected } from "../runtime/store.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { admitEntry, now as clockNow } from "./entry.ts";

// ---------------------------------------------------------------- the messagebox

/** One listed message: BRC-33 fields as the messagebox reports them. */
export interface Listed { messageId: string; sender?: string; body: unknown; created_at?: string }

/** The part of a BRC-33 messagebox the provider uses, as one identity. */
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

// ---------------------------------------------------------------- the provider

export interface DeliveryOptions {
  runtime: Runtime;
  /** The instance wallet: decrypts inbound content. Outbound envelopes come sealed. */
  wallet: WalletInterface;
  /** The host wallet: signs every entry this provider delivers. */
  host: KeyWallet;
  box: MessageBox;
  log?: (line: string) => void;
  /** Tests: the clock arrivals are stamped with. Default entry.ts's. */
  now?: () => Stamp;
}

export type Screened = { ok: true; envelope: Envelope; body: Uint8Array } | { ok: false; reason: string };

export class Delivery {
  private readonly o: DeliveryOptions;
  private readonly say: (line: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<unknown>;
  private unsent: Outbound[] = [];

  constructor(o: DeliveryOptions) {
    this.o = o;
    this.say = o.log ?? (() => {});
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
   * Retry what failed to send, then collect every routed box once: admit what
   * passes, acknowledge everything. Messages from all boxes are admitted in
   * the sender's order (envelope `created`, then the messagebox's arrival
   * time), so an `objects` bundle sent before a `run` over it is admitted
   * first. Returns what was admitted.
   */
  async poll(): Promise<Array<{ box: string; envelope: string; entry: string }>> {
    for (const o of this.unsent.splice(0)) await this.send(o);
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

  /** Screen one message (docs/MESSAGES.md, "Replay protection") and decrypt it through the instance wallet. */
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

  /** Screen, decrypt, stamp, sign, admit. Undefined when rejected (logged). */
  async ingest(box: string, m: Listed): Promise<{ envelope: string; entry: string } | undefined> {
    const s = await this.screen(m);
    if (!s.ok) { this.say(`inbox ${box} ${m.messageId}: rejected: ${s.reason}`); return undefined; }
    const signed = signedPart(s.envelope);
    const envelope = encode(signed).cid;
    try {
      const entry = await admitEntry(this.o.runtime, this.o.host, { envelope, box, body: encode(decode(s.body)).cid }, { envelope: signed, body: s.body }, (this.o.now ?? clockNow)());
      this.say(`inbox ${box} ${m.messageId}: admitted ${short(envelope)} as ${short(entry)}`);
      return { envelope: envelope.toString(), entry: entry.toString() };
    } catch (e) {
      if (e instanceof Rejected && e.reason === "duplicate-envelope") { this.say(`inbox ${box} ${m.messageId}: rejected: already admitted`); return undefined; }
      throw e;
    }
  }

  /**
   * The runtime's outbox, once the step is recorded: send the envelope the
   * program sealed, as it is. A failure is logged and kept for the next poll;
   * it never reaches the instance.
   */
  async send(o: Outbound): Promise<void> {
    try {
      await this.o.box.send({ recipient: o.to, box: o.box, body: o.envelope });
    } catch (e) {
      this.unsent.push(o);
      this.say(`outbox ${o.box} → ${short(o.to)}: ${short(o.cid)}: ${(e as Error).message} (will retry)`);
      return;
    }
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
