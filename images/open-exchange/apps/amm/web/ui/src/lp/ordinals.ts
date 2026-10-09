/**
 * The user's 1Sat ordinals (wallet basket `ORDINALS_BASKET`, "1sat") as icon
 * candidates. An icon is a pointer to the outpoint that holds the image bytes
 * (BRC-162 "Icon"): the output itself when its script carries the inscription,
 * otherwise the `content:` / `origin:` tag 1sat-sdk stamps on ordinal outputs
 * (`ordinalTagsFromMetadata`, @1sat/types).
 */
import { formatOrdinalOutpoint } from "@1sat/types";
import type { WalletOutput } from "@bsv/sdk";
import { imageFromScript, type ImageContent } from "./images";

export interface OrdinalImage {
  /** The wallet output, `txid_vout`. */
  outpoint: string;
  /** Where the image bytes are: the icon pointer to write, `txid_vout`. */
  iconOutpoint: string;
  /** From the inscription, else the `type:` tag. */
  contentType: string;
  /** Present when the output's own script carries the bytes (thumbnail). */
  image?: ImageContent;
}

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  const t = tags?.find((x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length) : undefined;
}

/** Image ordinals among `rows` (listOutputs on the ordinals basket with locking scripts and tags). */
export function imageOrdinals(rows: WalletOutput[]): OrdinalImage[] {
  const out: OrdinalImage[] = [];
  for (const row of rows) {
    const outpoint = formatOrdinalOutpoint(row.outpoint);
    const image = imageFromScript(row.lockingScript);
    const typeTag = tagValue(row.tags, "type:");
    const contentType = image?.contentType ?? typeTag;
    if (!contentType || !contentType.toLowerCase().startsWith("image/")) continue;
    let iconOutpoint: string | undefined;
    if (image) iconOutpoint = outpoint;
    else {
      const pointer = tagValue(row.tags, "content:") ?? tagValue(row.tags, "origin:");
      if (pointer) iconOutpoint = formatOrdinalOutpoint(pointer);
    }
    // Neither the bytes nor a pointer to them: nothing to point an icon at.
    if (!iconOutpoint) continue;
    out.push({ outpoint, iconOutpoint, contentType, ...(image && { image }) });
  }
  return out;
}
