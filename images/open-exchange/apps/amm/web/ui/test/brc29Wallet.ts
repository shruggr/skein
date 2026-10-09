/**
 * The BRC-29 half of the fake BRC-100 wallets: a real @bsv/sdk KeyDeriver
 * over a root key, so `getPublicKey` derives exactly as a wallet does, and
 * `internalizeAction` checks a "wallet payment" output as wallet-toolbox
 * does (src/signer/methods/internalizeAction.ts `setupWalletPaymentForOutput`:
 * `derivePrivateKey([2, "3241645161d8"], "<prefix> <suffix>",
 * senderIdentityKey)`, P2PKH of it must be the output's script), after
 * checking the AtomicBEEF and the base64 of prefix and suffix; a "basket
 * insertion" only needs the output and a basket.
 */
import { Beef, KeyDeriver, P2PKH, PrivateKey, Utils, type InternalizeActionArgs, type WalletProtocol } from "@bsv/sdk";

export const BRC29: WalletProtocol = [2, "3241645161d8"];

export const isBrc29 = (p: unknown): boolean => Array.isArray(p) && p[0] === 2 && p[1] === "3241645161d8";

function base64(s: string): boolean {
  try {
    return s.length > 0 && Utils.toBase64(Utils.toArray(s, "base64")) === s;
  } catch {
    return false;
  }
}

export interface KeyArgs {
  protocolID: WalletProtocol;
  keyID: string;
  counterparty?: string;
  forSelf?: boolean;
}

export function brc29Side(root: PrivateKey) {
  const kd = new KeyDeriver(root);
  const identityKey = root.toPublicKey().toString();
  const internalized: InternalizeActionArgs[] = [];
  return {
    identityKey,
    internalized,
    publicKey(a: KeyArgs): string {
      return kd.derivePublicKey(a.protocolID, a.keyID, a.counterparty ?? "self", a.forSelf ?? false).toString();
    },
    privateKey(a: KeyArgs): PrivateKey {
      return kd.derivePrivateKey(a.protocolID, a.keyID, a.counterparty ?? "self");
    },
    async internalizeAction(args: InternalizeActionArgs): Promise<{ accepted: true }> {
      const ab = Beef.fromBinary(Array.from(args.tx));
      if (!ab.atomicTxid) throw new Error("tx: valid AtomicBEEF");
      const tx = ab.findTxid(ab.atomicTxid)?.tx;
      if (!tx) throw new Error(`tx: valid AtomicBEEF with newest txid of ${ab.atomicTxid}`);
      for (const o of args.outputs) {
        if (o.protocol === "basket insertion") {
          // wallet-toolbox takes any output into the named basket (it must exist in the tx).
          if (!tx.outputs[o.outputIndex] || !o.insertionRemittance?.basket) throw new Error("insertionRemittance: valid for protocol basket insertion");
          continue;
        }
        if (o.protocol !== "wallet payment") throw new Error(`unexpected protocol ${o.protocol}`);
        const p = o.paymentRemittance;
        if (!p || !base64(p.derivationPrefix) || !base64(p.derivationSuffix)) throw new Error("paymentRemittance: valid for protocol wallet payment");
        const privKey = kd.derivePrivateKey(BRC29, `${p.derivationPrefix} ${p.derivationSuffix}`, p.senderIdentityKey);
        const expected = new P2PKH().lock(privKey.toAddress()).toHex();
        if (tx.outputs[o.outputIndex]?.lockingScript.toHex() !== expected) throw new Error("paymentRemittance: locked by script conforming to BRC-29");
      }
      internalized.push(args);
      return { accepted: true };
    },
  };
}
