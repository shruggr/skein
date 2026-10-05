// The roster for the front end (#24): every enabled row as
//   {handle, domain, identity, displayName, description, emoji?, avatar?, status}
// with the display fields from the deployed tree's IDENTITY.md (`- Name:`,
// `- Emoji:`, `- Description:`, `- Avatar:` lines), read from the instance's
// store by the row's `tree` (else, #124, the store's `main`); `status` is `live` when the instance's process,
// supervised by this host (`skein-host run`), is up and ready, else `idle`.
// `skein-host roster` prints it; `skein-host run` serves it at /roster.json
// (CORS *) for a static page on another origin, and an operator page at /
// (hostPage): every instance, its process, a link to its origin (a skein
// from the default image serves its management page there, #92).
//
// Each agent's own roster (#27) is a file, ROSTER.md (`skein-host roster --for`
// prints it; the owner deploys it with the directory: `skein plan deploy
// --only …,ROSTER.md`), which the loop appends to the system prompt: the colleagues the row
// `knows` (host.db), each with its address — `- @kurt@localhost — Kurt: …`.

import { createServer, type Server } from "node:http";
import { CID } from "multiformats/cid";
import { headTree, MAIN } from "../runtime/heads.ts";
import type { Store } from "../runtime/store.ts";
import { lookup, readBlob, readFile, type TreeBlocks } from "../runtime/tree.ts";
import { knowsOf, type InstanceRow } from "./instances.ts";

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
  const tree = await treeOf(row, blocks);
  if (tree && blocks) {
    try {
      id = parseIdentity(new TextDecoder().decode(await readFile(blocks, tree, "IDENTITY.md")));
    } catch { /* no IDENTITY.md, or the deploy has not been admitted yet: the page shows the row without a name either way */ }
  }
  return { handle: row.handle, domain: row.domain, identity: row.identity ?? "", ...id, status: live ? "live" : "idle" };
}

/** The row's deployed tree: its `tree`, else (#124: the owner deploys by message) the store's `main`. */
async function treeOf(row: InstanceRow, blocks: TreeBlocks | undefined): Promise<CID | undefined> {
  if (row.tree) return CID.parse(row.tree);
  const s = blocks as Partial<Store> | undefined;
  if (!s?.log || !(await s.log.tip())) return undefined;
  try { return await headTree(s as Store, MAIN); } catch { return undefined; }
}

/**
 * IDENTITY.md's fields in the row's deployed tree: empty ones if the tree has
 * none, undefined if there is no tree or `blocks` does not have it (yet).
 */
export async function deployedIdentity(row: InstanceRow, blocks: TreeBlocks | undefined): Promise<IdentityFields | undefined> {
  const tree = await treeOf(row, blocks);
  if (!tree || !blocks) return undefined;
  if (!(await blocks.has(tree))) return undefined;
  const leaf = await lookup(blocks, tree, "IDENTITY.md");
  return leaf ? parseIdentity(new TextDecoder().decode(await readBlob(blocks, leaf.cid))) : { displayName: "", description: "" };
}

/** The heading of every ROSTER.md. */
export const ROSTER_HEADING = "## Colleagues";

/**
 * `row`'s ROSTER.md: the rows it knows among `rows` (in their order; itself
 * never; `knows` naming no row is skipped), one line each —
 * `- @handle@domain — Name: description` (no name: the handle; no
 * description: no ": …"). Undefined when it knows nobody: no file.
 */
export async function rosterFor(row: InstanceRow, rows: InstanceRow[], fields: (row: InstanceRow) => Promise<IdentityFields>): Promise<string | undefined> {
  const k = knowsOf(row);
  const known = rows.filter((r) => r.handle !== row.handle && (k === "all" || k.includes(r.handle)));
  if (!known.length) return undefined;
  const lines: string[] = [];
  for (const r of known) {
    const f = await fields(r);
    const oneLine = (x: string) => x.replace(/\s+/g, " ").trim();
    const name = oneLine(f.displayName) || r.handle, description = oneLine(f.description);
    lines.push(`- @${r.handle}@${r.domain} — ${name}${description ? `: ${description}` : ""}`);
  }
  return `${ROSTER_HEADING}\n\n${lines.join("\n")}\n`;
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

/** One instance as the operator page shows it. */
export interface HostRow {
  handle: string; domain: string; identity: string; status: "live" | "idle" | "not run";
  store: string; tree: string; pid?: number; restarts: number;
  /** The instance's origin: a skein from the default image serves the management site there (#92). */
  origin?: string;
  /** The instance's next wake (ms), if it has one: the waker's earliest, or the cron provider's next tick (#69). */
  wake?: number;
}

/** The router's side of the page (#40): where it is, each instance's origin, the mailbox instances. */
export interface HostInfo {
  router?: string;
  originOf?(handle: string): string;
  mailboxes?: Array<{ handle: string; domain: string; owner?: string | null }>;
}

const esc = (x: unknown) => String(x).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The host's operator page (#23): read-only, one row per enabled instance, a link to each one's origin. */
export function hostPage(rows: HostRow[], info: HostInfo = {}): string {
  const body = rows.map((r) => `<tr><td><b>${esc(r.handle)}</b>@${esc(r.domain)}</td><td class="k" title="${esc(r.identity)}">${r.identity ? `${esc(r.identity.slice(0, 16))}…` : "—"}</td>
<td class="${r.status === "live" ? "ok" : "mut"}">${esc(r.status)}${r.restarts ? ` <span class="mut">(${r.restarts} restart${r.restarts === 1 ? "" : "s"})</span>` : ""}${r.wake !== undefined ? ` <span class="mut small" title="the waker hydrates it then">wakes ${esc(new Date(r.wake).toISOString().replace("T", " ").slice(0, 19))}</span>` : ""}</td><td>${r.pid ?? "—"}</td>
<td class="k">${esc(r.store)}</td><td class="k" title="${esc(r.tree)}">${r.tree ? `…${esc(r.tree.slice(-12))}` : "—"}</td><td>${r.origin ? `<a href="${esc(r.origin)}/">open</a>` : "—"}</td></tr>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>skein host</title>
<style>:root{--bg:#fbfaf7;--fg:#1d1c1a;--mut:#6b6760;--line:#e3e0d8;--acc:#2f5fd0;--ok:#1f7a3d}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#e8e6e1;--mut:#9a968e;--line:#2c2b28;--acc:#8fb0ff;--ok:#6fcf8f}}
body{margin:0 auto;max-width:1100px;padding:14px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
a{color:var(--acc)}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{font-size:13px;color:var(--mut);font-weight:600}.k{font-family:ui-monospace,monospace;font-size:13px}.mut{color:var(--mut)}.ok{color:var(--ok)}</style></head>
<body><h1 style="font-size:19px">skein host <span class="mut" style="font-size:13px">${rows.length} instance${rows.length === 1 ? "" : "s"} · <a href="/roster.json">roster.json</a></span></h1>
${info.router ? `<p class="mut">router <code>${esc(info.router)}</code>${info.originOf ? ` · an instance at <code>${esc(info.originOf("<handle>"))}</code> (its front door)` : ""} · an instance is <span class="ok">live</span> while its kernel runs; the router starts it on demand and stops it when idle</p>` : ""}
<table><tr><th>handle</th><th>identity</th><th>status</th><th>pid</th><th>store</th><th>tree</th><th>origin</th></tr>
${body}</table>
${info.mailboxes ? `<h2 style="font-size:16px">mailbox instances</h2>${info.mailboxes.length ? `<table><tr><th>handle</th><th>whose</th><th>origin</th></tr>
${info.mailboxes.map((m) => `<tr><td><b>${esc(m.handle)}</b>@${esc(m.domain)}</td><td class="k" title="${esc(m.owner ?? "")}">${esc((m.owner ?? "").slice(0, 16))}…</td><td class="k">${esc(info.originOf?.(m.handle) ?? "")}</td></tr>`).join("\n")}</table>` : `<p class="mut">none (skein-host add --mailbox, or POST /account/register)</p>`}` : ""}</body></html>`;
}

/**
 * GET /roster.json → get(), CORS *; GET / → page(), if given. Resolves once
 * listening (port 0: any; see server.address()).
 */
export function serveRoster(port: number, get: () => Promise<RosterEntry[]>, host = "127.0.0.1", page?: () => Promise<string>): Promise<Server> {
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/" && page) {
      try {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(await page());
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain" }).end(`${(e as Error).message}\n`);
      }
      return;
    }
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
