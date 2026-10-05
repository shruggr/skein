// v2 record kinds (docs/VM.md): message, program, genesis (with its dispatch rows).
// Types, not interfaces, so they satisfy Block's index signature.
// Thread/node shapes stay in types.ts and are re-exported so v2 code has one
// import. Validators are structural; a message is only trusted once
// verifyMessage passes, which needs nothing but the record itself.

import { createHash } from "node:crypto";
import { PublicKey, Signature } from "@bsv/sdk";
import { CID, decode, encode, isCID } from "./cid.ts";
import type { Ms, Ref } from "./types.ts";
import type { Signer } from "./identity.ts";
import type { DispatchRow } from "./dispatch.ts";

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

// ---------------------------------------------------------------- dispatch row

/**
 * A row of the dispatch table (#77; dispatch.ts, docs/MESSAGES.md "The
 * dispatch table"): the kernel's rule for a row (dispatch.zig `problem`).
 * `program` is a program record's CID, or "kernel" for an admin operation
 * named by `fn`.
 */
export function isDispatchRow(x: unknown): x is DispatchRow {
  if (!isObj(x)) return false;
  const t = x.transport;
  if (t !== "mailbox" && t !== "http" && t !== "libp2p" && t !== "local") return false;
  if (typeof x.address !== "string" || x.address === "" || /[ \0]/.test(x.address)) return false;
  if (x.prefix !== undefined && x.prefix !== null && x.prefix !== false && !(x.prefix === true && t === "http")) return false;
  const s = x.sender;
  if (!(s === "*" || ((s === "session" || s === "owner") && t === "http") || (s === "event" && t === "mailbox") || (s instanceof Uint8Array && s.length === 33 && (s[0] === 2 || s[0] === 3)))) return false;
  if (x.program === "kernel") return t === "mailbox" && typeof x.fn === "string" && KERNEL_OPS.includes(x.fn);
  return isCID(x.program) && (x.fn === undefined || x.fn === null || typeof x.fn === "string");
}

/** What a kernel row may name (its `fn`): the admin operations, and the claim (#89: an image's one row; the owner's admin rows written, the row removed). */
export const KERNEL_OPS: readonly string[] = ["objects", "head", "dispatch", "peers", "claim"];

// ---------------------------------------------------------------- genesis

/**
 * An instance's starting state: the record the first log entry names. Its
 * `identity` is the instance wallet's identity key, which its outbound
 * envelopes are signed by; `host` is the identity of the host that delivers
 * its inputs (format 1 only: format 2 dropped it); `owner` is the identity
 * it acts for; `programs` are the programs it starts with, by name;
 * `dispatch` is the seed of its dispatch table (dispatch.ts): written as the
 * table's chain's first updates when the entry is processed, never read for
 * routing; `scopes` are the heads each genesis-wired program may advance
 * (program name → head names, a prefix ending in `/`).
 */
export type Genesis = {
  kind: "genesis";
  identity: Identity;
  handle: string;
  domain: string;
  /** Absent in an image (#89): the owner comes with the claim (the head `claim`). */
  owner?: Identity;
  host?: Identity;
  programs: Record<string, CID>;
  dispatch: DispatchRow[];
  scopes?: Record<string, string[]>;
  /** Peers by role, e.g. `infer`: the identity a program sends that kind of request to. */
  peers?: Record<string, Identity>;
  /** Defaults programs fall back on, e.g. `model` for the loop. */
  defaults?: Record<string, string>;
  /** Handles of identities programs send to whose envelopes may not name them (the owner, the peers): an outbound envelope's `recipient`. */
  names?: Record<Identity, { handle: string; domain: string }>;
  /** Boxes the delivery provider collects besides the dispatched ones: replies (e.g. `completions`), routed only by `replyTo`. */
  collect?: string[];
};

export function isGenesis(x: unknown): x is Genesis {
  return isObj(x) && x.kind === "genesis" && isIdentity(x.identity) && (x.owner === undefined || isIdentity(x.owner)) && (x.host === undefined || isIdentity(x.host))
    && typeof x.handle === "string" && typeof x.domain === "string"
    && isObj(x.programs) && Object.values(x.programs).every(isCID)
    && Array.isArray(x.dispatch) && x.dispatch.every(isDispatchRow)
    && (x.scopes === undefined || (isObj(x.scopes) && Object.values(x.scopes).every((v) => Array.isArray(v) && v.every((h) => typeof h === "string" && h !== ""))))
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
 * An oracle call's record (format 6, #67: the one call a step makes out
 * mid-step): a BRC-100 wire request frame and its result frame, at (thread,
 * step, i). Referenced, in order, from the step's update (`calls`); on replay
 * the answer is served from here, not a wallet. (Before format 6 these were
 * `attested` records, with `http` and `libp2p` calls beside the wallet's.)
 */
export type OracleCall = {
  kind: "oracle";
  thread: CID;
  step: number;
  i: number;
  request: Uint8Array;
  result: Uint8Array;
};

export function isOracleCall(x: unknown): x is OracleCall {
  return isObj(x) && x.kind === "oracle" && isCID(x.thread) && typeof x.step === "number" && typeof x.i === "number"
    && x.request instanceof Uint8Array && x.result instanceof Uint8Array;
}

/**
 * Wallet wire calls a program may make (BRC-100 call codes): key derivation
 * and crypto only — no actions, no certificates (the kernel's scheduler.zig
 * `wallet_calls`). By code, for showing an oracle call.
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
