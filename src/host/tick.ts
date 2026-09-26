// The tick provider (docs/MESSAGES.md): the instance's wakes. A thread that
// sleeps rests until an entry stamped at or after its deadline; this provider
// reads the next deadline from the runtime (sleepersDue, cued by onSleep) and,
// at that moment, admits one wake entry for it — stamped with the host's
// clock and signed by the host wallet, like a delivery. Every tick is
// recorded, and there are no idle ticks: an instance with nothing due stays
// asleep. main.ts wires it; tests call fire() instead of waiting for a timer.

import type { CID } from "multiformats/cid";
import type { KeyWallet } from "../runtime/identity.ts";
import { short, stampMs } from "../runtime/log.ts";
import type { Runtime } from "../runtime/scheduler.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { admitEntry, now as clockNow } from "./entry.ts";

export interface TickOptions {
  runtime: Runtime;
  /** The host wallet: signs every wake entry. */
  host: KeyWallet;
  log?: (line: string) => void;
  /** Tests: the clock wakes are stamped with. Default entry.ts's. */
  now?: () => Stamp;
}

export class Tick {
  private readonly o: TickOptions;
  private readonly say: (line: string) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private firing?: Promise<unknown>;
  private stopped = false;

  constructor(o: TickOptions) {
    this.o = o;
    this.say = o.log ?? (() => {});
  }

  private now(): Stamp { return (this.o.now ?? clockNow)(); }

  /** Watch the runtime's sleepers: one timer, for the earliest deadline. Call before the runtime starts. */
  start(): void {
    this.o.runtime.onSleep = () => this.schedule();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.firing;
  }

  /** (Re)arm the timer for the earliest deadline, if there is one. */
  schedule(): void {
    clearTimeout(this.timer);
    const [next] = this.o.runtime.sleepersDue();
    if (!next || this.stopped) return;
    this.timer = setTimeout(() => {
      if (!this.firing) this.firing = this.fire().catch((e) => this.say(`tick: ${(e as Error).message}`)).finally(() => { this.firing = undefined; this.schedule(); });
    }, Math.max(0, next.until - stampMs(this.now())) + 1);
  }

  /**
   * Admit a wake for every sleeper whose deadline has come by now, one entry
   * each, and let the runtime process them. Returns the entries (none if
   * nothing is due).
   */
  async fire(): Promise<CID[]> {
    const t = this.now();
    const out: CID[] = [];
    for (const { thread, until } of this.o.runtime.sleepersDue()) {
      if (until > stampMs(t)) break;
      out.push(await admitEntry(this.o.runtime, this.o.host, { wake: thread }, {}, t));
      this.say(`tick: wake ${short(thread)} as ${short(out.at(-1)!)}`);
    }
    await this.o.runtime.idle();
    return out;
  }
}
