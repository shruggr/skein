// The writes a person makes: start a session, answer a waiting one. Shared by
// the CLI and the web API. Both are owner-signed prompt messages
// (instance.ts); the runtime routes them by subscription.

import type { CID } from "multiformats/cid";
import type { WalletInterface } from "@bsv/sdk";
import { encode } from "./cid.ts";
import { THINKING, type Thinking } from "./chat.ts";
import { ownerSay } from "./instance.ts";
import { LOOP_CID } from "./programs/records.ts";
import type { Message } from "./records.ts";
import type { Runtime } from "./runtime.ts";
import type { Store } from "./store.ts";
import { short, threadOf, waitingOnPerson } from "./view.ts";

export { THINKING };

/** A request that can't be carried out as asked (bad input, nothing to reply to). Not a server fault. */
export class Refused extends Error {}

export interface NewThread { prompt: string; model?: string; thinking?: string; system?: string }

/**
 * Start a session: a prompt with `new: true`, which the default subscriptions
 * hand to a fresh loop thread. Returns that thread's CID, known before the
 * runtime opens it: the thread origin is a pure function of the message.
 */
export async function newThread(store: Store, wallet: WalletInterface, o: NewThread, runtime?: Runtime): Promise<{ thread: CID; message: CID }> {
  if (!o.prompt?.trim()) throw new Refused("a prompt is required");
  if (o.thinking && !THINKING.includes(o.thinking as Thinking)) throw new Refused(`thinking must be one of ${THINKING.join("|")}`);
  if (o.model && !/^[^/]+\/.+/.test(o.model)) throw new Refused(`model must be "provider/model": ${o.model}`);
  const { cid, message } = await ownerSay(store, wallet, o.prompt, {
    new: true, model: o.model || undefined, thinking: (o.thinking || undefined) as Thinking | undefined, system: o.system || undefined, runtime,
  });
  return { thread: sessionThread(cid, message), message: cid };
}

/** The loop thread the runtime opens for a session-starting message. */
export function sessionThread(cid: CID, m: Message): CID {
  return encode({ kind: "thread", program: LOOP_CID, args: m.body, launchedBy: cid, at: m.at }).cid;
}

/** Answer the thread `cid` names (or the thread of the node it names), which must be waiting on its person. */
export async function reply(store: Store, wallet: WalletInterface, cid: CID, text: string, runtime?: Runtime): Promise<{ thread: CID; message: CID }> {
  if (!text.trim()) throw new Refused("a reply needs text");
  const thread = await threadOf(store, cid);
  if (!thread || !(await waitingOnPerson(store, thread))) throw new Refused(`${short(cid)} is not waiting on David`);
  const { cid: message } = await ownerSay(store, wallet, text, { thread, runtime });
  return { thread, message };
}
