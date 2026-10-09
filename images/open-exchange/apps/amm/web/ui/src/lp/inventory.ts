/**
 * The token inventory, from the wallet only (docs/notes.md "Name and wallet
 * convention", "Token deploy and the LP page"): the `bsv21` basket's outputs,
 * decoded from their locking scripts, grouped by token id and summed.
 *
 * Decoding: 1sat-sdk's `Mandala.decode` (binary, BRC-162) first, then the
 * BSV21 inscription template (legacy JSON, BRC-161); binary wins when a script
 * carries a valid prefix. The script is the authority; tags and
 * customInstructions are the wallet's index, not consulted for amounts.
 *
 * Metadata (sym/dec/icon) comes from a deploy output the wallet holds. A
 * token without one shows id and balance only. A Mandala (binary) deploy's
 * icon is the image embedded in it (BRC-162 draft bsv-blockchain/BRCs#308:
 * `[mediaType, bytes]`; the pointer forms are gone); a legacy BSV-21 JSON
 * deploy's icon is an outpoint, resolved as before (`resolveIcon`).
 */
import Mandala, { type MandalaIcon } from "@1sat/templates/mandala";
import { BSV21 } from "@1sat/templates";
import { formatOrdinalOutpoint } from "@1sat/types";
import { Script, type Transaction, type WalletOutput } from "@bsv/sdk";
import { imageFromScript, type ImageContent } from "./images";
import { isPoolRow } from "./poolRows";
import { parseOutpoint, parseTokenId, sdkTokenId, tokenIdOfWire, tokenIdText } from "../lib/tokenId";

export type TokenRole = "deploy" | "value" | "authority";
export type TokenEncoding = "mandala" | "bsv21";

export interface TokenMetadata {
  sym?: string;
  dec?: number;
  /** Mandala: the image embedded in the deploy; BSV-21 JSON: a `txid_vout` outpoint (or the raw string). */
  icon?: string | MandalaIcon;
}

export interface TokenOutput {
  /** `txid_vout` */
  outpoint: string;
  /** `<txid>_<vout>` for every token, `_0` included (src/lib/tokenId.ts). */
  tokenId: string;
  role: TokenRole;
  /** Base units; 0n on an authority (or an authority deploy). */
  amount: bigint;
  encoding: TokenEncoding;
  /** Deploys only. */
  metadata?: TokenMetadata;
}

export interface IconRef {
  /** The outpoint the icon points at, `txid_vout` (or the raw legacy string); an embedded icon's, its deploy's. */
  outpoint: string;
  /** The bytes, when the wallet holds that output or its transaction. */
  image?: ImageContent;
}

export interface TokenSummary {
  tokenId: string;
  /** Sum of value outputs and a fixed-supply deploy, base units. */
  balance: bigint;
  valueOutputs: number;
  /** Authority outputs, an authority deploy included. */
  authorities: number;
  encodings: TokenEncoding[];
  deployInWallet: boolean;
  sym?: string;
  dec?: number;
  icon?: IconRef;
}

export interface Inventory {
  tokens: TokenSummary[];
  /** Basket outputs neither template decodes (or a legacy burn). */
  unrecognized: string[];
  /** Pool outputs held as LP (`amm-pool` rows): not counted in balances. */
  pools: string[];
}

/** One `bsv21` basket row → its token output, or undefined. */
export function decodeTokenRow(row: Pick<WalletOutput, "outpoint" | "lockingScript">): TokenOutput | undefined {
  if (!row.lockingScript) return undefined;
  const outpoint = formatOrdinalOutpoint(row.outpoint);
  let script: Script;
  try {
    script = Script.fromHex(row.lockingScript);
  } catch {
    return undefined;
  }

  const bin = Mandala.decode(script);
  if (bin) {
    if (bin.role === "deploy") {
      const op = parseOutpoint(outpoint);
      if (!op) return undefined;
      return { outpoint, tokenId: tokenIdText(op), role: "deploy", amount: bin.amount, encoding: "mandala", metadata: bin.metadata ?? {} };
    }
    // A 32-byte id is `<txid>_0`, a 36-byte one `<txid>_<vout>`.
    return { outpoint, tokenId: tokenIdOfWire(bin.idBytes!), role: bin.role, amount: bin.amount, encoding: "mandala" };
  }

  let json: BSV21 | null = null;
  try {
    json = BSV21.decode(script);
  } catch {
    json = null;
  }
  if (!json) return undefined;
  const td = json.tokenData;
  let amount: bigint;
  try {
    amount = BigInt(td.amt ?? "0");
  } catch {
    return undefined;
  }
  switch (td.op) {
    case "deploy+mint":
    case "deploy+auth": {
      const metadata: TokenMetadata = {};
      if (typeof td.sym === "string") metadata.sym = td.sym;
      const dec = Number(td.dec ?? 0);
      if (Number.isInteger(dec) && dec >= 0 && dec <= 18) metadata.dec = dec;
      if (typeof td.icon === "string" && td.icon) metadata.icon = td.icon;
      return {
        outpoint,
        tokenId: outpoint,
        role: "deploy",
        amount: td.op === "deploy+auth" ? 0n : amount,
        encoding: "bsv21",
        metadata,
      };
    }
    case "transfer":
    case "mint":
      if (!td.id) return undefined;
      return { outpoint, tokenId: formatOrdinalOutpoint(td.id), role: "value", amount, encoding: "bsv21" };
    case "auth":
      if (!td.id) return undefined;
      return { outpoint, tokenId: formatOrdinalOutpoint(td.id), role: "authority", amount: 0n, encoding: "bsv21" };
    default:
      return undefined; // burn: not a balance
  }
}

/** Where the wallet may hold icon bytes: ordinal rows (with scripts) and transactions by txid. */
export interface IconSources {
  ordinalRows?: WalletOutput[];
  txs?: Map<string, Transaction>;
}

/** Find the image at `outpoint` in what the wallet gave us. */
export function resolveIcon(outpoint: string, sources: IconSources): IconRef {
  const op = parseOutpoint(outpoint);
  if (!op) return { outpoint };
  const norm = `${op.txid}_${op.vout}`;
  for (const row of sources.ordinalRows ?? []) {
    if (formatOrdinalOutpoint(row.outpoint).toLowerCase() !== norm) continue;
    const image = imageFromScript(row.lockingScript);
    if (image) return { outpoint: norm, image };
  }
  const tx = sources.txs?.get(op.txid);
  const out = tx?.outputs[op.vout];
  if (out) {
    const image = imageFromScript(out.lockingScript);
    if (image) return { outpoint: norm, image };
  }
  return { outpoint: norm };
}

/**
 * The icon of a deploy: a Mandala deploy's embedded image, as it is (nothing to resolve); a
 * BSV-21 JSON deploy's outpoint, resolved from what the wallet holds.
 */
export function deployIcon(deploy: TokenOutput, sources: IconSources): IconRef | undefined {
  const icon = deploy.metadata?.icon;
  if (icon === undefined) return undefined;
  if (typeof icon !== "string") {
    // An image only (as `imageFromScript` takes one); another media type shows no picture.
    if (!/^image\//i.test(icon.mediaType.trim()) || icon.bytes.length === 0) return { outpoint: deploy.outpoint };
    return { outpoint: deploy.outpoint, image: { contentType: icon.mediaType, bytes: Uint8Array.from(icon.bytes), via: "embedded" } };
  }
  return parseOutpoint(icon) ? resolveIcon(icon, sources) : { outpoint: icon };
}

/** Group decoded `bsv21` rows by token (any id form of the same token is one), its id `<txid>_<vout>`. */
export function buildInventory(tokenRows: WalletOutput[], sources: IconSources = {}): Inventory {
  const byId = new Map<string, TokenSummary>();
  const unrecognized: string[] = [];
  const pools: string[] = [];
  for (const row of tokenRows) {
    if (isPoolRow(row)) {
      pools.push(formatOrdinalOutpoint(row.outpoint));
      continue;
    }
    const t = decodeTokenRow(row);
    if (!t) {
      unrecognized.push(formatOrdinalOutpoint(row.outpoint));
      continue;
    }
    const key = parseTokenId(t.tokenId) ? sdkTokenId(t.tokenId) : t.tokenId; // a malformed legacy id groups as written
    let s = byId.get(key);
    if (!s) {
      s = { tokenId: key, balance: 0n, valueOutputs: 0, authorities: 0, encodings: [], deployInWallet: false };
      byId.set(key, s);
    }
    if (!s.encodings.includes(t.encoding)) s.encodings.push(t.encoding);
    if (t.amount === 0n) s.authorities++;
    else {
      s.balance += t.amount;
      s.valueOutputs++;
    }
    if (t.role === "deploy") {
      s.deployInWallet = true;
      const m = t.metadata ?? {};
      if (m.sym !== undefined) s.sym = m.sym;
      if (m.dec !== undefined) s.dec = m.dec;
      const icon = deployIcon(t, sources);
      if (icon) s.icon = icon;
    }
  }
  const tokens = [...byId.values()].sort(
    (a, b) => (a.sym ?? "￿").localeCompare(b.sym ?? "￿") || a.tokenId.localeCompare(b.tokenId),
  );
  return { tokens, unrecognized, pools };
}
