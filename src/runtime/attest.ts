// Host-signed recorded calls (issue #62), read from TypeScript: the same
// preimage and check as kernel-zig/src/attest.zig. Every `http` and `libp2p`
// call a step makes is recorded on its update with the host's attestation:
//
//   attest    {stamp: ms, key: bytes(33), signature: bytes (DER)}
//   preimage  dag-cbor {op, instance, request: sha256(request bytes),
//                       response: sha256(response bytes), stamp}   (canonical)
//
// signed (ECDSA over sha256(preimage)) by the host's attest key — a BRC-42
// child of its master under [2, "skein router"], key ID "attest"
// (src/host/oracle.ts) — which the genesis names (`attest`). Signing is the
// host's (it holds the key); this side only checks.

import { createHash } from "node:crypto";
import { PublicKey, Signature } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import type { Store } from "./store.ts";

/** The attest key's ID under the router's protocol ([2, "skein router"]). */
export const ATTEST_KEY_ID = "attest";

/** The ops a host attests (a `wallet` answer is a signature already). */
export const ATTESTED_OPS = new Set(["http", "libp2p"]);

export interface Attestation { stamp: number; key: Uint8Array; signature: Uint8Array }
export interface Exchange { op: string; instance: string; request: Uint8Array; response: Uint8Array; stamp: number }

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

/** The bytes the host signs for one exchange. */
export function attestPreimage(x: Exchange): Uint8Array {
  return dagCbor.encode({ op: x.op, instance: x.instance, request: sha256(x.request), response: sha256(x.response), stamp: x.stamp });
}

/** A recorded call as the kernel writes it (the fields the check reads). */
export interface RecordedCall { op: string; request: unknown; result: Uint8Array; attest?: unknown }

/**
 * Why a recorded call's attestation does not hold against the genesis
 * (`attest`: the host's key, `handle`: the instance), or undefined when it
 * does — or when the genesis names no attest key (nothing is asked then).
 */
export function attestProblem(genesis: { attest?: unknown; handle?: unknown }, call: RecordedCall): string | undefined {
  const want = bytesOf(genesis.attest);
  if (!want || !ATTESTED_OPS.has(call.op)) return undefined;
  const a = call.attest as { stamp?: unknown; key?: unknown; signature?: unknown } | undefined;
  if (!a || typeof a !== "object") return "no attestation (the genesis names the host's attest key)";
  if (typeof a.stamp !== "number") return "the attestation has no stamp";
  const key = bytesOf(a.key), sig = bytesOf(a.signature);
  if (!key) return "the attestation has no key";
  if (!sig) return "the attestation has no signature";
  if (Buffer.compare(key, want) !== 0) return "the attestation is by another key than the genesis's";
  if (!(call.request instanceof Uint8Array)) return "the request is not bytes";
  const pre = attestPreimage({ op: call.op, instance: String(genesis.handle ?? ""), request: call.request, response: call.result, stamp: a.stamp });
  try {
    // PublicKey.verify hashes with sha256 itself.
    if (PublicKey.fromString(key.toString("hex")).verify([...pre], Signature.fromDER([...sig]))) return undefined;
  } catch { /* a malformed key or signature */ }
  return "the attestation does not verify";
}

/** Bytes as stored, or as the display readers show them (index-store.ts `display`: keys and signatures as hex). */
function bytesOf(v: unknown): Buffer | undefined {
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === "string" && /^([0-9a-f]{2})+$/.test(v)) return Buffer.from(v, "hex");
  return undefined;
}

/** A recorded call whose attestation does not hold (a divergence from what the host attested). */
export interface BadAttestation { thread: CID; step: number; i: number; op: string; call: CID; why: string }
export interface AttestReport {
  /** The genesis's attest key, hex (none: the host attests nothing and nothing is checked). */
  key?: string;
  /** `http`/`libp2p` calls whose attestation verified. */
  verified: number;
  bad: BadAttestation[];
}

/**
 * Every recorded `http`/`libp2p` call in the store, checked against the
 * genesis's attest key (#62): what `skein-kernel replay` checks, read from
 * the store with no kernel (`skein-dev log`).
 */
export async function checkAttestations(store: Store): Promise<AttestReport> {
  let genesis: { attest?: unknown; handle?: unknown } | undefined;
  for await (const { entry } of store.log.entries()) {
    if (entry.genesis) genesis = await store.get(entry.genesis) as typeof genesis;
    break;
  }
  const key = bytesOf(genesis?.attest);
  const report: AttestReport = { verified: 0, bad: [], ...(key ? { key: key.toString("hex") } : {}) };
  if (!genesis || !report.key) return report;
  for await (const t of store.edges.query({ kind: "thread" })) {
    for await (const u of store.chains.history(t)) {
      if (u.equals(t)) continue;
      const up = await store.get(u) as unknown as { calls?: CID[] };
      for (const c of up.calls ?? []) {
        const r = await store.get(c) as unknown as RecordedCall & { step: number; i: number };
        if (!ATTESTED_OPS.has(r.op)) continue;
        const why = attestProblem(genesis, r);
        if (why) report.bad.push({ thread: t, step: r.step, i: r.i, op: r.op, call: c, why });
        else report.verified++;
      }
    }
  }
  return report;
}
