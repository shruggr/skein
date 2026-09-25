// HTML for the browser. Server-rendered; the only script polls a live thread
// and swaps its rendered fragment in.

import { isCID } from "../cid.ts";
import type { EmitView, HistoryRow, LaunchView, NodeViewRow, ThreadRow, ThreadView } from "../view.ts";
import type { Ref } from "../types.ts";
import { esc, markdown } from "./markdown.ts";

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1c1a;--mut:#6b6760;--line:#e3e0d8;--card:#fff;--acc:#2f5fd0;--say:#f3efe2;--ok:#1f7a3d;--bad:#b3261e;--wait:#9a6a00;--code:#f2f0ea}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#e8e6e1;--mut:#9a968e;--line:#2c2b28;--card:#1c1b19;--acc:#8fb0ff;--say:#2a2720;--ok:#6fcf8f;--bad:#ff8a80;--wait:#e0b44c;--code:#23221f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
main,header.top{max-width:860px;margin:0 auto;padding:0 16px}
header.top{display:flex;gap:16px;align-items:baseline;padding-top:14px;padding-bottom:6px}
header.top a.home{font-weight:700;color:var(--fg);text-decoration:none;font-size:18px}
a{color:var(--acc)}
h1{font-size:19px;margin:10px 0 6px;overflow-wrap:anywhere}
.mut{color:var(--mut)}.small{font-size:13px}
code,pre,.cid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:var(--code);padding:8px 10px;border-radius:6px;overflow:auto;max-height:28em;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
table{border-collapse:collapse;width:100%;margin:6px 0}
td,th{border-bottom:1px solid var(--line);padding:6px 6px;text-align:left;vertical-align:top}
.list td.label{overflow-wrap:anywhere}
.st{display:inline-block;padding:0 7px;border-radius:9px;font-size:12px;border:1px solid currentColor;white-space:nowrap}
.st.finished{color:var(--ok)}.st.errored,.st.dropped,.st.out-of-context{color:var(--bad)}.st.waiting,.st.new{color:var(--wait)}.st.running{color:var(--acc)}.st.david{color:var(--bad);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:12px 0}
.card>.hd{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--mut)}
.asked{background:var(--say);border-radius:8px;padding:6px 10px;margin:6px 0;white-space:pre-wrap}
.say{font-size:19px;line-height:1.4;border-left:4px solid var(--acc);padding:4px 12px;margin:10px 0}
.page{border:1px solid var(--line);border-radius:8px;padding:2px 14px;margin:8px 0}
.launch{margin:4px 0;font-size:14px;overflow-wrap:anywhere}
.chain{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0;padding:0;list-style:none}
.chain li a{text-decoration:none}
form.box{display:flex;flex-direction:column;gap:8px;margin:12px 0}
form.box .row{display:flex;gap:8px;flex-wrap:wrap}
textarea,input,select,button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px}
textarea{width:100%;min-height:5em}
button{background:var(--acc);color:var(--bg);border:0;padding:8px 16px;cursor:pointer}
details>summary{cursor:pointer;color:var(--mut);font-size:13px}
.json{max-height:none}.json a{color:var(--acc)}
.refs li{overflow-wrap:anywhere}
@media (max-width:600px){.hide-sm{display:none}}
`;

export function layout(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header class="top"><a class="home" href="/">skein</a><a class="small" href="/?all=1">all threads</a></header>
<main id="main">${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

export const shortCid = (c: string) => c.slice(4, 16);
const cidLink = (c: string, base = "/b/") => `<a class="cid" href="${base}${esc(c)}" title="${esc(c)}">${esc(shortCid(c))}</a>`;
const state = (s: string, david?: boolean) => david ? `<span class="st david">your turn</span>` : `<span class="st ${esc(s)}">${esc(s)}</span>`;

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const time = (ms: number) => `<time datetime="${new Date(ms).toISOString()}" title="${new Date(ms).toISOString()}">${ago(ms)} ago</time>`;

// ---------------------------------------------------------------- /

export interface HomeData { rows: ThreadRow[]; all: boolean; models: string[]; defaultModel?: string; defaultThinking?: string }

export function home(d: HomeData): string {
  const opts = (xs: string[], sel?: string) => xs.map((x) => `<option${x === sel ? " selected" : ""}>${esc(x)}</option>`).join("");
  const models = d.defaultModel && !d.models.includes(d.defaultModel) ? [d.defaultModel, ...d.models] : d.models;
  const form = `<form class="box" method="post" action="/api/new">
<textarea name="prompt" placeholder="What should we do?" required></textarea>
<div class="row"><select name="model" aria-label="model">${models.length ? opts(models, d.defaultModel) : `<option value="">config default</option>`}</select>
<select name="thinking" aria-label="thinking">${opts(["off", "low", "medium", "high"], d.defaultThinking ?? "off")}</select>
<button>Start</button></div></form>`;
  const rows = d.rows.map((r) => `<tr><td>${state(r.state, !!r.davidWaiting)}</td>
<td class="label"><a href="/t/${esc(r.cid)}">${esc(r.label || "(no label)")}</a><div class="mut small">${esc(r.runner)} · ${esc(shortCid(r.cid))}</div></td>
<td class="mut small">${ago(r.tipAt)}</td></tr>`).join("");
  const toggle = d.all ? `<a href="/">parent-less only</a>` : `<a href="/?all=1">include launched threads</a>`;
  return layout("skein", `${form}
<div class="small mut">${d.all ? "All threads" : "Threads you started"} · most recent activity first · ${toggle}</div>
<table class="list">${rows || `<tr><td class="mut">nothing yet</td></tr>`}</table>`);
}

// ---------------------------------------------------------------- /t/<cid>

export function threadPage(v: ThreadView): string {
  return layout(v.label || v.cid, threadBody(v), POLL.replace("__CID__", v.cid).replace("__V__", String(v.version)).replace("__LIVE__", String(!v.settled && !v.davidWaiting)));
}

export function threadBody(v: ThreadView): string {
  const parent = v.parent ? ` · launched from ${cidLink(v.parent, "/t/")}` : "";
  const head = `<h1>${esc(v.label || "(no label)")}</h1>
<div class="small mut">${esc(v.runner)} ${state(v.state, !!v.davidWaiting)} · ${cidLink(v.cid)} · started ${time(v.at)}${parent}</div>
<ol class="chain small">${v.history.map(chip).join("")}</ol>`;
  const steps = v.nodes.map((n, i) => node(v, n, i)).join("");
  const replyForm = v.davidWaiting ? `<form class="box" method="post" action="/api/reply">
<input type="hidden" name="thread" value="${esc(v.cid)}"><input type="hidden" name="back" value="/t/${esc(v.cid)}">
<textarea name="text" placeholder="Reply…" required autofocus></textarea><div class="row"><button>Reply</button></div></form>` : "";
  return `${head}${steps || `<p class="mut">not started yet</p>`}${replyForm}`;
}

function chip(h: HistoryRow): string {
  const detail = [h.waitingOn?.length ? `on ${h.waitingOn.map(shortCid).join(", ")}` : "", h.note ?? "", h.error ?? ""].filter(Boolean).join(" · ");
  return `<li><a href="/b/${esc(h.cid)}" title="${esc(`${new Date(h.at).toISOString()} ${detail}`)}">${esc(h.seq)} ${state(h.state)}</a></li>`;
}

function node(v: ThreadView, n: NodeViewRow, i: number): string {
  const body = n.emits.map((e) => emission(v, e)).join("");
  const rest = n.rest ? ` · rest ${esc(n.rest.state)}${n.rest.waitingOn?.length ? ` on ${n.rest.waitingOn.map((c) => cidLink(c, "/t/")).join(", ")}` : ""}` : "";
  return `<section class="card" id="n-${esc(n.cid)}"><div class="hd"><span>${v.runner === "loop" ? "step" : "node"} ${i + 1} · ${time(n.at)}${rest}</span>${cidLink(n.cid)}</div>
${n.asked ? `<div class="asked">${esc(n.asked)}</div>` : ""}${body}</section>`;
}

const s = (x: unknown) => (typeof x === "string" ? x : x === undefined || x === null ? "" : JSON.stringify(x));

function emission(v: ThreadView, e: EmitView): string {
  switch (e.type) {
    case "thinking":
      return details(`thinking · ${s(e.text).length} chars`, `<pre>${esc(e.text)}</pre>`, `th-${s(e.text).length}`);
    case "text":
      return v.runner === "shell" || v.runner === "bash" ? `<pre>${esc(e.text)}</pre>` : `<div class="text">${markdown(s(e.text))}</div>`;
    case "say":
      return `<div class="say">${esc(e.text)}</div>`;
    case "page":
      return `<div class="page">${markdown(s(e.markdown))}</div>`;
    case "tool_result":
      return `<div class="small mut">result ${e.ok ? "ok" : "failed"}${e.call ? ` · ${esc(e.call)}` : ""} · ${cidLink(s(e.thread), "/t/")}</div><pre>${esc(e.content)}</pre>`;
    case "conclusion":
      return v.runner === "model" ? details("assistant message", `<pre>${esc(e.text)}</pre>`) : `<div class="asked"><b>${v.runner === "david" ? "David" : "conclusion"}:</b> ${esc(e.text)}</div>`;
    case "launched":
      return e.run ? launch(e.run) : `<div class="launch">launched ${cidLink(s(e.thread), "/t/")}</div>`;
    case "sent":
      return `<div class="small mut">→ ${esc(e.kind ?? "message")} ${cidLink(s(e.message))}</div>`;
    case "received":
      return `<div class="small mut">← ${cidLink(s(e.message))}${e.note ? ` · ${esc(e.note)}` : ""}</div>`;
    default:
      return `<pre>${esc(JSON.stringify(e, null, 2))}</pre>`;
  }
}

function launch(r: LaunchView): string {
  const link = `<a href="/t/${esc(r.cid)}">`;
  const meta = [r.note, r.error].filter(Boolean).map((x) => esc(x)).join(" · ");
  if (r.runner === "model") {
    const th = r.thinking ? details(`thinking · ${r.thinking.length} chars`, `<pre>${esc(r.thinking)}</pre>`, `th-${r.cid}`) : "";
    return `<div class="launch small mut">${link}model</a> ${state(r.state)} ${meta}</div>${th}`;
  }
  if (r.runner === "david") {
    return `<div class="launch small">${link}→ David</a> ${state(r.state)}${r.reply !== undefined ? ` <span class="mut">replied</span>` : ""}</div>`;
  }
  return `<div class="launch">${link}<code>${esc(r.label)}</code></a> ${state(r.state)} <span class="small mut">${meta}</span></div>`;
}

function details(summary: string, inner: string, key?: string): string {
  return `<details${key ? ` data-k="${esc(key)}"` : ""}><summary>${esc(summary)}</summary>${inner}</details>`;
}

// Polls the version; on change re-renders the fragment, keeping open <details> open.
const POLL = `(() => {
  const cid = "__CID__"; let v = __V__, live = __LIVE__;
  async function poll() {
    try {
      const j = await (await fetch("/api/thread/" + cid + "?since=" + v)).json();
      if (j.changed) {
        const open = new Set([...document.querySelectorAll("details[open][data-k]")].map((d) => d.dataset.k));
        const atEnd = innerHeight + scrollY >= document.body.scrollHeight - 40;
        document.getElementById("main").innerHTML = await (await fetch("/t/" + cid + "?frag=1")).text();
        for (const d of document.querySelectorAll("details[data-k]")) if (open.has(d.dataset.k)) d.open = true;
        if (atEnd) scrollTo(0, document.body.scrollHeight);
        v = j.version;
      }
      live = !j.settled && !j.davidWaiting;
    } catch {}
    if (live) setTimeout(poll, 1500);
  }
  if (live) setTimeout(poll, 1500);
})();`;

// ---------------------------------------------------------------- /b/<cid>

export interface BlockData {
  cid: string;
  block: unknown;           // decoded, CIDs still CID instances
  origin?: string;          // set when the block is an update
  seq?: number;
  chain?: string[];         // when the block is an origin: its updates in order
  isThread: boolean;
  refsFrom: Ref[];
  refsTo: Array<Ref & { from: unknown }>;
}

export function blockPage(d: BlockData): string {
  const where = d.origin
    ? `<div class="small">update #${esc(d.seq)} of ${cidLink(d.origin)}</div>`
    : d.chain ? `<div class="small">origin with ${d.chain.length} update${d.chain.length === 1 ? "" : "s"}${d.isThread ? ` · <a href="/t/${esc(d.cid)}">thread view</a>` : ""}</div>` : "";
  const refs = (title: string, xs: Array<Ref & { from?: unknown }>, pick: (r: Ref & { from?: unknown }) => unknown) =>
    `<h2 class="small">${title} (${xs.length})</h2><ul class="refs small">${xs.map((r) =>
      `<li>${esc(r.rel)} ${target(pick(r))}${r.locator ? ` <code>${esc(r.locator)}</code>` : ""}</li>`).join("") || `<li class="mut">none</li>`}</ul>`;
  const chain = d.chain?.length ? `<details><summary>updates</summary><ol class="small">${d.chain.map((c) => `<li>${cidLink(c)}</li>`).join("")}</ol></details>` : "";
  return layout(shortCid(d.cid), `<h1 class="cid">${esc(d.cid)}</h1>${where}${chain}
<pre class="json">${jsonHtml(d.block, 0)}</pre>
${refs(d.origin ? "refs from its chain" : "refs from", d.refsFrom, (r) => r.to)}${refs("refs to", d.refsTo, (r) => r.from)}`);
}

function target(t: unknown): string {
  if (isCID(t)) return cidLink(String(t));
  const x = String(t);
  return /^https?:/.test(x) ? `<a href="${esc(x)}">${esc(x)}</a>` : `<code>${esc(x)}</code>`;
}

/** JSON-shaped HTML with every CID a link. */
export function jsonHtml(v: unknown, depth: number): string {
  const pad = "  ".repeat(depth + 1), end = "  ".repeat(depth);
  if (isCID(v)) return `<a href="/b/${v}">${v}</a>`;
  if (v instanceof Uint8Array) return `<span class="mut">&lt;${v.length} bytes&gt;</span>`;
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => pad + jsonHtml(x, depth + 1)).join(",\n")}\n${end}]` : "[]";
  if (v && typeof v === "object") {
    const es = Object.entries(v);
    return es.length ? `{\n${es.map(([k, x]) => `${pad}${esc(JSON.stringify(k))}: ${jsonHtml(x, depth + 1)}`).join(",\n")}\n${end}}` : "{}";
  }
  return esc(JSON.stringify(v));
}

export function errorPage(status: number, message: string): string {
  return layout(`${status}`, `<h1>${status}</h1><pre>${esc(message)}</pre>`);
}
