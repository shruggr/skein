// v2 record kinds (docs/VM.md): message, program, subscription, genesis.
// Types, not interfaces, so they satisfy Block's index signature.
// Thread/node shapes stay in types.ts and are re-exported so v2 code has one
// import. Validators are structural; a message is only trusted once
// verifyMessage passes, which needs nothing but the record itself.

import { createHash } from "node:crypto";
import { PublicKey, Signature } from "@bsv/sdk";
import { CID, decode, encode, isCID } from "./cid.ts";
import type { Ms, Ref } from "./types.ts";
import type { Signer } from "./identity.ts";

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
  m: { to?: string; seq: number; body: unknown; refs?: Ref[]; at: Ms },
): Promise<Message> {
  // Round-trip through dag-cbor so the record we return is exactly what gets
  // stored and re-encoded at verify time (undefined dropped, CIDs canonical).
  const unsigned = decode<UnsignedMessage>(encode({
    kind: "message", from: signer.identity, to: m.to, seq: m.seq, at: m.at, body: m.body, refs: m.refs ?? [],
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

/**
 * Routing for admitted envelopes (docs/MESSAGES.md): on (sender identity key,
 * BRC-33 box), tried in genesis order, first match wins. An absent field
 * matches anything. The handler is a program record's CID.
 */
export type Subscription = {
  match: { sender?: Identity; box?: string };
  handler: CID;
};

export function isSubscription(x: unknown): x is Subscription {
  if (!isObj(x) || !isObj(x.match)) return false;
  const m = x.match;
  return (m.sender === undefined || isIdentity(m.sender)) && (m.box === undefined || typeof m.box === "string") && isCID(x.handler);
}

/** Pure in (subscription, sender, box): delivery must replay identically. */
export function matches(sub: Subscription, sender: Identity, box: string): boolean {
  return (sub.match.sender === undefined || sub.match.sender === sender) && (sub.match.box === undefined || sub.match.box === box);
}

// ---------------------------------------------------------------- genesis

/**
 * An instance's starting state: the record the first log entry names. Its
 * `identity` is the instance wallet's identity key, which signs every log
 * entry (log.ts); `owner` is the identity it acts for; `programs` are the
 * programs it starts with, by name, and `subscriptions` route its boxes.
 */
export type Genesis = {
  kind: "genesis";
  identity: Identity;
  handle: string;
  domain: string;
  owner: Identity;
  programs: Record<string, CID>;
  subscriptions: Subscription[];
};

export function isGenesis(x: unknown): x is Genesis {
  return isObj(x) && x.kind === "genesis" && isIdentity(x.identity) && isIdentity(x.owner)
    && typeof x.handle === "string" && typeof x.domain === "string"
    && isObj(x.programs) && Object.values(x.programs).every(isCID)
    && Array.isArray(x.subscriptions) && x.subscriptions.every(isSubscription);
}

// ---------------------------------------------------------------- message keys

/**
 * The BRC-78 message key the host derived for an admitted envelope
 * (inbox.ts): the AES-256-GCM key its content decrypts under. Handlers decrypt
 * purely with it; a replayer recomputes the plaintext and checks the tag.
 */
export type MessageKey = { kind: "message-key"; envelope: CID; key: Uint8Array };

export function isMessageKey(x: unknown): x is MessageKey {
  return isObj(x) && x.kind === "message-key" && isCID(x.envelope) && x.key instanceof Uint8Array && x.key.length === 32;
}

// ---------------------------------------------------------------- program-written records

/** What a handler emits: an outbound envelope to `to` in `box`, whose content is the record `body`. */
export type Emit = { kind: "emit"; to: Identity; handle?: string; domain?: string; box: string; body: CID };

export function isEmit(x: unknown): x is Emit {
  return isObj(x) && x.kind === "emit" && isIdentity(x.to) && typeof x.box === "string" && x.box !== "" && isCID(x.body)
    && (x.handle === undefined || typeof x.handle === "string") && (x.domain === undefined || typeof x.domain === "string");
}

/**
 * An attested call's record: the request a step made across the boundary and
 * the answer, at (thread, step, i). Referenced, in order, from the step's
 * update (`calls`); on replay the answer is served from here, not the wallet.
 *   op "wallet": request = a BRC-100 wire request frame, result = the result frame
 *   op "reveal": request = the revealed record's CID, result = the DER signature
 *                (instance identity, [2, "skein reveal"], key "1", anyone, over the record's bytes)
 */
export type Attested = {
  kind: "attested";
  thread: CID;
  step: number;
  i: number;
  op: "wallet" | "reveal";
  request: Uint8Array | CID;
  result: Uint8Array;
};

export function isAttested(x: unknown): x is Attested {
  return isObj(x) && x.kind === "attested" && isCID(x.thread) && typeof x.step === "number" && typeof x.i === "number"
    && (x.op === "wallet" || x.op === "reveal") && x.result instanceof Uint8Array;
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
