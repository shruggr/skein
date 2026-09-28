// Mail for hosted identities kept in the VM (issue #33): the router's
// MailStore over the keeping instance's messagebox program
// (programs/messagebox). A message is a `mail` log entry {op: "put", …}; an
// acknowledgement a `mail` entry {op: "ack", …}; the program keeps each
// recipient's messages in admission order under the head `mailbox`, and
// listMessages is a read of that record through the kernel — no entry. The
// router waits for the step, so a list right after a send sees it.

import type { CID } from "multiformats/cid";
import type { Stamp } from "../runtime/syscalls.ts";
import { admit2, keyBytes } from "./genesis.ts";
import type { Kernel } from "./kernel.ts";
import type { Mail, MailStore } from "./mail.ts";

export interface VmMailHost {
  /** The instance (handle) that keeps `recipient`'s mail. */
  keeper(recipient: string): string | undefined;
  /** Run `f` with the keeper's kernel, serially with its other admissions. */
  withKernel<T>(handle: string, f: (k: Kernel) => Promise<T>): Promise<T>;
  now(): Stamp;
}

type Kept = { messageId: string; box: string; sender: Uint8Array; body: Uint8Array; json?: boolean; at: number };

export class VmMail implements MailStore {
  private readonly h: VmMailHost;
  constructor(h: VmMailHost) { this.h = h; }

  private keeperOf(recipient: string): string {
    const k = this.h.keeper(recipient);
    if (!k) throw new Error(`no mailbox kept here for ${recipient}`);
    return k;
  }

  private static async kept(k: Kernel, recipient: string): Promise<Kept[]> {
    const root = await k.call("head", "mailbox") as CID | null;
    if (!root) return [];
    const r = await k.store.get(root) as { recipients?: Array<{ identity: Uint8Array; mail: CID }> };
    const me = Buffer.from(recipient, "hex");
    const row = r.recipients?.find((x) => Buffer.from(x.identity).equals(me));
    if (!row) return [];
    return ((await k.store.get(row.mail)) as { messages?: Kept[] }).messages ?? [];
  }

  async put(recipient: string, box: string, m: Mail): Promise<void> {
    const json = !(m.body instanceof Uint8Array);
    const body = json ? new TextEncoder().encode(JSON.stringify(m.body)) : m.body as Uint8Array;
    await this.h.withKernel(this.keeperOf(recipient), async (k) => {
      await admit2(k, { mail: { op: "put", recipient: keyBytes(recipient), box, sender: keyBytes(m.sender), messageId: m.messageId, body, ...(json ? { json: true } : {}) } } as never, {}, this.h.now());
      await k.idle();
    });
  }

  async list(recipient: string, box: string): Promise<Mail[]> {
    return await this.h.withKernel(this.keeperOf(recipient), async (k) => (await VmMail.kept(k, recipient)).filter((x) => x.box === box).map((x) => ({
      messageId: x.messageId,
      sender: Buffer.from(x.sender).toString("hex"),
      body: x.json ? JSON.parse(new TextDecoder().decode(x.body)) : x.body,
      createdAt: new Date(x.at).toISOString(),
    })));
  }

  async ack(recipient: string, messageIds: string[]): Promise<number> {
    return await this.h.withKernel(this.keeperOf(recipient), async (k) => {
      const ids = (await VmMail.kept(k, recipient)).map((x) => x.messageId).filter((id) => messageIds.includes(id));
      if (!ids.length) return 0;
      await admit2(k, { mail: { op: "ack", recipient: keyBytes(recipient), messageIds: ids } } as never, {}, this.h.now());
      await k.idle();
      return ids.length;
    });
  }
}
