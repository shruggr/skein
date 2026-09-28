// Mail for hosted identities that are not instances (the owner's wallet, the
// inference peer, …): BRC-33 `listMessages`/`acknowledgeMessage` read and
// delete it, in arrival order. `MailStore` is the router's view of it; where
// the records live is the implementation's business (issue #33 puts them in
// the keeping instance's log: vmmail.ts).

export interface Mail {
  messageId: string;
  sender: string;
  /** The BRC-33 `body` exactly as the sender submitted it (a JSON value; bytes for BRC-231). */
  body: unknown;
  createdAt: string;
}

export interface MailStore {
  put(recipient: string, box: string, m: Mail): Promise<void>;
  list(recipient: string, box: string): Promise<Mail[]>;
  /** Delete these of the recipient's messages; how many there were. */
  ack(recipient: string, messageIds: string[]): Promise<number>;
}

/** In memory: tests, and the interim before the mailbox program. */
export function memoryMail(): MailStore {
  const boxes = new Map<string, Array<Mail & { box: string }>>();
  return {
    async put(recipient, box, m) {
      const l = boxes.get(recipient) ?? [];
      if (!l.some((x) => x.messageId === m.messageId)) l.push({ ...m, box });
      boxes.set(recipient, l);
    },
    async list(recipient, box) { return (boxes.get(recipient) ?? []).filter((m) => m.box === box).map(({ box: _b, ...m }) => m); },
    async ack(recipient, ids) {
      const l = boxes.get(recipient) ?? [];
      const keep = l.filter((m) => !ids.includes(m.messageId));
      boxes.set(recipient, keep);
      return l.length - keep.length;
    },
  };
}
