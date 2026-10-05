// The signer (#18, #29): one master secret held by the router, and
// per instance a root key derived from it with BRC-42/43 — protocol
// [2, "skein instance"], key ID = the instance id (its handle), counterparty
// self — behind a ProtoWallet: getPublicKey, createSignature, encrypt,
// decrypt, createHmac (and their verify halves), no storage, no actions. The
// instance's identity key is that child's public key; provisioning an
// instance is picking an id. The router answers the kernel's `wallet` import
// from it in process (kernel.ts); the router has no identity of its own. Its
// libp2p host (#51) signs as a second child per instance: [2, "skein instance"], key ID
// `libp2p:<handle>`, self (peerKey). Its providers (#70: the HTTP proxy,
// the waker, the libp2p node, the broadcaster — providers.ts) are third
// children, one per provider for the whole host: [2, "skein provider"], key
// ID = the provider's name (providerKey). The host's BRC-169 certifier key
// (#100: the manifest's `metanet.trust.publicKey`, the signer of the handle
// certificates — handles.ts) is the same derivation, key ID `certifier`: not
// a provider — it takes no messages, and no address book names it.
//
// Custody (dev): the secret is a file, `$SKEIN_HOME/master.key` (64 hex
// digits, mode 0600), made on first use; `SKEIN_MASTER_KEY` (hex) overrides
// it, `SKEIN_MASTER_KEY_FILE` names another file. KMS/hardware later, behind
// the same calls.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KeyDeriver, PrivateKey, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import { ephemeralWallet } from "../wallet.ts";

export const INSTANCE_PROTOCOL: WalletProtocol = [2, "skein instance"];
export const PROVIDER_PROTOCOL: WalletProtocol = [2, "skein provider"];

/** The master secret: SKEIN_MASTER_KEY, else the file (created if absent). */
export function masterKey(vars: Record<string, string | undefined>, home: string): PrivateKey {
  if (vars.SKEIN_MASTER_KEY) return PrivateKey.fromHex(vars.SKEIN_MASTER_KEY.trim());
  const file = vars.SKEIN_MASTER_KEY_FILE || join(home, "master.key");
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${PrivateKey.fromRandom().toHex().padStart(64, "0")}\n`, { mode: 0o600, flag: "wx" });
  }
  return PrivateKey.fromHex(readFileSync(file, "utf8").trim());
}

export class Signer {
  private readonly deriver: KeyDeriver;
  private readonly wallets = new Map<string, WalletInterface>();

  readonly master: PrivateKey;

  constructor(master: PrivateKey) {
    this.master = master;
    this.deriver = new KeyDeriver(master);
  }

  /** An instance's root key: BRC-42 child of the master, key ID = the instance id. */
  instanceKey(id: string): PrivateKey {
    return this.deriver.derivePrivateKey(INSTANCE_PROTOCOL, id, "self");
  }

  /**
   * An instance's libp2p peer key (#51): a BRC-42 child of the master, key ID
   * `libp2p:<handle>` — never the instance's root. Its peer ID is the identity
   * multihash of the compressed key (p2p.ts peerIdOf).
   */
  peerKey(id: string): PrivateKey {
    return this.deriver.derivePrivateKey(INSTANCE_PROTOCOL, `libp2p:${id}`, "self");
  }

  /** The instance's identity key (hex): what `skein-host add` records. */
  identity(id: string): string {
    return this.instanceKey(id).toPublicKey().toString();
  }

  /** The instance's signer: a ProtoWallet over its root key (a WalletInterface whose actions reject). */
  wallet(id: string): WalletInterface {
    let w = this.wallets.get(id);
    if (!w) this.wallets.set(id, (w = ephemeralWallet(this.instanceKey(id))));
    return w;
  }

  /**
   * A provider's key (#70: the HTTP proxy, the waker, the libp2p node, the
   * broadcaster — providers.ts): a BRC-42 child of the master under
   * PROVIDER_PROTOCOL, key ID = the provider's name. The same identity for
   * every instance on this host; each genesis's address book names it. How a
   * host obtains provider keys is its own business: this is this host's way.
   */
  providerKey(name: string): PrivateKey {
    return this.deriver.derivePrivateKey(PROVIDER_PROTOCOL, name, "self");
  }

  /** The certifier key (#100): BRC-169's trust anchor, providerKey("certifier"). */
  certifierKey(): PrivateKey {
    return this.providerKey("certifier");
  }
}

