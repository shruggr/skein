// The program ABI (docs/VM.md "Tools"). A program is a `Program` record; its
// code is a step function the runtime calls whenever something wakes one of
// its threads. The step reads the graph through exactly two imports — `get`
// and a narrowed wallet — and answers with what to write and what to send.
// It has no clock, no store writes, no network: everything it knows arrives
// as records, and everything it does leaves as records and messages, which
// is what lets the runtime replay it.
//
// Output and `$ref`. The runtime applies `append` entries in order: an
// `{open}` entry opens a chain (the origin's CID is its result), an
// `{origin, body}` entry appends an update (the update's CID is its result).
// Anywhere inside an entry — the block, the origin, the body — or inside an
// emit's body or refs, the value `{ $ref: i }` stands for the result of
// append entry i, and `{ $msg: j }` for the CID of emit j once signed. An
// append may only $ref entries before it; emits may $ref any entry. So one
// step can open a thread, emit `launched` naming it, and send a message that
// the node records as `sent`. The runtime stamps `at` (log time) on every
// update and on any opened block that lacks one: programs never read a clock.

import type { CID } from "multiformats/cid";
import type { WalletInterface } from "@bsv/sdk";
import type { Block, Ref, ThreadOrigin, ThreadUpdate } from "./types.ts";
import type { Message, Program } from "./records.ts";
import { REGISTRY } from "./programs/index.ts";

/** What a program may do with the instance's wallet. Signing its messages is the runtime's job. */
export type ProgramWallet = Pick<WalletInterface, "createSignature" | "verifySignature" | "encrypt" | "decrypt" | "getPublicKey">;

/** A program's two imports. */
export interface ProgramContext {
  get<T extends Block = Block>(cid: CID): Promise<T>;
  wallet: ProgramWallet;
}

export interface StepInput {
  thread: CID;
  /** The thread's latest update, or its origin if it has never been stepped. */
  tip: ThreadUpdate | ThreadOrigin;
  /** The message that woke it, if one did. Its CID is cidOf(message). */
  message?: Message;
  /** The settled tips (thread *updates*, so `get` reads their state) of threads it waited on, if that woke it. */
  resolved?: CID[];
}

/** `{ $ref: i }`: the result of append entry i. `{ $msg: j }`: the CID of emit j. */
export type Placeholder = { $ref: number } | { $msg: number };

export type Append =
  | { origin: CID | Placeholder; body: Record<string, unknown> }
  | { open: Block };

export interface Emit {
  to: string;         // an identity (compressed pubkey hex)
  body: unknown;
  refs?: Ref[];       // the runtime adds {to: thread, rel: "from-thread"}
}

export interface StepOutput {
  append: Append[];
  emit: Emit[];
}

export interface ProgramImpl {
  step(input: StepInput, ctx: ProgramContext): Promise<StepOutput>;
}

export function loadProgram(record: Program): ProgramImpl {
  const code = record.code;
  if ("ts" in code) {
    const impl = REGISTRY[code.ts];
    if (!impl) throw new Error(`no TS program "${code.ts}" in src/programs/index.ts`);
    return impl;
  }
  // A wasm program is a record holding the module's bytes; instantiate it with
  // `get` and the wallet as its only imports and call its exported step.
  throw new Error("wasm loader not implemented");
}
