// The page: connect David's wallet (the Yours extension, via @1sat/connect),
// register on the host, import a directory, chat, run, and read the inbox.
// Plain DOM; everything skein-specific is in core.ts.

import { connectWallet, loadLastProvider, type ConnectWalletResult } from "@1sat/connect";
import { WalletClient } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { short } from "../src/client/conversation.ts";
import { BOX, WebSkein, type Result, type Store, type WebConfig } from "./core.ts";
import { escapeHtml, markdownToHtml } from "./markdown.ts";
import { ignored, relativeToPicked, type PickedFile } from "./tree.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store: Store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

let cfg: WebConfig;
let skein: WebSkein | undefined;
let polling: ReturnType<typeof setTimeout> | undefined;

/** Errors as they came: wallet denials are often plain objects, not Errors. */
function errText(e: unknown): string {
  if (e instanceof Error) {
    const extra = Object.entries(e).filter(([k]) => k !== "message" && k !== "stack");
    return e.message + (extra.length ? ` ${JSON.stringify(Object.fromEntries(extra))}` : "");
  }
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function log(el: HTMLElement, text: string, kind: "ok" | "err" | "info" = "info"): void {
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function guard(el: HTMLElement, what: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { console.error(what, e); log(el, `${what}: ${errText(e)}`, "err"); }
}

function requireSkein(): WebSkein {
  if (!skein) throw new Error("connect the wallet first");
  return skein;
}

// ---------------------------------------------------------------- connect

async function connect(): Promise<void> {
  const out = $("connect-status");
  log(out, "connecting… (approve in the wallet if it asks)");
  let reason: unknown;
  // @1sat/connect's BRC-100 auto-detect (WalletClient('auto'): window.CWI from
  // the extension first), as a provider so its failure reason is kept: the
  // stock race swallows it and returns null.
  const result: ConnectWalletResult | null = await connectWallet({
    autoDetect: false,
    providers: [{
      type: "brc100",
      name: "BRC-100 wallet",
      connect: async () => {
        try {
          const client = new WalletClient("auto");
          await client.connectToSubstrate();
          await client.waitForAuthentication({});
          const { publicKey } = await client.getPublicKey({ identityKey: true });
          return { wallet: client, provider: "brc100", identityKey: publicKey, disconnect: () => {} };
        } catch (e) { reason = e; throw e; }
      },
    }],
  });
  if (!result) { log(out, `no wallet: ${reason === undefined ? "nothing answered" : errText(reason)}`, "err"); return; }
  skein = new WebSkein(cfg, result.wallet, store);
  $("identity").textContent = result.identityKey;
  const want = cfg.expectedOwner;
  if (want && result.identityKey !== want) {
    log(out, `connected, but this is not the expected identity ${want} — the instance will not answer it`, "err");
  } else log(out, "connected", "ok");
  document.body.classList.add("connected");
  renderConversation();
  if ($<HTMLInputElement>("poll").checked) schedulePoll(0);
}

// ---------------------------------------------------------------- register

async function register(): Promise<void> {
  const out = $("register-status");
  await guard(out, "register", async () => {
    const username = $<HTMLInputElement>("username").value.trim();
    log(out, `registering ${username}…`);
    const r = await requireSkein().register(username);
    const kind = r.status === 200 ? "ok" : r.status === 409 && /already/i.test(r.text) ? "ok" : "err";
    log(out, `HTTP ${r.status} ${r.text}`, kind);
  });
}

// ---------------------------------------------------------------- import

let picked: PickedFile[] | undefined;

async function pick(): Promise<void> {
  const out = $("import-status");
  await guard(out, "read directory", async () => {
    const list = [...($<HTMLInputElement>("dir").files ?? [])];
    const keep = list.filter((f) => !ignored(relativeToPicked(f.webkitRelativePath || f.name)));
    log(out, `reading ${keep.length} files…`);
    const files: PickedFile[] = [];
    let bytes = 0;
    for (const f of keep) {
      const b = new Uint8Array(await f.arrayBuffer());
      bytes += b.length;
      files.push({ path: relativeToPicked(f.webkitRelativePath || f.name), bytes: b });
    }
    picked = files;
    log(out, `${files.length} files, ${bytes} bytes (${list.length - keep.length} under .git/node_modules skipped); press Import`);
  });
}

async function doImport(): Promise<void> {
  const out = $("import-status");
  await guard(out, "import", async () => {
    if (!picked?.length) throw new Error("pick a directory first");
    const r = await requireSkein().importFiles(picked, (i, n, bytes) => log(out, `bundle ${i + 1}/${n} (${bytes} bytes)…`));
    const root = r.root.toString();
    log(out, `${r.records} objects in ${r.bundles.length} envelope(s) to box objects`, "ok");
    $("root").textContent = root;
    $<HTMLInputElement>("chat-tree").value = root;
    $<HTMLInputElement>("run-tree").value = root;
    store.set("skein.lastImport", root);
  });
}

// ---------------------------------------------------------------- chat, run

function renderConversation(): void {
  const c = skein?.conversation();
  $("conversation").textContent = c ? `continuing: reply to say ${short(c.say)}${c.tree ? `, tree ${short(c.tree)}` : ""}` : "no conversation yet: the next chat starts one";
  $<HTMLInputElement>("chat-tree").placeholder = c?.tree ? `default: ${short(c.tree)} (last say)` : "tree CID (optional)";
}

async function chat(): Promise<void> {
  const out = $("chat-status");
  await guard(out, "chat", async () => {
    const text = $<HTMLTextAreaElement>("chat-text").value;
    const tree = $<HTMLInputElement>("chat-tree").value.trim() || undefined;
    const model = $<HTMLInputElement>("chat-model").value.trim() || undefined;
    const fresh = $<HTMLInputElement>("chat-new").checked;
    const s = await requireSkein().chat({ text, tree, model, fresh });
    log(out, `sent ${short(s.cid)}${s.replyTo ? ` (reply to ${short(s.replyTo)})` : " (new conversation)"}; waiting for the say`, "ok");
    $<HTMLTextAreaElement>("chat-text").value = "";
    $<HTMLInputElement>("chat-new").checked = false;
    $<HTMLInputElement>("chat-tree").value = "";
  });
}

async function run(): Promise<void> {
  const out = $("run-status");
  await guard(out, "run", async () => {
    const tree = $<HTMLInputElement>("run-tree").value.trim();
    const cmd = $<HTMLInputElement>("run-cmd").value;
    const cwd = $<HTMLInputElement>("run-cwd").value.trim() || undefined;
    if (!tree) throw new Error("run needs a tree CID (import a directory first)");
    if (!cmd.trim()) throw new Error("empty command");
    const s = await requireSkein().run({ tree, cmd, cwd });
    log(out, `sent ${short(s.cid)}; waiting for the result`, "ok");
  });
}

// ---------------------------------------------------------------- inbox

interface View {
  box: string; messageId: string; cid?: string; created?: string; verified: boolean; sender: string; error?: string;
  text?: string; page?: string; tree?: string; thread?: string; replyTo?: string;
  exitCode?: string; stdout?: string; stderr?: string; other?: string;
}

const str = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  const c = CID.asCID(v);
  return c ? c.toString() : typeof v === "string" ? v : JSON.stringify(v);
};

function view(r: Result): View {
  const b = r.body ?? {};
  const known = ["text", "page", "tree", "thread", "replyTo", "exitCode", "stdout", "stderr"];
  const other = Object.keys(b).filter((k) => !known.includes(k));
  return {
    box: r.box, messageId: r.messageId, cid: r.cid, created: r.created, verified: r.verified, sender: r.sender, error: r.error,
    text: str(b.text), page: str(b.page), tree: str(b.tree), thread: str(b.thread), replyTo: str(b.replyTo),
    exitCode: str(b.exitCode), stdout: str(b.stdout), stderr: str(b.stderr),
    other: other.length ? JSON.stringify(Object.fromEntries(other.map((k) => [k, str(b[k])]))) : undefined,
  };
}

const HISTORY = "skein.inbox";
const loadHistory = (): View[] => { try { return JSON.parse(store.get(HISTORY) ?? "[]"); } catch { return []; } };

function cidLink(label: string, cid: string | undefined, useAsTree = false): string {
  if (!cid) return "";
  const attrs = useAsTree ? ` class="cid tree" data-cid="${escapeHtml(cid)}" title="${escapeHtml(cid)} (click: use as tree)"` : ` class="cid" title="${escapeHtml(cid)}"`;
  return `<span${attrs}>${label} ${escapeHtml(short(cid))}</span>`;
}

function renderInbox(): void {
  const lastChat = skein?.lastSent(BOX.chat)?.cid, lastRun = skein?.lastSent(BOX.run)?.cid;
  $("messages").innerHTML = loadHistory().map((v) => {
    const answers = v.replyTo && (v.replyTo === lastChat || v.replyTo === lastRun) ? ` <span class="tag">answers your last ${v.box === BOX.say ? "chat" : "run"}</span>` : "";
    const head = `<div class="meta">${escapeHtml(v.box)} · ${escapeHtml(v.created ?? "?")} · ${v.verified ? "verified" : "<b>UNVERIFIED</b>"}${answers}</div>`;
    if (v.error) return `<article class="msg err">${head}<pre class="error">${escapeHtml(v.error)}</pre></article>`;
    const parts: string[] = [];
    if (v.text !== undefined) parts.push(`<p class="text">${escapeHtml(v.text)}</p>`);
    if (v.page) parts.push(`<div class="page">${markdownToHtml(v.page)}</div>`);
    if (v.exitCode !== undefined) parts.push(`<div>exit ${escapeHtml(v.exitCode)}</div>`);
    if (v.stdout) parts.push(`<pre>${escapeHtml(v.stdout)}</pre>`);
    if (v.stderr) parts.push(`<pre class="stderr">${escapeHtml(v.stderr)}</pre>`);
    if (v.other) parts.push(`<pre>${escapeHtml(v.other)}</pre>`);
    parts.push(`<div class="ids">${[cidLink("tree", v.tree, true), cidLink("thread", v.thread), cidLink("reply to", v.replyTo)].filter(Boolean).join(" ")}</div>`);
    return `<article class="msg ${escapeHtml(v.box)}">${head}${parts.join("")}</article>`;
  }).join("");
}

async function pollOnce(): Promise<void> {
  const out = $("inbox-status");
  const results = await requireSkein().inbox({ ack: true });
  if (results.length) {
    const hist = [...results.map(view).reverse(), ...loadHistory()].slice(0, 100);
    store.set(HISTORY, JSON.stringify(hist));
    renderInbox();
    renderConversation();
  }
  log(out, `checked ${new Date().toLocaleTimeString()}${results.length ? `: ${results.length} new` : ""}`, "ok");
}

function schedulePoll(ms = 2000): void {
  clearTimeout(polling);
  polling = setTimeout(async () => {
    if (!skein || !$<HTMLInputElement>("poll").checked) return;
    try {
      await pollOnce();
      schedulePoll();
    } catch (e) {
      // Stop on error: a denied wallet permission would otherwise prompt every 2 s.
      console.error("inbox", e);
      $<HTMLInputElement>("poll").checked = false;
      log($("inbox-status"), `inbox: ${errText(e)} — polling stopped; tick "poll" to resume`, "err");
    }
  }, ms);
}

// ---------------------------------------------------------------- boot

async function boot(): Promise<void> {
  try {
    const res = await fetch("dist/config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cfg = await res.json();
  } catch (e) {
    log($("connect-status"), `no dist/config.json (run npm run web:build): ${errText(e)}`, "err");
    return;
  }
  $("cfg").textContent = `instance ${cfg.instance.handle}@${cfg.instance.domain} ${short(cfg.instance.identityKey)} · messagebox ${cfg.messageboxUrl}`;
  $("expected").textContent = cfg.expectedOwner ?? "(none configured)";
  const last = store.get("skein.lastImport");
  if (last) { $("root").textContent = last; $<HTMLInputElement>("run-tree").value = last; }
  $("connect").addEventListener("click", () => void connect().catch((e) => log($("connect-status"), errText(e), "err")));
  $("register").addEventListener("click", () => void register());
  $("dir").addEventListener("change", () => void pick());
  $("import").addEventListener("click", () => void doImport());
  $("chat-send").addEventListener("click", () => void chat());
  $("chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void chat(); });
  $("run-send").addEventListener("click", () => void run());
  $("poll").addEventListener("change", () => { if ($<HTMLInputElement>("poll").checked) schedulePoll(0); });
  $("check").addEventListener("click", () => void guard($("inbox-status"), "inbox", pollOnce));
  $("clear").addEventListener("click", () => { store.remove(HISTORY); renderInbox(); });
  $("messages").addEventListener("click", (e) => {
    const cid = (e.target as HTMLElement).closest<HTMLElement>(".cid.tree")?.dataset.cid;
    if (cid) { $<HTMLInputElement>("chat-tree").value = cid; $<HTMLInputElement>("run-tree").value = cid; }
  });
  renderInbox();
  log($("connect-status"), "not connected");
  if (loadLastProvider()) void connect().catch((e) => log($("connect-status"), errText(e), "err"));
}

void boot();
