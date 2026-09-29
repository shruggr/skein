// The signing oracle (#18, #29): one master secret held by the router, and
// per instance a root key derived from it with BRC-42/43 — protocol
// [2, "skein instance"], key ID = the instance id (its handle), counterparty
// self — behind a ProtoWallet: getPublicKey, createSignature, encrypt,
// decrypt, createHmac (and their verify halves), no storage, no actions. The
// instance's identity key is that child's public key; provisioning an
// instance is picking an id. The router answers the kernel's `wallet` import
// from it in process (kernel.ts), and authenticates its own transport (BRC-104)
// as a second child, [2, "skein router"] / "messagebox". Its libp2p host (#51)
// signs as a third per instance: [2, "skein instance"], key ID
// `libp2p:<handle>`, self (peerKey).
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
export const ROUTER_PROTOCOL: WalletProtocol = [2, "skein router"];

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

export class Oracle {
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

  /** The instance's oracle: a ProtoWallet over its root key (a WalletInterface whose actions reject). */
  wallet(id: string): WalletInterface {
    let w = this.wallets.get(id);
    if (!w) this.wallets.set(id, (w = ephemeralWallet(this.instanceKey(id))));
    return w;
  }

  /** The router's own transport identity (BRC-104 server key). */
  routerWallet(): WalletInterface {
    let w = this.wallets.get("\0router");
    if (!w) this.wallets.set("\0router", (w = ephemeralWallet(this.deriver.derivePrivateKey(ROUTER_PROTOCOL, "messagebox", "self"))));
    return w;
  }
}
