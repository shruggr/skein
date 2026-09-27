// Many instances in one host process (#23): the kernel configuration of
// main.ts, once per management-database row (instances.ts). Each instance gets
// its own store, runtime (scheduler), wallet, messagebox session and delivery
// provider, and tick; they share nothing but the host wallet, which signs every
// log entry for all of them (#9: the host's identity is the genesis's `host`).
// A new instance's genesis is main.ts's plus an open `chat` subscription:
// anyone may open a conversation with it (#24, item 3). Replies to what it sent
// are matched before subscriptions — another agent's reply arrives in `chat`
// with `replyTo`, and resumes the thread that awaits it instead of opening a
// new one — so agent↔agent needs nothing more than the resolver: a handle →
// the identity key its `message` is sealed to.

import type { WalletInterface } from "@bsv/sdk";
import { rootIdentity, type KeyWallet } from "../runtime/identity.ts";
import { defaultSubscriptions, genesisOf, OPEN_CHAT, short, type InstanceConfig } from "../runtime/log.ts";
import { isIdentity, type Identity } from "../runtime/records.ts";
import { Runtime } from "../runtime/scheduler.ts";
import type { Store } from "../runtime/store.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { ensureGenesis } from "./entry.ts";
import type { InstanceRow } from "./instances.ts";
import { Delivery, type MessageBox } from "./messagebox.ts";
import { Tick } from "./tick.ts";

type Named = { handle: string; domain: string };

export interface HostOptions {
  /** The host wallet: signs every entry of every instance. */
  host: KeyWallet;
  /** A new instance's owner (its genesis `owner`); needed only to write a genesis. */
  owner?: Identity;
  /** The inference peer (a new genesis's `peers.infer`). */
  infer?: Identity;
  /** A new genesis's names for the owner and the peer (what outbound envelopes call them). Default david@localhost, infer@localhost. */
  ownerHandle?: Named;
  inferHandle?: Named;
  /** The row's instance wallet. */
  wallet(row: InstanceRow): Promise<WalletInterface>;
  /** The row's store, opened (the modules installed). */
  store(row: InstanceRow): Promise<Store>;
  /** A messagebox session as the row's wallet; absent: no delivery provider. */
  box?(row: InstanceRow, wallet: WalletInterface): MessageBox;
  /** Handle → identity key for the runtime's `resolve` (hostResolver); "" when unknown. Absent: every resolve fails. */
  resolve?(handle: string, domain: string): Promise<string>;
  /** Delivery poll interval; 0 = do not poll (tests call delivery.poll()). Default 1000. */
  pollMs?: number;
  /** Lines, prefixed by the caller. */
  log?(handle: string, line: string): void;
  /** Tests: the clock entries are stamped with. */
  now?: () => Stamp;
}

/** A new instance's genesis config for a row: the owner's boxes, then `chat` from anyone; the owner's and the peer's names. */
export function configFor(row: Pick<InstanceRow, "handle" | "domain">, o: { owner: Identity; infer?: Identity; ownerHandle?: Named; inferHandle?: Named }): InstanceConfig {
  return {
    owner: o.owner, handle: row.handle, domain: row.domain,
    subscriptions: [...defaultSubscriptions(o.owner), OPEN_CHAT],
    peers: o.infer ? { infer: o.infer } : undefined,
    names: {
      [o.owner]: o.ownerHandle ?? { handle: "david", domain: "localhost" },
      ...(o.infer ? { [o.infer]: o.inferHandle ?? { handle: "infer", domain: "localhost" } } : {}),
    },
  };
}

export interface Running {
  row: InstanceRow;
  identity: Identity;
  store: Store;
  runtime: Runtime;
  tick: Tick;
  delivery?: Delivery;
  stop(): Promise<void>;
}

/**
 * Start one row: connect its wallet, open its store, write its genesis if the
 * store is empty, and wire its runtime to its own providers. Refuses a row
 * whose wallet is not the recorded identity or the genesis's, or whose genesis
 * names another host.
 */
export async function startInstance(row: InstanceRow, o: HostOptions): Promise<Running> {
  const say = (line: string) => o.log?.(row.handle, line);
  const wallet = await o.wallet(row);
  const identity = await rootIdentity(wallet);
  if (row.identity && row.identity !== identity) throw new Error(`wallet ${row.wallet_url} is ${short(identity)}, not the recorded identity ${short(row.identity)}`);
  const store = await o.store(row);
  try {
    if (!(await store.log.tip())) {
      if (!o.owner) throw new Error("an empty store needs the owner's identity key (SKEIN_OWNER) for its genesis");
      const g = await ensureGenesis(store, wallet, o.host, configFor(row, { ...o, owner: o.owner }), o.now?.());
      say(`genesis ${g.entry}`);
    }
    const g = await genesisOf(store);
    const hostKey = await rootIdentity(o.host);
    if (g.host !== hostKey) throw new Error(`the host wallet (${short(hostKey)}) is not this instance's host (${short(g.host)}): its entries would not verify`);
    if (g.identity !== identity) throw new Error(`the wallet (${short(identity)}) is not this instance's identity (${short(g.identity)})`);

    const runtime = new Runtime({ store, wallet, log: say });
    // runtime.resolver (the `resolve` import's Resolver), set untyped so this builds on a runtime without it.
    if (o.resolve) Object.assign(runtime, { resolver: { resolve: o.resolve } });
    const tick = new Tick({ runtime, host: o.host, log: say, now: o.now });
    tick.start();
    let delivery: Delivery | undefined;
    if (o.box) {
      delivery = new Delivery({ runtime, wallet, host: o.host, box: o.box(row, wallet), log: say, now: o.now });
      runtime.outbox = delivery;
    } else {
      say("no messagebox (SKEIN_MESSAGEBOX): nothing will be delivered");
    }
    await runtime.start();
    const poll = o.pollMs ?? 1000;
    if (delivery && poll > 0) delivery.start(poll);
    say(`${g.identity} (${g.handle}@${g.domain}) · owner ${short(g.owner)}${g.peers?.infer ? ` · infer ${short(g.peers.infer)}` : ""} · boxes ${(await runtime.boxes()).join(",")} · state ${(await runtime.tip())?.toString()}`);
    return {
      row, identity, store, runtime, tick, delivery,
      async stop() { await tick.stop(); await delivery?.stop(); await runtime.stop(); await store.close(); },
    };
  } catch (e) {
    await store.close();
    throw e;
  }
}

/**
 * The host's resolver: its own rows first (`rows`, e.g. HostDb.identityOf),
 * then the messagebox host's paymail PKI (`<origin>/bsvalias/id/handle@domain`,
 * which `1sat serve` answers for every registered account); "" if neither
 * knows the handle.
 */
export function hostResolver(rows: (handle: string, domain: string) => string | null | undefined, messagebox?: string, f: typeof fetch = fetch): (handle: string, domain: string) => Promise<string> {
  const origin = messagebox ? new URL(messagebox).origin : undefined;
  return async (handle, domain) => {
    const known = rows(handle, domain);
    if (known) return known;
    if (!origin) return "";
    const res = await f(`${origin}/bsvalias/id/${encodeURIComponent(handle)}@${encodeURIComponent(domain)}`);
    if (!res.ok) return "";
    const { pubkey } = (await res.json()) as { pubkey?: unknown };
    return typeof pubkey === "string" && isIdentity(pubkey) ? pubkey : "";
  };
}
