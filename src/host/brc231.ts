// A BRC-231 messagebox client: the BRC-33 calls in dag-cbor over BRC-104
// (AuthFetch), identity keys and bodies as bytes. The router answers a CBOR
// request in CBOR (router.ts). Implements the provider's MessageBox
// (messagebox.ts): `list` gives each body as its bytes; `send` takes a §7.3
// envelope (sent as its dag-cbor bytes) or bytes.

import { AuthFetch, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { isCborEnvelope } from "../envelope-cbor.ts";
import type { Listed, MessageBox } from "./messagebox.ts";

/** Over `wallet`'s own BRC-104 session, or an existing AuthFetch's (a MessageBoxClient's `authFetch`: the same session). */
export function cborBoxClient(wallet: WalletInterface | AuthFetch, host: string): MessageBox {
  const f = wallet instanceof AuthFetch ? wallet : new AuthFetch(wallet);
  const call = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await f.fetch(`${host}${path}`, { method: "POST", headers: { "content-type": "application/cbor" }, body: dagCbor.encode(body) });
    const out = dagCbor.decode(new Uint8Array(await res.arrayBuffer())) as Record<string, unknown>;
    if (!res.ok || out.status !== "success") throw new Error(`Message Box ${path} failed with HTTP ${res.status} (${String(out.code)}): ${String(out.description)}`);
    return out;
  };
  return {
    async list(box) {
      const r = await call("/listMessages", { messageBox: box });
      return (r.messages as Array<{ messageId: string; body: Uint8Array; sender: Uint8Array }>).map((m): Listed => ({ messageId: m.messageId, sender: Buffer.from(m.sender).toString("hex"), body: m.body }));
    },
    async ack(ids) { if (ids.length) await call("/acknowledgeMessage", { messageIds: ids }); },
    async send(m) {
      const body = m.body instanceof Uint8Array ? m.body : isCborEnvelope(m.body) ? dagCbor.encode(m.body) : new TextEncoder().encode(JSON.stringify(m.body));
      await call("/sendMessage", { message: { recipient: Uint8Array.from(Buffer.from(m.recipient, "hex")), messageBox: m.box, body } });
    },
  };
}
