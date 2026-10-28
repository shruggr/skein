// The signer (#18, #29): one master secret held by the router, and
// per instance a root key derived from it with BRC-42/43 — protocol
// [2, "skein instance"], key ID = the instance id (its handle), counterparty
// self — behind a ProtoWallet: getPublicKey, createSignature, encrypt,
// decrypt, createHmac (and their verify halves), no storage, no actions. The
// instance's identity key is that child's public key; provisioning an
// instance is picking an id. The router answers the kernel's `wallet` import
// from it in process (kernel.ts); the router has no identity of its own. Its
// libp2p host (#51, #129) signs as a child of the INSTANCE's root key: [2,
// "skein instance"], key ID `libp2p:<handle>`, counterparty self (peerKey) —
// exactly what the instance's program gets when it asks its signer for that
// public key, so a program knows its own peer ID. The master is only how this
// host hands each instance its root. Its providers (#70: the HTTP proxy,
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
//
// One-key mode (#160): a host provisioned with ONE private key —
// `SKEIN_KEY_FILE` (a file, 64 hex digits, read and never made: the host is
// provisioned) or `SKEIN_KEY` (hex); never together with the master key
// settings. Its signer (Signer.oneKey) answers for every instance with that
// key directly: instanceKey(id) is the key for every id, so every instance's
// identity is its public key and its wallet one ProtoWallet over it. The
// peer key is the key's child [2, "skein instance"], key ID `libp2p`,
// counterparty self — the same for every id — and a program's
// getPublicKey([2, "skein instance"], `libp2p:<handle>`, self) is answered
// with that child: the lookup is by handle as it is in master-key mode, the
// derivation rule ignores the handle (David, 2026-10-28: "all derive the same
// way"). The providers' keys and the certifier key are derived from the key
// as they are from the master. signerOf picks the mode.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KeyDeriver, PrivateKey, ProtoWallet, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import { ephemeralWallet, keyWallet } from "../wallet.ts";

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

/** One-key mode (#160): the provisioned key's settings — SKEIN_KEY (hex) or SKEIN_KEY_FILE — if either is set. */
export function oneKeySetting(vars: Record<string, string | undefined>): boolean {
  return !!(vars.SKEIN_KEY || vars.SKEIN_KEY_FILE);
}

/**
 * The one key (#160): SKEIN_KEY (hex), else the file SKEIN_KEY_FILE names, read and never made (the
 * host is provisioned with it). Refused together with SKEIN_MASTER_KEY or SKEIN_MASTER_KEY_FILE.
 */
export function oneKey(vars: Record<string, string | undefined>): PrivateKey {
  if (vars.SKEIN_MASTER_KEY || vars.SKEIN_MASTER_KEY_FILE) throw new Error("SKEIN_KEY / SKEIN_KEY_FILE (one key for every instance) and SKEIN_MASTER_KEY / SKEIN_MASTER_KEY_FILE (a key derived per instance) are two modes: set one");
  if (vars.SKEIN_KEY && vars.SKEIN_KEY_FILE) throw new Error("SKEIN_KEY and SKEIN_KEY_FILE: set one");
  if (vars.SKEIN_KEY) return PrivateKey.fromHex(vars.SKEIN_KEY.trim());
  const file = vars.SKEIN_KEY_FILE!;
  if (!existsSync(file)) throw new Error(`SKEIN_KEY_FILE ${file}: no such file (a one-key host is provisioned with its key: it is never made here)`);
  return PrivateKey.fromHex(readFileSync(file, "utf8").trim());
}

/** The host's signer by its settings (#160): one-key mode when SKEIN_KEY / SKEIN_KEY_FILE is set, else the master key's (made if absent). */
export function signerOf(vars: Record<string, string | undefined>, home: string): Signer {
  return oneKeySetting(vars) ? Signer.oneKey(oneKey(vars)) : new Signer(masterKey(vars, home));
}

/** Whether a getPublicKey asks for an instance's peer key by handle: [2, "skein instance"], key ID `libp2p:<handle>`, counterparty self. */
function peerLookup(args: { identityKey?: boolean; protocolID?: WalletProtocol; keyID?: string; counterparty?: string }): boolean {
  if (args.identityKey || !args.protocolID || typeof args.keyID !== "string" || !args.keyID.startsWith("libp2p:")) return false;
  const [level, name] = args.protocolID;
  return level === INSTANCE_PROTOCOL[0] && typeof name === "string" && name.trim().toLowerCase() === INSTANCE_PROTOCOL[1] && (args.counterparty === undefined || args.counterparty === "self");
}

/**
 * The one-key host's signer wallet (#160): a ProtoWallet over the key whose getPublicKey for an
 * instance's peer key by handle ([2, "skein instance"], `libp2p:<handle>`, self) answers the one peer
 * key (Signer.peerKey: key ID `libp2p`), whatever the handle. Everything else is the ProtoWallet's.
 */
class OneKeyWallet extends ProtoWallet {
  private readonly peer: string;
  constructor(key: PrivateKey, peer: PrivateKey) {
    super(key);
    this.peer = peer.toPublicKey().toString();
  }
  override async getPublicKey(args: Parameters<ProtoWallet["getPublicKey"]>[0]): ReturnType<ProtoWallet["getPublicKey"]> {
    if (peerLookup(args as never)) return { publicKey: this.peer };
    return await super.getPublicKey(args);
  }
}

export class Signer {
  private readonly deriver: KeyDeriver;
  private readonly wallets = new Map<string, WalletInterface>();

  readonly master: PrivateKey;
  /** One-key mode (#160): the key every instance signs with (Signer.oneKey); undefined: the master's derivation per instance. */
  readonly shared?: PrivateKey;

  constructor(master: PrivateKey, shared = false) {
    this.master = master;
    this.deriver = new KeyDeriver(master);
    if (shared) this.shared = master;
  }

  /** One-key mode (#160): every instance's key is `key` itself; providers and the certifier derive from it as from a master. */
  static oneKey(key: PrivateKey): Signer {
    return new Signer(key, true);
  }

  /** An instance's root key: BRC-42 child of the master, key ID = the instance id. One-key mode: the key, for every id. */
  instanceKey(id: string): PrivateKey {
    if (this.shared) return this.shared;
    return this.deriver.derivePrivateKey(INSTANCE_PROTOCOL, id, "self");
  }

  /**
   * An instance's libp2p peer key (#51, #129): a BRC-42 child of the
   * instance's root key (instanceKey), protocol [2, "skein instance"], key ID
   * `libp2p:<handle>`, counterparty self — the key whose public half the
   * instance's signer answers for getPublicKey with those arguments. Not the
   * root itself. Its peer ID is the identity multihash of the compressed key
   * (p2p.ts peerIdOf).
   */
  peerKey(id: string): PrivateKey {
    // #160: one-key mode — the key's child, key ID `libp2p`, the same for every id (the handle is ignored).
    if (this.shared) return this.deriver.derivePrivateKey(INSTANCE_PROTOCOL, "libp2p", "self");
    return new KeyDeriver(this.instanceKey(id)).derivePrivateKey(INSTANCE_PROTOCOL, `libp2p:${id}`, "self");
  }

  /** The instance's identity key (hex): what `skein-host add` records. */
  identity(id: string): string {
    return this.instanceKey(id).toPublicKey().toString();
  }

  /** The instance's signer: a ProtoWallet over its root key (a WalletInterface whose actions reject). */
  wallet(id: string): WalletInterface {
    // #160: one-key mode — one wallet for every instance, its peer-key lookup answered by OneKeyWallet.
    const k = this.shared ? "" : id;
    let w = this.wallets.get(k);
    if (!w) this.wallets.set(k, (w = this.shared ? keyWallet(this.shared, new OneKeyWallet(this.shared, this.peerKey(id))) : ephemeralWallet(this.instanceKey(id))));
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

