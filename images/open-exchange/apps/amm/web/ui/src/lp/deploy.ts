/**
 * Deploy a Mandala token: a wallet action and nothing else (docs/notes.md
 * "Token deploy and the LP page"). One `createAction`:
 *
 * - output 0: `Mandala.deployValue(amount, …)` or `Mandala.deployAuthority(…)`,
 *   P2PKH to a wallet-derived key, payload {sym, dec, icon}; basket `bsv21`,
 *   tags and customInstructions as 1sat-sdk's `deployBsv21Mint` /
 *   `deployBsv21Auth` file them (`bsv21:deploy` [+ `bsv21:auth`], no
 *   `bsv21:<id>` and no `id` in customInstructions: the id is this outpoint).
 *
 * The icon is embedded in the deploy's payload (BRC-162 draft
 * bsv-blockchain/BRCs#308: `icon` is `[mediaType, bytes]`; the pointer forms,
 * an outpoint or an output index, are gone — 0.8.0, on skein-mandala 0.9.0):
 * an uploaded image, or a copy of one of the wallet's image ordinals' bytes.
 * No second output carries it (before 0.8.0: output 1, an inscription or a B
 * file, the payload pointing at it).
 *
 * Keys: BRC-42 `getPublicKey` under 1sat-sdk's protocol (`P1SAT_PROTOCOL`),
 * counterparty self, keyID `<prefix>-<random hex>` as 1sat-sdk's
 * `resolveDestination` mints them; keyID recorded in customInstructions.
 *
 * Broadcast: 1sat-sdk's `runCreateActionPipeline` (what its actions run:
 * managed `id:` tags, createAction, signAction), the wallet broadcasts.
 */
import Mandala, { type MandalaMetadata } from "@1sat/templates/mandala";
import {
  BSV21_AUTH_TAG,
  BSV21_BASKET,
  BSV21_DEPLOY_TAG,
  MAX_INSCRIPTION_BYTES,
  P1SAT_PROTOCOL,
  buildBsv21CustomInstructions,
  runCreateActionPipeline,
} from "@1sat/actions";
import {
  PublicKey,
  Utils,
  type CreateActionArgs,
  type CreateActionOutput,
  type WalletInterface,
  type WalletProtocol,
} from "@bsv/sdk";
import { tokenIdText } from "../lib/tokenId";

export type SupplyModel = { kind: "fixed"; amount: bigint } | { kind: "authority" };

/** The icon to embed: none, or an image's bytes and media type (an uploaded file, or one of the user's image ordinals' bytes). */
export type IconChoice =
  | { kind: "none" }
  | { kind: "ordinal" | "upload"; content: Uint8Array; contentType: string };

export interface DeployRequest {
  symbol: string;
  decimals: number;
  supply: SupplyModel;
  icon: IconChoice;
}

/** A wallet-derived key: what to lock to and what to record. */
export interface DerivedKey {
  protocolID: WalletProtocol;
  keyID: string;
  /** Compressed public key, hex. */
  publicKey: string;
}

/** The deploy output's index (BRC-162: deploys are output 0). */
export const DEPLOY_VOUT = 0;

/** BRC-100 descriptions are 5-50 characters. */
function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

export function validateRequest(req: DeployRequest): void {
  if (!req.symbol.trim()) throw new Error("symbol is required");
  if (!Number.isInteger(req.decimals) || req.decimals < 0 || req.decimals > 18) {
    throw new Error("decimals must be an integer 0-18");
  }
  if (req.supply.kind === "fixed" && req.supply.amount <= 0n) throw new Error("supply must be positive");
  if (req.icon.kind !== "none") {
    if (!req.icon.contentType.startsWith("image/")) throw new Error("the icon must be an image");
    if (req.icon.content.length === 0) throw new Error("the icon file is empty");
    if (req.icon.content.length > MAX_INSCRIPTION_BYTES) {
      throw new Error(`the icon is ${req.icon.content.length} bytes; at most ${MAX_INSCRIPTION_BYTES}`);
    }
  }
}

/** The keyID prefix 1sat-sdk uses for the deploy output. */
export function keyIdPrefixes(req: DeployRequest): { token: string } {
  const sym = req.symbol.trim();
  return { token: req.supply.kind === "fixed" ? `bsv21-deploy-${sym}` : `bsv21-auth-${sym}` };
}

/** The createAction arguments for a deploy, given the derived key. Pure. */
export function buildDeployArgs(req: DeployRequest, tokenKey: DerivedKey): CreateActionArgs {
  validateRequest(req);
  const sym = req.symbol.trim();
  const fixed = req.supply.kind === "fixed";
  const amount = req.supply.kind === "fixed" ? req.supply.amount : 0n;

  const payload: MandalaMetadata = { sym, dec: req.decimals };
  if (req.icon.kind !== "none") payload.icon = { mediaType: req.icon.contentType.split(";")[0]!.trim().toLowerCase(), bytes: req.icon.content };

  const tokenAddress = PublicKey.fromString(tokenKey.publicKey).toAddress();
  const deploy = fixed
    ? Mandala.deployValue(amount, { lock: tokenAddress, payload })
    : Mandala.deployAuthority({ lock: tokenAddress, payload });

  const outputs: CreateActionOutput[] = [
    {
      lockingScript: deploy.lock().toHex(),
      satoshis: 1,
      outputDescription: describe(fixed ? `Deploy ${sym}` : `Deploy ${sym} auth`),
      basket: BSV21_BASKET,
      tags: fixed ? [BSV21_DEPLOY_TAG] : [BSV21_DEPLOY_TAG, BSV21_AUTH_TAG],
      customInstructions: buildBsv21CustomInstructions({
        // No `id`: the token id is this output's outpoint.
        token: {
          amt: String(amount),
          op: fixed ? "deploy+mint" : "deploy+auth",
          sym,
          dec: req.decimals,
          // The icon is in the payload itself (embedded): the JSON's `icon` string has nothing to point at.
        },
        protocolID: tokenKey.protocolID,
        keyID: tokenKey.keyID,
      }),
    },
  ];

  return {
    description: describe(fixed ? `Deploy ${sym} (${amount} fixed supply)` : `Deploy ${sym} (mintable)`),
    outputs,
    // The deploy must stay output 0.
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  };
}

function randomHex(bytes = 8): string {
  return Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(bytes))));
}

/** BRC-42 self key under 1sat-sdk's protocol, as `resolveDestination` derives it. */
export async function deriveSelfKey(wallet: WalletInterface, keyIDPrefix: string): Promise<DerivedKey> {
  const protocolID = P1SAT_PROTOCOL as WalletProtocol;
  const keyID = `${keyIDPrefix}-${randomHex()}`;
  const { publicKey } = await wallet.getPublicKey({ protocolID, keyID, counterparty: "self", forSelf: true });
  return { protocolID, keyID, publicKey };
}

export interface DeployResult {
  txid: string;
  /** `<txid>_0`: the token's id (src/lib/tokenId.ts). */
  tokenId: string;
  args: CreateActionArgs;
}

export async function deployToken(wallet: WalletInterface, req: DeployRequest): Promise<DeployResult> {
  validateRequest(req);
  const prefixes = keyIdPrefixes(req);
  const tokenKey = await deriveSelfKey(wallet, prefixes.token);
  const args = buildDeployArgs(req, tokenKey);
  const result = await runCreateActionPipeline(wallet, args, []);
  if (result.error) throw new Error(result.error);
  if (!result.txid) throw new Error("the wallet returned no txid");
  return { txid: result.txid, tokenId: tokenIdText({ txid: result.txid, vout: DEPLOY_VOUT }), args };
}
