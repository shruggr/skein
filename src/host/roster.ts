// The roster for the front end (#24): every enabled row as
//   {handle, domain, identity, displayName, description, emoji?, avatar?, status}
// with the display fields from the deployed tree's IDENTITY.md (`- Name:`,
// `- Emoji:`, `- Description:`, `- Avatar:` lines), read from the instance's
// store by the row's `tree`; `status` is `live` when the instance runs in this
// host process, else `idle`. `skein-host roster` prints it; `skein-host run`
// serves it at /roster.json (CORS *) for a static page on another origin.

import { createServer, type Server } from "node:http";
import { CID } from "multiformats/cid";
import { readFile, type TreeBlocks } from "../runtime/tree.ts";
import type { InstanceRow } from "./instances.ts";

export interface RosterEntry {
  handle: string;
  domain: string;
  identity: string;
  displayName: string;
  description: string;
  emoji?: string;
  avatar?: string;
  status: "live" | "idle";
}

export type IdentityFields = Pick<RosterEntry, "displayName" | "description" | "emoji" | "avatar">;

const FIELD: Record<string, keyof IdentityFields> = { name: "displayName", description: "description", emoji: "emoji", avatar: "avatar" };

/** IDENTITY.md's `- Key: value` lines (first of each wins); missing ones are "" (name, description) or absent. */
export function parseIdentity(text: string): IdentityFields {
  const out: IdentityFields = { displayName: "", description: "" };
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    const k = m && FIELD[m[1]!.toLowerCase()];
    if (!k || seen.has(k) || !m[2]) continue;
    seen.add(k);
    out[k] = m[2];
  }
  return out;
}

/** The row's entry; `blocks` holds its store, if there is one to read. A tree not (yet) in the store reads as no IDENTITY.md. */
export async function rosterEntry(row: InstanceRow, blocks: TreeBlocks | undefined, live: boolean): Promise<RosterEntry> {
  let id: IdentityFields = { displayName: "", description: "" };
  if (row.tree && blocks) {
    try {
      id = parseIdentity(new TextDecoder().decode(await readFile(blocks, CID.parse(row.tree), "IDENTITY.md")));
    } catch { /* no IDENTITY.md, or the deploy has not been admitted yet */ }
  }
  return { handle: row.handle, domain: row.domain, identity: row.identity ?? "", ...id, status: live ? "live" : "idle" };
}

/**
 * The roster of `rows` (the caller passes the enabled ones). `open` gives a
 * row's store to read, or undefined, and how to let go of it.
 */
export async function roster(rows: InstanceRow[], open: (row: InstanceRow) => Promise<{ blocks?: TreeBlocks; close?(): Promise<void> | void }>, live: (row: InstanceRow) => boolean): Promise<RosterEntry[]> {
  const out: RosterEntry[] = [];
  for (const row of rows) {
    const s = await open(row);
    try { out.push(await rosterEntry(row, s.blocks, live(row))); } finally { await s.close?.(); }
  }
  return out;
}

/** GET /roster.json → get(), CORS *. Resolves once listening (port 0: any; see server.address()). */
export function serveRoster(port: number, get: () => Promise<RosterEntry[]>, host = "127.0.0.1"): Promise<Server> {
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method !== "GET" || path !== "/roster.json") { res.writeHead(404, { "content-type": "text/plain" }).end("not found\n"); return; }
    try {
      const body = JSON.stringify(await get());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(`${(e as Error).message}\n`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(server); });
  });
}
