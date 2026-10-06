// The browser client: what src/client/client.ts does, over any WalletInterface
// (in the page, the one @1sat/connect returns) and without node:fs. State the
// CLI keeps in ~/.skein/client lives in a `Store` (localStorage in the page).
// The bundle and conversation code is the CLI's own, imported. A message is a
// plain BRC-33 message on the wallet's BRC-104 session with the messagebox
// (src/client/raw.ts RawBox): the session proves who sends it, and nothing in
// it is signed or sealed (#126 step 4; before it, a BRC-169 envelope).

import { AuthFetch, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { RawBox, type Listed } from "../src/client/raw.ts";
import { chunk } from "../src/client/bundle.ts";
import { asConversation, chatBody, conversationFrom, parseReply, type Conversation } from "../src/client/conversation.ts";
import { hashFiles, importOrder, type PickedFile } from "./tree.ts";

export const BOX = { objects: "objects", run: "shell/run", results: "results", chat: "chat" } as const;
/** `run` results, then `chat`: the instance's replies (`replyTo` set), and chats from others. */
export const INBOX = [BOX.results, BOX.chat] as const;

export interface WebConfig {
  /** The instance: its identity key and handle (skein@localhost). */
  instance: { identityKey: string; handle: string; domain: string };
  /** The messagebox, e.g. http://127.0.0.1:8100/messagebox. */
  messageboxUrl: string;
  /** The host root for /account/register, e.g. http://127.0.0.1:8100. */
  hostUrl: string;
  /** The identity key the connected wallet is expected to have (David's Yours key). */
  expectedOwner?: string;
}

export interface Store { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void }

export function memoryStore(): Store {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

export interface Sent { cid: string; box: string; messageId: string; at: string; tree?: string; cmd?: string; text?: string; replyTo?: string }

export interface Result {
  box: string;
  messageId: string;
  cid?: string;
  sender: string;
  /** The sender is the one the messagebox names: proven by the sender's session with it (#126 step 4); nothing in the message is signed. */
  verified: boolean;
  created?: string;
  body?: Record<string, unknown>;
  error?: string;
}

/** What the page needs of a messagebox: RawBox's send, list and ack (a fake in tests). */
export interface Box {
  send(recipient: string, box: string, body: unknown): Promise<{ id: CID }>;
  list(box: string): Promise<Listed[]>;
  ack(ids: string[]): Promise<void>;
}

const CONVERSATION = "skein.conversation";
const SENT = "skein.sent";

export class WebSkein {
  readonly cfg: WebConfig;
  readonly wallet: WalletInterface;
  readonly mb: Box;
  readonly store: Store;

  constructor(cfg: WebConfig, wallet: WalletInterface, store: Store = memoryStore(), mb?: Box) {
    this.cfg = cfg;
    this.wallet = wallet;
    this.store = store;
    this.mb = mb ?? new RawBox(wallet, cfg.messageboxUrl);
  }

  async identityKey(): Promise<string> {
    return (await this.wallet.getPublicKey({ identityKey: true })).publicKey;
  }

  /** POST /account/register {username} over BRC-104. 409 = already registered (or the name is taken): the text says which. */
  async register(username: string): Promise<{ status: number; text: string }> {
    const res = await new AuthFetch(this.wallet).fetch(`${this.cfg.hostUrl}/account/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username }),
    });
    return { status: res.status, text: await res.text() };
  }

  send(box: string, body: unknown, note: Partial<Sent> = {}): Promise<Sent> {
    return this.sendBytes(box, dagCbor.encode(body), note);
  }

  /** The body (dag-cbor) to the instance in `box`: a plain message on the session. Its id is the message's (what a reply names). */
  async sendBytes(box: string, body: Uint8Array, note: Partial<Sent> = {}): Promise<Sent> {
    const { id } = await this.mb.send(this.cfg.instance.identityKey, box, body);
    const sent: Sent = { cid: id.toString(), box, messageId: id.toString(), at: new Date().toISOString(), ...note };
    this.store.set(`${SENT}.${box}`, JSON.stringify(sent));
    return sent;
  }

  /** Hash, bundle (≤1 MiB, blobs first, root tree last) and send each bundle to `objects`. */
  async importFiles(files: PickedFile[], onBundle?: (i: number, n: number, bytes: number) => void): Promise<{ root: CID; records: number; bundles: Sent[] }> {
    const { root, records } = await hashFiles(files);
    const bundles = [...chunk(importOrder(root, records))];
    const sent: Sent[] = [];
    for (const [i, bytes] of bundles.entries()) {
      onBundle?.(i, bundles.length, bytes.length);
      sent.push(await this.sendBytes(BOX.objects, bytes, { tree: root.toString() }));
    }
    return { root, records: records.length, bundles: sent };
  }

  run(args: { tree: string; cmd: string; cwd?: string; env?: Record<string, string> }): Promise<Sent> {
    const body: Record<string, unknown> = { cmd: args.cmd, tree: CID.parse(args.tree) };
    if (args.cwd !== undefined) body.cwd = args.cwd;
    if (args.env !== undefined) body.env = args.env;
    return this.send(BOX.run, body, { tree: args.tree, cmd: args.cmd });
  }

  chat(args: { text: string; tree?: string; model?: string; fresh?: boolean }): Promise<Sent> {
    const body = chatBody(args, this.conversation());
    return this.send(BOX.chat, body, {
      text: args.text,
      ...(body.tree && { tree: body.tree.toString() }),
      ...(body.replyTo && { replyTo: body.replyTo.toString() }),
    });
  }

  conversation(): Conversation | undefined {
    try {
      return asConversation(JSON.parse(this.store.get(CONVERSATION) ?? "null"));
    } catch { return undefined; }
  }

  forgetConversation(): void { this.store.remove(CONVERSATION); }

  lastSent(box: string): Sent | undefined {
    try { return JSON.parse(this.store.get(`${SENT}.${box}`) ?? "null") ?? undefined; } catch { return undefined; }
  }

  /** Read (and by default acknowledge) `results` then `chat`; the newest `chat` reply from the instance becomes the conversation. */
  async inbox(opts: { ack?: boolean } = {}): Promise<Result[]> {
    const out: Result[] = [];
    for (const box of INBOX) {
      const msgs = await this.mb.list(box);
      for (const m of msgs) out.push(this.readOne(box, m));
      if ((opts.ack ?? true) && msgs.length) await this.mb.ack(msgs.map((m) => m.messageId));
    }
    let newest: Conversation | undefined = this.conversation();
    for (const r of out) {
      if (r.box !== BOX.chat || r.error || !r.cid || r.sender !== this.cfg.instance.identityKey || r.body?.replyTo === undefined) continue;
      try {
        const c = conversationFrom(r.cid, parseReply(r.body), r.created, newest);
        if (!newest || c.at >= newest.at) newest = c;
      } catch (e) {
        r.error = (e as Error).message;
      }
    }
    if (newest) this.store.set(CONVERSATION, JSON.stringify(newest));
    return out;
  }

  /** One listed message: its body as sent (dag-cbor), its id the messagebox's (the record's CID). */
  readOne(box: string, m: Listed): Result {
    const r: Result = { box, messageId: m.messageId, cid: m.messageId, sender: m.sender, verified: true };
    if (m.value && typeof m.value === "object" && !(m.value instanceof Uint8Array)) r.body = m.value as Record<string, unknown>;
    else r.error = "the body is not a record";
    return r;
  }
}
