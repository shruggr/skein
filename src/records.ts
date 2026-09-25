// v2 record kinds (docs/VM.md): message, program, subscription, genesis.
// Types, not interfaces, so they satisfy Block's index signature.
// Thread/node shapes stay in types.ts and are re-exported so v2 code has one
// import. Validators are structural; a message is only trusted once
// verifyMessage passes, which needs nothing but the record itself.

import { createHash } from "node:crypto";
import { PublicKey, Signature } from "@bsv/sdk";
import { CID, decode, encode, isCID } from "./cid.ts";
import type { Ms, Ref } from "./types.ts";
import type { Signer } from "./wallet.ts";

export type * from "./types.ts";

/** A compressed secp256k1 public key, hex. */
export type Identity = string;

const IDENTITY = /^0[23][0-9a-f]{64}$/;
export const isIdentity = (x: unknown): x is Identity => typeof x === "string" && IDENTITY.test(x);

// ---------------------------------------------------------------- message

export type Message = {
  kind: "message";
  from: Identity;
  to?: string;      // an identity, or a handle (BRC-169) the host resolves
  seq: number;      // per `from`; the store refuses a second record at the same seq
  at: Ms;
  body: unknown;
  refs: Ref[];
  sig: Uint8Array;  // DER ECDSA over messageDigest(this)
};

export type UnsignedMessage = Omit<Message, "sig">;

/** The signed bytes: dag-cbor of the record with `sig` removed (every other field is covered). */
export function messageBytes(m: UnsignedMessage | Message): Uint8Array {
  const { sig: _, ...rest } = m as Message;
  return encode(rest).bytes;
}

/** What ECDSA signs: sha256(messageBytes(m)). */
export function messageDigest(m: UnsignedMessage | Message): Uint8Array {
  return new Uint8Array(createHash("sha256").update(messageBytes(m)).digest());
}

export async function signMessage(
  signer: Signer,
  m: { to?: string; seq: number; body: unknown; refs?: Ref[]; at?: Ms },
): Promise<Message> {
  // Round-trip through dag-cbor so the record we return is exactly what gets
  // stored and re-encoded at verify time (undefined dropped, CIDs canonical).
  const unsigned = decode<UnsignedMessage>(encode({
    kind: "message", from: signer.identity, to: m.to, seq: m.seq, at: m.at ?? Date.now(), body: m.body, refs: m.refs ?? [],
  }).bytes);
  if (!isMessage({ ...unsigned, sig: new Uint8Array() })) throw new TypeError("signMessage: malformed message");
  return { ...unsigned, sig: await signer.sign(messageBytes(unsigned)) };
}

export function isMessage(x: unknown): x is Message {
  if (!isObj(x) || x.kind !== "message") return false;
  return isIdentity(x.from)
    && (x.to === undefined || typeof x.to === "string")
    && Number.isSafeInteger(x.seq) && (x.seq as number) >= 0
    && typeof x.at === "number"
    && x.body !== undefined
    && Array.isArray(x.refs) && x.refs.every(isRef)
    && x.sig instanceof Uint8Array;
}

/** Shape plus signature against `from`. Synchronous for the store's transactions; see verifyMessage. */
export function verifyMessageSync(m: unknown): m is Message {
  if (!isMessage(m)) return false;
  try {
    // PublicKey.verify hashes with sha256 itself, so this checks the signature over messageDigest(m).
    return PublicKey.fromString(m.from).verify([...messageBytes(m)], Signature.fromDER([...m.sig]));
  } catch {
    return false; // not a curve point, not DER
  }
}

export async function verifyMessage(m: unknown): Promise<boolean> {
  return verifyMessageSync(m);
}

// ---------------------------------------------------------------- program

export type Program = {
  kind: "program";
  name: string;
  code: { ts: string } | { wasm: CID };
  inputs: unknown;      // JSON schema for a thread's `args`
  services: string[];   // host services it may call (inference, execution, …)
  description: string;
};

export function program(p: Omit<Program, "kind">): Program {
  const out = { kind: "program" as const, ...p };
  if (!isProgram(out)) throw new TypeError("program: malformed");
  return out;
}

export function isProgram(x: unknown): x is Program {
  if (!isObj(x) || x.kind !== "program") return false;
  const code = x.code;
  const codeOk = isObj(code) && (typeof code.ts === "string") !== isCID(code.wasm);
  return typeof x.name === "string" && x.name !== "" && codeOk
    && x.inputs !== undefined
    && Array.isArray(x.services) && x.services.every((s) => typeof s === "string")
    && typeof x.description === "string";
}

// ---------------------------------------------------------------- subscription

export interface SubscriptionMatch {
  from?: string;
  to?: string;
  kind?: string;                   // the body's kind: every inbound record is a message
  body?: Record<string, unknown>;  // subset of the body, compared by dag-cbor encoding
}

export type Subscription = {
  kind: "subscription";
  match: SubscriptionMatch;
  handler: CID | "resolve-waiter";
  at: Ms;
};

export function subscription(match: SubscriptionMatch, handler: Subscription["handler"], at: Ms = Date.now()): Subscription {
  const out: Subscription = { kind: "subscription", match, handler, at };
  if (!isSubscription(out)) throw new TypeError("subscription: malformed");
  return out;
}

export function isSubscription(x: unknown): x is Subscription {
  if (!isObj(x) || x.kind !== "subscription" || !isObj(x.match) || typeof x.at !== "number") return false;
  const m = x.match;
  return (m.from === undefined || typeof m.from === "string")
    && (m.to === undefined || typeof m.to === "string")
    && (m.kind === undefined || typeof m.kind === "string")
    && (m.body === undefined || isObj(m.body))
    && (x.handler === "resolve-waiter" || isCID(x.handler));
}

/** The subscription a message carries, if it is one and `admin` signed it. Verify the message first. */
export function subscriptionIn(m: Message, admin: Identity): Subscription | undefined {
  return m.from === admin && isSubscription(m.body) ? m.body : undefined;
}

/** Pure in (subscription, message): delivery must replay identically. */
export function matches(sub: Subscription, m: Message): boolean {
  const { from, to, kind, body } = sub.match;
  if (from !== undefined && m.from !== from) return false;
  if (to !== undefined && m.to !== to) return false;
  if (kind !== undefined && !(isObj(m.body) && m.body.kind === kind)) return false;
  return body === undefined || contains(body, m.body);
}

// Plain objects match as subsets, recursively; anything else (arrays, CIDs,
// bytes, scalars) must be equal, and dag-cbor bytes are the canonical equality.
function contains(pattern: unknown, value: unknown): boolean {
  if (isPlain(pattern)) {
    if (!isPlain(value)) return false;
    return Object.entries(pattern).every(([k, p]) => k in value && contains(p, value[k]));
  }
  if (pattern === undefined || value === undefined) return pattern === value;
  try {
    return Buffer.from(encode(pattern).bytes).equals(encode(value).bytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- genesis

/**
 * An instance's first record, carried as the body of a signed message.
 * `root` is the wallet's identity key; BRC-100 never signs with that key
 * itself, so the carrying message is from a key derived under it.
 */
export type Genesis = {
  kind: "genesis";
  root: Identity;
  at: Ms;
  name?: string;
};

export function genesis(root: Identity, name?: string, at: Ms = Date.now()): Genesis {
  const out: Genesis = name === undefined ? { kind: "genesis", root, at } : { kind: "genesis", root, at, name };
  if (!isGenesis(out)) throw new TypeError("genesis: malformed");
  return out;
}

export function isGenesis(x: unknown): x is Genesis {
  return isObj(x) && x.kind === "genesis" && isIdentity(x.root) && typeof x.at === "number"
    && (x.name === undefined || typeof x.name === "string");
}

// ---------------------------------------------------------------- helpers

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !isCID(v) && !(v instanceof Uint8Array);
}

function isPlain(v: unknown): v is Obj {
  if (!isObj(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isRef(r: unknown): r is Ref {
  return isObj(r) && (isCID(r.to) || typeof r.to === "string") && typeof r.rel === "string"
    && (r.locator === undefined || typeof r.locator === "string");
}
