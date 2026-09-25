// Instance setup and the owner's voice.
//
// An instance's log opens with admin-signed messages: the genesis, then the
// default subscriptions (docs/VM.md "Subscriptions"), tried in this order:
//
//   1. {from: owner, kind: "prompt", body: {new: true}} → loop   a prompt that asks for a new session
//   2. {from: owner, kind: "prompt"}                    → resolve-waiter   continue the waiting session
//   3. {from: owner, kind: "prompt"}                    → loop   …or, with none waiting, start one
//   4. {from: clock}                                    → resolve-waiter
//   5. {from: inference}, 6. {from: execution}          → resolve-waiter   service replies
//
// (4–6 are needed because delivery is only ever by subscription: a service's
// reply to a thread is routed like any other message.)
//
// The owner is, for now, an identity derived from the instance's own wallet
// (`signerFor(wallet, "david")`), so the CLI and tests can speak for David.
// Once the Yours extension is wired his lines are signed by his wallet and
// the owner identity in these subscriptions is his key.

import type { CID } from "multiformats/cid";
import type { WalletInterface } from "@bsv/sdk";
import { encode } from "./cid.ts";
import { genesis, isGenesis, signMessage, subscription, type Message, type Subscription, type SubscriptionMatch } from "./records.ts";
import type { Store } from "./store.ts";
import type { Ms, Ref } from "./types.ts";
import { PROGRAM_RECORDS, LOOP_CID } from "./programs/records.ts";
import { identityOf, rootIdentity, signerFor, type Signer } from "./wallet.ts";
import type { Thinking } from "./chat.ts";
import type { Runtime } from "./runtime.ts";

export interface InstanceOptions {
  admin?: string;       // keyID, default "admin"
  owner?: string;       // keyID, default "david"
  name?: string;        // the genesis name
  at?: Ms;              // the instance's birth time (replay passes the original's)
  runtime?: Runtime;    // deliver through it (serialised with services) rather than straight to the store
}

export interface Instance { admin: string; owner: string; genesis: CID; created: boolean }

/** Write genesis, program records and default subscriptions, unless the store already has a genesis from this admin. */
export async function initInstance(store: Store, wallet: WalletInterface, o: InstanceOptions = {}): Promise<Instance> {
  const admin = await signerFor(wallet, o.admin ?? "admin");
  const owner = await identityOf(wallet, o.owner ?? "david");
  for (const p of PROGRAM_RECORDS) await store.put(p);
  for await (const c of store.edges.query({ kind: "message", from: admin.identity })) {
    const m = await store.get<Message>(c);
    if (m.seq === 0 && isGenesis(m.body)) return { admin: admin.identity, owner, genesis: c, created: false };
  }
  const at = o.at ?? Date.now();
  const [clock, inference, execution] = await Promise.all(["clock", "inference", "execution"].map((n) => identityOf(wallet, n)));
  const bodies: unknown[] = [
    genesis(await rootIdentity(wallet), o.name, at),
    subscription({ from: owner, kind: "prompt", body: { new: true } }, LOOP_CID, at),
    subscription({ from: owner, kind: "prompt" }, "resolve-waiter", at),
    subscription({ from: owner, kind: "prompt" }, LOOP_CID, at),
    subscription({ from: clock }, "resolve-waiter", at),
    subscription({ from: inference }, "resolve-waiter", at),
    subscription({ from: execution }, "resolve-waiter", at),
  ];
  let first: CID | undefined;
  for (const [seq, body] of bodies.entries()) {
    const cid = await deliver(store, await signMessage(admin, { seq, at, body }), o.runtime);
    first ??= cid;
  }
  return { admin: admin.identity, owner, genesis: first!, created: true };
}

export interface SayOptions {
  thread?: CID;         // reply to this thread (a `replies-to` ref); default: the waiting session, else a new one
  new?: boolean;        // always start a new session
  model?: string;       // for a new session: "provider/model"
  thinking?: Thinking;
  system?: string;
  owner?: string;       // keyID, default "david"
  runtime?: Runtime;
  at?: Ms;
}

/** Sign a prompt as the owner and put it in the log. Without a runtime, a daemon's next poll picks it up. */
export function ownerSay(store: Store, wallet: WalletInterface, text: string, o: SayOptions = {}): Promise<{ cid: CID; message: Message }> {
  const body = {
    kind: "prompt", text,
    ...(o.new ? { new: true } : {}),
    ...(o.model ? { model: o.model } : {}), ...(o.thinking ? { thinking: o.thinking } : {}), ...(o.system ? { system: o.system } : {}),
  };
  return speak(store, wallet, o.owner ?? "david", body, { refs: o.thread ? [{ to: o.thread, rel: "replies-to" }] : [], runtime: o.runtime, at: o.at });
}

/** Sign `body` as the identity `keyID` derives to, at its next seq, and deliver it. */
export async function speak(store: Store, wallet: WalletInterface, keyID: string, body: unknown, o: { to?: string; refs?: Ref[]; runtime?: Runtime; at?: Ms } = {}): Promise<{ cid: CID; message: Message }> {
  const signer = await signerFor(wallet, keyID);
  // A concurrent writer (another CLI) can take the same seq; the store refuses the second, so retry.
  for (let tries = 0; ; tries++) {
    const message = await signMessage(signer, { to: o.to, seq: await nextSeq(store, signer), at: o.at, body, refs: o.refs });
    try {
      return { cid: await deliver(store, message, o.runtime), message };
    } catch (e) {
      if (tries >= 3 || (e as { reason?: string }).reason !== "duplicate-seq") throw e;
    }
  }
}

/** Admin: add a subscription (it applies from its place in the log on). */
export function subscribe(store: Store, wallet: WalletInterface, match: SubscriptionMatch, handler: Subscription["handler"], o: { admin?: string; runtime?: Runtime } = {}) {
  return speak(store, wallet, o.admin ?? "admin", subscription(match, handler), { runtime: o.runtime });
}

async function nextSeq(store: Store, s: Signer): Promise<number> {
  let max = -1;
  for await (const c of store.edges.query({ kind: "message", from: s.identity })) max = Math.max(max, (await store.get<Message>(c)).seq);
  return max + 1;
}

async function deliver(store: Store, m: Message, runtime?: Runtime): Promise<CID> {
  if (runtime) return runtime.ingest(m);
  await store.putMessage(m);
  return encode(m).cid;
}
