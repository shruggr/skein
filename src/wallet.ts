// The runtime's second surface (docs/VM.md): a BRC-100 wallet. Skein never
// holds keys; it connects to a wallet and sees only `WalletInterface`, and the
// rest of the code sees only a `Signer` built from it.

import { createHash } from "node:crypto";
import { HTTPWalletJSON, PrivateKey, ProtoWallet, type WalletInterface, type WalletProtocol } from "@bsv/sdk";

export type { WalletInterface };

/** Every skein key is derived under this protocol, keyID = the service/actor name. */
export const PROTOCOL: WalletProtocol = [1, "skein"];

export type WalletConfig =
  /** An in-process @1sat/wallet-node wallet. The key comes from the host's config/env, never from skein's files. */
  | {
      kind: "node";
      chain?: "main" | "test";
      privateKey?: string;        // WIF or hex; default $PRIVATE_KEY_WIF
      storage: string;            // the wallet's sqlite file; the host names it, skein picks no default
      storageIdentityKey?: string;
    }
  /** A running BRC-100 JSON endpoint, e.g. `1sat serve wallet-api` (default http://127.0.0.1:3321). */
  | { kind: "remote"; url?: string; originator?: string }
  /** Tests only: a random key that lives as long as the process. */
  | { kind: "ephemeral" };

export async function connectWallet(config: WalletConfig): Promise<WalletInterface> {
  switch (config.kind) {
    case "remote": return remoteWallet(config.url, config.originator);
    case "node": return nodeWallet(config);
    case "ephemeral": return ephemeralWallet();
  }
}

/**
 * Tests only. Never persisted, so nothing it signs is attributable after the
 * process exits. A ProtoWallet has keys but no actions; those reject.
 */
export function ephemeralWallet(): WalletInterface {
  return new Proxy(new ProtoWallet(PrivateKey.fromRandom()), {
    get(t, p) {
      // `then` must stay undefined or awaiting the wallet would call it.
      if (typeof p !== "string" || p === "then" || p in t) return Reflect.get(t, p);
      return () => Promise.reject(new Error(`ephemeral wallet: ${p} is not supported`));
    },
  }) as unknown as WalletInterface;
}

export function remoteWallet(url = "http://127.0.0.1:3321", originator = "skein"): WalletInterface {
  return new HTTPWalletJSON(originator, url, relayErrors);
}

// wallet-api answers a refusal with 400 {"error": "..."}; HTTPWalletJSON only
// understands {isError, ...} and would reduce the message to a status code,
// losing the `1sat permissions grant …` command the refusal names.
async function relayErrors(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.ok) return res;
  let body: unknown;
  try { body = await res.clone().json(); } catch { return res; }
  const b = body as { error?: unknown; isError?: unknown } | null;
  if (b && typeof b.error === "string" && !b.isError) throw new Error(`wallet: ${b.error}`);
  return res;
}

async function nodeWallet(c: Extract<WalletConfig, { kind: "node" }>): Promise<WalletInterface> {
  const privateKey = c.privateKey ?? process.env.PRIVATE_KEY_WIF;
  if (!privateKey) throw new Error("node wallet: no privateKey in config and $PRIVATE_KEY_WIF unset");
  // Optional dependency: loaded by name so skein installs and typechecks without it.
  const spec = "@1sat/wallet-node";
  let mod: { createNodeWallet(o: unknown): Promise<{ wallet: WalletInterface }> };
  try {
    mod = await import(spec);
  } catch (e) {
    throw new Error(`node wallet: ${spec} is not installed (${(e as Error).message}); use {kind:"remote"} against \`1sat serve wallet-api\``);
  }
  const { wallet } = await mod.createNodeWallet({
    privateKey,
    chain: c.chain ?? "main",
    storageIdentityKey: c.storageIdentityKey ?? "skein",
    storage: { provider: "bun-sqlite", filename: c.storage }, // picks node:sqlite under Node
    skipInitialMonitor: true,
  });
  return wallet;
}

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
