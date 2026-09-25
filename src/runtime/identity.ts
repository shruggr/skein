// Identities under the connected wallet. The runtime sees the wallet only as
// `KeyWallet` (BRC-100's getPublicKey + createSignature); how it is connected
// (a remote wallet-api over HTTP, an in-process wallet) is src/wallet.ts,
// outside the machine, handed in by main.ts.

import { createHash } from "node:crypto";
import type { WalletInterface, WalletProtocol } from "@bsv/sdk";

export type { WalletInterface };

/** Every skein key is derived under this protocol, keyID = the service/actor name. */
export const PROTOCOL: WalletProtocol = [1, "skein"];

// ---------------------------------------------------------------- identities

/** The part of BRC-100 skein's identities use. Any WalletInterface is one. */
export type KeyWallet = Pick<WalletInterface, "getPublicKey" | "createSignature">;

// Keyed by wallet object: identities are a pure function of (root key, name),
// and a round trip per lookup would dominate signing over a remote wallet.
const identities = new WeakMap<KeyWallet, Map<string, Promise<string>>>();

/** The public key (compressed hex) a wallet derives for `name`. */
export function identityOf(wallet: KeyWallet, name: string): Promise<string> {
  let byName = identities.get(wallet);
  if (!byName) identities.set(wallet, (byName = new Map()));
  let p = byName.get(name);
  if (!p) {
    p = wallet.getPublicKey({ protocolID: PROTOCOL, keyID: name, counterparty: "self" }).then((r) => r.publicKey);
    p.catch(() => byName.delete(name)); // don't memoise a failure (wallet locked, permission not yet granted)
    byName.set(name, p);
  }
  return p;
}

/** The wallet's identity key: the instance's root. Nothing is signed with it directly (see Signer). */
export async function rootIdentity(wallet: KeyWallet): Promise<string> {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey;
}

export interface Signer {
  /** DER ECDSA (secp256k1, low-S) over sha256(bytes), by the key behind `identity`. */
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  identity: string;
}

export async function signerFor(wallet: KeyWallet, name: string): Promise<Signer> {
  const identity = await identityOf(wallet, name);
  return {
    identity,
    async sign(bytes) {
      // Send the digest, not the data: a remote wallet needn't see the record.
      const hash = [...createHash("sha256").update(bytes).digest()];
      const { signature } = await wallet.createSignature({ protocolID: PROTOCOL, keyID: name, counterparty: "self", hashToDirectlySign: hash });
      return Uint8Array.from(signature);
    },
  };
}
