// Helpers for writing programs. Pure functions of records and the two
// imports; nothing here touches the store, the clock or the network.

import type { CID } from "multiformats/cid";
import { encode, isCID } from "../cid.ts";
import type { ToolDef } from "../chat.ts";
import type { Program } from "../records.ts";
import type { Block, Emission, NodeOrigin, NodeUpdate, Rest, ThreadOrigin, ThreadState, ThreadUpdate } from "../types.ts";
import { PROTOCOL } from "../wallet.ts";
import type { Append, Emit, Placeholder, ProgramContext, ProgramWallet, StepOutput } from "../program.ts";

/** A record's CID, computed (no store needed). */
export const cidOf = (record: unknown): CID => encode(record).cid;

/** The identity a host service signs as: derived under the instance's wallet by name. */
export async function serviceIdentity(wallet: ProgramWallet, name: string): Promise<string> {
  return (await wallet.getPublicKey({ protocolID: PROTOCOL, keyID: name, counterparty: "self" })).publicKey;
}

export function isSettled(state: ThreadState | undefined): boolean {
  return state === "finished" || state === "errored" || state === "out-of-context" || state === "dropped";
}

export function isUpdate(b: ThreadUpdate | ThreadOrigin): b is ThreadUpdate {
  return (b as { kind?: unknown }).kind !== "thread";
}

export interface NodeAt {
  node: CID;          // the origin
  origin: NodeOrigin;
  tip: CID;           // the version read
  emits: Emission[];
  rest?: Rest;
}

/** A node as of one of its versions (origin or update): walks prev back to the origin. */
export async function nodeAt(get: ProgramContext["get"], version: CID): Promise<NodeAt> {
  const emits: Emission[] = [];
  let rest: Rest | undefined;
  let cur = version;
  for (;;) {
    const b = await get<Block>(cur);
    if ((b as NodeOrigin).kind === "node") {
      return { node: cur, origin: b as NodeOrigin, tip: version, emits: emits.reverse(), rest };
    }
    const u = b as NodeUpdate;
    if (u.emit) emits.push(u.emit);
    if (u.rest && !rest) rest = u.rest;
    cur = u.prev;
  }
}

/** The OpenAI tool schema for a program. Inputs of `format: "cid"` are the caller's to fill, not the model's. */
export function toolDef(p: Program): ToolDef {
  const inputs = (p.inputs ?? {}) as { properties?: Record<string, { format?: string }>; required?: string[] };
  const properties = Object.fromEntries(Object.entries(inputs.properties ?? {}).filter(([, s]) => s?.format !== "cid"));
  const required = (inputs.required ?? []).filter((k) => k in properties);
  return { type: "function", function: { name: p.name, description: p.description, parameters: { ...inputs, type: "object", properties, required } } };
}

/** Accumulates a step's output; returns placeholders for what it will produce. */
export class Out {
  readonly append: Append[] = [];
  readonly emit: Emit[] = [];

  open(block: Record<string, unknown>): Placeholder {
    this.append.push({ open: block as Block });
    return { $ref: this.append.length - 1 };
  }

  add(origin: CID | Placeholder, body: Record<string, unknown>): Placeholder {
    this.append.push({ origin, body });
    return { $ref: this.append.length - 1 };
  }

  send(to: string, body: unknown, refs?: Emit["refs"]): Placeholder {
    this.emit.push(refs ? { to, body, refs } : { to, body });
    return { $msg: this.emit.length - 1 };
  }

  done(): StepOutput {
    return { append: this.append, emit: this.emit };
  }
}

export const NOTHING: StepOutput = { append: [], emit: [] };

/** dag-cbor has no undefined: drop absent optionals (CIDs and placeholders pass through). */
export function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(compact) as T;
  if (v && typeof v === "object" && !isCID(v) && !(v instanceof Uint8Array) && Object.getPrototypeOf(v) === Object.prototype) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = compact(x);
    return o as T;
  }
  return v;
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !isCID(v) && !(v instanceof Uint8Array);
