// A host service: an effect executor with its own identity. It consumes
// messages addressed to it and answers with signed messages that enter the
// instance like any other input (docs/VM.md "Runtime and host").
//
// Reply bodies share one failure shape across services:
//   { kind: "failed", error: { kind: "cant-do" | "blew-up", message } }
// cant-do: the request itself is wrong, retrying changes nothing.

import type { CID } from "multiformats/cid";
import type { Message } from "../records.ts";
import type { Store } from "../store.ts";
import type { Ref } from "../types.ts";

export interface Request { cid: CID; msg: Message }

export interface HostCtx {
  store: Store;
  log(line: string): void;
  /** Sign `body` as this service, ref the request (`replies-to`), and hand it to the runtime. */
  replyTo(req: Request, body: unknown, refs?: Ref[]): Promise<CID>;
  /** Requests addressed to this service with no reply from it yet, in log order. */
  pending(): AsyncIterable<Request>;
  /** Hand a request to this service's `handle` again, tracked like a fresh dispatch (for recover). */
  redeliver(req: Request): void;
}

export interface ServiceCtx extends HostCtx {
  reply(body: unknown, refs?: Ref[]): Promise<CID>;
}

export interface Service {
  name: string; // also the keyID its identity is derived under
  /** A request arrived. The returned promise settles when the work (and its reply) is done. */
  handle(req: Request, ctx: ServiceCtx): Promise<void>;
  /** On start: answer requests left unanswered by a previous process (run them, or report them lost). */
  recover?(ctx: HostCtx): Promise<void>;
  /** Periodic: timers, checks. */
  tick?(ctx: HostCtx): Promise<void>;
}

export const failed = (kind: "cant-do" | "blew-up", message: string) => ({ kind: "failed", error: { kind, message } });
