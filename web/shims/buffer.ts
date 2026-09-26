// Injected into the browser bundle for the free `Buffer` global that
// src/envelope.ts (and friends) use. The `buffer` package, with node's
// leniency restored where the shared code relies on it: node's
// buf.equals / Buffer.compare take any Uint8Array, the package only a Buffer
// (brc78Decode compares against a Uint8Array constant).
import { Buffer } from "buffer";

const asBuffer = (x: Uint8Array) => (Buffer.isBuffer(x) ? x : Buffer.from(x.buffer, x.byteOffset, x.byteLength));
const equals = Buffer.prototype.equals;
Buffer.prototype.equals = function (other: Uint8Array) { return equals.call(this, asBuffer(other)); };
const compare = Buffer.compare;
Buffer.compare = (a: Uint8Array, b: Uint8Array) => compare(asBuffer(a), asBuffer(b));

export { Buffer };
