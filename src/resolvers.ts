// URL → bytes. The registry is the only place routes live; blocks hold CIDs
// and URLs, never "where to fetch it". The fragment (a locator) is ignored
// here: it is for whoever finally opens the bytes.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "./cid.ts";
import { NotFound, type Blocks, type Resolved, type Resolver, type Resolvers } from "./store.ts";

const scheme = (s: string) => s.replace(/:$/, "").toLowerCase();

export function createResolvers(blocks: Pick<Blocks, "bytes">): Resolvers {
  const table = new Map<string, Resolver>();
  const registry: Resolvers = {
    register(s, resolver) { table.set(scheme(s), resolver); },
    async resolve(input) {
      let url: URL;
      try { url = typeof input === "string" ? new URL(input) : input; }
      catch { return { ok: false, reason: "unknown-scheme", message: `not a URL: ${input}` }; }
      const r = table.get(scheme(url.protocol));
      if (!r) return { ok: false, reason: "unknown-scheme", message: `no resolver for ${url.protocol}` };
      try { return await r(url); }
      catch (e) { return { ok: false, reason: "unreachable", message: String((e as Error)?.message ?? e) }; }
    },
  };
  registry.register("skein", skeinResolver(blocks));
  registry.register("file", fileResolver);
  return registry;
}

/** `skein://<cid>` (or `skein:<cid>`) → the block's dag-cbor bytes. */
export function skeinResolver(blocks: Pick<Blocks, "bytes">): Resolver {
  return async (url) => {
    const s = url.host || url.pathname.replace(/^\/+/, "");
    let cid;
    try { cid = parse(s); }
    catch { return { ok: false, reason: "not-found", message: `not a CID: ${s}` }; }
    try {
      return { ok: true, bytes: await blocks.bytes(cid), contentType: "application/vnd.ipld.dag-cbor" };
    } catch (e) {
      if (e instanceof NotFound) return { ok: false, reason: "not-found", message: e.message };
      throw e;
    }
  };
}

export const fileResolver: Resolver = async (url) => {
  try {
    return { ok: true, bytes: new Uint8Array(await readFile(fileURLToPath(url))) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "not-found", message: String(e) };
    return { ok: false, reason: "unreachable", message: String(e) };
  }
};
