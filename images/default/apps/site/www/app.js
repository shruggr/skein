// The management site (shruggr/skein#92), an app since #125: installed in a
// skein, it serves these files at /site/ (and at / by root's own route, which
// the default image has); what makes the page yours is the wallet in the browser. Everything it shows of a skein it reads from
// that skein, on a BRC-104 session signed by your wallet; everything it
// changes there is a message from you to that skein. The skein that served
// the page is never in the path for another skein's data.
//
//   #/                       your skeins (this page's host lists them: the skeins whose head `grants`
//                            names your key root, GET <host>/skeins?key=), create one here; your
//                            handles (certificates in your wallet), register one on this page's host,
//                            each one's profile (#104: name and avatar, signed by your wallet); find a
//                            handle on this page's host (BRC-169 search)
//   #/s/<identity>           a skein, its Apps tab: installed (upgrade, uninstall), add from the
//                            catalog or a repository (GitHub's versions resolved to a commit), the
//                            review; the skeins created there (a host skein's)
//   #/s/<identity>/app/<name>  one app: its routes (transport, address, filters, handler) and its
//                            roles (root, user and the app's own), each role's holders from the
//                            kernel's head `grants`, granted and revoked by root (shruggr/skein#143)
//   #/s/<identity>/peers     its Contacts (the address book): add by handle, or by key and URL
//   #/s/<identity>/overview  root, handle, counts, identity
//   #/s/<identity>/log, /threads, /thread/<cid>, /record/<cid>, /edges/<cid>, /routes, /heads
//                            the explorer: the skein's own reads (/explore, root's)
//   #/inbox                  the Inbox: a mailbox's box listed (@bsv/message-box-client), and its
//                            metanet_inbox synced into your wallet (@1sat/actions' syncMetanetInbox);
//                            the mailbox your first handle resolves to, unless you typed another
//
// Query string (tests): ?key=<hex> runs a wallet in the tab over that key
// (createWebWallet, webwallet.js) instead of connecting one; &services=<url>
// points that wallet at a 1sat services endpoint.

import { appRecordIn, Certificate, chunk, CID, connectWallet, createContext, dagJson, decodeProfile, describe, dispatchOrigin, encodeProfile, fold, formatOrdinalOutpoint, Hash, lookup, MasterCertificate, MessageBoxClient, outpointFromBytes, outpointToBytes, parseTree, planInstall, planUninstall, ProtoWallet, RawBox, readStoredApp, rowKey, sendInstall, sendUninstall, signClaim, syncMetanetInbox, Utils, WalletClient, wiring } from "./lib.js";

const q = new URLSearchParams(location.search);
/** The skein that served this page: its base URL (the page is its `/site/`, or its `/` by root's route). */
const here = new URL(".", location.href).href.replace(/\/+$/, "").replace(/\/site$/, "");
const GIT_RAW = 0x78;
/** BRC-169 §4.5: the handle-certificate type. */
const HANDLE_TYPE = Utils.toBase64(Hash.sha256(Utils.toArray("metanet-handles handle certificate v1", "utf8")));
/** A registration's signature (the host's POST /account/register): protocol, key ID the name, over `register <name>@<domain>` (the host's domain, lower case). */
const REGISTER = [2, "skein register"];
/**
 * A handle's profile (#104): the OpNS profile record (@1sat/utils
 * encodeProfile: DAG-CBOR {domain, name?, avatar?}, the avatar an image
 * inscription's 36-byte outpoint), signed by the holder's wallet under this
 * protocol, key ID "1", counterparty anyone, over those bytes — anyone with
 * the identity key verifies it. Posted to the host's POST /account/profile
 * {handle, record: <base64 of the bytes>, signature: <hex DER>}; the host's
 * onboarding app keeps it (skein docs/MESSAGES.md "Mailbox instances").
 */
const PROFILE = [1, "metanet handles profile"];
const PROFILE_KEY_ID = "1";

const state = { wallet: undefined, me: "", skeins: [], skeinsError: "", catalog: [], boxes: new Map(), host: undefined, handles: undefined };
window.site = state;

// ---------------------------------------------------------------- DOM

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k !== undefined && k !== null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
const short = (s, n = 10) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const isKey = (s) => /^0[23][0-9a-f]{64}$/.test(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const when = (t) => (Array.isArray(t) ? new Date(t[0] * 1000 + Math.floor(t[1] / 1e6)).toISOString().replace("T", " ").slice(0, 19) : "");
function status(el, text, cls = "") { el.className = `status ${cls}`; el.textContent = text; }

/**
 * A generative identicon for an identity key (BRC-169 §2.4 item 1, where a
 * handle has no avatar): a 5×5 grid mirrored left to right, its cells and
 * colour from SHA-256 of the key.
 */
function identicon(key, size = 28, cls = "") {
  const d = Hash.sha256(Utils.toArray(key, "hex"));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 5 5", width: size, height: size, class: `avatar ${cls}`.trim(), "aria-hidden": "true" })) svg.setAttribute(k, String(v));
  const fill = `hsl(${((d[0] << 8) | d[1]) % 360} 55% 48%)`;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (!(d[2 + y * 3 + x] & 1)) continue;
      for (const cx of new Set([x, 4 - x])) {
        const r = document.createElementNS(ns, "rect");
        for (const [k, v] of Object.entries({ x: cx, y, width: 1, height: 1, fill })) r.setAttribute(k, String(v));
        svg.append(r);
      }
    }
  }
  return svg;
}

/** The inspect icon (a list and a magnifier), for the link to a skein's log, threads and routes. */
function inspectIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, String(v));
  for (const [tag, attrs] of [["path", { d: "M4 6h16M4 12h10M4 18h7" }], ["circle", { cx: 18, cy: 16, r: 3 }], ["path", { d: "M20.2 18.2 22 20" }]]) {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    svg.append(e);
  }
  return svg;
}
const inspectLink = (identity) => h("a", { class: "icon-btn", href: `#/s/${identity}/log`, "aria-label": "Inspect: log, threads, routes, heads", title: "Inspect: log, threads, routes, heads" }, inspectIcon());
const errText = (e) => (e instanceof Error ? e.message : String(e));

/** The copy icon (two sheets). */
function copyIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, String(v));
  for (const [tag, attrs] of [["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ["path", { d: "M5 15V5a2 2 0 0 1 2-2h10" }]]) {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    svg.append(e);
  }
  return svg;
}

/** Text onto the clipboard: the async API, else a selected textarea (a page served over http). */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* below */ }
  const t = h("textarea", { class: "offscreen", readonly: true, "aria-hidden": "true" });
  t.value = text;
  document.body.append(t);
  t.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* not copied */ }
  t.remove();
  return ok;
}

/**
 * An id as these pages show one (an identity key, a txid, a CID, a commit):
 * shortened, the full value a click away (click again to shorten it), and a
 * copy button that says "Copied".
 */
function idView(value, { n = 6, label = "id" } = {}) {
  const full = String(value ?? "");
  const brief = full.length > 2 * n + 1 ? `${full.slice(0, n)}…${full.slice(-n)}` : full;
  const text = brief === full
    ? h("span", { class: "idv-text" }, full)
    : h("button", { type: "button", class: "idv-text", title: `${full} (click to show it in full)`, "aria-expanded": "false" }, brief);
  if (text.tagName === "BUTTON") {
    text.onclick = () => {
      const open = text.getAttribute("aria-expanded") !== "true";
      text.setAttribute("aria-expanded", String(open));
      text.textContent = open ? full : brief;
      text.closest(".idv")?.classList.toggle("open", open);
    };
  }
  const done = h("span", { class: "idv-done", "aria-live": "polite" });
  const copy = h("button", { type: "button", class: "idv-copy", title: `Copy the ${label}`, "aria-label": `Copy the ${label}` }, copyIcon(), done);
  let timer;
  copy.onclick = async () => {
    const ok = await copyText(full);
    clearTimeout(timer);
    done.textContent = ok ? "Copied" : "Not copied";
    copy.classList.add("copied");
    timer = setTimeout(() => { done.textContent = ""; copy.classList.remove("copied"); }, 1600);
  };
  return h("span", { class: "idv", "data-id": full }, text, copy);
}

/** The wait (0.7.4's): the mark turning beside the step being taken. */
function waiter(id) {
  const text = h("span", { class: "waiting-text" });
  const el = h("div", { class: "waiting", hidden: true, role: "status", ...(id ? { id } : {}) }, h("img", { src: "skein-mark.jpg", alt: "", width: "22", height: "22" }), text);
  return { el, say: (t) => { text.textContent = t; el.hidden = false; }, stop: () => { el.hidden = true; } };
}

/**
 * A quiet action that asks first, in place (never window.confirm): the
 * button gives way to the question, the action's own button and Cancel.
 * `question` may be a function (async) that works out what to ask. `run`
 * gets the step reporter; it re-renders the page when done, or throws.
 */
function confirmAction({ label, question, yes, run, cls = "quiet", attrs = {} }) {
  const box = h("span", { class: "confirm" });
  const st = h("span", { class: "status small" });
  const w = waiter();
  const start = h("button", { type: "button", class: cls, ...attrs }, label);
  const ask = (q) => {
    const go = h("button", { type: "button", class: "danger" }, yes);
    const no = h("button", { type: "button", class: "quiet" }, "Cancel");
    no.onclick = () => { box.classList.remove("asking"); box.replaceChildren(start, st); start.focus(); };
    go.onclick = async () => {
      go.disabled = no.disabled = true;
      status(st, "");
      try { await run(w.say); } catch (e) { w.stop(); status(st, errText(e), "bad"); go.disabled = no.disabled = false; }
    };
    box.classList.add("asking");
    box.replaceChildren(h("span", { class: "confirm-q" }, q), h("span", { class: "confirm-btns" }, go, no), w.el, st);
    go.focus();
  };
  start.onclick = async () => {
    status(st, "");
    if (typeof question !== "function") return ask(question);
    start.disabled = true;
    try { ask(await question()); } catch (e) { status(st, errText(e), "bad"); } finally { start.disabled = false; }
  };
  box.append(start, st);
  return box;
}

/** Whether version `a` is newer than `b` (x.y.z, a leading v ignored). */
function newer(a, b) {
  const p = (v) => String(v ?? "").replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// ---------------------------------------------------------------- the wallet

async function connect() {
  const key = q.get("key");
  if (key) {
    const { createWebWallet, PrivateKey } = await import("./webwallet.js");
    const privateKey = PrivateKey.fromHex(key);
    const services = q.get("services");
    const web = await createWebWallet({ privateKey, chain: "main", storageIdentityKey: privateKey.toPublicKey().toString(), skipInitialMonitor: true, ...(services ? { servicesBaseUrl: services } : {}) });
    return web.wallet;
  }
  let reason;
  const r = await connectWallet({
    autoDetect: false,
    providers: [{
      type: "brc100", name: "BRC-100 wallet",
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
  if (!r) throw new Error(`no wallet: ${reason ? errText(reason) : "nothing answered"}`);
  return r.wallet;
}

async function useWallet() {
  state.wallet = await connect();
  state.me = (await state.wallet.getPublicKey({ identityKey: true })).publicKey;
  renderWho();
  $("who").title = state.me;
  $("connect").hidden = true;
  await loadSkeins();
}

/**
 * The wallet chip in the header: your handle when the page has read it
 * (state.handles, from myHandles), else your key shortened; the key in mono
 * under it. Nothing is fetched for it.
 */
function renderWho() {
  const who = $("who");
  if (!state.me) return;
  const x = (state.handles ?? []).find((r) => r.handle && !r.error);
  const key = short(state.me, 4);
  who.className = "who on";
  who.replaceChildren(
    x ? picFor(state.me, x.profile, "avatar-sm") : identicon(state.me, 30, "avatar-sm"),
    h("span", { class: "who-text" },
      x ? h("span", { class: "who-name" }, `${x.handle}@${x.domain}`) : "",
      h("span", { class: "who-key" }, key)));
}

/**
 * Connect failed: one short line in the header, "No wallet found" when no
 * wallet answered, else the first line of the error; the full text in title.
 */
function connectFailed(e) {
  const text = errText(e);
  const none = text.includes("No wallet available") || text.startsWith("no wallet:");
  let msg = none ? "No wallet found" : text.split("\n")[0];
  if (msg.length > 60) msg = `${msg.slice(0, 57)}…`;
  const who = $("who");
  who.className = "who bad";
  who.title = text;
  who.textContent = msg;
}

// ---------------------------------------------------------------- your skeins, from the host

/**
 * Your skeins on this page's host: the host answers GET <its origin>/skeins?key=<your
 * identity key> from each skein's head `grants` (#143: the skeins whose root role names
 * your key), [{handle, identity, url}]. Nothing in your wallet tracks them. A host that
 * does not answer: none, its reason kept for the page.
 */
async function loadSkeins() {
  state.skeins = [];
  state.skeinsError = "";
  try {
    const host = await hostInfo();
    if (!host) return state.skeins;
    const r = await fetch(`${host.origin}/skeins?key=${state.me}`);
    if (r.status !== 200) throw new Error(`${host.origin}/skeins: HTTP ${r.status}`);
    state.skeins = (await r.json()).filter((x) => isKey(x.identity ?? "") && typeof x.url === "string").map(({ handle, identity, url }) => ({ handle: handle ?? "", identity, url }));
  } catch (e) { state.skeinsError = errText(e); }
  return state.skeins;
}

const skeinListed = (identity) => state.skeins.find((l) => l.identity === identity);

// ---------------------------------------------------------------- a skein, read and written directly

function boxFor(url) {
  const u = url.replace(/\/+$/, "");
  let b = state.boxes.get(u);
  if (!b) { b = new RawBox(state.wallet, u); state.boxes.set(u, b); }
  return b;
}

class ReadError extends Error {
  constructor(status, text) { super(status === 403 ? "your key may not read this skein: its explorer is root's" : `HTTP ${status} ${text}`); this.status = status; }
}

class Skein {
  constructor(loc) {
    this.loc = loc;
    this.url = loc.url.replace(/\/+$/, "");
    this.box = boxFor(this.url);
    this.records = new Map();
  }
  /** A signed request to the skein; the identity its answer is signed by is remembered. */
  async fetch(path, init = { method: "GET" }) {
    const r = await this.box.af.fetch(this.url + path, init);
    const id = r.headers.get("x-bsv-auth-identity-key");
    if (id) this.answeredBy = id;
    return r;
  }
  /** A read of the skein's explorer (`/explore…`, a `{read: true}` route): DAG-JSON decoded; 404 → undefined. */
  async read(path) {
    const r = await this.fetch(`/explore${path}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new ReadError(r.status, new TextDecoder().decode(bytes).slice(0, 200));
    return dagJson.decode(bytes);
  }
  /** A record by CID (immutable: kept once read). */
  async record(cid) {
    const k = cid.toString();
    if (!this.records.has(k)) this.records.set(k, await this.read(`/record/${k}`));
    return this.records.get(k);
  }
  /** A message from you to the skein (BRC-33 on the session): its id. */
  async send(box, body) { return (await this.box.send(this.loc.identity, box, body)).id; }

  /**
   * The instance as the install plan reads it (skein src/host/plan.ts
   * InstanceView), from the explorer: heads, the genesis (identity,
   * programs), the address book, the route table, the grants (the kernel's
   * head `grants`, #143: `{kind: "grants", roles: {<role>: [<key>…]}}`; its
   * `root` holders: `roots`, hex), and the store by CID.
   */
  async view() {
    const top = await this.read("");
    const heads = Object.entries(top.heads ?? {}).map(([name, root]) => ({ name, root }));
    const head = (name) => heads.find((x) => x.name === name)?.root;
    const first = (await this.read("/log?before=1&limit=1"))?.entries?.[0]?.record;
    const genesis = first?.genesis ? await this.record(first.genesis) : {};
    const g = head("grants") ? await this.record(head("grants")) : undefined;
    const grants = g?.kind === "grants" ? g : { kind: "grants", roles: {} };
    const keyHex = (k) => (k instanceof Uint8Array ? toHex(k) : typeof k === "string" ? k : "");
    const book = [];
    if (head("peers")) {
      for (const e of (await this.record(head("peers")))?.peers ?? []) {
        const p = await this.record(e.peer);
        book.push({ key: keyHex(p.key ?? e.key), transport: p.transport ?? "mailbox", address: p.address ?? "", ...(p.handle ? { handle: p.handle } : {}), ...(p.domain ? { domain: p.domain } : {}), ...(p.source ? { source: p.source } : {}) });
      }
    }
    const chain = await this.read(`/thread/${dispatchOrigin()}`);
    const dispatch = fold((chain?.updates ?? []).map((u) => u.record).filter((u) => u && u.row));
    const store = {
      get: async (cid) => { const v = await this.record(cid); if (v === undefined) throw new Error(`not found: ${cid}`); return v; },
      has: async (cid) => (await this.record(cid)) !== undefined,
      bytes: async (cid) => { const v = await this.record(cid); if (!(v instanceof Uint8Array)) throw new Error(`not found: ${cid}`); return v; },
      putBlock: async () => {},
    };
    return {
      store, heads, dispatch, addressBook: book, top,
      identity: keyHex(genesis.identity), programs: genesis.programs ?? {},
      grants, roots: holdersOf(grants, "root"),
    };
  }

  /** The thread a message launched (its `launched-by` edge), read until it comes to rest: its last update. */
  async threadOf(message, timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs;
    for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
      const e = await this.read(`/edges/${message}?rel=launched-by`);
      for (const edge of e?.edges ?? []) {
        const t = await this.read(`/thread/${edge.from}`);
        const last = t?.updates?.at(-1)?.record;
        if (last && (last.state === "finished" || last.state === "errored")) return { origin: edge.from, update: last };
      }
      if (Date.now() > deadline) throw new Error("no answer yet: the thread has not come to rest (see the explorer's threads)");
      await sleep(wait);
    }
  }

  /**
   * Deploy by hash, step one: `{fn: "git.clone", args: {url, hash}}` to the
   * git app's box; its answer `{tree, app}` read from the thread's result.
   */
  async clone(url, hash) {
    const id = await this.send("git", { fn: "git.clone", args: { url, hash } });
    const { update } = await this.threadOf(id);
    if (update.state === "errored") throw new Error(`the git app's thread errored: ${JSON.stringify(update.error ?? {})}`);
    const out = dagJson.decode(update.result?.stdout ?? new Uint8Array());
    if (out.error) throw new Error(`git.clone: ${out.error.code}: ${out.error.message}`);
    return out.result;
  }
}

const skeins = new Map();
function skeinOf(identity) {
  const loc = skeinListed(identity);
  if (!loc) return undefined;
  let s = skeins.get(loc.url);
  if (!s) { s = new Skein(loc); skeins.set(loc.url, s); }
  return s;
}

// ---------------------------------------------------------------- handles (BRC-169, #103)

/**
 * The host this page's skein runs on: `/.well-known/skein-host` (the host's
 * router answers it at every skein's origin) gives its router origin and
 * domain; the manifest there (BRC-169 §5.1) the certifier key and the
 * resolve endpoint. null: the page is not served by a skein host.
 */
async function hostInfo() {
  if (state.host !== undefined) return state.host;
  try {
    const at = await (await fetch(new URL("/.well-known/skein-host", location.href))).json();
    const mf = await (await fetch(`${at.origin}/manifest.json`)).json();
    const t = mf.metanet.trust;
    state.host = { origin: at.origin, domain: at.domain, certifier: t.publicKey, name: t.name, icon: t.icon, resolve: mf.metanet.handles.resolve, search: mf.metanet.handles.search };
  } catch { state.host = null; }
  return state.host;
}

/**
 * What an answer — a resolution, or a search result — says of a handle's
 * profile (#104). `attested`: its `profile` record verified here against
 * the answer's identity key (PROFILE, key ID "1"), its domain the handle's;
 * {name?, avatar?: txid_vout}. `hints`: `displayName` and `avatarURL` as the
 * host sent them, unattested (BRC-169 §2.4 item 8, §5.6).
 */
async function profileIn(a, domain) {
  const out = { hints: {} };
  if (typeof a.displayName === "string") out.hints.displayName = a.displayName;
  if (typeof a.avatarURL === "string") out.hints.avatarURL = a.avatarURL;
  const p = a.profile;
  if (p && typeof p.record === "string" && typeof p.signature === "string" && isKey(a.identityKey ?? "")) {
    try {
      const data = Utils.toArray(p.record, "base64");
      const { valid } = await new ProtoWallet("anyone").verifySignature({ protocolID: PROFILE, keyID: PROFILE_KEY_ID, counterparty: a.identityKey, data, signature: Utils.toArray(p.signature, "hex") });
      const d = decodeProfile(data);
      if (valid && d.domain === domain) out.attested = { record: p.record, ...(d.name ? { name: d.name } : {}), ...(d.avatar ? { avatar: outpointFromBytes(d.avatar) } : {}) };
    } catch { /* not verified: only the hints */ }
  }
  return out;
}

/**
 * A handle as BRC-169 §2.4 has it shown: the avatar, or the identity key's
 * identicon, then the handle. The name and avatar from a verified profile
 * are marked as signed by the handle's key; the host's hints, shown only
 * without one, as unattested.
 */
function picFor(key, prof = { hints: {} }, cls = "") {
  const a = prof.attested, hint = prof.hints;
  const c = `avatar ${cls}`.trim();
  if (a?.avatar && hint.avatarURL?.endsWith(`/${a.avatar}`)) return h("img", { class: c, src: hint.avatarURL, alt: "", width: 28, height: 28, title: `avatar ${a.avatar}` });
  if (!a && hint.avatarURL) return h("img", { class: c, src: hint.avatarURL, alt: "", width: 28, height: 28, title: "avatar: from the host, unattested" });
  return identicon(key, 28, cls);
}

function handleView(key, handle, domain, prof = { hints: {} }) {
  const a = prof.attested, hint = prof.hints;
  return h("span", { class: "handle" }, picFor(key, prof),
    h("span", {}, `${handle}@${domain}`,
      a?.name ? h("span", { class: "pname" }, ` ${a.name}`) : "",
      a ? h("span", { class: "small ok" }, " (profile signed by its key)") : "",
      !a && (hint.displayName || hint.avatarURL) ? h("span", { class: "small wait" }, ` ${hint.displayName ?? ""} (from the host, unattested)`) : ""));
}

/** A domain's manifest (§5.1): this host's from hostInfo, another's from https://<domain>/manifest.json. */
async function manifestOf(domain, host) {
  if (host && domain === host.domain) return { certifier: host.certifier, resolve: host.resolve };
  const mf = await (await fetch(`https://${domain}/manifest.json`)).json();
  return { certifier: mf.metanet?.trust?.publicKey, resolve: mf.metanet?.handles?.resolve };
}

/**
 * Your handles (§5.8 path 1): the handle certificates in your wallet from
 * this host's certifier (`listCertificates`), each checked (your key, the
 * signature, the certifier the domain's manifest names), its fields
 * decrypted with the keyring the wallet keeps, and resolved: the messagebox.
 */
async function myHandles(refresh = false) {
  if (state.handles && !refresh) return state.handles;
  const host = await hostInfo();
  if (!host) return (state.handles = []);
  const { certificates } = await state.wallet.listCertificates({ certifiers: [host.certifier], types: [HANDLE_TYPE] });
  const out = [];
  for (const c of certificates) {
    const row = { serialNumber: c.serialNumber, handle: "", domain: "" };
    try {
      if (c.subject !== state.me) throw new Error("not your key's certificate");
      if (!(await new Certificate(c.type, c.serialNumber, c.subject, c.certifier, c.revocationOutpoint, c.fields, c.signature).verify())) throw new Error("its signature does not verify");
      const f = await MasterCertificate.decryptFields(state.wallet, c.keyring ?? {}, c.fields, c.certifier);
      row.handle = f.handle; row.domain = f.domain;
      const mf = await manifestOf(f.domain, host);
      if (mf.certifier !== c.certifier) throw new Error(`its certifier is not the one ${f.domain} publishes`);
      row.resolve = mf.resolve;
      const a = await resolveHandle(row);
      if (a.identityKey !== state.me) throw new Error(`${f.handle}@${f.domain} resolves to another key`);
      row.messagebox = a.messagebox;
      row.profile = await profileIn(a, f.domain);
    } catch (e) { row.error = errText(e); }
    out.push(row);
  }
  state.handles = out;
  renderWho();
  return out;
}

/** A handle's resolution (§5.2) at its domain's resolve endpoint. */
async function resolveHandle(row) {
  const r = await fetch(`${row.resolve}?handle=${encodeURIComponent(row.handle)}`);
  const a = await r.json();
  if (r.status !== 200) throw new Error(`resolve: ${a.error?.message ?? `HTTP ${r.status}`}`);
  return a;
}

/**
 * Set your profile for a handle (#104): the record built (@1sat/utils
 * encodeProfile: the handle's domain, the name and the avatar's outpoint
 * when given), signed by your wallet, and posted to the host's
 * POST /account/profile {handle, record (base64), signature (hex DER)}.
 */
async function setProfile(row, name, avatar) {
  let av;
  if (avatar) {
    av = outpointToBytes(formatOrdinalOutpoint(avatar));
    if (!av) throw new Error(`the avatar is not an outpoint (txid_vout or txid.vout): ${avatar}`);
  }
  const bytes = encodeProfile({ domain: row.domain, ...(name ? { name } : {}), ...(av ? { avatar: av } : {}) });
  const { signature } = await state.wallet.createSignature({ protocolID: PROFILE, keyID: PROFILE_KEY_ID, counterparty: "anyone", data: bytes });
  const host = await hostInfo();
  if (!host || row.domain !== host.domain) throw new Error(`${row.handle}@${row.domain} is not a handle of this page's host`);
  // A write (it keeps the record): a signed request, over the wallet's session (shruggr/skein#135).
  const r = await boxFor(host.origin).af.fetch(`${host.origin}/account/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: row.handle, record: Utils.toBase64(bytes), signature: toHex(signature) }) });
  let v = {};
  try { v = await r.json(); } catch { /* the status says it */ }
  if (r.status !== 200) throw new Error(v.error ?? `HTTP ${r.status}`);
  return v;
}

/** The Profile form of one of your handles: the current profile, and Save (setProfile). */
function profileForm(x) {
  const a = x.profile?.attested;
  const name = h("input", { type: "text", name: "name", placeholder: "a name (optional)", "aria-label": "Name", value: a?.name ?? "" });
  const avatar = h("input", { type: "text", name: "avatar", placeholder: "avatar: an image inscription's outpoint, txid_vout (optional)", "aria-label": "Avatar outpoint", value: a?.avatar ?? "" });
  const st = h("div", { class: "status profile-status" });
  const now = a
    ? `Now: ${a.name ? `name ${a.name}` : "no name"}, ${a.avatar ? `avatar ${a.avatar}` : "no avatar"} (signed by your key, verified here).`
    : "No profile yet.";
  const panel = h("div", { class: "profile", hidden: true },
    h("p", { class: "mut small" }, `${now} Your wallet signs the name and the avatar (an image inscription, by outpoint); ${x.domain} keeps them and serves them with ${x.handle}@${x.domain} when it is resolved or found.`),
    h("form", { class: "row profile-form", onsubmit: async (e) => {
      e.preventDefault();
      try {
        status(st, `signing and sending to ${x.domain}`);
        await setProfile(x, name.value.trim(), avatar.value.trim());
        status(st, "saved: the host serves it", "ok");
        state.handles = undefined;
        await sleep(300);
        route();
      } catch (err) { status(st, errText(err), "bad"); }
    } }, name, avatar, h("button", { type: "submit", class: "go" }, "Save")), st);
  const open = h("button", { type: "button", class: "outline", "aria-expanded": "false", onclick: () => {
    panel.hidden = !panel.hidden;
    open.setAttribute("aria-expanded", String(!panel.hidden));
  } }, "Edit profile");
  return { open, panel };
}

/**
 * Find a handle on this page's host (BRC-169 §5.6): one query per explicit
 * search (nothing is sent as you type; the button waits for the answer),
 * to the search endpoint the host's manifest names. The results are hints:
 * no certificate comes with them.
 */
function searchSection(m, host) {
  if (!host.search) return;
  const q = h("input", { type: "text", name: "q", placeholder: "a handle or a name", "aria-label": "A handle or a name" });
  const go = h("button", { type: "submit", class: "outline" }, "Search");
  const st = h("div", { class: "status", id: "search-status" });
  const out = h("div", { id: "search-results" });
  const where = `${host.name ? `${host.name}, ` : ""}${host.domain}`;
  const sec = h("section", { class: "find" });
  m.append(sec);
  sec.append(h("h2", {}, "Find a handle"),
    h("p", { class: "mut small" }, `Asks ${where} when you press Search. Results are the host's hints: resolve a handle before you rely on it. A profile signed by its handle's key is marked.`),
    h("form", { class: "row find-row", id: "search", onsubmit: async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      go.disabled = true;
      out.replaceChildren();
      status(st, `searching ${host.domain}`);
      try {
        const r = await fetch(`${host.search}?q=${encodeURIComponent(q.value.trim())}&limit=20`);
        const v = await r.json();
        if (r.status !== 200) throw new Error(v.error?.message ?? `HTTP ${r.status}`);
        status(st, `${v.results.length}${v.truncated ? " (more: narrow the search)" : ""} from ${host.domain}`);
        if (v.results.length) {
          const rows = await Promise.all(v.results.map(async (x) => h("tr", { "data-result": `${x.handle}@${host.domain}` },
            h("td", {}, handleView(x.identityKey, x.handle, host.domain, await profileIn(x, host.domain))),
            h("td", { class: "key" }, idView(String(x.identityKey), { label: "identity key" })))));
          out.append(h("table", {}, h("tbody", {}, rows)));
        }
      } catch (err) { status(st, errText(err), "bad"); }
      go.disabled = false;
    } }, q, go), st, out);
}

/**
 * Register `name` on this page's host for your key: the host's
 * POST /account/register over your wallet's session, with your signature over `register <name>@<domain>`; it
 * creates your mailbox instance and answers with the handle certificate,
 * which your wallet keeps (`acquireCertificate`, direct) unless it holds it.
 */
async function registerHandle(name) {
  const host = await hostInfo();
  if (!host) throw new Error("this page's skein is not on a skein host");
  const { signature } = await state.wallet.createSignature({ protocolID: REGISTER, keyID: name, counterparty: "anyone", data: Utils.toArray(`register ${name}@${host.domain.toLowerCase()}`, "utf8") });
  // shruggr/skein#135: a registration is a write, so a signed request — over your wallet's BRC-104 session with the host's origin (its host skein).
  const r = await boxFor(host.origin).af.fetch(`${host.origin}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, identityKey: state.me, signature: toHex(signature) }) });
  let v = {};
  try { v = await r.json(); } catch { /* the status says it */ }
  if (r.status !== 200) throw new Error(v.error ?? `HTTP ${r.status}`);
  const c = v.certificate ?? {};
  if (c.type !== HANDLE_TYPE || c.subject !== state.me || c.certifier !== host.certifier) throw new Error("the host's answer carries no handle certificate for your key from its certifier");
  const { certificates } = await state.wallet.listCertificates({ certifiers: [host.certifier], types: [HANDLE_TYPE] });
  if (!certificates.some((x) => x.serialNumber === c.serialNumber)) {
    await state.wallet.acquireCertificate({
      acquisitionProtocol: "direct", type: c.type, serialNumber: c.serialNumber, certifier: c.certifier, revocationOutpoint: c.revocationOutpoint,
      fields: c.fields, signature: c.signature, keyringRevealer: "certifier", keyringForSubject: v.keyringForSubject,
    });
  }
  state.handles = undefined;
  return v;
}

// ---------------------------------------------------------------- pages

const main = () => $("main");

async function route() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  const m = main();
  m.replaceChildren();
  const inInbox = parts[0] === "inbox";
  for (const [id, on] of [["nav-skeins", !inInbox], ["nav-inbox", inInbox]]) {
    if (on) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  }
  document.body.classList.toggle("out", !state.wallet);
  m.classList.toggle("landing", !state.wallet);
  m.classList.toggle("skein", !!state.wallet && parts[0] === "s");
  if (!state.wallet) return landing(m);
  try {
    if (parts[0] === "inbox") return await inboxPage(m);
    if (parts[0] !== "s") return await home(m);
    const sk = skeinOf(parts[1]);
    if (!sk) {
      m.append(h("h1", {}, short(parts[1] ?? "")), h("p", { class: "bad" }, "Not among your skeins on this host."), h("p", {}, h("a", { href: "#/" }, "Your skeins")));
      return;
    }
    m.append(skeinHeader(sk, parts[2] ?? ""));
    const page = parts[2] ?? "";
    if (page === "") await appsPage(m, sk);
    else if (page === "app") await appPage(m, sk, parts[3] ?? "");
    else if (page === "overview") await overviewPage(m, sk);
    else if (page === "peers") await contactsPage(m, sk);
    else if (page === "heads") await headsPage(m, sk);
    else if (page === "log") await logPage(m, sk, params);
    else if (page === "threads") await threadsPage(m, sk);
    else if (page === "thread") await threadPage(m, sk, parts[3]);
    else if (page === "record") await recordPage(m, sk, parts[3], params.get("path") ?? "");
    else if (page === "edges") await edgesPage(m, sk, parts[3]);
    else if (page === "routes" || page === "dispatch") await routesPage(m, sk);
    else m.append(h("p", { class: "bad" }, `no page ${page}`));
  } catch (e) {
    m.append(h("p", { class: "bad", id: "error" }, errText(e)));
  }
}

/** The page with no wallet connected: what a skein is, and Create a skein (the header's Connect). */
function landing(m) {
  const block = (tag, title, text) => h("div", { class: "how-block" }, h("div", { class: "eyebrow" }, tag), h("h2", {}, title), h("p", {}, text));
  m.append(
    h("section", { class: "hero wrap" },
      h("div", { class: "hero-text" },
        h("h1", {}, "A skein, a handle, a mailbox."),
        h("p", { class: "hero-lead" }, "Start a skein: it runs the apps you install, on keys only you hold. From it, register ", h("span", { class: "handle-sample" }, "@you@skein.nexus"), ". Your wallet keeps the certificate, and your skein's mailbox takes messages and payments from anyone who knows the handle."),
        h("div", { class: "hero-actions" }, h("button", { type: "button", class: "go big", id: "hero-create", onclick: () => $("connect").click() }, "Create a skein")),
        h("div", { class: "hero-note" }, "Works with any BRC-100 wallet · no email, no password")),
      h("div", { class: "hero-mark" }, h("img", { src: "skein-mark.jpg", alt: "The skein mark: a knot of soft periwinkle yarn, densest at the centre", width: "360", height: "360" }))),
    h("section", { class: "how", id: "how", "aria-label": "How it works" },
      h("div", { class: "how-grid wrap" },
        block("SKEIN", "Apps that run on your keys", "Install the shell, chat, an overlay, a static site. Every change is a signed entry in a log you can read, replay and move to another host."),
        block("HANDLE", "A name anyone can resolve", "Registered from your skein: the host binds the handle to your identity key and issues the certificate into your wallet. Any BRC-169 client turns the handle back into your key and your mailbox."),
        block("MAILBOX", "Messages and payments, kept for you", "The mailbox app on your skein holds your mail until your wallet picks it up. Payments arrive the same way and land in the wallet when you open it."))));
}

async function home(m) {
  const skeinsSec = h("section", { class: "sec" });
  m.append(skeinsSec);

  // Your skeins on this host (the host's answer from their grants), one card each.
  await loadSkeins();
  skeinsSec.append(h("div", { class: "sec-head" }, h("h1", {}, "Your skeins")));
  const grid = h("div", { class: "grid", id: "skeins" });
  for (const l of state.skeins) {
    grid.append(h("article", { class: "card skein-card", "data-skein": l.identity },
      h("div", { class: "card-top" },
        h("div", { class: "card-id" },
          h("a", { class: "card-title", href: `#/s/${l.identity}` }, l.handle || short(l.identity)),
          h("a", { class: "url", href: `${l.url}/` }, l.url)),
        inspectLink(l.identity)),
      h("div", { class: "meta" }, "identity ", idView(l.identity, { label: "identity key" })),
      h("div", { class: "actions" },
        h("a", { class: "btn primary", href: `#/s/${l.identity}` }, "Manage"))));
  }

  // Create a skein (on a host skein: the onboarding app's route on the skein that served this page).
  const made = h("div", { class: "status", id: "create-status", "aria-live": "polite" });
  const name = h("input", { type: "text", name: "handle", id: "create-name", placeholder: "a hostname label" });
  const go = h("button", { type: "submit", class: "outline" }, "Create");
  // The wait (a new skein loads the chain's headers on its first step, 15–20 s): the mark turning, the seconds counting.
  const secs = h("span", { class: "wait-secs" });
  const wait = h("div", { class: "waiting", id: "create-wait", hidden: true }, h("img", { src: "skein-mark.jpg", alt: "", width: "22", height: "22" }), h("span", {}, "Creating your skein and loading the chain…", secs));
  let tick;
  const busy = (on) => {
    clearInterval(tick);
    name.disabled = go.disabled = on;
    if (on) form.setAttribute("aria-busy", "true"); else form.removeAttribute("aria-busy");
    wait.hidden = !on;
    if (on) { const t0 = Date.now(); secs.textContent = ""; tick = setInterval(() => { secs.textContent = ` · ${Math.floor((Date.now() - t0) / 1000)} s`; }, 1000); }
  };
  const form = h("form", { class: "card dashed create-card", id: "create", onsubmit: async (e) => {
    e.preventDefault();
    const handle = name.value.trim();
    if (!handle) return;
    busy(true);
    try {
      status(made, `asking ${here} to create ${handle}`);
      // #127, #143: the new skein's root is the sender of its claim; your wallet signs it now (naming no recipient), the host forwards it.
      const claim = await signClaim(state.wallet);
      const r = await boxFor(here).af.fetch(`${here}/onboard/call`, { method: "POST", headers: { "content-type": "application/json" }, body: new TextDecoder().decode(dagJson.encode({ fn: "onboard.create", args: { handle, claim } })) });
      const text = await r.text();
      let v = {};
      try { v = JSON.parse(text); } catch { /* shown as text */ }
      if (r.status === 404) throw new Error("this skein does not create skeins (no onboarding app here)");
      if (r.status !== 200 || !v.result) throw new Error(v.error?.message ?? `HTTP ${r.status} ${text.slice(0, 200)}`);
      const { identity, url: at } = v.result;
      status(made, `created ${handle}: ${at}\nopening it`, "ok");
      // The host lists it now (its grants name your key root); its answer stands in if the list is behind.
      await loadSkeins();
      if (!skeinListed(identity)) state.skeins.push({ handle, identity, url: at });
      // A new skein serves no page (#125): it is managed from here, talking to it directly.
      location.hash = `#/s/${identity}`;
    } catch (err) { status(made, errText(err), "bad"); } finally { busy(false); }
  } },
    h("div", { class: "card-title" }, "Create a skein"),
    h("p", { class: "help" }, `A new skein on ${new URL(here).host}, owned by your key. Your wallet signs the claim.`),
    h("label", { for: "create-name", class: "label" }, "Name"),
    h("div", { class: "row" }, name, go),
    wait,
    made);
  grid.append(form);
  if (state.skeinsError) skeinsSec.append(h("p", { class: "bad" }, `Your skeins: ${state.skeinsError}`));
  else if (!state.skeins.length) skeinsSec.append(h("p", { class: "mut" }, "No skein on this host is yours yet."));
  skeinsSec.append(grid);

  await handlesSection(m);
}

/** Your handle (a certificate in your wallet) with its profile, or Register a handle on this page's host; then Find a handle. */
async function handlesSection(m) {
  const host = await hostInfo();
  if (!host) return;
  const title = h("h2", {}, "Your handle");
  const at = h("div", { class: "handles", id: "handles" }, h("p", { class: "mut" }, "Reading the handle certificates in your wallet."));
  m.append(h("section", { class: "sec" }, title, at));
  try {
    const list = await myHandles();
    if (list.length > 1) title.textContent = "Your handles";
    at.replaceChildren(...(list.length ? list.map((x) => handleCard(x)) : [h("p", { class: "mut" }, `No handle certificate from ${host.domain} in your wallet.`), registerCard(host)]));
  } catch (e) { at.replaceChildren(h("p", { class: "bad" }, `listCertificates: ${errText(e)}`)); }

  searchSection(m, host);
}

/** One of your handles: its picture, its name, the handle, its mailbox; Edit profile and Open inbox. */
function handleCard(x) {
  const id = x.handle ? `${x.handle}@${x.domain}` : x.serialNumber;
  if (!x.messagebox) {
    return h("article", { class: "card handle-card", "data-handle": id },
      identicon(state.me, 52, "avatar-lg"),
      h("div", { class: "handle-body" },
        h("span", { class: "hname" }, x.handle ? `${x.handle}@${x.domain}` : short(x.serialNumber)),
        h("span", { class: "bad small" }, x.error ?? "")));
  }
  const a = x.profile?.attested, hint = x.profile?.hints ?? {};
  const { open, panel } = profileForm(x);
  return h("article", { class: "card handle-card", "data-handle": id },
    picFor(state.me, x.profile, "avatar-lg"),
    h("div", { class: "handle-body" },
      a?.name ? h("span", { class: "pname" }, a.name)
        : !a && hint.displayName ? h("span", { class: "pname" }, hint.displayName, h("span", { class: "small wait" }, " (from the host, unattested)"))
        : "",
      h("span", { class: "hid" }, `${x.handle}@${x.domain}`),
      a ? h("span", { class: "small ok" }, "Profile signed by its key.") : "",
      h("span", { class: "small mut" }, "Mailbox ", h("a", { href: "#/inbox" }, x.messagebox), " · certificate in your wallet"),
      h("span", { class: "small mut key-line" }, "Key ", idView(state.me, { label: "identity key" })),
      h("div", { class: "actions" }, open, h("a", { class: "btn-link", href: "#/inbox" }, "Open inbox")),
      panel));
}

/** Register a handle on this page's host (shown only while your key has none from it). */
function registerCard(host) {
  const st = h("div", { class: "status", id: "register-status" });
  const name = h("input", { type: "text", name: "handle", id: "register-name", placeholder: "a name", autocomplete: "off" });
  return h("form", { class: "card dashed register-card", id: "register", onsubmit: async (e) => {
    e.preventDefault();
    const n = name.value.trim().toLowerCase();
    if (!n) return;
    try {
      status(st, `registering ${n}@${host.domain}`);
      const v = await registerHandle(n);
      status(st, `${v.handle}@${v.domain}: the certificate is in your wallet; your mailbox is ${v.messagebox}`, "ok");
      await sleep(300);
      route();
    } catch (err) { status(st, errText(err), "bad"); }
  } },
    h("div", { class: "card-title" }, "Register a handle"),
    h("p", { class: "help" }, `Your wallet signs the request to ${host.origin}. The host creates your mailbox and answers with the handle certificate, which your wallet keeps. One handle per key on a host.`),
    h("label", { for: "register-name", class: "label" }, "Name"),
    h("div", { class: "row" },
      h("span", { class: "suffixed" }, name, h("span", { class: "suffix" }, `@${host.domain}`)),
      h("button", { type: "submit", class: "go" }, "Register")),
    st);
}

const EXPLORER = ["log", "threads", "routes", "dispatch", "heads", "thread", "record", "edges"];
/** The apps a skein of the default image is born with (shruggr/skein#141): marked, never uninstalled from here. */
const IMAGE_APPS = ["chain", "git", "site"];

function skeinHeader(sk, page) {
  const id = sk.loc.identity;
  const at = (p) => `#/s/${id}${p ? `/${p}` : ""}`;
  const current = page === "app" ? "" : page;
  const tab = (p, label) => h("a", { href: at(p), ...(p === current ? { "aria-current": "page" } : {}) }, label);
  const sub = (p, label) => (p === page ? h("strong", {}, label) : h("a", { href: at(p) }, label));
  return h("div", { class: "skein-head" },
    h("a", { class: "back", href: "#/" }, "← Your skeins"),
    h("div", { class: "card-top" },
      h("div", { class: "card-id" },
        h("h1", {}, sk.loc.handle || short(id)),
        h("a", { class: "url", href: `${sk.loc.url}/` }, sk.loc.url)),
      inspectLink(id)),
    h("nav", { class: "tabs", "aria-label": "This skein" }, tab("", "Apps"), tab("peers", "Contacts"), tab("overview", "Overview")),
    EXPLORER.includes(page) ? h("nav", { class: "sublinks small", "aria-label": "Inspect" }, sub("log", "log"), sub("threads", "threads"), sub("routes", "routes"), sub("heads", "heads")) : "");
}

/** A value as the explorer gives it, its links clickable. */
function show(sk, v, depth = 0) {
  const link = (c) => h("a", { href: `#/s/${sk.loc.identity}/record/${c}`, class: "cid" }, short(c.toString(), 12));
  const asCid = CID.asCID(v);
  if (asCid) return link(asCid);
  if (v instanceof Uint8Array) {
    const t = v.length === 33 ? toHex(v) : `${toHex(v.slice(0, 48))}${v.length > 48 ? "…" : ""} (${v.length} bytes)`;
    return h("code", {}, t);
  }
  if (v === null || typeof v !== "object") return h("code", {}, JSON.stringify(v));
  const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
  if (!entries.length) return h("code", {}, Array.isArray(v) ? "[]" : "{}");
  if (depth > 6) return h("code", {}, "…");
  return h("ul", { class: "plain json" }, entries.map(([k, x]) => h("li", {}, h("span", { class: "mut" }, `${k}: `), show(sk, x, depth + 1))));
}

// ---------------------------------------------------------------- a skein's view, its apps, in plain words

/**
 * The skein's view (Skein.view) and its installed apps (each head
 * `<app>/app` whose root is an app record); on a read the skein refuses, the
 * reason shown and undefined.
 */
async function readSkein(m, sk) {
  const mismatch = () => (sk.answeredBy && sk.answeredBy !== sk.loc.identity
    ? h("p", { class: "bad" }, "This URL answers as ", idView(sk.answeredBy, { label: "identity key" }), ", not the identity the host lists for it.")
    : "");
  let view;
  try { view = await sk.view(); } catch (e) {
    m.append(h("div", { class: "card notice" }, h("p", { class: "bad" }, errText(e)), mismatch()));
    return undefined;
  }
  m.append(mismatch());
  return { view, apps: await appsIn(sk, view) };
}

/** The installed apps: each `<name>/app` head whose root is an app record. */
async function appsIn(sk, view) {
  const apps = [];
  for (const x of view.heads) if (x.name.endsWith("/app")) { const r = await sk.record(x.root); if (r?.kind === "app") apps.push({ head: x, record: r }); }
  return apps;
}

const keyText = (s) => (s instanceof Uint8Array ? toHex(s) : String(s ?? ""));

/** An address book entry's handle as name@domain, from its `handle` and `domain` (an older entry kept the whole of it in `handle`). */
const handleText = (e) => (!e.handle ? "" : e.domain && !e.handle.includes("@") ? `${e.handle}@${e.domain}` : e.handle);

/** A handle as typed (name@domain, a leading @ dropped) as the address book keeps it: `handle` and `domain` apart. */
function splitHandle(text) {
  const t = text.trim().replace(/^@/, "");
  const at = t.lastIndexOf("@");
  return at > 0 ? { handle: t.slice(0, at), domain: t.slice(at + 1) } : { handle: t };
}

/** The holders of `role` (its full name: root, <app>.<role>) in a grants record, as hex keys. */
const holdersOf = (grants, role) => (grants?.roles?.[role] ?? []).map((k) => keyText(k));

/** Whether your key holds root in the skein the view is of (#143: root passes every check). */
const isRoot = (view) => !!state.me && view.roots.includes(state.me);

/** Who a key is, in plain words: you, this skein, a provider, a contact, or the key. */
function keyWords(key, view) {
  const k = keyText(key);
  if (k === state.me) return h("span", {}, "you ", idView(k, { n: 4, label: "identity key" }));
  if (k === view.identity) return "this skein";
  const e = view.addressBook.find((x) => x.key === k);
  if (e?.transport === "local") return `the ${e.address} provider`;
  if (e?.handle) return h("span", {}, `${handleText(e)} `, idView(k, { n: 4, label: "identity key" }));
  return h("span", {}, "the key ", idView(k, { label: "identity key" }));
}

/** Where a route takes requests: a box, an event box, an http path (and below it), a libp2p topic. */
const whereWords = (r) => (r.transport === "mailbox" ? `box ${r.address}` : r.transport === "event" ? `events in box ${r.address}` : r.transport === "http" ? `${r.address}${r.prefix ? " and below" : ""}` : `${r.transport} ${r.address}`);

/** The role (the app's name for a program) a route's program is, or a short CID, or kernel. */
function roleOf(record, program) {
  if (program === "kernel") return "kernel";
  const c = CID.asCID(program);
  const role = c && Object.entries(record?.programs ?? {}).find(([, x]) => CID.asCID(x)?.equals(c))?.[0];
  return role ?? (c ? short(c.toString(), 8) : String(program));
}

/** A route's settings beyond its key, filters, program and fn (root, index, …), as text. */
function settingsText(r) {
  const core = new Set(["transport", "address", "prefix", "filters", "program", "fn", "handler", "app"]);
  return Object.entries(r).filter(([k, v]) => !core.has(k) && v !== undefined).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
}

/** What a route runs: its handler (`<role>.<fn>`), or, with none, a read route whose filters answer. */
const handlerText = (r, record) => (r.program === undefined ? "read: its filters answer, nothing logged" : `${roleOf(record, r.program)}${r.fn ? `.${r.fn}` : ""}`);

/** A route's filters in plain words: the list, or none (anyone reaches the handler). */
const filtersWords = (r) => (r.filters?.length ? `filters ${r.filters.join(", ")}` : r.transport === "mailbox" ? "the message's sender" : "no filter: anyone");

/** One route in plain words: where, through which filters, to what. */
function routeLine(r, record) {
  const set = settingsText(r);
  return h("span", { class: "row-line" },
    h("span", { class: "row-where" }, whereWords(r)),
    h("span", { class: "row-who" }, filtersWords(r)),
    h("span", { class: "row-to mut" }, `→ ${handlerText(r, record)}${set ? ` · ${set}` : ""}`));
}

const listWords = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// ---------------------------------------------------------------- the Apps tab

/** GitHub's public API (no token: 60 requests an hour per address): a repository's tags and its default branch's head. */
const github = new Map();
function githubRepo(url) {
  const x = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return x ? { owner: x[1], repo: x[2], key: `${x[1]}/${x[2]}`.toLowerCase() } : undefined;
}
async function githubVersions(g) {
  if (github.has(g.key)) return github.get(g.key);
  const api = `https://api.github.com/repos/${g.owner}/${g.repo}`;
  const get = async (path) => {
    const r = await fetch(`${api}${path}`, { headers: { accept: "application/vnd.github+json" } });
    if (r.status === 404) throw new Error(`GitHub has no public repository ${g.owner}/${g.repo}`);
    if ((r.status === 403 || r.status === 429) && r.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(r.headers.get("x-ratelimit-reset"));
      const mins = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000)) : 0;
      throw new Error(`GitHub's limit for unsigned requests from this address is used up${mins ? ` for about ${mins} min` : ""}`);
    }
    if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}`);
    return r.json();
  };
  const [info, tags] = await Promise.all([get(""), get("/tags?per_page=100")]);
  const branch = info.default_branch;
  const head = (await get(`/branches/${encodeURIComponent(branch)}`))?.commit?.sha;
  const list = (tags ?? []).filter((t) => /^[0-9a-f]{40}$/.test(t.commit?.sha ?? "")).map((t) => ({ name: t.name, sha: t.commit.sha }));
  list.sort((a, b) => (newer(a.name, b.name) ? -1 : newer(b.name, a.name) ? 1 : 0));
  const v = { branch, head, tags: list };
  github.set(g.key, v);
  return v;
}

/**
 * From a repository: its URL; for a github.com URL, its versions (tags, and
 * the default branch's latest commit) read from GitHub's API and the commit
 * shown; otherwise, or when GitHub does not answer, the commit id typed. The
 * form (#install-url, inputs url and hash) hands install() {url, hash}.
 */
function repoForm(run, hasGit) {
  const url = h("input", { type: "text", name: "url", id: "repo-url", placeholder: "https://github.com/…", autocomplete: "off", spellcheck: "false" });
  const hash = h("input", { type: "text", name: "hash", id: "repo-hash", placeholder: "40 hex digits", autocomplete: "off", spellcheck: "false" });
  const version = h("select", { id: "repo-version", name: "version" });
  const commit = h("div", { class: "small mut commit-line" });
  const note = h("div", { class: "small mut", "aria-live": "polite" });
  const hashField = h("div", { class: "field" }, h("label", { for: "repo-hash" }, "Commit id"), hash);
  const versionField = h("div", { class: "field", hidden: true }, h("label", { for: "repo-version" }, "Version"), version, commit);
  let resolved = "";
  let seq = 0;
  const showCommit = () => {
    hash.value = version.value;
    commit.replaceChildren("commit ", idView(version.value, { label: "commit id" }), " · read from GitHub");
  };
  const manual = (why) => {
    versionField.hidden = true;
    hashField.hidden = false;
    note.textContent = why ?? "";
    note.className = why ? "small wait" : "small mut";
  };
  const resolve = async () => {
    const g = githubRepo(url.value);
    if (!g) { resolved = ""; return manual(url.value.trim() ? "" : ""); }
    if (resolved === g.key) return;
    const mine = ++seq;
    resolved = g.key;
    note.className = "small mut";
    note.textContent = `Reading ${g.owner}/${g.repo}'s versions from GitHub…`;
    try {
      const v = await githubVersions(g);
      if (mine !== seq) return;
      if (!v.head && !v.tags.length) throw new Error("GitHub lists no commit for it");
      version.replaceChildren(...v.tags.map((t) => h("option", { value: t.sha }, t.name)), ...(v.head ? [h("option", { value: v.head }, `${v.branch} · latest commit`)] : []));
      versionField.hidden = false;
      hashField.hidden = true;
      note.textContent = "";
      showCommit();
    } catch (e) {
      if (mine !== seq) return;
      resolved = "";
      manual(`${errText(e)}. Type the commit id instead.`);
    }
  };
  let timer;
  url.addEventListener("input", () => {
    clearTimeout(timer);
    seq++;
    if (!githubRepo(url.value)) { resolved = ""; manual(); return; }
    timer = setTimeout(resolve, 450);
  });
  url.addEventListener("change", () => { clearTimeout(timer); resolve(); });
  version.addEventListener("change", showCommit);
  return h("form", { class: "card repo-card", id: "install-url", onsubmit: (ev) => {
    ev.preventDefault();
    run({ url: url.value.trim(), hash: hash.value.trim() });
  } },
    h("h2", { class: "card-h" }, "From a repository"),
    h("p", { class: "help" }, "Any app's git repository. For GitHub, pick a version; elsewhere, its commit id. The git app clones exactly that commit."),
    h("div", { class: "field" }, h("label", { for: "repo-url" }, "Repository"), url),
    versionField, hashField, note,
    h("div", { class: "actions" }, h("button", { type: "submit", class: "go", disabled: !hasGit }, "Review"),
      hasGit ? "" : h("span", { class: "small mut" }, "Install the git app first.")));
}

async function appsPage(m, sk) {
  const got = await readSkein(m, sk);
  if (!got) return;
  const { view, apps } = got;
  const id = sk.loc.identity;
  const hasGit = apps.some((a) => a.record.name === "git");

  // The task: the clone and the review, with its steps and its error, above everything else.
  const ui = { st: h("div", { class: "status", id: "install-status" }), wait: waiter("install-wait"), prompt: h("div", { id: "prompt" }) };
  const task = h("div", { class: "task", id: "task" }, ui.wait.el, ui.st, ui.prompt);
  const run = (e) => install(sk, e, ui);

  m.append(task);

  // Installed: one card per app (a table, its rows laid out as cards: tr[data-app]).
  const sec = h("section", { class: "sec" }, h("h2", { class: "sec-title" }, "Installed"));
  m.append(sec);
  if (!apps.length) sec.append(h("p", { class: "mut", id: "apps" }, "No apps installed yet."));
  else sec.append(h("table", { id: "apps", class: "app-cards" }, h("tbody", {}, apps.map((a) => appCard(sk, a, run)))));

  // Add an app (the catalog's, not installed) and From a repository.
  const avail = state.catalog.filter((e) => !apps.some((a) => a.record.name === e.name));
  const cat = h("div", { class: "card catalog-card" },
    h("h2", { class: "card-h" }, "Add an app"),
    avail.length
      ? h("table", { id: "catalog", class: "catalog" }, h("tbody", {}, avail.map((e) => h("tr", { "data-catalog": e.name },
        h("td", {}, h("span", { class: "cat-name" }, h("strong", {}, e.name), " ", h("span", { class: "ver" }, e.version)), h("span", { class: "cat-desc", title: e.description }, e.description)),
        h("td", { class: "cat-act" }, h("button", { type: "button", disabled: !hasGit && e.name !== "git", onclick: () => run(e) }, "Install"))))))
      : h("p", { class: "mut", id: "catalog" }, "Every app in the catalog is installed."));
  m.append(h("section", { class: "two-col" }, cat, repoForm(run, hasGit)));

  // A host skein's children: the onboarding app's records.
  const kids = view.heads.filter((x) => x.name.startsWith("onboard/instances/"));
  if (kids.length) {
    const grid = h("div", { class: "grid", id: "children" });
    m.append(h("section", { class: "sec" }, h("div", { class: "sec-head" }, h("h2", { class: "sec-title" }, "Skeins created here"), h("span", { class: "small mut" }, "by the onboard app")), grid));
    for (const k of kids) {
      const r = await sk.record(k.root);
      const kid = keyText(r?.identity);
      const have = skeinListed(kid);
      grid.append(h("article", { class: "card skein-card", "data-child": r?.handle ?? "" },
        h("div", { class: "card-id" },
          have ? h("a", { class: "card-title", href: `#/s/${kid}` }, r?.handle ?? k.name) : h("span", { class: "card-title" }, r?.handle ?? k.name),
          r?.url ? h("a", { class: "url", href: `${r.url}/` }, r.url) : ""),
        kid ? h("div", { class: "meta" }, "identity ", idView(kid, { label: "identity key" })) : "",
        h("div", { class: "actions" },
          have ? h("a", { class: "btn", href: `#/s/${kid}` }, "Open") : "")));
    }
  }
}

/** An installed app's card: name, version, description; Roles, Upgrade to the catalog's newer version, Uninstall (asks first). */
function appCard(sk, a, run) {
  const r = a.record;
  const core = IMAGE_APPS.includes(r.name);
  const cat = state.catalog.find((e) => e.name === r.name);
  const up = cat && newer(cat.version, r.version) ? cat : undefined;
  const page = `#/s/${sk.loc.identity}/app/${encodeURIComponent(r.name)}`;
  return h("tr", { class: "card app-card", "data-app": r.name },
    h("td", { class: "app-title" }, h("a", { class: "app-name", href: page }, r.name), h("span", { class: "ver" }, r.version), core ? h("span", { class: "tag" }, "from the image") : ""),
    h("td", { class: "app-desc", title: r.description ?? "" }, r.description ?? ""),
    h("td", { class: "actions" },
      h("a", { class: "btn", href: page }, "Roles"),
      up ? h("button", { type: "button", class: "go", onclick: () => run(up) }, `Upgrade to ${up.version}`) : "",
      core ? "" : confirmAction({
        label: "Uninstall",
        question: async () => {
          const p = await planUninstall(r.name, await sk.view());
          return `Uninstall ${r.name}? ${p.stop ? "It is stopped, then its" : "Its"} ${p.rows.length} ${p.rows.length === 1 ? "route is" : "routes are"} removed. Its data and its roles' grants stay.`;
        },
        yes: "Uninstall",
        run: (say) => uninstall(sk, r.name, say),
      })));
}

/**
 * Install `e` ({url, hash}, or a catalog entry): the git app's clone (or,
 * for the git app itself, the tree the image carries), then the review. `ui`: the task's wait, status (#install-status) and prompt.
 */
async function install(sk, e, ui) {
  const { st, prompt } = ui;
  const step = (t) => ui.wait.say(t);
  prompt.replaceChildren();
  status(st, "");
  ui.wait.el.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  try {
    const view = await sk.view();
    // #143: installing is root's (every message it sends goes to a kernel admin box; the git app's call is gated by root).
    if (!isRoot(view)) throw new Error("your key does not hold root in this skein: only root installs");
    const git = await appRecordIn(view, "git");
    let tree, app;
    if (!git) {
      if (!e.image) throw new Error("install the git app first");
      const main = view.heads.find((x) => x.name === "main")?.root;
      const leaf = main && await lookup(view.store, main, e.image);
      if (!leaf || leaf.mode !== "40000") throw new Error(`this skein's tree has no ${e.image}: it was not started from the default image (install the git app with skein-host install)`);
      step(`The git app's tree from this skein's image (${e.image})…`);
      tree = leaf.cid;
    } else {
      if (!/^[0-9a-fA-F]{40}$/.test(e.hash ?? "")) throw new Error("the hash is a commit id: 40 hex digits");
      step(`The git app is cloning ${e.url} at ${e.hash.slice(0, 12)}…`);
      ({ tree, app } = await sk.clone(e.url, e.hash));
    }
    step(`Reading the manifest out of tree ${short(tree.toString(), 12)}…`);
    const stored = await readStoredApp(view.store, tree);
    const plan = await planInstall(stored, view, { modules: { get: async () => undefined } });
    if (app && !plan.recordCid.equals(app)) throw new Error(`the app record rebuilt here (${plan.recordCid}) is not the git app's (${app})`);
    let want = [], wantErr = "";
    try { want = await wiring(plan.record, view); } catch (err) { wantErr = errText(err); }
    ui.wait.stop();
    prompt.append(reviewCard(sk, plan, view, e, ui, want, wantErr));
    prompt.scrollIntoView?.({ behavior: "smooth", block: "start" });
  } catch (err) { ui.wait.stop(); status(st, errText(err), "bad"); }
}

/**
 * The review: what the plan sends, read from the plan itself — the routes
 * (where requests go, through which filters, to which handler), the filters
 * and roles it declares, what it needs and offers — and describe()'s exact
 * lines (#plan). `want`: every route the record asks for (skein's `wiring`).
 * The install grants nothing (#143: you are root); an app role is granted on
 * the app's Roles page. Approve sends it (sendInstall), the wait showing each
 * step; then the page is read again.
 */
function reviewCard(sk, plan, view, e, ui, want, wantErr) {
  const rec = plan.record;
  const again = plan.upgrade !== undefined && plan.upgrade === plan.version;
  const title = plan.upgrade === undefined ? `Install ${plan.app} ${plan.version}` : again ? `Install ${plan.app} ${plan.version} again` : `Upgrade ${plan.app} ${plan.upgrade} → ${plan.version}`;
  const adding = new Set(plan.rows.filter((r) => r.op === "add").map((r) => rowKey(r.row)));
  const removing = plan.rows.filter((r) => r.op === "remove");
  const fact = (term, ...dd) => [h("dt", {}, term), h("dd", {}, ...dd)];
  const facts = [];
  if (e.url && e.hash) facts.push(...fact("From", h("span", { class: "url-text" }, e.url), " at ", idView(e.hash, { label: "commit id" })));
  else if (e.image) facts.push(...fact("From", `this skein's image (${e.image})`));
  if (want.length) {
    facts.push(...fact("Routes", h("ul", { class: "plain review-rows", id: "review-routes" }, want.map((w) => h("li", {}, routeLine(w.row, rec),
      adding.has(rowKey(w.row)) ? h("span", { class: "tag new" }, "new") : h("span", { class: "tag" }, "already set"))))));
  } else facts.push(...fact("Routes", h("span", { class: "mut" }, wantErr || "none: nothing reaches it")));
  if (removing.length) facts.push(...fact("No longer", h("ul", { class: "plain review-rows" }, removing.map((r) => h("li", {}, routeLine(r.row, rec))))));
  const filters = Object.entries(rec.filters ?? {});
  if (filters.length) facts.push(...fact("Filters", h("ul", { class: "plain review-rows", id: "review-filters" }, filters.map(([f, x]) => h("li", {}, h("span", { class: "row-where" }, `${rec.name}.${f}`), " ", h("span", { class: "mut" }, `→ ${x} · runs before anything is recorded; any route may list it`))))));
  const roles = Object.entries(rec.roles ?? {});
  if (roles.length) facts.push(...fact("Roles", h("ul", { class: "plain review-rows", id: "review-roles" }, roles.map(([r, fns]) => h("li", {}, h("span", { class: "row-where" }, roleName(rec.name, r)), " ", h("span", { class: "mut" }, `gates ${fns.join(", ")}${r === "user" ? " · any signed-in key" : r === "root" ? " · root only" : " · its holders (none until root grants it)"}`))))));
  if (plan.requires?.length) facts.push(...fact("Needs", plan.requires.join(", ")));
  if (rec.provides?.length) facts.push(...fact("Offers", h("ul", { class: "plain review-rows" }, rec.provides.map((p) => h("li", {}, h("span", { class: "row-where" }, p.interface), " ", h("span", { class: "mut" }, Object.keys(p.functions ?? {}).join(", ")))))));
  if (plan.start) facts.push(...fact("Starts", `a start message into box ${plan.app}`));
  for (const n of plan.notes ?? []) facts.push(...fact("Note", n));
  const objects = [...chunk(plan.records)].length;
  const total = objects + plan.heads.length + plan.rows.length + (plan.start ? 1 : 0);
  const parts = [objects ? `${objects} bundle${objects === 1 ? "" : "s"} of objects` : "", `${plan.heads.length} head${plan.heads.length === 1 ? "" : "s"}`, plan.rows.length ? `${plan.rows.length} row${plan.rows.length === 1 ? "" : "s"}` : "", plan.start ? "the start" : ""].filter(Boolean);
  facts.push(...fact("Sends", `${total} message${total === 1 ? "" : "s"}, each signed by your wallet: ${parts.join(", ")}`, plan.rows.length ? "" : h("span", { class: "mut" }, ". No row to add: nothing is missing.")));

  const go = h("button", { type: "button", class: "go", id: "approve" }, "Approve and install");
  const no = h("button", { type: "button", onclick: () => ui.prompt.replaceChildren() }, "Cancel");
  const w = waiter("approve-wait");
  const done = h("div", { class: "status" });
  go.onclick = async () => {
    go.disabled = no.disabled = true;
    status(done, "");
    let n = 0;
    try {
      w.say(`Sending 1 of ${total}, signed by your wallet…`);
      const r = await sendInstall(plan, async (box, body) => { w.say(`Sending ${n + 1} of ${total}, signed by your wallet…`); const id = await sk.send(box, body); n++; return id; });
      w.say(`Sent ${r.messages} messages. Waiting for this skein to show ${plan.app} ${plan.version}…`);
      await until(async () => { sk.records.clear(); const v = await sk.view(); const a = await appRecordIn(v, plan.app); return a && a.record.tree.equals(plan.record.tree); });
      route();
    } catch (err) { w.stop(); status(done, errText(err), "bad"); go.disabled = no.disabled = false; }
  };
  return h("section", { class: "card review", id: "review", "aria-label": title },
    h("h2", { class: "card-h" }, title),
    rec.description ? h("p", { class: "help review-desc", title: rec.description }, rec.description) : "",
    h("p", { class: "small mut" }, `Resolved against this skein. Approving sends these as messages from you (root). The install grants no role: you are root.`),
    h("dl", { class: "facts" }, facts),
    h("details", { class: "exact", open: true }, h("summary", {}, "The exact messages"), h("pre", { id: "plan" }, describe(plan).join("\n"))),
    h("div", { class: "actions" }, go, no),
    w.el, done);
}

/** Uninstall `name`: planned (planUninstall) when you confirm, sent (sendUninstall), then the page read again once its rows are gone. */
async function uninstall(sk, name, say) {
  say("Planning…");
  const p = await planUninstall(name, await sk.view());
  say("Sending, signed by your wallet…");
  await sendUninstall(p, async (box, body) => await sk.send(box, body));
  say(`Waiting for this skein to remove ${name}'s routes…`);
  await until(async () => { sk.records.clear(); const v = await sk.view(); return !v.dispatch.some((r) => r.app === name); });
  route();
}

async function until(f, ms = 60_000) {
  const end = Date.now() + ms;
  for (let wait = 300; ; wait = Math.min(wait * 2, 3000)) {
    if (await f()) return;
    if (Date.now() > end) throw new Error("sent; the skein has not shown the change yet");
    await sleep(wait);
  }
}

// ---------------------------------------------------------------- one app: its routes and roles

/** A role's full name (#143): root and user are themselves; an app's own is `<app>.<role>`. */
const roleName = (app, role) => (role === "root" || role === "user" ? role : `${app}.${role}`);

/**
 * A grant from root (#143): the kernel's admin operation `grant` — `{op: "add" | "remove", role,
 * principal}` in box `grant`, a message from you as every admin message is — then the head
 * `grants` read until it shows the change.
 */
async function sendGrant(sk, op, role, key, say) {
  say("Sending, signed by your wallet…");
  await sk.send("grant", { op, role, principal: fromHex(key) });
  say("Waiting for this skein's grants to show it…");
  await until(async () => { sk.records.clear(); const v = await sk.view(); return holdersOf(v.grants, role).includes(key) === (op === "add"); });
  route();
}

async function appPage(m, sk, name) {
  const got = await readSkein(m, sk);
  if (!got) return;
  const { view, apps } = got;
  const id = sk.loc.identity;
  m.append(h("a", { class: "back", href: `#/s/${id}` }, "← Apps"));
  const a = apps.find((x) => x.record.name === name);
  if (!a) return m.append(h("p", { class: "bad" }, `No app named ${name} is installed here.`));
  const r = a.record;
  const mine = isRoot(view);

  const fact = (term, ...dd) => [h("dt", {}, term), h("dd", {}, ...dd)];
  const facts = [
    ...fact("App record", idView(String(a.head.root), { label: "record CID" }), " ", h("a", { class: "small", href: `#/s/${id}/record/${a.head.root}` }, "inspect")),
    ...(r.tree ? fact("Tree", idView(String(r.tree), { label: "tree CID" })) : []),
    ...Object.entries(r.programs ?? {}).flatMap(([role, c]) => fact(`Program ${role}`, idView(String(c), { label: "program CID" }))),
    ...(r.requires?.length ? fact("Needs", r.requires.join(", ")) : []),
    ...(r.provides?.length ? fact("Offers", h("ul", { class: "plain review-rows" }, r.provides.map((p) => h("li", {}, h("span", { class: "row-where" }, p.interface), " ", h("span", { class: "mut" }, Object.keys(p.functions ?? {}).join(", ")))))) : []),
    ...(Object.keys(r.filters ?? {}).length ? fact("Filters", h("ul", { class: "plain review-rows" }, Object.entries(r.filters).map(([f, x]) => h("li", {}, h("span", { class: "row-where" }, `${name}.${f}`), " ", h("span", { class: "mut" }, `→ ${x}`))))) : []),
  ];
  m.append(h("section", { class: "card app-detail" },
    h("div", { class: "app-title" }, h("h2", { class: "card-h app-name" }, r.name), h("span", { class: "ver" }, r.version), IMAGE_APPS.includes(r.name) ? h("span", { class: "tag" }, "from the image") : ""),
    r.description ? h("p", { class: "help" }, r.description) : "",
    h("dl", { class: "facts" }, facts)));

  m.append(rolesCard(sk, view, r, mine));

  // Its routes: the table's (with `app` this app), and the ones its manifest asks for that are missing.
  let want = [], wantErr = "";
  try { want = await wiring(r, view); } catch (e) { wantErr = errText(e); }
  const asked = new Set(want.map((w) => rowKey(w.row)));
  const rows = view.dispatch.filter((x) => x.app === name);
  const have = new Set(rows.map((x) => rowKey(x)));
  const missing = want.filter((w) => !have.has(rowKey(w.row)));
  const list = h("ul", { class: "plain perm-list", id: "app-routes" });
  for (const row of rows) list.append(h("li", { class: "perm", "data-route": rowKey(row) }, routeLine(row, r), asked.has(rowKey(row)) ? "" : h("span", { class: "tag" }, "not in its manifest")));
  for (const w of missing) list.append(h("li", { class: "perm missing", "data-route": rowKey(w.row) }, routeLine(w.row, r), h("span", { class: "tag new" }, "missing: install it again")));
  if (!rows.length && !missing.length) list.append(h("li", { class: "mut" }, "No routes: nothing reaches it."));
  m.append(h("section", { class: "card" },
    h("h2", { class: "card-h" }, "Routes"),
    h("p", { class: "help" }, `Where requests reach ${name}: each route's filters run first (kernel.brc104 checks the signed session and names who it is from); then, if a role gates the handler's function, the key must hold it. A route with no handler is a read: its filter answers and nothing is logged. Installing ${name} again or upgrading it sets its routes back to what its manifest asks for.`),
    wantErr ? h("p", { class: "small wait" }, `Its manifest's routes: ${wantErr}`) : "",
    list));
}

/**
 * The app's roles (#143): root and user, then the app's own (`<app>.<role>`), each with the
 * functions it gates (the app record's `roles`) and its holders (the head `grants`). Root grants
 * and revokes root and the app's roles; `user` is any signed-in key and is never granted.
 */
function rolesCard(sk, view, record, mine) {
  const name = record.name;
  const declared = record.roles ?? {};
  const gates = (role) => declared[role] ?? [];
  const own = Object.keys(declared).filter((x) => x !== "root" && x !== "user");
  const list = h("ul", { class: "plain role-list", id: "app-roles" });
  const holderList = (full) => {
    const keys = holdersOf(view.grants, full);
    const ul = h("ul", { class: "plain role-holders" });
    for (const k of keys) {
      const last = full === "root" && keys.length === 1;
      ul.append(h("li", { class: "role-holder", "data-holder": k }, identicon(k, 20), keyWords(k, view),
        mine && !last ? confirmAction({
          label: "Revoke",
          question: h("span", {}, `Revoke ${full} from `, keyWords(k, view), "?", full === "root" && k === state.me ? " You will no longer manage this skein." : ""),
          yes: "Revoke",
          run: (say) => sendGrant(sk, "remove", full, k, say),
        }) : last ? h("span", { class: "small mut" }, "the only root holder") : ""));
    }
    if (!keys.length) ul.append(h("li", { class: "mut small" }, "No one holds it."));
    return ul;
  };
  const roleItem = (full, title, what, grantable) => h("li", { class: "role", "data-role": full },
    h("div", { class: "role-top" }, h("strong", { class: "role-name" }, title), h("span", { class: "small mut" }, what)),
    grantable ? holderList(full) : "",
    grantable && mine ? grantForm(sk, view, full) : "");
  const fnText = (fns) => (fns.length ? `gates ${fns.join(", ")}` : "");
  list.append(roleItem("root", "root", ["passes every check: any function, any route, any grant", fnText(gates("root"))].filter(Boolean).join(" · "), true));
  list.append(roleItem("user", "user", ["any signed-in key (a principal an identity filter named); never granted", fnText(gates("user")) || `gates none of ${name}'s functions`].join(" · "), false));
  for (const r of own) list.append(roleItem(roleName(name, r), roleName(name, r), fnText(gates(r)) || "gates no function", true));
  return h("section", { class: "card roles" },
    h("h2", { class: "card-h" }, "Roles"),
    h("p", { class: "help" }, mine
      ? `Who may run ${name}'s gated functions. You hold root: you grant and revoke. A function no role lists is open to whatever its route's filters let through.`
      : `Who may run ${name}'s gated functions. Only root grants and revokes; your key does not hold root here.`),
    list);
}

/** Grant `role` to a key: yours, a contact's, or one typed; reviewed in place, then the grant message. */
function grantForm(sk, view, role) {
  const slug = role.replace(/[^a-z0-9]+/gi, "-");
  const pick = h("select", { name: "who", id: `grant-who-${slug}`, "aria-label": `Grant ${role} to` },
    h("option", { value: "" }, "Grant to…"),
    ...view.addressBook.filter((e) => e.transport !== "local" && isKey(e.key)).map((e) => h("option", { value: e.key }, handleText(e) || short(e.key))),
    h("option", { value: "key" }, "a key…"));
  const key = h("input", { type: "text", name: "key", placeholder: "identity key (66 hex)", autocomplete: "off", spellcheck: "false", hidden: true, "aria-label": "Identity key" });
  const st = h("span", { class: "status small" });
  const review = h("div", { class: "grant-review" });
  pick.onchange = () => { key.hidden = pick.value !== "key"; review.replaceChildren(); status(st, ""); };
  const go = h("button", { type: "submit" }, "Review");
  return h("form", { class: "row grant-form", "data-grant": role, onsubmit: (ev) => {
    ev.preventDefault();
    status(st, "");
    review.replaceChildren();
    const k = (pick.value === "key" ? key.value : pick.value).trim().toLowerCase();
    if (!isKey(k)) return status(st, "the key is 33 bytes in hex (66 digits, 02 or 03 first)", "bad");
    if (holdersOf(view.grants, role).includes(k)) return status(st, `that key holds ${role} already`, "bad");
    const w = waiter();
    const yes = h("button", { type: "button", class: "go" }, `Grant ${role}`);
    const no = h("button", { type: "button", onclick: () => review.replaceChildren() }, "Cancel");
    const done = h("div", { class: "status" });
    yes.onclick = async () => {
      yes.disabled = no.disabled = true;
      try { await sendGrant(sk, "add", role, k, w.say); } catch (e) { w.stop(); status(done, errText(e), "bad"); yes.disabled = no.disabled = false; }
    };
    review.append(h("div", { class: "confirm-card" },
      h("p", {}, `Grant ${role} to `, keyWords(k, view), "? Signed by you.", role === "root" ? " Root passes every check: they could manage this skein as you do." : ""),
      h("pre", {}, `grant ${JSON.stringify({ op: "add", role, principal: k })}`),
      h("div", { class: "actions" }, yes, no), w.el, done));
  } }, pick, key, go, st, review);
}

// ---------------------------------------------------------------- the Overview tab

async function overviewPage(m, sk) {
  const got = await readSkein(m, sk);
  if (!got) return;
  const { view, apps } = got;
  const id = sk.loc.identity;
  const mine = isRoot(view);

  // The handle whose mailbox this skein is, if one of yours (state.handles).
  let handle;
  try { if (await hostInfo()) handle = (await myHandles()).find((x) => x.messagebox && x.messagebox.replace(/\/+$/, "") === sk.url); } catch { /* not shown */ }
  const people = view.addressBook.filter((e) => e.transport !== "local");
  const kids = view.heads.filter((x) => x.name.startsWith("onboard/instances/"));
  const tile = (label, value, sub, extra = {}) => h("div", { class: "card tile", ...extra }, h("span", { class: "tile-label" }, label), h("span", { class: "tile-value" }, value), sub ? h("span", { class: "tile-sub" }, sub) : "");
  m.append(h("section", { class: "tiles", id: "tiles" },
    tile("Root", mine ? (view.roots.length > 1 ? `you and ${view.roots.length - 1} more` : "you") : view.roots.length ? idView(view.roots[0], { n: 4, label: "root's key" }) : "not claimed", mine ? "your key holds root" : view.roots.length ? `${view.roots.length === 1 ? "another key" : `${view.roots.length} keys`}` : "its first claim is root", { "data-tile": "root" }),
    handle ? tile("Handle", `${handle.handle}@${handle.domain}`, "its mailbox runs here", { "data-tile": "handle" }) : "",
    tile("Apps", String(apps.length), h("a", { href: `#/s/${id}` }, "Manage apps"), { "data-tile": "apps" }),
    tile("Contacts", String(people.length), h("a", { href: `#/s/${id}/peers` }, "Address book"), { "data-tile": "contacts" }),
    kids.length ? tile("Skeins created here", String(kids.length), h("a", { href: `#/s/${id}` }, "Open the list"), { "data-tile": "children" }) : ""));

  const fact = (term, ...dd) => [h("dt", {}, term), h("dd", {}, ...dd)];
  m.append(h("section", { class: "card identity" },
    h("h2", { class: "card-h" }, "Identity"),
    h("dl", { class: "facts" },
      ...fact("Identity key", idView(view.identity || id, { label: "identity key" })),
      ...fact("URL", h("a", { class: "url", href: `${sk.url}/` }, sk.url)),
      ...(view.roots.length ? fact("Root", h("ul", { class: "plain" }, view.roots.map((k) => h("li", {}, keyWords(k, view))))) : []),
      ...fact("Heads", h("a", { href: `#/s/${id}/heads` }, `${view.heads.length} heads`)),
      ...fact("Routes", h("a", { href: `#/s/${id}/routes` }, `${view.dispatch.length} routes`)))));
}

async function headsPage(m, sk) {
  const view = await sk.view();
  m.append(h("h2", {}, "Heads"), h("table", { id: "heads" }, h("tbody", {}, view.heads.map((x) => h("tr", {}, h("td", {}, x.name), h("td", {}, show(sk, x.root)))))));
}

// ---------------------------------------------------------------- the Contacts tab (the address book)

/** A `peers` message from you (the kernel's address book), then the book read until it shows the change. */
async function sendPeers(sk, body, key, say) {
  say("Sending, signed by your wallet…");
  await sk.send("peers", body);
  say("Waiting for this skein's address book to show it…");
  try {
    await until(async () => { sk.records.clear(); const v = await sk.view(); return v.addressBook.some((e) => e.key === key) === (body.op === "add"); }, 20_000);
  } catch { /* shown as it is when the page is read again */ }
  route();
}

async function contactsPage(m, sk) {
  const got = await readSkein(m, sk);
  if (!got) return;
  const { view } = got;

  // Add a contact by handle: resolved at its domain (BRC-169 §5.2), the found card, then Add.
  const handle = h("input", { type: "text", name: "handle", id: "contact-handle", placeholder: "name@domain", autocomplete: "off", spellcheck: "false", "aria-label": "Their handle" });
  const find = h("button", { type: "submit", class: "go" }, "Find");
  const st = h("div", { class: "status", id: "contact-status" });
  const w = waiter();
  const found = h("div", { id: "contact-found" });
  const findForm = h("form", { class: "row find-row", id: "contact-find", onsubmit: async (ev) => {
    ev.preventDefault();
    const x = /^@?([^@\s]+)@([^@\s]+)$/.exec(handle.value.trim());
    found.replaceChildren();
    status(st, "");
    if (!x) return status(st, "A handle is a name and a domain: name@domain.", "bad");
    const [, name, domain] = x;
    find.disabled = true;
    w.say(`Asking ${domain}…`);
    try {
      const host = await hostInfo();
      const mf = await manifestOf(domain, host);
      if (!mf.resolve) throw new Error(`${domain} publishes no handle resolver`);
      const a = await resolveHandle({ resolve: mf.resolve, handle: name });
      if (!isKey(a.identityKey ?? "")) throw new Error(`${name}@${domain}: the answer carries no identity key`);
      const prof = await profileIn(a, domain);
      found.append(foundCard(sk, view, { name, domain, key: a.identityKey, messagebox: a.messagebox, prof }));
    } catch (e) { status(st, errText(e), "bad"); }
    w.stop();
    find.disabled = false;
  } }, handle, find);
  m.append(h("section", { class: "card find-contact" },
    h("h2", { class: "card-h" }, "Add a contact"),
    h("p", { class: "help" }, "Their handle: the page resolves it at its domain to a key and a mailbox."),
    findForm, w.el, st, found,
    manualAdd(sk)));

  // The list: people (mailbox, libp2p), then the host's services (local) out of the way.
  const people = view.addressBook.filter((e) => e.transport !== "local");
  const services = view.addressBook.filter((e) => e.transport === "local");
  const rowOf = (e) => {
    const who = handleText(e);
    const src = { genesis: "from its genesis", admin: "added by root", claim: "from the claim" }[e.source] ?? e.source ?? "";
    return h("li", { class: "contact", "data-peer": e.key },
      identicon(e.key, 40, "avatar-md"),
      h("span", { class: "contact-body" },
        who ? h("span", { class: "contact-name" }, who) : h("span", { class: "contact-name mut" }, "No handle"),
        h("span", { class: "contact-meta" }, idView(e.key, { label: "identity key" })),
        h("span", { class: "contact-meta mono" }, `${e.transport} · ${e.address}`, src ? h("span", { class: "mut" }, ` · ${src}`) : "")),
      confirmAction({ label: "Remove", question: `Remove ${who || short(e.key)} from this skein's contacts?`, yes: "Remove", run: (say) => sendPeers(sk, { op: "remove", key: fromHex(e.key) }, e.key, say) }));
  };
  m.append(h("section", { class: "card contacts" },
    h("div", { class: "contacts-head" }, h("h2", { class: "card-h" }, "Contacts"), h("p", { class: "small mut" }, "Who this skein can reach, and how. Only root's messages change the list.")),
    people.length ? h("ul", { class: "plain contact-list", id: "peers" }, people.map(rowOf)) : h("p", { class: "mut contacts-empty", id: "peers" }, "No contacts yet. Add one by handle above."),
    services.length ? h("details", { class: "services" }, h("summary", {}, `The host's services (${services.length})`), h("ul", { class: "plain contact-list" }, services.map(rowOf))) : ""));
}

/** A handle found: its picture, name, key and mailbox; Add sends the same peers message as the form below. */
function foundCard(sk, view, f) {
  const a = f.prof.attested, hint = f.prof.hints;
  const full = `${f.name}@${f.domain}`;
  const have = view.addressBook.find((e) => e.key === f.key);
  const st = h("div", { class: "status small" });
  const w = waiter();
  const add = h("button", { type: "button", class: "go", disabled: !f.messagebox || !!have }, have ? "In your contacts" : "Add");
  add.onclick = async () => {
    add.disabled = true;
    // docs/MESSAGES.md, the address book: {op: "add", key, transport, address, handle?, domain?}: the name and its domain apart.
    const row = { op: "add", key: f.key, transport: "mailbox", address: f.messagebox, handle: f.name, domain: f.domain };
    try { await sendPeers(sk, { ...row, key: fromHex(row.key) }, f.key, w.say); } catch (e) { w.stop(); status(st, errText(e), "bad"); add.disabled = false; }
  };
  return h("div", { class: "found", "data-found": full },
    picFor(f.key, f.prof, "avatar-lg"),
    h("div", { class: "found-body" },
      h("span", { class: "contact-name" }, a?.name ?? hint.displayName ?? full),
      a?.name || hint.displayName ? h("span", { class: "hid" }, full) : "",
      h("span", { class: "contact-meta" }, idView(f.key, { label: "identity key" })),
      h("span", { class: "contact-meta mono" }, f.messagebox ? `mailbox · ${f.messagebox}` : "no mailbox in the answer"),
      a ? h("span", { class: "small ok" }, "Profile signed by its key.") : !a && (hint.displayName || hint.avatarURL) ? h("span", { class: "small wait" }, "Name from the host, unattested.") : "",
      w.el, st),
    add);
}

/** Add by identity key and mailbox URL (and a handle): reviewed in place, then the peers message. */
function manualAdd(sk) {
  const key = h("input", { type: "text", name: "key", placeholder: "identity key (hex)", "aria-label": "Identity key", autocomplete: "off", spellcheck: "false" });
  const url = h("input", { type: "text", name: "address", placeholder: "its mailbox URL", "aria-label": "Mailbox URL", autocomplete: "off", spellcheck: "false" });
  const handle = h("input", { type: "text", name: "handle", placeholder: "name@domain (optional)", "aria-label": "Handle (optional)", autocomplete: "off", spellcheck: "false" });
  const st = h("div", { class: "status" });
  const review = h("div", {});
  const go = h("button", { type: "button" }, "Review");
  go.onclick = () => {
    status(st, "");
    review.replaceChildren();
    const named = handle.value.trim() ? splitHandle(handle.value) : {};
    const row = { op: "add", key: key.value.trim(), transport: "mailbox", address: url.value.trim(), ...named };
    if (!isKey(row.key)) return status(st, "the key is 33 bytes in hex", "bad");
    if (!row.address) return status(st, "the mailbox URL is needed", "bad");
    if (handle.value.trim() && (!named.handle || named.domain === "")) return status(st, "a handle is name@domain", "bad");
    const w = waiter();
    const yes = h("button", { type: "button", class: "go" }, "Send");
    const no = h("button", { type: "button", onclick: () => review.replaceChildren() }, "Cancel");
    const done = h("div", { class: "status" });
    yes.onclick = async () => {
      yes.disabled = no.disabled = true;
      try { await sendPeers(sk, { ...row, key: fromHex(row.key) }, row.key, w.say); } catch (e) { w.stop(); status(done, errText(e), "bad"); yes.disabled = no.disabled = false; }
    };
    review.append(h("div", { class: "confirm-card" }, h("p", {}, "Send this to the skein's address book, signed by you?"), h("pre", {}, `peers ${JSON.stringify(row)}`), h("div", { class: "actions" }, yes, no), w.el, done));
  };
  return h("details", { class: "manual" }, h("summary", {}, "Add by identity key and mailbox URL instead"),
    h("div", { class: "row manual-row", id: "add-peer" }, key, url, handle, go), st, review);
}

async function logPage(m, sk, params) {
  const before = params.get("before");
  const r = await sk.read(`/log?limit=50${before ? `&before=${before}` : ""}`);
  const rows = (r?.entries ?? []).map((x) => {
    const e = x.record ?? {};
    const what = e.genesis ? "genesis" : e.request ? `request (${e.transport})` : e.mail ? "message" : e.event ? `event → ${e.box}` : "entry";
    const link = e.genesis ?? e.request ?? e.mail ?? e.event;
    return h("tr", {}, h("td", {}, String(x.n)), h("td", { class: "small mut" }, when(e.time)), h("td", {}, h("a", { href: `#/s/${sk.loc.identity}/record/${x.entry}` }, what)), h("td", {}, link ? show(sk, link) : ""));
  });
  const last = r?.entries?.at(-1)?.n;
  m.append(h("h2", {}, "The log, newest first"), h("table", { id: "log" }, h("tbody", {}, rows)),
    last > 0 ? h("p", {}, h("a", { href: `#/s/${sk.loc.identity}/log?before=${last}` }, "Older")) : "");
}

async function threadsPage(m, sk) {
  const r = await sk.read("/threads?limit=100");
  m.append(h("h2", {}, "Threads, newest first"), h("table", { id: "threads" }, h("tbody", {}, (r?.threads ?? []).map((t) =>
    h("tr", {}, h("td", { class: "small mut" }, when([Math.floor(t.at / 1000), (t.at % 1000) * 1e6])), h("td", {}, h("a", { href: `#/s/${sk.loc.identity}/thread/${t.origin}` }, short(t.origin.toString(), 14))))))));
}

async function threadPage(m, sk, origin) {
  const t = await sk.read(`/thread/${origin}`);
  if (!t) return m.append(h("p", { class: "bad" }, "not a thread here"));
  m.append(h("h2", {}, "Thread ", h("span", { class: "cid" }, origin)), h("h2", {}, "Origin"), show(sk, await sk.record(origin)), h("h2", {}, "Updates"));
  for (const u of t.updates ?? []) {
    const r = u.record ?? {};
    const out = r.result?.stdout instanceof Uint8Array ? new TextDecoder().decode(r.result.stdout) : undefined;
    m.append(h("div", { class: "card" }, h("div", { class: "small mut" }, `${u.seq} · `, h("span", { class: r.state === "errored" ? "bad" : r.state === "finished" ? "ok" : "wait" }, r.state ?? ""), ` · fuel ${r.fuel ?? ""} · `, show(sk, u.update)),
      out !== undefined && /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(out) ? h("pre", {}, out) : show(sk, r)));
  }
}

async function recordPage(m, sk, cidText, path) {
  const cid = CID.parse(cidText);
  const v = await sk.record(cid);
  m.append(h("h2", {}, "Record ", h("span", { class: "cid" }, cidText)), h("p", {}, h("a", { href: `#/s/${sk.loc.identity}/edges/${cidText}` }, "what points here")));
  if (v === undefined) return m.append(h("p", { class: "bad" }, "not in this skein's store"));
  if (v instanceof Uint8Array && cid.code === GIT_RAW) {
    const nul = v.indexOf(0);
    const head = new TextDecoder().decode(v.subarray(0, nul));
    if (head.startsWith("tree ")) {
      m.append(h("p", { class: "mut" }, `git tree${path ? ` ${path}` : ""}`), h("ul", { class: "plain", id: "tree" }, parseTree(v, cid).map((e) =>
        h("li", {}, h("a", { href: `#/s/${sk.loc.identity}/record/${e.cid}?path=${encodeURIComponent(path ? `${path}/${e.name}` : e.name)}` }, e.name + (e.mode === "40000" ? "/" : "")), h("span", { class: "mut small" }, ` ${e.mode}`)))));
      return;
    }
    const body = v.subarray(nul + 1);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(body.subarray(0, 200_000));
    m.append(h("p", { class: "mut" }, `git ${head}${path ? ` · ${path}` : ""}`), /\x00/.test(text) ? h("p", { class: "mut" }, "binary") : h("pre", {}, text));
    return;
  }
  m.append(show(sk, v));
}

async function edgesPage(m, sk, cidText) {
  const r = await sk.read(`/edges/${cidText}`);
  m.append(h("h2", {}, "What points at ", h("span", { class: "cid" }, cidText)), (r?.edges ?? []).length
    ? h("table", { id: "edges" }, h("tbody", {}, r.edges.map((e) => h("tr", {}, h("td", {}, e.rel), h("td", {}, show(sk, e.from)), h("td", { class: "mut small" }, `seq ${e.seq}${e.locator !== null && e.locator !== undefined ? ` · ${e.locator}` : ""}`)))))
    : h("p", { class: "mut" }, "Nothing."));
}

/** The route table (#143): transport, address, filters, handler, and whose route it is. */
async function routesPage(m, sk) {
  const view = await sk.view();
  const apps = await appsIn(sk, view);
  const recordOf = (app) => apps.find((x) => x.record.name === app)?.record;
  const handlerCell = (r) => {
    if (r.program === undefined) return h("span", { class: "mut" }, "read: its filters answer");
    if (r.program === "kernel") return `kernel ${r.fn ?? ""}`;
    const rec = r.app && recordOf(r.app);
    return rec ? `${roleOf(rec, r.program)}${r.fn ? `.${r.fn}` : ""}` : [show(sk, r.program), r.fn ? ` .${r.fn}` : ""];
  };
  m.append(h("h2", {}, "Routes"),
    h("p", { class: "small mut" }, "An http request takes the route at its exact path, else the longest prefix; a message the route at its box. Its filters run in order before anything is recorded."),
    h("table", { id: "routes" },
      h("thead", {}, h("tr", {}, ["Transport", "Address", "Filters", "Handler", "Whose"].map((x) => h("th", {}, x)))),
      h("tbody", {}, view.dispatch.map((r) =>
        h("tr", { "data-route": rowKey(r) }, h("td", {}, r.transport), h("td", {}, `${r.address}${r.prefix ? "*" : ""}`),
          h("td", { class: "small" }, r.filters?.length ? r.filters.join(", ") : h("span", { class: "mut" }, "none")),
          h("td", {}, handlerCell(r)), h("td", { class: "mut small" }, r.app ?? "root's or the genesis's"))))));
}

// ---------------------------------------------------------------- the Inbox

/**
 * A mailbox's box, for your key: what is waiting (listed by
 * @bsv/message-box-client on a BRC-104 session signed by your wallet), and
 * Sync (@1sat/actions' syncMetanetInbox with the same wallet: each BRC-169
 * envelope in metanet_inbox opened, its payment internalized, then
 * acknowledged; the box is the SDK's, not the field). The mailbox is any BRC-33
 * messagebox — a mailbox instance, or another — not the skein that served
 * this page. The URL: the one typed here last (kept in this browser), else
 * the messagebox your first handle resolves to (myHandles).
 */
const INBOX_BOX = "metanet_inbox";
const inboxKey = () => `skein-site inbox ${state.me}`;
function inboxSaved() {
  try { return JSON.parse(localStorage.getItem(inboxKey()) ?? "{}"); } catch { return {}; }
}
function inboxSave(v) {
  try { localStorage.setItem(inboxKey(), JSON.stringify(v)); } catch { /* not kept: typed again next time */ }
}

/** One line for a listed body: a BRC-169 envelope, a paymail payment, or the body itself. */
function inboxWhat(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (body.metanetHandles !== undefined) {
      const p = body.payment;
      return `BRC-169 envelope${body.created ? ` of ${body.created}` : ""}: ${p && typeof p === "object" ? `a payment of ${p.satoshis} sats` : "no payment"}`;
    }
    if (typeof body.beef === "string" && body.satoshis !== undefined) return `a payment of ${body.satoshis} sats${body.alias ? ` to ${body.alias}` : ""}`;
  }
  const t = typeof body === "string" ? body : JSON.stringify(body);
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}

async function inboxPage(m) {
  const saved = inboxSaved();
  let from = "";
  if (!saved.url) {
    const first = (await myHandles().catch(() => [])).find((x) => x.messagebox);
    if (first) { saved.url = first.messagebox; from = `${first.handle}@${first.domain}`; }
  }
  const url = h("input", { type: "text", name: "url", placeholder: "your mailbox's URL (https://…)", value: saved.url ?? "" });
  const box = h("input", { type: "text", name: "box", placeholder: "box (List)", value: saved.box ?? INBOX_BOX });
  const st = h("div", { class: "status", id: "inbox-status" });
  const result = h("div", { class: "status", id: "sync-result" });
  const rows = h("div", { id: "sync-rows" });
  const list = h("div", { id: "inbox-list" });
  const sync = h("button", { type: "button", class: "go", id: "sync" }, "Sync");
  const where = () => ({ url: url.value.trim().replace(/\/+$/, ""), box: box.value.trim() || INBOX_BOX });
  // Kept in this browser: what you typed; not the URL your handle resolves to (that is looked up each time).
  const keep = (w) => { if (!(from && w.url === url.defaultValue)) inboxSave(w); };

  async function show() {
    const w = where();
    if (!w.url) return status(st, "Type your mailbox's URL, or register a handle (Your skeins): the page finds your mailbox from it.");
    keep(w);
    status(st, `listing ${w.box} at ${w.url}`);
    list.replaceChildren();
    try {
      const client = new MessageBoxClient({ walletClient: state.wallet, host: w.url });
      const msgs = await client.listMessagesLite({ messageBox: w.box, host: w.url });
      status(st, `${msgs.length} waiting in ${w.box} at ${w.url}`);
      if (!msgs.length) return list.append(h("p", { class: "mut", id: "inbox-messages" }, "Nothing waiting."));
      list.append(h("table", { id: "inbox-messages" },
        h("thead", {}, h("tr", {}, h("th", {}, "message"), h("th", {}, "from"), h("th", {}, "at"), h("th", {}, "what"))),
        h("tbody", {}, msgs.map((x) => {
          const text = typeof x.body === "string" ? x.body : JSON.stringify(x.body, null, 1);
          return h("tr", { "data-message": x.messageId },
            h("td", { class: "cid", title: x.messageId }, short(String(x.messageId), 12)),
            h("td", { class: "key", title: x.sender }, short(String(x.sender ?? ""))),
            h("td", { class: "small mut" }, String(x.createdAt ?? "").replace("T", " ").slice(0, 19)),
            h("td", {}, inboxWhat(x.body), h("details", {}, h("summary", { class: "small mut" }, "body"), h("pre", {}, text.length > 4000 ? `${text.slice(0, 4000)}…` : text))));
        }))));
    } catch (e) { status(st, errText(e), "bad"); }
  }

  sync.onclick = async () => {
    const w = where();
    if (!w.url) return status(st, "Type your mailbox's URL first.", "bad");
    keep(w);
    sync.disabled = true;
    status(result, `syncing ${INBOX_BOX} from ${w.url} into your wallet`);
    rows.replaceChildren();
    try {
      const r = await syncMetanetInbox.execute(createContext(state.wallet), { messageboxUrl: w.url });
      status(result, `received ${r.received.length}, skipped ${r.skipped.length}${r.error ? `; error: ${r.error}` : ""}`, r.error || r.skipped.length ? "bad" : "ok");
      if (r.received.length) rows.append(h("h2", {}, "Received"), h("table", { id: "sync-received" },
        h("thead", {}, h("tr", {}, h("th", {}, "txid"), h("th", {}, "sats"), h("th", {}, "memo"), h("th", {}, "from"))),
        h("tbody", {}, r.received.map((x) => h("tr", { "data-message": x.messageId },
          h("td", { class: "cid", title: x.txid }, short(x.txid, 12)),
          h("td", {}, x.satoshis === undefined ? "" : String(x.satoshis)),
          h("td", {}, x.memo ?? (x.tokenIds.length ? `tokens: ${x.tokenIds.join(", ")}` : "")),
          h("td", { class: "key", title: x.sender }, short(x.sender)))))));
      if (r.skipped.length) rows.append(h("h2", {}, "Left in the box"), h("table", { id: "sync-skipped" },
        h("thead", {}, h("tr", {}, h("th", {}, "message"), h("th", {}, "why"))),
        h("tbody", {}, r.skipped.map((x) => h("tr", { "data-message": x.messageId },
          h("td", { class: "cid", title: x.messageId }, short(String(x.messageId), 12)),
          h("td", {}, x.reason))))));
    } catch (e) { status(result, `sync: ${errText(e)}`, "bad"); }
    sync.disabled = false;
    await show();
  };

  m.append(h("h1", {}, "Inbox"),
    h("p", { class: "mut small" }, "A mailbox's box, for your key: List shows what is waiting in the box named here. Sync always reads metanet_inbox, whatever the box field says: it opens each BRC-169 envelope there, takes its payment into your wallet (@1sat/actions' syncMetanetInbox, with the wallet connected here) and acknowledges it. Received: internalized and acknowledged. Left in the box: not acknowledged, with the reason."),
    h("form", { class: "row", id: "inbox", onsubmit: (ev) => { ev.preventDefault(); show(); } }, url, box, h("button", { type: "submit" }, "List"), sync),
    from ? h("p", { class: "mut small", id: "inbox-from" }, `The mailbox ${from} resolves to.`) : "",
    st, result, rows, list);
  if (where().url) await show();
  else status(st, "Type your mailbox's URL, or register a handle (Your skeins): the page finds your mailbox from it.");
}

// ---------------------------------------------------------------- start

async function start() {
  try { state.catalog = (await (await fetch("catalog.json")).json()).apps ?? []; } catch { state.catalog = []; }
  $("nav-how").onclick = (e) => { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); };
  $("connect").onclick = async () => { try { await useWallet(); route(); } catch (e) { connectFailed(e); } };
  window.addEventListener("hashchange", () => route());
  // The silent probe on load: no wallet is the normal case, so the header keeps only Connect.
  try { await useWallet(); } catch (e) { console.debug("wallet probe on load:", errText(e)); }
  await route();
  window.siteReady = true;
}

start().catch((e) => { window.siteFailed = errText(e); main().replaceChildren(h("p", { class: "bad" }, errText(e))); });
