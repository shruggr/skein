// David's client: a peer that signs as David through his wallet-api (docs/ARCH.md
// "Everything outside is a peer"; docs/MESSAGES.md). It speaks raw BRC-33 on a
// BRC-104 session (#40, raw.ts): a message is sent to the instance's own front
// door (its URL: the instance is an HTTP server), and David's boxes are read
// from his mailbox — the mailbox instance the instance delivers to (the one
// peer its genesis names, etc/config.json `owner.messagebox`). No envelope: the
// session proves who sends; a message's id is its record's CID, which a reply's
// `replyTo` names.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { remoteWallet, type WalletInterface } from "../wallet.ts";
import { scan, type ScanOptions } from "../dev/scan.ts";
import type { TreeBlocks } from "../runtime/tree.ts";
import { chunk, type Rec } from "./bundle.ts";
import type { ClientConfig } from "./config.ts";
import { RawBox } from "./raw.ts";
import { chatBody, conversationFrom, loadConversation, parseReply, saveConversation, type Conversation } from "./conversation.ts";

export const BOX = { objects: "objects", run: "run", head: "head", dispatch: "dispatch", results: "results", chat: "chat" } as const;

/** The boxes David reads, in this order: `run` results, then `chat` (the instance's replies, and chats from others). */
export const INBOX = [BOX.results, BOX.chat] as const;

/** A dispatch table change for a mailbox row: (sender — anyone when absent, else an identity key in hex —, box) → handler. */
export interface DispatchArgs { op: "add" | "remove"; sender?: string; box: string; handler: string }

/**
 * A handler: a program record's CID, or the name of one in `programs` (an
 * instance's genesis `programs`: name → record CID, as skein-host reads it
 * from the store; the client has no store, so it takes CIDs).
 */
export function handlerCid(s: string, programs: Record<string, CID> = {}): CID {
  const named = programs[s];
  if (named) return named;
  try { return CID.parse(s); } catch {
    const names = Object.keys(programs);
    throw new Error(`handler ${JSON.stringify(s)}: not a CID${names.length ? ` or a program name (${names.join(", ")})` : " (a program by name needs the instance's genesis: skein plan dispatch)"}`);
  }
}

/**
 * The kernel's `dispatch` operation's body (box `dispatch`, from the owner):
 * {op, row} with row a mailbox row {transport, address: box, sender: "*" or
 * the key's 33 bytes, program}; a handler named from `programs` (handlerCid).
 */
export function dispatchBody(a: DispatchArgs, programs: Record<string, CID> = {}): { op: "add" | "remove"; row: Record<string, unknown> } {
  return { op: a.op, row: { transport: "mailbox", address: a.box, sender: a.sender ? senderKey(a.sender) : "*", program: handlerCid(a.handler, programs) } };
}

export function senderKey(hex: string): Uint8Array {
  if (!/^0[23][0-9a-f]{64}$/i.test(hex)) throw new Error(`sender ${JSON.stringify(hex)}: not an identity key (33 bytes, hex)`);
  return new Uint8Array(Buffer.from(hex, "hex"));
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
  /** The message's id as a CID (the instance's `chat` reply's is the next chat's replyTo). */
  cid?: string;
  sender: string;
  /** Always true: the sender is the BRC-104 session's identity, which the mailbox checked. */
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
  /** The instance's front door. */
  readonly toInstance: RawBox;
  /** David's mailbox (instance). */
  readonly mailbox: RawBox;

  constructor(cfg: ClientConfig, wallet?: WalletInterface, o: { fetch?: typeof fetch } = {}) {
    this.cfg = cfg;
    this.wallet = wallet ?? remoteWallet(cfg.walletUrl, cfg.originator);
    this.toInstance = new RawBox(this.wallet, cfg.instanceUrl, { originator: cfg.originator, fetch: o.fetch });
    this.mailbox = new RawBox(this.wallet, cfg.mailboxUrl, { originator: cfg.originator, fetch: o.fetch });
  }

  async identityKey(): Promise<string> {
    return (await this.wallet.getPublicKey({ identityKey: true })).publicKey;
  }

  /** Send `body` (dag-cbor encoded here) to the instance's `box`. */
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

  /** Send already-encoded body bytes (dag-cbor) to the instance's `box`: its front door's sendMessage. */
  async sendBytes(box: string, body: Uint8Array, note: Partial<Sent> = {}): Promise<Sent> {
    const { id } = await this.toInstance.send(this.cfg.instance.identityKey, box, body);
    const cid = id.toString();
    const sent: Sent = { cid, box, messageId: cid, at: new Date().toISOString(), ...note };
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

  /** Change the instance's dispatch table (box `dispatch`, a kernel operation): add or remove the mailbox row (sender, box) → handler. No reply. */
  dispatch(a: DispatchArgs): Promise<Sent> {
    return this.send(BOX.dispatch, dispatchBody(a));
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
      const msgs = await this.mailbox.list(box);
      for (const m of msgs) {
        const r: Result = { box, messageId: m.messageId, cid: m.messageId, sender: m.sender, verified: true };
        if (m.value && typeof m.value === "object" && !Array.isArray(m.value) && !(m.value instanceof Uint8Array)) r.body = m.value as Record<string, unknown>;
        else r.error = "the body is not a record";
        out.push(r);
      }
      if ((opts.ack ?? true) && msgs.length) await this.mailbox.ack(msgs.map((m) => m.messageId));
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
