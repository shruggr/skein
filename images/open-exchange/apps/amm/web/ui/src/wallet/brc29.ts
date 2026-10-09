/**
 * BRC-29 ("wallet payment") outputs to the user's own wallet: the sats a
 * user receives from a pool (a token-in swap's payout, a RemoveLiquidity
 * sats withdrawal). No basket: the wallet does not track the output when the
 * action is created; it takes it in with `internalizeAction({protocol:
 * "wallet payment", paymentRemittance})` once the transaction is final, and
 * from then on spends it as its own change.
 *
 * The derivation, as wallet-toolbox checks it
 * (src/signer/methods/internalizeAction.ts `setupWalletPaymentForOutput`):
 *
 *   keyID   = `${derivationPrefix} ${derivationSuffix}`
 *   privKey = keyDeriver.derivePrivateKey([2, "3241645161d8"], keyID, senderIdentityKey)
 *   lock    = P2PKH(privKey.toAddress())
 *
 * The page is both payer-side author and payee, so senderIdentityKey is the
 * user's own identity key. The payee side of that derivation is
 * `rootKey.deriveChild(identityPub, invoice)`; the page asks for the same
 * key with `getPublicKey({protocolID: BRC29, keyID, counterparty: "self",
 * forSelf: true})`, which is `rootKey.deriveChild(rootKey.toPublicKey(),
 * invoice).toPublicKey()` (@bsv/sdk KeyDeriver: `normalizeCounterparty("self")`
 * is `rootKey.toPublicKey()`, which is the identity key). "self" rather than
 * the identity key's hex, because WalletPermissionsManager keys level-2
 * grants by the exact counterparty string and the manifest can only name
 * "self" (public/manifest.json, README "Permissions"). With counterparty =
 * self, forSelf true and false give the same key (the ECDH secret is
 * root·root·G either way).
 */
import { P2PKH, PublicKey, Utils, type WalletInterface, type WalletProtocol } from "@bsv/sdk";

export const BRC29_PROTOCOL: WalletProtocol = [2, "3241645161d8"];
export const WALLET_PAYMENT = "wallet payment" as const;

export interface PaymentRemittance {
  derivationPrefix: string;
  derivationSuffix: string;
  senderIdentityKey: string;
}

/** A BRC-29 payout as the page records it: the output, its remittance. */
export interface Brc29Payout {
  outputIndex: number;
  satoshis: number;
  /** P2PKH to the derived key, hex. */
  lockingScript: string;
  remittance: PaymentRemittance;
}

/** Random base64, as wallet-toolbox's `randomBytesBase64(8)` for a payment's prefix and suffix. */
export function randomBase64(bytes = 8): string {
  return Utils.toBase64(Array.from(crypto.getRandomValues(new Uint8Array(bytes))));
}

export function brc29KeyID(r: { derivationPrefix: string; derivationSuffix: string }): string {
  return `${r.derivationPrefix} ${r.derivationSuffix}`;
}

/** `${prefix} ${suffix}` → the two parts, or null (base64 has no spaces). */
export function splitBrc29KeyID(keyID: string): { derivationPrefix: string; derivationSuffix: string } | null {
  const parts = keyID.split(" ");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { derivationPrefix: parts[0], derivationSuffix: parts[1] };
}

export function isBrc29Protocol(p: WalletProtocol | readonly unknown[] | undefined): boolean {
  return Array.isArray(p) && p[0] === BRC29_PROTOCOL[0] && p[1] === BRC29_PROTOCOL[1];
}

/** The user's identity key (one `getPublicKey({identityKey: true})`). */
export async function identityKeyOf(wallet: WalletInterface): Promise<string> {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey;
}

/** The payee key of a BRC-29 payment to self (see the module comment). */
export async function brc29PublicKey(wallet: WalletInterface, r: { derivationPrefix: string; derivationSuffix: string }): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({ protocolID: BRC29_PROTOCOL, keyID: brc29KeyID(r), counterparty: "self", forSelf: true });
  return publicKey;
}

export function p2pkhHexOf(publicKey: string): string {
  return new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex();
}

/** A fresh payout key: random prefix and suffix, sender = the user's identity. */
export async function newBrc29Payout(
  wallet: WalletInterface,
  identityKey?: string,
): Promise<{ remittance: PaymentRemittance; publicKey: string; lockingScript: string }> {
  const senderIdentityKey = identityKey ?? (await identityKeyOf(wallet));
  const remittance: PaymentRemittance = { derivationPrefix: randomBase64(), derivationSuffix: randomBase64(), senderIdentityKey };
  const publicKey = await brc29PublicKey(wallet, remittance);
  return { remittance, publicKey, lockingScript: p2pkhHexOf(publicKey) };
}

/** The payout output's customInstructions: the remittance, so the wallet's own record of the action carries it. */
export function paymentCustomInstructions(r: PaymentRemittance): string {
  return JSON.stringify({ protocol: WALLET_PAYMENT, derivationPrefix: r.derivationPrefix, derivationSuffix: r.derivationSuffix, senderIdentityKey: r.senderIdentityKey });
}

/**
 * The final step: the wallet takes the payout in. `atomicBeef` is the
 * AtomicBEEF of the final transaction (all signatures in).
 */
export async function internalizePayout(
  wallet: WalletInterface,
  atomicBeef: number[],
  payout: { outputIndex: number; remittance: PaymentRemittance },
  description: string,
): Promise<{ accepted: boolean }> {
  const r = await wallet.internalizeAction({
    tx: atomicBeef,
    outputs: [{ outputIndex: payout.outputIndex, protocol: WALLET_PAYMENT, paymentRemittance: { ...payout.remittance } }],
    description: description.length <= 50 ? description : `${description.slice(0, 49)}…`,
    labels: ["amm-payout"],
  });
  return { accepted: r.accepted };
}
