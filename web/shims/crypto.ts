// node:crypto for the browser bundle: only what the shared modules the page
// imports use (src/envelope.ts, src/runtime/identity.ts): createHash("sha256")
// and randomBytes. Synchronous like node's; hashing is @bsv/sdk's pure-JS
// SHA-256 (inputs here are envelope canonical forms, a few hundred bytes).
// esbuild aliases `node:crypto` to this file (web/build.ts).

import { Buffer } from "buffer";
import { Hash } from "@bsv/sdk";

const ALGS: Record<string, (data: number[]) => number[]> = {
  sha256: (d) => Hash.sha256(d),
  sha1: (d) => Hash.sha1(d),
};

export function createHash(alg: string) {
  const fn = ALGS[alg.toLowerCase()];
  if (!fn) throw new Error(`node:crypto shim: createHash(${alg}) not supported`);
  const parts: Uint8Array[] = [];
  const h = {
    update(data: string | Uint8Array, enc?: BufferEncoding) {
      parts.push(typeof data === "string" ? Buffer.from(data, enc ?? "utf8") : data);
      return h;
    },
    digest(): Buffer {
      return Buffer.from(fn([...Buffer.concat(parts)]));
    },
  };
  return h;
}

export function randomBytes(n: number): Buffer {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return Buffer.from(b);
}

export function createDecipheriv(): never {
  throw new Error("node:crypto shim: createDecipheriv is not available in the browser");
}
