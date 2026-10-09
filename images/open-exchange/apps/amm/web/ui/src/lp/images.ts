/**
 * Image bytes held in a locking script: a 1Sat ordinal inscription (`ord`
 * envelope, @1sat/templates `Inscription`) or a B protocol file
 * (`OP_FALSE OP_RETURN 19Hxig… <data> <type> <encoding>`, @1sat/templates `B`).
 */
import { Inscription, B } from "@1sat/templates";
import { Script, Utils } from "@bsv/sdk";

export interface ImageContent {
  contentType: string;
  bytes: Uint8Array;
  /** Which encoding carried it: an inscription, a B file, or embedded in a Mandala deploy's payload (BRC-162 draft BRCs#308). */
  via: "inscription" | "b" | "embedded";
}

function isImage(type: string | undefined): type is string {
  return !!type && type.split(";")[0]!.trim().toLowerCase().startsWith("image/");
}

/** The image content in `script`, or undefined (no content, or not an image). */
export function imageFromScript(script: Script | string | number[] | undefined): ImageContent | undefined {
  if (script === undefined) return undefined;
  let s: Script;
  try {
    s = typeof script === "string" ? Script.fromHex(script) : Array.isArray(script) ? Script.fromBinary(script) : script;
  } catch {
    return undefined;
  }
  try {
    const ins = Inscription.decode(s);
    if (ins && isImage(ins.file.type) && ins.file.content.length > 0) {
      return { contentType: ins.file.type, bytes: Uint8Array.from(ins.file.content), via: "inscription" };
    }
  } catch {
    /* not an inscription */
  }
  try {
    const b = B.decode(s);
    if (b && isImage(b.mediaType) && b.data.length > 0) {
      return { contentType: b.mediaType, bytes: Uint8Array.from(b.data), via: "b" };
    }
  } catch {
    /* not a B file */
  }
  return undefined;
}

/** `data:` URL for an `<img src>`. */
export function imageDataUrl(img: ImageContent): string {
  return `data:${img.contentType.split(";")[0]!.trim()};base64,${Utils.toBase64(Array.from(img.bytes))}`;
}
