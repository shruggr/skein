// Pure BRC-78 decryption with a recorded message key (docs/MESSAGES.md, "Why
// the key, not the plaintext"): the scheduler reads an admitted body's
// `replyTo` this way, exactly as a handler program does (programs/brc78), with
// no wallet — a replayer recomputes it and the GCM tag proves it.
//
// Layout: version 0x42421033 ‖ sender (33) ‖ recipient (33) ‖ key id (32) ‖
// AES-256-GCM with a 32-byte IV prepended and the 16-byte tag appended.

import { createDecipheriv } from "node:crypto";

export interface Brc78Header { sender: string; recipient: string; keyId: Uint8Array }

const VERSION = "42421033";

export function brc78Header(msg: Uint8Array): Brc78Header {
  if (msg.length < 4 + 33 + 33 + 32 + 32 + 16 || Buffer.from(msg.subarray(0, 4)).toString("hex") !== VERSION) throw new Error("brc78: not a BRC-78 message");
  return { sender: Buffer.from(msg.subarray(4, 37)).toString("hex"), recipient: Buffer.from(msg.subarray(37, 70)).toString("hex"), keyId: msg.subarray(70, 102) };
}

/** Decrypt with the 32-byte message key. Throws if the key is wrong or the content was altered. */
export function brc78Decrypt(msg: Uint8Array, key: Uint8Array): { header: Brc78Header; plaintext: Uint8Array } {
  const header = brc78Header(msg);
  if (key.length !== 32) throw new Error("brc78: message key is not 32 bytes");
  const ct = msg.subarray(102);
  const d = createDecipheriv("aes-256-gcm", key, ct.subarray(0, 32));
  d.setAuthTag(ct.subarray(ct.length - 16));
  try {
    const plaintext = Buffer.concat([d.update(ct.subarray(32, ct.length - 16)), d.final()]);
    return { header, plaintext: new Uint8Array(plaintext) };
  } catch {
    throw new Error("brc78: authentication failed (wrong key or altered content)");
  }
}
