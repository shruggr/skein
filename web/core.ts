// The browser client: what src/client/client.ts does, over any WalletInterface
// (in the page, the one @1sat/connect returns) and without node:fs. State the
// CLI keeps in ~/.skein/client lives in a `Store` (localStorage in the page).
// The envelope, bundle and conversation code is the CLI's own, imported.

import { AuthFetch, type WalletInterface } from "@bsv/sdk";
import { MessageBoxClient } from "@bsv/message-box-client";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { open, seal, verify, type Envelope } from "../src/envelope.ts";
import { chunk } from "../src/client/bundle.ts";
import { chatBody, conversationFrom, parseSay, type Conversation } from "../src/client/conversation.ts";
import { hashFiles, importOrder, type PickedFile } from "./tree.ts";

export const BOX = { objects: "objects", run: "run", results: "results", chat: "chat", say: "say" } as const;
export const INBOX = [BOX.results, BOX.say] as const;

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
  verified: boolean;
  created?: string;
  body?: Record<string, unknown>;
  error?: string;
}

/** The envelope's CID: CIDv1 dag-cbor, sha2-256 of the dag-cbor encoded envelope (client.ts envelopeCid). */
export async function envelopeCid(env: Envelope): Promise<CID> {
  return CID.createV1(dagCbor.code, await sha256.digest(dagCbor.encode(env)));
}

const CONVERSATION = "skein.conversation";
const SENT = "skein.sent";

export class WebSkein {
  readonly cfg: WebConfig;
  readonly wallet: WalletInterface;
  readonly mb: MessageBoxClient;
  readonly store: Store;

  constructor(cfg: WebConfig, wallet: WalletInterface, store: Store = memoryStore(), mb?: MessageBoxClient) {
    this.cfg = cfg;
    this.wallet = wallet;
    this.store = store;
    this.mb = mb ?? new MessageBoxClient({ host: cfg.messageboxUrl, walletClient: wallet });
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

  async sendBytes(box: string, body: Uint8Array, note: Partial<Sent> = {}): Promise<Sent> {
    const env = await seal(this.wallet, { recipient: this.cfg.instance, body });
    const cid = (await envelopeCid(env)).toString();
    const r = await this.mb.sendMessage(
      { recipient: this.cfg.instance.identityKey, messageBox: box, body: env as unknown as Record<string, unknown>, skipEncryption: true },
      this.cfg.messageboxUrl,
    );
    const sent: Sent = { cid, box, messageId: r.messageId, at: new Date().toISOString(), ...note };
    this.store.set(`${SENT}.${box}`, JSON.stringify(sent));
    return sent;
  }

  /** Hash, bundle (≤1 MiB, blobs first, root tree last), seal and send each bundle to `objects`. */
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
      const c = JSON.parse(this.store.get(CONVERSATION) ?? "null") as Conversation | null;
      return c && typeof c.say === "string" ? c : undefined;
    } catch { return undefined; }
  }

  forgetConversation(): void { this.store.remove(CONVERSATION); }

  lastSent(box: string): Sent | undefined {
    try { return JSON.parse(this.store.get(`${SENT}.${box}`) ?? "null") ?? undefined; } catch { return undefined; }
  }

  /** Read (and by default acknowledge) `results` then `say`; the newest verified say becomes the conversation. */
  async inbox(opts: { ack?: boolean } = {}): Promise<Result[]> {
    const out: Result[] = [];
    for (const box of INBOX) {
      const msgs = await this.mb.listMessagesLite({ messageBox: box, host: this.cfg.messageboxUrl });
      for (const m of msgs) out.push(await this.readOne(box, m.messageId, m.sender, m.body));
      if ((opts.ack ?? true) && msgs.length) {
        await this.mb.acknowledgeMessage({ messageIds: msgs.map((m) => m.messageId), host: this.cfg.messageboxUrl });
      }
    }
    let newest: Conversation | undefined = this.conversation();
    for (const r of out) {
      if (r.box !== BOX.say || r.error || !r.cid) continue;
      try {
        const c = conversationFrom(r.cid, parseSay(r.body), r.created);
        if (!newest || c.at >= newest.at) newest = c;
      } catch (e) {
        r.error = (e as Error).message;
      }
    }
    if (newest) this.store.set(CONVERSATION, JSON.stringify(newest));
    return out;
  }

  async readOne(box: string, messageId: string, sender: string, raw: unknown): Promise<Result> {
    const r: Result = { box, messageId, sender, verified: false };
    try {
      const env = (typeof raw === "string" ? JSON.parse(raw) : raw) as Envelope;
      r.created = env.created;
      r.cid = (await envelopeCid(env)).toString();
      r.verified = verify(env);
      if (!r.verified) throw new Error("envelope signature does not verify");
      if (env.sender.identityKey !== sender) throw new Error(`envelope sender ${env.sender.identityKey} is not the messagebox sender ${sender}`);
      const { body } = await open(this.wallet, env);
      r.body = dagCbor.decode(body) as Record<string, unknown>;
    } catch (e) {
      r.error = (e as Error).message;
    }
    return r;
  }
}
