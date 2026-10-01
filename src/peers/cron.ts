// A remote cron service (#69): the cron provider as a peer of its own,
// reached by mailbox. An instance whose address book names the cron
// provider's key with transport `mailbox` (its messagebox URL) emits its tick
// requests exactly as it would to the host's own (`local`) cron provider:
// the instance's delivery thread carries each over BRC-103/104 into the
// service's mailbox instance; the program does not know which it talks to.
//
// The service collects its `cron` box there (raw BRC-33 on a BRC-104
// session as its own key, like the inference peer: src/peers/infer.ts),
// keeps the schedules (src/host/cron.ts: the same `Cron` the host's provider
// runs; the instance is the sender's key) and answers each request — and
// sends each tick — at the sender's messagebox, on a session of its own: a
// message from the service's key, `replyTo` the request's id for an answer,
// none for a tick. Where a sender's messagebox is comes from the service's
// own address book (its admin's: `addressOf`); a request from a key it does
// not know has nowhere to go and is dropped with one line.

import { CID } from "multiformats/cid";
import type { Listed } from "../client/raw.ts";
import { Cron, type ScheduleStore } from "../host/cron.ts";

export interface CronPeerOptions {
  /** Its mailbox instance (a RawBox as the service's key): requests arrive in box `cron`. */
  inbox: { list(box: string): Promise<Listed[]>; ack(ids: string[]): Promise<void> };
  /** A session with the messagebox at `url` (a RawBox as the service's key). */
  outbox(url: string): { send(recipient: string, box: string, body: unknown): Promise<unknown> };
  /** Its address book: the messagebox URL of the sender `key`; undefined: no route. */
  addressOf(key: string): string | undefined;
  /** The clock (ms); default Date.now. */
  now?(): number;
  /** Where the schedules are kept (default memory). */
  store?: ScheduleStore;
  log?(line: string): void;
}

const short = (s: string) => s.slice(-8);

export class CronPeer {
  readonly o: CronPeerOptions;
  readonly cron: Cron;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<unknown>;

  constructor(o: CronPeerOptions) {
    this.o = o;
    this.cron = new Cron({
      now: () => (o.now ?? Date.now)(), store: o.store, log: (_s, l) => this.say(l),
      tick: async (s, body) => {
        const url = this.o.addressOf(s.recipient);
        if (!url) throw new Error(`no route to ${short(s.recipient)}`);
        await this.o.outbox(url).send(s.recipient, s.box, body);
      },
    });
  }

  private say(line: string): void { this.o.log?.(line); }

  /** Take up the kept schedules, and collect the `cron` box every `ms`. */
  start(ms = 1000): void {
    this.cron.start();
    const tick = () => { if (!this.polling) this.polling = this.poll().catch((e) => this.say(`cron: ${(e as Error).message}`)).finally(() => { this.polling = undefined; }); };
    tick();
    this.timer = setInterval(tick, ms);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.polling;
    await this.cron.stop();
  }

  /** Collect the `cron` box once: each request answered at its sender's messagebox, then acknowledged. How many were answered. */
  async poll(): Promise<number> {
    let n = 0;
    for (const m of await this.o.inbox.list("cron")) {
      const url = this.o.addressOf(m.sender);
      if (!url) {
        this.say(`cron ${short(m.messageId)} from ${short(m.sender)}: no route: ${m.sender} is not in the address book; dropped`);
        await this.o.inbox.ack([m.messageId]);
        continue;
      }
      const answer = this.cron.request(m.sender, m.sender, m.messageId, m.value);
      try {
        await this.o.outbox(url).send(m.sender, "cron", { replyTo: CID.parse(m.messageId), ...answer });
        n++;
      } catch (e) {
        this.say(`cron ${short(m.messageId)}: answer to ${url}: ${(e as Error).message} (left unacknowledged)`);
        continue;
      }
      await this.o.inbox.ack([m.messageId]);
    }
    return n;
  }
}
