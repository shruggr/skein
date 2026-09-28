// HTML for the explorer. Server-rendered from the read model (view.ts); the
// only script polls a thread that is not at rest and swaps its fragment in.
// Every CID is a link: threads to /t/, log entries to /e/, anything else to /r/.

import type { CID } from "multiformats/cid";
import { decode, encode, isCID } from "../../runtime/cid.ts";
import { headTree, type HeadUpdate } from "../../runtime/heads.ts";
import type { SubscriptionUpdate } from "../../runtime/subscriptions.ts";
import { short, stampMs } from "../../runtime/log.ts";
import { RAW } from "../../runtime/programs.ts";
import type { Attested, Emit } from "../../runtime/records.ts";
import { WALLET_CALLS } from "../../runtime/scheduler.ts";
import { GIT_RAW, lookup, parseTree, readBlob, readTree } from "../../runtime/tree.ts";
import type { Ref } from "../../runtime/types.ts";
import { signedPart, verify } from "../../envelope.ts";
import { escapeHtml, markdownToHtml } from "../../../web/markdown.ts";
import { ancestry, emitter, headMoves, headNames, kindOf, label, maybe, routeOf, rulesAt, senderOf, tryDecode, type EnvelopeRecord, type Thread, type Update, type World } from "./view.ts";

const DAG_CBOR = 0x71;
const esc = (x: unknown) => escapeHtml(String(x));
const LIVE = new Set(["new", "running", "waiting"]);

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1c1a;--mut:#6b6760;--line:#e3e0d8;--card:#fff;--acc:#2f5fd0;--say:#f3efe2;--ok:#1f7a3d;--bad:#b3261e;--wait:#9a6a00;--code:#f2f0ea}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#e8e6e1;--mut:#9a968e;--line:#2c2b28;--card:#1c1b19;--acc:#8fb0ff;--say:#2a2720;--ok:#6fcf8f;--bad:#ff8a80;--wait:#e0b44c;--code:#23221f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
main,header.top{max-width:960px;margin:0 auto;padding:0 16px}
header.top{display:flex;gap:16px;align-items:baseline;padding-top:14px;padding-bottom:6px}
header.top a.home{font-weight:700;color:var(--fg);text-decoration:none;font-size:18px}
a{color:var(--acc)}
h1{font-size:19px;margin:10px 0 6px;overflow-wrap:anywhere}
h2{font-size:15px;margin:18px 0 4px}
.mut{color:var(--mut)}.small{font-size:13px}
code,pre,.cid,.key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:var(--code);padding:8px 10px;border-radius:6px;overflow:auto;max-height:28em;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
pre.err{color:var(--bad)}
table{border-collapse:collapse;width:100%;margin:6px 0}
td,th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top}
th{font-weight:600;font-size:13px;color:var(--mut)}
table.kv th{width:9em}
td{overflow-wrap:anywhere}
.st{display:inline-block;padding:0 7px;border-radius:9px;font-size:12px;border:1px solid currentColor;white-space:nowrap}
.st.finished,.st.delivered{color:var(--ok)}.st.failed,.st.errored,.st.dropped,.st.out-of-context{color:var(--bad)}.st.waiting,.st.new{color:var(--wait)}.st.running{color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:12px 0}
.card>.hd{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--mut);flex-wrap:wrap}
.asked{background:var(--say);border-radius:8px;padding:6px 10px;margin:6px 0;white-space:pre-wrap}
.say{font-size:17px;line-height:1.4;border-left:4px solid var(--acc);padding:4px 12px;margin:8px 0;white-space:pre-wrap}
.text{border-left:4px solid var(--line);padding:0 12px;margin:6px 0}
.turn{margin:8px 0}.who{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.bad{color:var(--bad)}.ok{color:var(--ok)}
.chain{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0;padding:0;list-style:none}
.chain li a{text-decoration:none}
ul.plain{list-style:none;padding:0;margin:4px 0}ul.plain li{margin:2px 0;overflow-wrap:anywhere}
details>summary{cursor:pointer;color:var(--mut);font-size:13px}
.json{max-height:none}
nav.pager{display:flex;gap:16px;margin:10px 0}
@media (max-width:600px){.hide-sm{display:none}}
`;

// ---------------------------------------------------------------- bits

export function layout(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header class="top"><a class="home" href="/">skein explorer</a><a class="small" href="/log">log</a><a class="small" href="/threads">threads</a></header>
<main id="main">${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

/** Where a CID's page is. */
function href(w: World, c: CID | string): string {
  const s = c.toString();
  return w.byThread.has(s) ? `/t/${s}` : w.entries.has(s) ? `/e/${s}` : `/r/${s}`;
}
const link = (w: World, c: CID | string, text = short(c)) => `<a class="cid" href="${esc(href(w, c))}" title="${esc(c.toString())}">${esc(text)}</a>`;
const st = (s: string) => `<span class="st ${esc(s)}">${esc(s)}</span>`;
const iso = (ms: number) => new Date(ms).toISOString();
const time = (ms: number) => `<time datetime="${iso(ms)}" title="${iso(ms)}">${iso(ms).replace("T", " ").slice(0, 19)}</time>`;
const text = (b: unknown) => (b instanceof Uint8Array ? Buffer.from(b).toString("utf8") : typeof b === "string" ? b : "");
const key = (w: World, id: string | undefined) => (id ? `<span class="key" title="${esc(id)}">${esc(label(w, id) ?? `${id.slice(0, 10)}…`)}</span>` : "");
const kv = (rows: Array<[string, string]>) => `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</table>`;
const details = (summary: string, inner: string, k?: string) => `<details${k ? ` data-k="${esc(k)}"` : ""}><summary>${esc(summary)}</summary>${inner}</details>`;
const threadLink = (w: World, t: Thread) => `${link(w, t.cid)} <span class="mut">${esc(t.program)}</span> ${st(t.state)}`;
const entryLink = (w: World, e: CID | undefined) => {
  if (!e) return "";
  const x = w.entries.get(e.toString());
  return x ? `<a href="/e/${e}" title="${e}">#${x.entry.n}${x.entry.box ? ` ${esc(x.entry.box)}` : x.entry.outcome ? ` ${esc(x.entry.outcome.status)}` : x.entry.envelope ? "" : ` ${kindOf(x.entry)}`}</a>` : link(w, e);
};

/** An emit's outcome, as the delivery provider reported it: delivered, failed (why), or none yet. */
const outcomeOf = (w: World, emit: CID) => {
  const x = w.outcomes.get(emit.toString());
  if (!x) return `<span class="st new">no outcome yet</span>`;
  const o = x.entry.outcome!;
  return `${st(o.status)}${o.reason ? ` <span class="bad">${esc(o.reason)}</span>` : ""} ${entryLink(w, x.cid)}`;
};

/** JSON-shaped HTML with every CID a link and bytes summarised. */
export function jsonHtml(w: World, v: unknown, depth = 0): string {
  const pad = "  ".repeat(depth + 1), end = "  ".repeat(depth);
  if (isCID(v)) return link(w, v, v.toString());
  if (v instanceof Uint8Array) {
    const t = text(v);
    return `<span class="mut">&lt;${v.length} bytes&gt;</span>${v.length && /^[\t\n\r\x20-\x7e]*$/.test(t) ? ` ${esc(JSON.stringify(t.length > 2000 ? `${t.slice(0, 2000)}…` : t))}` : v.length ? ` ${Buffer.from(v.subarray(0, 32)).toString("hex")}${v.length > 32 ? "…" : ""}` : ""}`;
  }
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => pad + jsonHtml(w, x, depth + 1)).join(",\n")}\n${end}]` : "[]";
  if (v && typeof v === "object") {
    const es = Object.entries(v);
    return es.length ? `{\n${es.map(([k, x]) => `${pad}${esc(JSON.stringify(k))}: ${jsonHtml(w, x, depth + 1)}`).join(",\n")}\n${end}}` : "{}";
  }
  return esc(JSON.stringify(v) ?? "undefined");
}
const json = (w: World, v: unknown) => `<pre class="json">${jsonHtml(w, v)}</pre>`;

export function errorPage(status: number, message: string): string {
  return layout(`${status}`, `<h1>${status}</h1><pre>${esc(message)}</pre>`);
}

// ---------------------------------------------------------------- /

export async function overview(w: World): Promise<string> {
  const g = w.genesis;
  const tip = w.log.at(-1);
  if (!g) return layout("skein explorer", `<h1>empty store</h1><p class="mut">no genesis in the log yet</p>`);
  const heads = await Promise.all((await headNames(w)).map(async (n) => {
    const tree = await headTree(w.store, n);
    return `<tr><td><a href="/h/${encodeURIComponent(n)}">${esc(n)}</a></td><td>${tree ? link(w, tree, tree.toString()) : `<span class="mut">never moved</span>`}</td></tr>`;
  }));
  const rules = rulesAt(w);
  const subs = rules.map((s, i) => `<tr><td>${i}</td><td>${s.match.sender ? key(w, s.match.sender) : `<span class="mut">anyone</span>`}</td><td>${esc(s.match.box ?? "any")}</td><td>${link(w, s.handler, programOf(w, s.handler))}</td></tr>`).join("");
  const boxes = new Map<string, number>();
  for (const b of [...rules.map((s) => s.match.box), ...(g.collect ?? [])]) if (b) boxes.set(b, 0);
  for (const { entry } of w.log) if (entry.box) boxes.set(entry.box, (boxes.get(entry.box) ?? 0) + 1);
  const states = new Map<string, number>();
  for (const t of w.threads) states.set(t.state, (states.get(t.state) ?? 0) + 1);
  const ident = (id: string) => `<span class="key">${esc(id)}</span>`;
  return layout(`${g.handle}@${g.domain}`, `<h1>${esc(g.handle)}@${esc(g.domain)}</h1>
${kv([
    ["identity", ident(g.identity)],
    ["host", g.host ? ident(g.host) : `<span class="mut small">none (format 2)</span>`],
    ["owner", ident(g.owner)],
    ...Object.entries(g.peers ?? {}).map(([r, id]): [string, string] => [`peer ${r}`, ident(id)]),
    ["state hash", tip ? link(w, tip.cid, tip.cid.toString()) : "(empty)"],
    ["log", `${w.log.length} entries · processed ${w.cursor} · <a href="/log">log</a>`],
    ["threads", `${w.threads.length} · ${[...states].map(([s, n]) => `<a href="/threads?state=${esc(s)}">${n} ${esc(s)}</a>`).join(" · ")}`],
    ["genesis", link(w, w.log[0].entry.genesis!, w.log[0].entry.genesis!.toString())],
    ["defaults", esc(Object.entries(g.defaults ?? {}).map(([k, v]) => `${k}=${v}`).join(" "))],
  ])}
<h2>heads</h2><table>${heads.join("")}</table>
<h2>subscriptions</h2><div class="small mut">${w.subscriptions ? `${w.subscriptions.length} change${w.subscriptions.length === 1 ? "" : "s"} · <a href="/s">chain</a>` : "no subscriptions chain: this log predates it"}</div><table><tr><th>#</th><th>sender</th><th>box</th><th>handler</th></tr>${subs}</table>
<h2>programs</h2><table>${Object.entries(g.programs).map(([n, c]) => `<tr><td>${esc(n)}</td><td>${link(w, c, c.toString())}</td></tr>`).join("")}</table>
<h2>boxes</h2><table><tr><th>box</th><th>routed</th><th>entries</th></tr>${[...boxes].map(([b, n]) => `<tr><td>${esc(b)}</td><td class="small mut">${rules.some((s) => s.match.box === b) ? "subscription" : (g.collect ?? []).includes(b) ? "collected (replies)" : "—"}</td><td>${n}</td></tr>`).join("")}</table>`);
}

function programOf(w: World, c: CID): string {
  return Object.entries(w.genesis?.programs ?? {}).find(([, p]) => p.equals(c))?.[0] ?? short(c);
}

// ---------------------------------------------------------------- /s

export function subscriptionsPage(w: World): string {
  const ups = w.subscriptions ?? [];
  const rows = ups.map(({ cid, u }) => {
    const t = u.thread ? w.byThread.get(u.thread.toString()) : undefined;
    return `<tr><td>${link(w, cid, String(u.seq))}</td><td class="small">${time(u.at)}</td><td>${esc(u.op)}</td><td>${u.sender ? key(w, u.sender) : `<span class="mut">anyone</span>`}</td><td>${esc(u.box)}</td><td>${link(w, u.handler, programOf(w, u.handler))}</td><td>${t ? threadLink(w, t) : u.thread ? link(w, u.thread) : `<span class="mut">genesis seed</span>`}</td><td>${entryLink(w, u.input)}</td></tr>`;
  }).reverse().join("");
  return layout("subscriptions", `<h1>subscriptions</h1><div class="small mut">${w.subscriptions ? `${ups.length} change${ups.length === 1 ? "" : "s"}, newest first` : "no subscriptions chain: this log predates it"}</div>
<table><tr><th>seq</th><th>at</th><th>op</th><th>sender</th><th>box</th><th>handler</th><th>by thread</th><th>input</th></tr>${rows}</table>`);
}

// ---------------------------------------------------------------- /log

export const PAGE = 50;

export function logPage(w: World, before?: number): string {
  const top = before ?? w.log.length;
  const rows = w.log.filter(({ entry }) => entry.n < top).slice(-PAGE).reverse();
  const body = rows.map(({ cid, entry: e }) => {
    const kind = e.outcome ? `outcome ${st(e.outcome.status)}` : kindOf(e);
    const env = e.envelope ? w.envelopes.get(e.envelope.toString()) : undefined;
    const threads = (w.touched.get(cid.toString()) ?? []).map((t) => `${link(w, t.thread.cid)} <span class="mut small">${esc(t.thread.program)} ${t.seq ? `step ${t.seq}` : "launched"}</span>`);
    return `<tr><td><a href="/e/${cid}" title="${cid}">#${e.n}</a></td><td class="small">${time(stampMs(e.time))}</td><td>${kind}${e.n >= w.cursor ? ` <span class="st new">pending</span>` : ""}</td>
<td>${esc(e.box ?? "")}</td><td>${key(w, senderOf(env))}</td><td>${e.envelope ? link(w, e.envelope) : e.genesis ? link(w, e.genesis) : e.wake ? link(w, e.wake) : e.outcome ? link(w, e.outcome.emit) : ""}</td><td>${e.body ? link(w, e.body) : ""}</td><td class="small">${threads.join("<br>")}</td></tr>`;
  }).join("");
  const oldest = rows.at(-1)?.entry.n ?? 0;
  const pager = `<nav class="pager small">${top < w.log.length ? `<a href="/log${top + PAGE >= w.log.length ? "" : `?before=${top + PAGE}`}">← newer</a>` : ""}${oldest > 0 ? `<a href="/log?before=${oldest}">older →</a>` : ""}</nav>`;
  return layout("log", `<h1>log</h1><div class="small mut">${w.log.length} entries, newest first · processed ${w.cursor}</div>
<table><tr><th>n</th><th>time</th><th>kind</th><th>box</th><th>sender</th><th>envelope / record</th><th>body</th><th>threads</th></tr>${body}</table>${pager}`);
}

// ---------------------------------------------------------------- /e/<cid>

export async function entryPage(w: World, cid: CID): Promise<string> {
  const x = w.entries.get(cid.toString());
  if (!x) throw new Error(`${cid} is not a log entry`);
  const e = x.entry;
  const parts: string[] = [];
  parts.push(kv([
    ["entry", link(w, cid, cid.toString())],
    ["prev", e.prev ? link(w, e.prev, e.prev.toString()) : "—"],
    ["time", `${time(stampMs(e.time))} <span class="mut small">[${e.time.join(", ")}]</span>`],
    ["processed", e.n < w.cursor ? "yes" : `<span class="st new">pending</span>`],
    ...(e.sig ? [["sig", `<code>${Buffer.from(e.sig).toString("hex").slice(0, 24)}…</code> <span class="mut small">by the host</span>`] as [string, string]] : [["sig", `<span class="mut small">none: format 2 (#33), entries are unsigned</span>`] as [string, string]]),
  ]));
  if (e.genesis) parts.push(`<h2>genesis</h2>${json(w, await maybe(w.store, e.genesis))}`);
  if (e.wake) parts.push(`<h2>wake</h2><p>the deadline of ${w.byThread.get(e.wake.toString()) ? threadLink(w, w.byThread.get(e.wake.toString())!) : link(w, e.wake)}</p>`);
  if (e.outcome) {
    const o = e.outcome;
    const rec = await maybe<Emit>(w.store, o.emit);
    const by = emitter(w, o.emit);
    parts.push(`<h2>outcome</h2>${kv([
      ["status", `${st(o.status)}${o.reason ? ` <span class="bad">${esc(o.reason)}</span>` : ""}`],
      ["emit", `${link(w, o.emit, o.emit.toString())}${rec ? ` → <b>${esc(rec.box)}</b> to ${key(w, rec.to)}` : ""}`],
      ["emitted by", by ? threadLink(w, by) : "—"],
    ])}<p class="small mut">${o.status === "failed" ? "the host's delivery gave up on it: a thread awaiting a reply to it is resumed with the failure" : "the host's delivery sent it: a record, nothing runs"}</p>`);
  }
  if (e.envelope) {
    const env = w.envelopes.get(e.envelope.toString());
    const body = await maybe(w.store, e.body);
    const hashOk = !!env?.contentHash && e.body && Buffer.from(e.body.multihash.digest).toString("hex") === env.contentHash;
    const who = (p: EnvelopeRecord["sender"]) => p ? `${key(w, p.identityKey)} <span class="mut small">${esc([p.handle, p.domain].filter(Boolean).join("@"))}</span>` : "";
    parts.push(`<h2>envelope · ${esc(e.box ?? "")}</h2>${kv([
      ["envelope", link(w, e.envelope, e.envelope.toString())],
      ["sender", who(env?.sender)],
      ["recipient", who(env?.recipient)],
      ["created", esc(env?.created ?? "")],
      ["contentHash", `<code>${esc(env?.contentHash ?? "")}</code> ${hashOk ? `<span class="ok">= body digest</span>` : `<span class="bad">≠ body digest</span>`}`],
      ["signature", env && safe(() => verify(env as never)) ? `<span class="ok">verifies</span>` : `<span class="bad">does not verify</span>`],
    ])}<h2>body ${e.body ? link(w, e.body) : ""}</h2>${json(w, body)}`);
    const r = routeOf(w, e.n, senderOf(env), e.box, body);
    parts.push(`<h2>routing</h2><p>${!r ? `no subscription matches (${key(w, senderOf(env))}, ${esc(e.box ?? "")}): recorded, nothing runs`
      : "reply" in r ? (r.reply ? `a reply to ${link(w, r.reply)}: goes only to the thread awaiting it` : "a <code>replyTo</code> that is not a CID: recorded, nothing runs")
      : `subscription #${r.i} (${r.sub.match.sender ? key(w, r.sub.match.sender) : "anyone"}, ${esc(r.sub.match.box ?? "any box")}) → ${link(w, r.sub.handler, programOf(w, r.sub.handler))}`}</p>`);
  }
  const touched = w.touched.get(cid.toString()) ?? [];
  parts.push(`<h2>threads</h2>${touched.length ? `<ul class="plain">${touched.map((t) => `<li>${t.seq ? `stepped (update ${t.seq})` : "launched"} ${threadLink(w, t.thread)}</li>`).join("")}</ul>` : `<p class="mut">none</p>`}`);
  return layout(`entry #${e.n}`, `<h1>log entry #${e.n} <span class="mut small">${kindOf(e)}</span></h1>${parts.join("\n")}`);
}

function safe(f: () => boolean): boolean {
  try { return f(); } catch { return false; }
}

// ---------------------------------------------------------------- /threads

export function threadsPage(w: World, f: { program?: string; state?: string }): string {
  const ts = w.threads.filter((t) => (!f.program || t.program === f.program) && (!f.state || t.state === f.state));
  const programs = [...new Set(w.threads.map((t) => t.program))];
  const states = [...new Set(w.threads.map((t) => t.state))];
  const q = (p?: string, s?: string) => { const u = new URLSearchParams(); if (p) u.set("program", p); if (s) u.set("state", s); const x = u.toString(); return `/threads${x ? `?${x}` : ""}`; };
  const filter = `<div class="small">program: <a href="${q(undefined, f.state)}">all</a> ${programs.map((p) => p === f.program ? `<b>${esc(p)}</b>` : `<a href="${q(p, f.state)}">${esc(p)}</a>`).join(" ")}
 · state: <a href="${q(f.program)}">all</a> ${states.map((s) => s === f.state ? `<b>${esc(s)}</b>` : `<a href="${q(f.program, s)}">${esc(s)}</a>`).join(" ")}</div>`;
  const rows = ts.map((t) => {
    const parent = t.o.launchedBy && w.byThread.get(t.o.launchedBy.toString());
    const by = parent ? `${link(w, parent.cid)} <span class="mut small">${esc(parent.program)}</span>` : entryLink(w, t.o.input);
    const what = t.program === "shell" ? `<code>${esc(String((t.o.args as { cmd?: unknown })?.cmd ?? "").slice(0, 60))}</code>` : "";
    return `<tr><td>${link(w, t.cid)}</td><td>${esc(t.program)} ${what}</td><td>${by}</td><td>${st(t.state)}</td><td>${t.updates.length}</td><td class="small">${time(t.tipAt)}</td></tr>`;
  }).join("");
  return layout("threads", `<h1>threads</h1>${filter}
<table><tr><th>origin</th><th>program</th><th>launched by</th><th>state</th><th>updates</th><th>last update</th></tr>${rows || `<tr><td class="mut">none</td></tr>`}</table>`);
}

// ---------------------------------------------------------------- /t/<cid>

export async function threadPage(w: World, t: Thread): Promise<string> {
  const live = LIVE.has(t.state);
  const script = live ? POLL.replace("__CID__", t.cid.toString()).replace("__TIP__", tipOf(t)) : "";
  return layout(`${t.program} ${short(t.cid)}`, await threadBody(w, t), script);
}

export const tipOf = (t: Thread) => (t.updates.at(-1)?.cid ?? t.cid).toString();

export async function threadBody(w: World, t: Thread): Promise<string> {
  const up = await ancestry(w, t);
  const chain = up.map((a) => "thread" in a ? `${link(w, a.thread.cid)} <span class="mut">${esc(a.thread.program)}</span>` : `${entryLink(w, a.entry)} <span class="mut small">envelope</span> ${link(w, a.envelope)}`).join(" ← ");
  const head = `<h1>${esc(t.program)} ${st(t.state)}</h1>
${kv([
    ["origin", link(w, t.cid, t.cid.toString())],
    ["program", link(w, t.o.program, `${t.program} · ${short(t.o.program)}`)],
    ["launched by", chain || "—"],
    ["input", entryLink(w, t.o.input)],
    ["at", time(t.o.at)],
    ...(t.o.nonce ? [["nonce", esc(t.o.nonce)] as [string, string]] : []),
  ])}
${details("args", json(w, t.o.args), "args")}
<ol class="chain small">${t.updates.map(({ cid, u }) => `<li><a href="#u-${cid}" title="${esc(`${iso(u.at)} ${cid}`)}">${u.seq} ${st(u.state)}</a></li>`).join("")}</ol>`;
  const steps: string[] = [];
  for (const { cid, u } of t.updates) steps.push(await updateCard(w, t, cid, u));
  return `${head}${steps.join("") || `<p class="mut">no steps yet</p>`}`;
}

async function updateCard(w: World, t: Thread, cid: CID, u: Update): Promise<string> {
  const parts: string[] = [];
  if (u.error) parts.push(`<pre class="err">${esc(`${u.error.kind}: ${u.error.message}`)}</pre>`);
  for (const k of u.kept ?? []) parts.push(await kept(w, k));
  if (u.launched?.length) {
    parts.push(`<div class="small mut">launched</div><ul class="plain">${u.launched.map((c) => {
      const child = w.byThread.get(c.toString());
      const cmd = (child?.o.args as { cmd?: unknown } | undefined)?.cmd;
      return `<li>${child ? threadLink(w, child) : link(w, c)}${typeof cmd === "string" ? ` <code>${esc(cmd)}</code>` : ""}</li>`;
    }).join("")}</ul>`);
  }
  const calls = await Promise.all((u.calls ?? []).map((c) => maybe<Attested>(w.store, c).then((a) => ({ c, a }))));
  for (const e of u.emits ?? []) parts.push(await emitted(w, e));
  if (u.awaits?.length) parts.push(`<div class="small">awaits a reply to ${u.awaits.map((a) => link(w, a)).join(", ")}</div>`);
  if (u.waitingOn?.length) parts.push(`<div class="small">waiting on ${u.waitingOn.map((c) => link(w, c)).join(", ")}</div>`);
  if (u.until) parts.push(`<div class="small">until ${time(u.until)}</div>`);
  for (const h of u.heads ?? []) {
    const hu = await maybe<HeadUpdate>(w.store, h);
    const name = (await maybe<{ name?: string }>(w.store, hu?.origin))?.name ?? "?";
    parts.push(`<div class="small">moved head <a href="/h/${encodeURIComponent(name)}">${esc(name)}</a> → ${hu ? link(w, hu.tree) : ""} ${link(w, h, "(move)")}</div>`);
  }
  for (const s of u.subscriptions ?? []) {
    const su = await maybe<SubscriptionUpdate>(w.store, s);
    if (su) parts.push(`<div class="small"><a href="/s">subscription</a> ${esc(su.op)} (${su.sender ? key(w, su.sender) : "anyone"}, ${esc(su.box)}) → ${link(w, su.handler, programOf(w, su.handler))} ${link(w, s, "(change)")}</div>`);
  }
  if (calls.length) {
    parts.push(details(`${calls.length} attested call${calls.length === 1 ? "" : "s"}`, `<ul class="plain small">${calls.map(({ c, a }) => `<li>${link(w, c)} ${a ? `${a.i} ${esc(a.op)} ${a.op === "wallet" && a.request instanceof Uint8Array ? esc(WALLET_CALLS.get(a.request[0]) ?? `call ${a.request[0]}`) : isCID(a.request) ? `emit ${link(w, a.request)}` : ""}` : ""}</li>`).join("")}</ul>`, `calls-${cid}`));
  }
  const res = u.result as { exitCode?: number; stdout?: unknown; stderr?: unknown; tree?: CID } | undefined;
  if (res) {
    const out = text(res.stdout), err = text(res.stderr);
    if (t.program === "shell" || res.exitCode || out || err || res.tree) {
      parts.push(`<div class="small mut">exit ${esc(res.exitCode ?? "?")}${res.tree ? ` · tree ${link(w, res.tree)}` : ""}</div>${out ? `<pre>${esc(out)}</pre>` : ""}${err ? `<pre class="err">${esc(err)}</pre>` : ""}`);
    }
  }
  return `<section class="card" id="u-${cid}"><div class="hd"><span>${u.step !== undefined ? `step ${u.step}` : `update ${u.seq}`} ${st(u.state)} · ${time(u.at)} · input ${entryLink(w, u.input)}</span>${link(w, cid)}</div>${parts.join("\n")}</section>`;
}

/** A kept record: loop turns as the conversation, anything else as JSON. */
async function kept(w: World, c: CID): Promise<string> {
  const r = await maybe<Record<string, unknown>>(w.store, c);
  if (!r || r.kind !== "turn") return details(`kept ${short(c)}`, json(w, r), `k-${c}`);
  const of = isCID(r.of) ? ` <span class="mut">of</span> ${link(w, r.of)}` : "";
  const hd = (who: string, extra = "") => `<div class="who">${esc(who)}${extra}${of} · ${link(w, c)}</div>`;
  switch (r.role) {
    case "user":
      return `<div class="turn">${hd("user", r.model ? ` · ${esc(r.model)}` : "")}<div class="asked">${esc(text(r.text))}</div>${isCID(r.tree) ? `<div class="small mut">tree ${link(w, r.tree)}</div>` : ""}</div>`;
    case "assistant": {
      const u = r.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      const meta = [r.model, r.ms !== undefined ? `${r.ms} ms` : "", u ? `${u.prompt_tokens ?? "?"}→${u.completion_tokens ?? "?"} tokens` : ""].filter(Boolean).join(" · ");
      const calls = Array.isArray(r.tool_calls) ? r.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }> : [];
      return `<div class="turn">${hd("assistant", meta ? ` · ${esc(meta)}` : "")}
${r.reasoning ? details(`reasoning · ${text(r.reasoning).length} chars`, `<pre>${esc(text(r.reasoning))}</pre>`, `r-${c}`) : ""}
${r.content ? `<div class="text">${markdownToHtml(text(r.content))}</div>` : ""}
${calls.map((tc) => `<div class="small">tool call <code>${esc(tc.function?.name ?? "?")}</code> <span class="mut">${esc(tc.id ?? "")}</span></div><pre>${esc(argsOf(tc.function?.arguments))}</pre>`).join("")}</div>`;
    }
    case "tool": {
      if (r.exitCode === undefined) { // a message: its answer, or why it could not be sent or delivered
        return `<div class="turn">${hd("tool", ` · ${esc(r.call ?? "")} · message ${esc(r.to ?? "")}`)}${r.error ? `<pre class="err">${esc(text(r.error))}</pre>` : `<div class="asked">${esc(text(r.text))}</div>`}</div>`;
      }
      const out = text(r.stdout), err = text(r.stderr);
      return `<div class="turn">${hd("tool", ` · ${esc(r.call ?? "")} · exit ${esc(r.exitCode ?? "?")}`)}${isCID(r.tree) ? `<div class="small mut">tree ${link(w, r.tree)}</div>` : ""}${out ? `<pre>${esc(out)}</pre>` : ""}${err ? `<pre class="err">${esc(err)}</pre>` : ""}${!out && !err ? `<div class="small mut">(no output)</div>` : ""}</div>`;
    }
    case "error":
      return `<div class="turn">${hd("error")}<pre class="err">${esc(text(r.error) || JSON.stringify(r.error))}</pre></div>`;
    default:
      return `<div class="turn">${hd(String(r.role))}${json(w, r)}</div>`;
  }
}

/** A tool call's JSON arguments, the bash `cmd` alone when that is all there is. */
function argsOf(a: string | undefined): string {
  try {
    const j = JSON.parse(a ?? "");
    return j && typeof j === "object" && Object.keys(j).length === 1 && typeof j.cmd === "string" ? j.cmd : JSON.stringify(j, null, 2);
  } catch { return a ?? ""; }
}

async function emitted(w: World, c: CID): Promise<string> {
  const e = await maybe<Emit>(w.store, c);
  if (!e) return `<div class="small">emitted ${link(w, c)}</div>`;
  const body = await maybe<Record<string, unknown>>(w.store, e.body);
  const r = (e.envelope as { recipient?: { handle?: unknown; domain?: unknown } } | undefined)?.recipient;
  const env = e.envelope && typeof e.envelope === "object" ? encode(signedPart(e.envelope as never)).cid : undefined;
  const summary = typeof body?.text === "string" ? `<div class="say">${esc(body.text)}</div>`
    : Array.isArray(body?.messages) ? `<div class="small mut">${esc(String(body.model ?? ""))} · ${body.messages.length} messages${Array.isArray(body.tools) ? ` · ${body.tools.length} tools` : ""}</div>` : "";
  return `<div class="small">emitted → <b>${esc(e.box)}</b> to ${key(w, e.to)}${r?.handle ? ` <span class="mut">${esc(String(r.handle))}@${esc(String(r.domain ?? ""))}</span>` : ""} · emit ${link(w, c)} · body ${link(w, e.body)}${env ? ` · envelope ${link(w, env)}` : ""} · ${outcomeOf(w, c)}</div>${summary}${details("body", json(w, body), `b-${c}`)}`;
}

// Polls the thread's tip; when it moves, re-renders the fragment, keeping open <details> open.
const POLL = `(() => {
  const cid = "__CID__"; let tip = "__TIP__";
  async function poll() {
    let live = true;
    try {
      const j = await (await fetch("/t/" + cid + "?tip=1")).json();
      live = j.live;
      if (j.tip !== tip) {
        const open = new Set([...document.querySelectorAll("details[open][data-k]")].map((d) => d.dataset.k));
        const atEnd = innerHeight + scrollY >= document.body.scrollHeight - 40;
        document.getElementById("main").innerHTML = await (await fetch("/t/" + cid + "?frag=1")).text();
        for (const d of document.querySelectorAll("details[data-k]")) if (open.has(d.dataset.k)) d.open = true;
        if (atEnd) scrollTo(0, document.body.scrollHeight);
        tip = j.tip;
      }
    } catch {}
    if (live) setTimeout(poll, 1500);
  }
  setTimeout(poll, 1500);
})();`;

// ---------------------------------------------------------------- /r/<cid>

export async function recordPage(w: World, cid: CID, path = ""): Promise<string> {
  const bytes = await w.store.bytes(cid);
  const title = `<h1 class="cid">${esc(cid.toString())}</h1>`;
  if (cid.code === GIT_RAW) return layout(short(cid), `${title}${await gitView(w, cid, bytes, path)}`);
  if (cid.code !== DAG_CBOR) {
    const wasm = bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).equals(Buffer.from([0, 0x61, 0x73, 0x6d]));
    return layout(short(cid), `${title}${kv([
      ["codec", cid.code === RAW ? "raw" : `0x${cid.code.toString(16)}`],
      ["size", `${bytes.length} bytes`],
      ["looks like", wasm ? "a wasm module" : "—"],
    ])}<pre>${hex(bytes)}</pre>`);
  }
  const v = decode<Record<string, unknown>>(bytes);
  const notes: string[] = [];
  let origin: CID | undefined;
  try { origin = await w.store.chains.originOf(cid); } catch { /* a plain record */ }
  if (w.byThread.has(cid.toString())) notes.push(`a thread origin · <a href="/t/${cid}">thread view</a>`);
  if (w.entries.has(cid.toString())) notes.push(`a log entry · <a href="/e/${cid}">entry view</a>`);
  if (v?.kind === "head" && typeof v.name === "string") notes.push(`a head origin · <a href="/h/${encodeURIComponent(v.name)}">moves</a>`);
  if (v?.kind === "subscriptions") notes.push(`the subscriptions origin · <a href="/s">changes</a>`);
  if (origin && !origin.equals(cid)) notes.push(`update #${esc(v.seq)} of ${link(w, origin)}`);
  const admitted = await w.store.log.byEnvelope(cid);
  if (admitted) notes.push(`an admitted envelope · ${entryLink(w, admitted)}`);
  if (v?.kind === "emit") notes.push(`outcome ${outcomeOf(w, cid)}`);
  let chain = "";
  if (origin?.equals(cid)) {
    const ups: CID[] = [];
    for await (const c of w.store.chains.history(cid)) if (!c.equals(cid)) ups.push(c);
    chain = ups.length ? details(`${ups.length} update${ups.length === 1 ? "" : "s"}`, `<ol class="small">${ups.map((c) => `<li>${link(w, c, c.toString())}</li>`).join("")}</ol>`) : "";
  }
  const refs = async () => {
    const from = await w.store.edges.refsFrom(origin ?? cid).catch(() => [] as Ref[]);
    const to = await w.store.edges.refsTo(cid).catch(() => [] as Array<Ref & { from: CID }>);
    const li = (r: Ref, x: unknown) => `<li>${esc(r.rel)} ${isCID(x) ? link(w, x) : `<code>${esc(String(x))}</code>`}${r.locator ? ` <code>${esc(r.locator)}</code>` : ""}</li>`;
    return from.length || to.length ? `<h2>refs</h2><ul class="plain small">${from.map((r) => li(r, r.to)).join("")}${to.map((r) => li({ ...r, rel: `← ${r.rel}` }, r.from)).join("")}</ul>` : "";
  };
  return layout(short(cid), `${title}<div class="small">dag-cbor · ${bytes.length} bytes${v && typeof v === "object" && typeof v.kind === "string" ? ` · kind <b>${esc(v.kind)}</b>` : ""}${notes.map((n) => ` · ${n}`).join("")}</div>${chain}${json(w, v)}${await refs()}`);
}

function hex(b: Uint8Array, n = 256): string {
  const h = Buffer.from(b.subarray(0, n)).toString("hex").replace(/(.{32})/g, "$1\n").replace(/(\S{2})(?=\S)/g, "$1 ");
  return esc(h.trimEnd()) + (b.length > n ? "\n…" : "");
}

/** A git object: a tree browsable by `path` from this root, or a blob. */
async function gitView(w: World, root: CID, bytes: Uint8Array, path: string): Promise<string> {
  const nul = bytes.indexOf(0);
  const type = Buffer.from(bytes.subarray(0, Math.max(nul, 0))).toString("latin1").split(" ")[0];
  if (type === "blob") return `<div class="small">git blob</div>${blob(await readBlob(w.store, root))}`;
  if (type !== "tree") return `<div class="small">git-raw, not a blob or tree</div><pre>${hex(bytes)}</pre>`;
  parseTree(bytes, root); // throws on a malformed tree
  const segs = path.split("/").filter(Boolean);
  const crumbs = [`<a href="/r/${root}">/</a>`, ...segs.map((s, i) => `<a href="/r/${root}?p=${encodeURIComponent(segs.slice(0, i + 1).join("/"))}">${esc(s)}</a>`)].join(" / ");
  const at = await lookup(w.store, root, path);
  if (!at) return `<div class="small">git tree · ${crumbs}</div><p class="bad">no such path</p>`;
  if (at.mode !== "40000") return `<div class="small">git tree · ${crumbs} · ${link(w, at.cid)} · mode ${at.mode}</div>${at.mode === "160000" ? `<p class="mut">submodule</p>` : blob(await readBlob(w.store, at.cid))}`;
  const rows = (await readTree(w.store, at.cid)).map((e) => {
    const p = [...segs, e.name].join("/");
    return `<tr><td class="small mut">${e.mode}</td><td><a href="/r/${root}?p=${encodeURIComponent(p)}">${esc(e.name)}${e.mode === "40000" ? "/" : ""}</a></td><td>${link(w, e.cid)}</td></tr>`;
  }).join("");
  return `<div class="small">git tree · ${crumbs}${segs.length ? ` · ${link(w, at.cid)}` : ""}</div><table>${rows}</table>`;
}

function blob(b: Uint8Array): string {
  const t = Buffer.from(b).toString("utf8");
  const isText = !t.includes("�") && !t.includes("\0");
  return `<div class="small mut">${b.length} bytes${isText ? "" : " · binary"}</div><pre>${isText ? esc(t.length > 256 * 1024 ? `${t.slice(0, 256 * 1024)}\n…` : t) : hex(b)}</pre>`;
}

// ---------------------------------------------------------------- /h/<name>

export async function headPage(w: World, name: string): Promise<string> {
  const moves = await headMoves(w.store, name);
  const rows = moves.map(({ cid, u }) => {
    const t = w.byThread.get(u.thread.toString());
    return `<tr><td>${link(w, cid, String(u.seq))}</td><td class="small">${time(u.at)}</td><td>${link(w, u.tree, u.tree.toString())}</td><td>${t ? threadLink(w, t) : link(w, u.thread)}</td><td>${entryLink(w, u.input)}</td></tr>`;
  }).reverse().join("");
  return layout(`head ${name}`, `<h1>head ${esc(name)}</h1><div class="small mut">${moves.length} move${moves.length === 1 ? "" : "s"}, newest first</div>
<table><tr><th>seq</th><th>at</th><th>tree</th><th>by thread</th><th>input</th></tr>${rows || `<tr><td class="mut">never moved</td></tr>`}</table>`);
}
