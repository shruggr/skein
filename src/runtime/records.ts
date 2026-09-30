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
import type { Attestation } from "./attest.ts";

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
 * BRC-33 box), tried in the subscriptions chain's order (subscriptions.ts),
 * first match wins. An absent field matches anything. The handler is a
 * program record's CID.
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
 * `identity` is the instance wallet's identity key, which its outbound
 * envelopes are signed by; `host` is the identity of the host that delivers
 * its inputs, which signs every log entry (log.ts); `owner` is the identity
 * it acts for; `programs` are the programs it starts with, by name, and
 * `subscriptions` are the seed of its subscriptions chain (subscriptions.ts):
 * written as the chain's first updates when the entry is processed, never
 * read for routing.
 */
export type Genesis = {
  kind: "genesis";
  identity: Identity;
  handle: string;
  domain: string;
  owner: Identity;
  host: Identity;
  programs: Record<string, CID>;
  subscriptions: Subscription[];
  /** Peers by role, e.g. `infer`: the identity a program sends that kind of request to. */
  peers?: Record<string, Identity>;
  /** Defaults programs fall back on, e.g. `model` for the loop. */
  defaults?: Record<string, string>;
  /** Handles of identities programs send to whose envelopes may not name them (the owner, the peers): an outbound envelope's `recipient`. */
  names?: Record<Identity, { handle: string; domain: string }>;
  /** Boxes the delivery provider collects besides the subscribed ones: replies (e.g. `completions`), routed only by `replyTo`. */
  collect?: string[];
};

export function isGenesis(x: unknown): x is Genesis {
  return isObj(x) && x.kind === "genesis" && isIdentity(x.identity) && isIdentity(x.owner) && isIdentity(x.host)
    && typeof x.handle === "string" && typeof x.domain === "string"
    && isObj(x.programs) && Object.values(x.programs).every(isCID)
    && Array.isArray(x.subscriptions) && x.subscriptions.every(isSubscription)
    && (x.peers === undefined || (isObj(x.peers) && Object.values(x.peers).every(isIdentity)))
    && (x.defaults === undefined || (isObj(x.defaults) && Object.values(x.defaults).every((v) => typeof v === "string")))
    && (x.names === undefined || (isObj(x.names) && Object.entries(x.names).every(([k, v]) => isIdentity(k) && isObj(v) && typeof v.handle === "string" && typeof v.domain === "string")))
    && (x.collect === undefined || (Array.isArray(x.collect) && x.collect.every((b) => typeof b === "string" && b !== "")));
}

// ---------------------------------------------------------------- program-written records

/**
 * What a handler emits: an outbound message to `to` in `box`. `envelope` is the
 * complete BRC-169 envelope (signed metadata and BRC-78 content), which the
 * program sealed through the instance wallet; `body` is its plaintext content,
 * a record. The kernel checks the envelope before accepting it.
 */
export type Emit = { kind: "emit"; to: Identity; box: string; body: CID; envelope: Record<string, unknown> & { content: string } };

export function isEmit(x: unknown): x is Emit {
  return isObj(x) && x.kind === "emit" && isIdentity(x.to) && typeof x.box === "string" && x.box !== "" && isCID(x.body)
    && isObj(x.envelope) && typeof x.envelope.content === "string";
}

/**
 * An attested call's record: the request a step made across the boundary and
 * the answer, at (thread, step, i). Referenced, in order, from the step's
 * update (`calls`); on replay the answer is served from here, not the host.
 *   op "wallet": request = a BRC-100 wire request frame, result = the result frame
 *   op "http": request = dag-cbor {method, url, headers?, body?, options?}, result = {status, headers, body}
 *   op "libp2p" (#51): request = dag-cbor {op, …}, result = its result ({error} too)
 * `http` and `libp2p` carry the host's attestation (#62, attest.ts) when the
 * genesis names an attest key.
 */
export type Attested = {
  kind: "attested";
  thread: CID;
  step: number;
  i: number;
  op: "wallet" | "http" | "libp2p";
  request: Uint8Array;
  result: Uint8Array;
  attest?: Attestation;
};

export function isAttested(x: unknown): x is Attested {
  return isObj(x) && x.kind === "attested" && isCID(x.thread) && typeof x.step === "number" && typeof x.i === "number"
    && (x.op === "wallet" || x.op === "http" || x.op === "libp2p") && x.result instanceof Uint8Array;
}

/**
 * Wallet wire calls a program may make (BRC-100 call codes): key derivation
 * and crypto only — no actions, no certificates (the kernel's scheduler.zig
 * `wallet_calls`). By code, for showing an attested `wallet` request.
 */
export const WALLET_CALLS: ReadonlyMap<number, string> = new Map([
  [8, "getPublicKey"], [11, "encrypt"], [12, "decrypt"], [13, "createHmac"], [14, "verifyHmac"], [15, "createSignature"], [16, "verifySignature"],
]);

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
