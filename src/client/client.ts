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
import { scan } from "../dev/scan.ts";
import type { TreeBlocks } from "../runtime/tree.ts";
import { chunk, type Rec } from "./bundle.ts";
import type { ClientConfig } from "./config.ts";
import { open, seal, verify, type Envelope } from "./envelope.ts";

export const BOX = { objects: "objects", run: "run", results: "results" } as const;

/** The envelope's CID: CIDv1 dag-cbor, sha2-256 of the dag-cbor encoded envelope. */
export async function envelopeCid(env: Envelope): Promise<CID> {
  return CID.createV1(dagCbor.code, await sha256.digest(dagCbor.encode(env)));
}

/** A directory as git objects held in memory: [root, records]. */
export async function hashDir(dir: string): Promise<{ root: CID; records: Rec[] }> {
  const m = new Map<string, Rec>();
  const blocks: TreeBlocks = {
    has: async (cid) => m.has(cid.toString()),
    bytes: async (cid) => { const r = m.get(cid.toString()); if (!r) throw new Error(`missing ${cid}`); return r.bytes; },
    putBlock: async (cid, bytes) => { m.set(cid.toString(), { cid, bytes }); },
  };
  const root = await scan(blocks, dir);
  return { root, records: [...m.values()] };
}

export interface Sent { cid: string; box: string; messageId: string; at: string; tree?: string; cmd?: string }

export interface Result {
  messageId: string;
  sender: string;
  verified: boolean;
  created?: string;
  body?: Record<string, unknown>;
  error?: string;
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
    const { root, records } = await hashDir(dir);
    // Blobs before trees and the root tree last, so a receiver storing in order
    // never holds a tree whose children have not arrived yet.
    const rootKey = root.toString();
    records.sort((a, b) => rank(a) - rank(b));
    function rank(r: Rec): number {
      if (r.cid.toString() === rootKey) return 2;
      return new TextDecoder().decode(r.bytes.subarray(0, 5)) === "tree " ? 1 : 0;
    }
    const bundles = [...chunk(records)];
    const sent: Sent[] = [];
    for (const [i, bytes] of bundles.entries()) {
      onBundle?.(i, bundles.length, bytes.length);
      // The bundle is already dag-cbor; send it as the body bytes, not re-wrapped.
      sent.push(await this.sendBytes(BOX.objects, bytes, { tree: rootKey }));
    }
    return { root, records: records.length, bundles: sent };
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

  async run(args: { tree: string; cmd: string; cwd?: string; env?: Record<string, string> }): Promise<Sent> {
    const body: Record<string, unknown> = { cmd: args.cmd, tree: CID.parse(args.tree) };
    if (args.cwd !== undefined) body.cwd = args.cwd;
    if (args.env !== undefined) body.env = args.env;
    return this.send(BOX.run, body, { tree: args.tree, cmd: args.cmd });
  }

  /** Read (and by default acknowledge) David's `results` box. */
  async inbox(opts: { ack?: boolean } = {}): Promise<Result[]> {
    const msgs = await this.mb.listMessagesLite({ messageBox: BOX.results, host: this.cfg.messageboxUrl });
    const out: Result[] = [];
    for (const m of msgs) out.push(await this.readOne(m.messageId, m.sender, m.body));
    if ((opts.ack ?? true) && msgs.length) {
      await this.mb.acknowledgeMessage({ messageIds: msgs.map((m) => m.messageId), host: this.cfg.messageboxUrl });
    }
    return out;
  }

  private async readOne(messageId: string, sender: string, raw: unknown): Promise<Result> {
    const r: Result = { messageId, sender, verified: false };
    try {
      const env = (typeof raw === "string" ? JSON.parse(raw) : raw) as Envelope;
      r.created = env.created;
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
