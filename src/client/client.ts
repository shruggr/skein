// David's client: a peer that signs as David through his wallet-api and talks
// only to the messagebox (docs/ARCH.md "Everything outside is a peer";
// docs/MESSAGES.md). Every message is a BRC-169 envelope to the instance, sent
// with the messagebox client's own body encryption off.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MessageBoxClient } from "@bsv/message-box-client";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { remoteWallet, type WalletInterface } from "../wallet.ts";
import { scan, type ScanOptions } from "../dev/scan.ts";
import type { TreeBlocks } from "../runtime/tree.ts";
import { chunk, type Rec } from "./bundle.ts";
import type { ClientConfig } from "./config.ts";
import { open, seal, signedPart, verify, type Envelope, type Signed } from "./envelope.ts";
import { chatBody, conversationFrom, loadConversation, parseReply, saveConversation, type Conversation } from "./conversation.ts";

export const BOX = { objects: "objects", run: "run", head: "head", results: "results", chat: "chat" } as const;

/** The boxes David reads, in this order: `run` results, then `chat` (the instance's replies, and chats from others). */
export const INBOX = [BOX.results, BOX.chat] as const;

/** The message's id: CIDv1 dag-cbor, sha2-256 of the dag-cbor encoded signed part (the envelope without `content`). */
export async function envelopeCid(env: Envelope | Signed): Promise<CID> {
  return CID.createV1(dagCbor.code, await sha256.digest(dagCbor.encode(signedPart(env))));
}

/** A directory as git objects held in memory: [root, records]. `opts.ignore` as scan's. */
export async function hashDir(dir: string, opts: ScanOptions = {}): Promise<{ root: CID; records: Rec[] }> {
  const m = new Map<string, Rec>();
  const blocks: TreeBlocks = {
    has: async (cid) => m.has(cid.toString()),
    bytes: async (cid) => { const r = m.get(cid.toString()); if (!r) throw new Error(`missing ${cid}`); return r.bytes; },
    putBlock: async (cid, bytes) => { m.set(cid.toString(), { cid, bytes }); },
  };
  const root = await scan(blocks, dir, opts);
  return { root, records: [...m.values()] };
}

/**
 * A directory as the `objects` box takes it: ≤ 1 MiB bundles, blobs before
 * trees and the root tree last, so a receiver storing in order never holds a
 * tree whose children have not arrived yet; the last bundle names the root.
 * `skip` drops records the receiver already has; if it has the root tree it
 * has everything (trees arrive after their children), and nothing is sent.
 */
export async function dirBundles(dir: string, o: ScanOptions & { limit?: number; skip?: (cid: CID) => Promise<boolean> } = {}): Promise<{ root: CID; records: number; bundles: Uint8Array[] }> {
  const { root, records: all } = await hashDir(dir, o);
  return recordBundles(root, all, o);
}

/** dirBundles for records already in hand (every object of the tree `root`). */
export async function recordBundles(root: CID, all: Rec[], o: { limit?: number; skip?: (cid: CID) => Promise<boolean> } = {}): Promise<{ root: CID; records: number; bundles: Uint8Array[] }> {
  const rootKey = root.toString();
  const records: Rec[] = [];
  if (!(await o.skip?.(root))) for (const r of all) if (r.cid.toString() === rootKey || !(await o.skip?.(r.cid))) records.push(r);
  const rank = (r: Rec) => (r.cid.toString() === rootKey ? 2 : new TextDecoder().decode(r.bytes.subarray(0, 5)) === "tree " ? 1 : 0);
  records.sort((a, b) => rank(a) - rank(b));
  return { root, records: records.length, bundles: [...chunk(records, o.limit, root)] };
}

export interface Sent { cid: string; box: string; messageId: string; at: string; tree?: string; cmd?: string; text?: string; replyTo?: string }

export interface Result {
  box: string;
  messageId: string;
  /** CID of the received envelope (the instance's `chat` reply's CID is the next chat's replyTo). */
  cid?: string;
  sender: string;
  verified: boolean;
  created?: string;
  body?: Record<string, unknown>;
  error?: string;
}

/** A verified `chat` from the instance that is a reply (`replyTo` set): what the next chat continues from. */
export function isInstanceReply(r: Result, instance: string): boolean {
  return r.box === BOX.chat && !r.error && !!r.cid && r.sender === instance && r.body?.replyTo !== undefined;
}

export class SkeinClient {
  readonly cfg: ClientConfig;
  readonly wallet: WalletInterface;
  readonly mb: MessageBoxClient;

  constructor(cfg: ClientConfig, wallet?: WalletInterface) {
    this.cfg = cfg;
    this.wallet = wallet ?? remoteWallet(cfg.walletUrl, cfg.originator);
    this.mb = new MessageBoxClient({ host: cfg.messageboxUrl, walletClient: this.wallet, originator: cfg.originator });
  }

  async identityKey(): Promise<string> {
    return (await this.wallet.getPublicKey({ identityKey: true })).publicKey;
  }

  /** Seal `body` (dag-cbor encoded here) to the instance and deliver it into `box`. */
  send(box: string, body: unknown, note: Partial<Sent> = {}): Promise<Sent> {
    return this.sendBytes(box, dagCbor.encode(body), note);
  }

  async importDir(dir: string, onBundle?: (i: number, n: number, bytes: number) => void): Promise<{ root: CID; records: number; bundles: Sent[] }> {
    const { root, records, bundles } = await dirBundles(dir);
    const rootKey = root.toString();
    const sent: Sent[] = [];
    for (const [i, bytes] of bundles.entries()) {
      onBundle?.(i, bundles.length, bytes.length);
      // The bundle is already dag-cbor; send it as the body bytes, not re-wrapped.
      sent.push(await this.sendBytes(BOX.objects, bytes, { tree: rootKey }));
    }
    return { root, records, bundles: sent };
  }

  /** Seal already-encoded body bytes to the instance and deliver the envelope into `box`. */
  async sendBytes(box: string, body: Uint8Array, note: Partial<Sent> = {}): Promise<Sent> {
    const env = await seal(this.wallet, { recipient: this.cfg.instance, body });
    const cid = (await envelopeCid(env)).toString();
    const r = await this.mb.sendMessage(
      // skipEncryption: the envelope's content is the encryption; the client's
      // own body encryption would hide the envelope metadata (MESSAGES.md).
      { recipient: this.cfg.instance.identityKey, messageBox: box, body: env as unknown as Record<string, unknown>, skipEncryption: true },
      this.cfg.messageboxUrl, // never resolve the host through the overlay
    );
    const sent: Sent = { cid, box, messageId: r.messageId, at: new Date().toISOString(), ...note };
    mkdirSync(this.cfg.stateDir, { recursive: true });
    appendFileSync(join(this.cfg.stateDir, "sent.jsonl"), JSON.stringify(sent) + "\n");
    return sent;
  }

  /** Run a command (box `run`). No tree: the instance's `main` head, else the empty tree. */
  async run(args: { tree?: string; cmd: string; cwd?: string; env?: Record<string, string> }): Promise<Sent> {
    const body: Record<string, unknown> = { cmd: args.cmd };
    if (args.tree !== undefined) body.tree = CID.parse(args.tree);
    if (args.cwd !== undefined) body.cwd = args.cwd;
    if (args.env !== undefined) body.env = args.env;
    return this.send(BOX.run, body, { tree: args.tree, cmd: args.cmd });
  }

  /** Move a named head to a tree the instance holds (box `head`): "`name` is now `tree`". */
  head(name: string, tree: string): Promise<Sent> {
    return this.send(BOX.head, { name, tree: CID.parse(tree) }, { tree });
  }

  /**
   * Chat with the instance (box `chat`). Continues the conversation in
   * conversation.json (replyTo = the instance's last reply, tree defaults to its tree)
   * unless `fresh`.
   */
  chat(args: { text: string; tree?: string; model?: string; fresh?: boolean }): Promise<Sent> {
    const body = chatBody(args, this.conversation());
    return this.send(BOX.chat, body, {
      text: args.text,
      ...(body.tree && { tree: body.tree.toString() }),
      ...(body.replyTo && { replyTo: body.replyTo.toString() }),
    });
  }

  conversation(): Conversation | undefined {
    return loadConversation(this.cfg.stateDir);
  }

  /**
   * Read (and by default acknowledge) David's boxes, `results` then `chat`.
   * The newest well-formed, verified `chat` reply from the instance becomes
   * the conversation state.
   */
  async inbox(opts: { ack?: boolean } = {}): Promise<Result[]> {
    const out: Result[] = [];
    for (const box of INBOX) {
      const msgs = await this.mb.listMessagesLite({ messageBox: box, host: this.cfg.messageboxUrl });
      for (const m of msgs) out.push(await this.readOne(box, m.messageId, m.sender, m.body));
      if ((opts.ack ?? true) && msgs.length) {
        await this.mb.acknowledgeMessage({ messageIds: msgs.map((m) => m.messageId), host: this.cfg.messageboxUrl });
      }
    }
    const prev = this.conversation();
    let newest: Conversation | undefined;
    for (const r of out) {
      if (!isInstanceReply(r, this.cfg.instance.identityKey)) continue;
      try {
        const c = conversationFrom(r.cid!, parseReply(r.body), r.created, newest ?? prev);
        if (!newest || c.at >= newest.at) newest = c;
      } catch (e) {
        r.error = (e as Error).message;
      }
    }
    if (newest) saveConversation(this.cfg.stateDir, newest);
    return out;
  }

  /**
   * Poll the inbox every `intervalMs` until a message in one of `want`'s boxes
   * answers (replyTo) the paired CID; every message read goes to `onResult`.
   * Resolves the matching result, or undefined at the deadline.
   */
  async waitFor(want: { box: string; replyTo: string }[], opts: { timeoutMs: number; intervalMs?: number; ack?: boolean; onResult?: (r: Result) => void }): Promise<Result | undefined> {
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      let hit: Result | undefined;
      for (const r of await this.inbox({ ack: opts.ack })) {
        opts.onResult?.(r);
        if (!hit && r.body && want.some((w) => w.box === r.box && String(r.body!.replyTo) === w.replyTo)) hit = r;
      }
      if (hit) return hit;
      if (Date.now() > deadline) return undefined;
      await new Promise((res) => setTimeout(res, opts.intervalMs ?? 1000));
    }
  }

  private async readOne(box: string, messageId: string, sender: string, raw: unknown): Promise<Result> {
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

  lastSent(box?: string): Sent | undefined {
    let lines: string[];
    try { lines = readFileSync(join(this.cfg.stateDir, "sent.jsonl"), "utf8").trim().split("\n"); } catch { return undefined; }
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = JSON.parse(lines[i]!) as Sent;
      if (!box || s.box === box) return s;
    }
    return undefined;
  }
}
