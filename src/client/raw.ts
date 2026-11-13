// A request signed outside any session (skein next, SPEC.md section 2, the `signed` scheme): what a
// client, an operator's tool or the host's own services hand an instance when the sender must be
// proven and no BRC-104 session carries it — the request record
//
//   {kind: "request", payload: {method, path, query, headers, body},
//    signature: {scheme: "signed", sender, recipient, nonce, signature}}
//
// signed BRC-169's way ([2, "metanet handles envelope"], key "send", counterparty anyone) over the
// dag-cbor of {sender, recipient, nonce, payload}; `recipient` the instance's identity key. Anyone can
// check it (kernel-zig door.zig `signed`). An identical signed request is refused the second time
// (the unique map): `nonce` makes two like requests two.
//
//   const r = await signRequest(wallet, {recipient, payload: requestPayload("POST", "/kernel/grant", body)})

import type { WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { RequestRecord } from "../host/kernel.ts";

/** What signing a request needs of a wallet: its identity key and a signature (a ProtoWallet does). */
export type Signer = Pick<WalletInterface, "getPublicKey" | "createSignature">;

export const MESSAGE_PROTOCOL: [2, string] = [2, "metanet handles envelope"];
export const MESSAGE_KEY_ID = "send";

export type RequestPayload = RequestRecord["payload"];

/** A request's payload: `body` bytes, or a value encoded as dag-cbor (content-type application/cbor). */
export function requestPayload(method: string, path: string, body?: Uint8Array | unknown, o: { query?: string; headers?: Record<string, string> } = {}): RequestPayload {
  const bytes = body === undefined ? new Uint8Array() : body instanceof Uint8Array ? body : dagCbor.encode(body);
  const cbor = body !== undefined && !(body instanceof Uint8Array);
  return { method, path, query: o.query ?? "", headers: { ...(cbor ? { "content-type": "application/cbor" } : {}), ...(o.headers ?? {}) }, body: bytes };
}

/** What a `signed` request's signature covers: dag-cbor {sender, recipient, nonce, payload}. */
export function signedPreimage(sender: Uint8Array, recipient: Uint8Array, nonce: Uint8Array, payload: RequestPayload): Uint8Array {
  return dagCbor.encode({ sender, recipient, nonce, payload });
}

const keyBytes = (k: Uint8Array | string): Uint8Array => typeof k === "string" ? Uint8Array.from(Buffer.from(k, "hex")) : k;

/**
 * A request signed by `wallet` (its identity key the sender) to the instance `recipient` (hex or 33
 * bytes) under the `signed` scheme. `nonce`: 16 fresh bytes when absent.
 */
export async function signRequest(wallet: Signer, r: { recipient: Uint8Array | string; payload: RequestPayload; nonce?: Uint8Array }, originator?: string): Promise<RequestRecord> {
  const me = (await wallet.getPublicKey({ identityKey: true }, originator)).publicKey;
  const sender = keyBytes(me), recipient = keyBytes(r.recipient);
  const nonce = r.nonce ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const payload = dagCbor.decode(dagCbor.encode(r.payload)) as RequestPayload;
  const { signature } = await wallet.createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...signedPreimage(sender, recipient, nonce, payload)] }, originator);
  return { kind: "request", payload, signature: { scheme: "signed", sender, recipient, nonce, signature: Uint8Array.from(signature) } };
}

/** The kernel's claim row's path (images/default etc/routes.json: handler kernel.claim, role user). */
export const CLAIM_PATH = "/kernel/claim";

/**
 * A claim (SPEC 3: the kernel's claim operation on the image's claim row): a request signed by
 * `wallet` to the instance `recipient`, POST /kernel/claim, body dag-cbor {handle?, domain?}. The
 * kernel grants root to its sender and removes the claim row in the same step.
 */
export async function signClaim(wallet: Signer, recipient: Uint8Array | string, body: { handle?: string; domain?: string } = {}, originator?: string): Promise<RequestRecord> {
  return await signRequest(wallet, { recipient, payload: requestPayload("POST", CLAIM_PATH, body) }, originator);
}
