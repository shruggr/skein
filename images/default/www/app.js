// The management site (shruggr/skein#92). The same files on every skein
// (the default image serves them at / and /site/); what makes the page yours
// is the wallet in the browser. Everything it shows of a skein it reads from
// that skein, on a BRC-104 session signed by your wallet; everything it
// changes there is a message from you to that skein. The skein that served
// the page is never in the path for another skein's data.
//
//   #/                       your skeins (locators in your wallet), add one, create one here
//   #/s/<identity>           a skein: its apps, install, uninstall, children (a host skein's)
//   #/s/<identity>/peers     its address book
//   #/s/<identity>/log, /threads, /thread/<cid>, /record/<cid>, /edges/<cid>, /dispatch
//                            the explorer: the skein's own reads (/explore, its owner's)
//
// Query string (tests): ?key=<hex> runs a wallet in the tab over that key
// (createWebWallet, webwallet.js) instead of connecting one; &services=<url>
// points that wallet at a 1sat services endpoint.

import { appRecordIn, CID, connectWallet, dagJson, describe, dispatchOrigin, fold, LockingScript, lookup, parseTree, planInstall, planUninstall, PushDrop, RawBox, readStoredApp, rowKey, sendInstall, sendUninstall, senderText, Utils, WalletClient } from "./lib.js";

const q = new URLSearchParams(location.search);
/** The skein that served this page: its base URL (the page is its `/`). */
const here = new URL(".", location.href).href.replace(/\/+$/, "");
/** Locator tokens: PushDrop outputs in this basket, fields [identity (33 bytes), url, handle]. */
const BASKET = "skein-locators";
const PROTOCOL = [1, "skein locator"];
const KEY_ID = "1";
const GIT_RAW = 0x78;

const state = { wallet: undefined, me: "", locators: [], catalog: [], boxes: new Map() };
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
const errText = (e) => (e instanceof Error ? e.message : String(e));

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
  $("who").textContent = `you: ${short(state.me)}`;
  $("who").title = state.me;
  $("connect").hidden = true;
  await loadLocators();
}

// ---------------------------------------------------------------- locators

async function loadLocators() {
  const r = await state.wallet.listOutputs({ basket: BASKET, include: "locking scripts", limit: 1000 });
  state.locators = [];
  for (const o of r.outputs) {
    try {
      const { fields } = PushDrop.decode(LockingScript.fromHex(o.lockingScript));
      const [identity, url, handle] = fields;
      state.locators.push({ identity: Utils.toHex(identity), url: Utils.toUTF8(url), handle: Utils.toUTF8(handle), outpoint: o.outpoint });
    } catch { /* an output of the basket that is not a locator: not shown */ }
  }
  return state.locators;
}

async function addLocator({ identity, url, handle }) {
  if (!isKey(identity)) throw new Error("not an identity key (33 bytes, hex)");
  const script = await new PushDrop(state.wallet).lock([Utils.toArray(identity, "hex"), Utils.toArray(url, "utf8"), Utils.toArray(handle, "utf8")], PROTOCOL, KEY_ID, "self", true);
  await state.wallet.createAction({
    description: "skein locator",
    outputs: [{ lockingScript: script.toHex(), satoshis: 1, basket: BASKET, outputDescription: `skein locator ${handle}`.slice(0, 50), tags: ["skein-locator"] }],
    // Broadcast now: a locator the network has not taken is not one yet.
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  });
  await loadLocators();
}

async function removeLocator(l) {
  await state.wallet.relinquishOutput({ basket: BASKET, output: l.outpoint });
  await loadLocators();
}

const locatorOf = (identity) => state.locators.find((l) => l.identity === identity);

// ---------------------------------------------------------------- a skein, read and written directly

function boxFor(url) {
  const u = url.replace(/\/+$/, "");
  let b = state.boxes.get(u);
  if (!b) { b = new RawBox(state.wallet, u); state.boxes.set(u, b); }
  return b;
}

class ReadError extends Error {
  constructor(status, text) { super(status === 403 ? "your key may not read this skein: its explorer is its owner's" : `HTTP ${status} ${text}`); this.status = status; }
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
   * programs, owner), the claim, the address book, the dispatch table, and
   * the store by CID.
   */
  async view() {
    const top = await this.read("");
    const heads = Object.entries(top.heads ?? {}).map(([name, root]) => ({ name, root }));
    const head = (name) => heads.find((x) => x.name === name)?.root;
    const first = (await this.read("/log?before=1&limit=1"))?.entries?.[0]?.record;
    const genesis = first?.genesis ? await this.record(first.genesis) : {};
    const claim = head("claim") ? await this.record(head("claim")) : undefined;
    const keyHex = (k) => (k instanceof Uint8Array ? toHex(k) : typeof k === "string" ? k : "");
    const book = [];
    if (head("peers")) {
      for (const e of (await this.record(head("peers")))?.peers ?? []) {
        const p = await this.record(e.peer);
        book.push({ key: keyHex(p.key ?? e.key), transport: p.transport ?? "mailbox", address: p.address ?? "", ...(p.role ? { role: p.role } : {}), ...(p.handle ? { handle: p.handle } : {}), ...(p.domain ? { domain: p.domain } : {}), ...(p.source ? { source: p.source } : {}) });
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
      owner: genesis.owner !== undefined ? keyHex(genesis.owner) : keyHex(claim?.owner),
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
  const loc = locatorOf(identity);
  if (!loc) return undefined;
  let s = skeins.get(loc.url);
  if (!s) { s = new Skein(loc); skeins.set(loc.url, s); }
  return s;
}

/** The identity a skein's answers are signed by: one signed request (a read the skein may refuse; the signature is what counts). */
async function identityAt(url) {
  const s = new Skein({ url, identity: "", handle: "" });
  await s.fetch("/explore");
  if (!s.answeredBy) throw new Error(`${url}: no signed answer (is it a skein?)`);
  return s.answeredBy;
}

// ---------------------------------------------------------------- pages

const main = () => $("main");

async function route() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  const m = main();
  m.replaceChildren();
  if (!state.wallet) {
    m.append(h("h1", {}, "skein"), h("p", {}, "Connect a BRC-100 wallet to see your skeins, create one here, and manage them. Your locators (which skeins you keep, and where) are outputs in your wallet."));
    return;
  }
  try {
    if (parts[0] !== "s") return await home(m);
    const sk = skeinOf(parts[1]);
    if (!sk) {
      m.append(h("h1", {}, short(parts[1] ?? "")), h("p", { class: "bad" }, "No locator in your wallet names this skein."), h("p", {}, h("a", { href: "#/" }, "Your skeins")));
      return;
    }
    m.append(skeinHeader(sk, parts[2] ?? ""));
    const page = parts[2] ?? "";
    if (page === "") await overview(m, sk);
    else if (page === "peers") await peersPage(m, sk);
    else if (page === "log") await logPage(m, sk, params);
    else if (page === "threads") await threadsPage(m, sk);
    else if (page === "thread") await threadPage(m, sk, parts[3]);
    else if (page === "record") await recordPage(m, sk, parts[3], params.get("path") ?? "");
    else if (page === "edges") await edgesPage(m, sk, parts[3]);
    else if (page === "dispatch") await dispatchPage(m, sk);
    else m.append(h("p", { class: "bad" }, `no page ${page}`));
  } catch (e) {
    m.append(h("p", { class: "bad", id: "error" }, errText(e)));
  }
}

async function home(m) {
  m.append(h("h1", {}, "Your skeins"));
  const list = h("tbody");
  for (const l of state.locators) {
    const st = h("span", { class: "mut small" });
    list.append(h("tr", { "data-locator": l.identity },
      h("td", {}, h("a", { href: `#/s/${l.identity}` }, l.handle || short(l.identity))),
      h("td", {}, h("a", { href: `${l.url}/` }, l.url)),
      h("td", { class: "key", title: l.identity }, short(l.identity)),
      h("td", {}, h("button", { type: "button", onclick: async () => { status(st, "removing"); try { await removeLocator(l); route(); } catch (e) { status(st, errText(e), "bad"); } } }, "Remove"), st)));
  }
  m.append(state.locators.length
    ? h("table", { id: "locators" }, h("thead", {}, h("tr", {}, h("th", {}, "skein"), h("th", {}, "where"), h("th", {}, "identity"), h("th", {}))), list)
    : h("p", { class: "mut", id: "locators" }, "No locators in your wallet yet."));

  // Add a locator (a bookmark: what it resolves to is what your key may do there).
  const add = h("div", { class: "status" });
  const url = h("input", { type: "text", name: "url", placeholder: "the skein's URL", value: here });
  const handle = h("input", { type: "text", name: "handle", placeholder: "a name for it" });
  m.append(h("h2", {}, "Add a locator"),
    h("p", { class: "mut small" }, "A locator is an output in your wallet (basket skein-locators) naming a skein's identity and where it answers. Anyone may keep one for any skein."),
    h("form", { class: "row", id: "add-locator", onsubmit: async (e) => {
      e.preventDefault();
      try {
        status(add, "asking the skein for its identity");
        const u = url.value.trim().replace(/\/+$/, "");
        const identity = await identityAt(u);
        status(add, `writing the locator (${short(identity)}) into your wallet`);
        await addLocator({ identity, url: u, handle: handle.value.trim() || new URL(u).hostname.split(".")[0] });
        route();
      } catch (err) { status(add, errText(err), "bad"); }
    } }, url, handle, h("button", { type: "submit" }, "Add")), add);

  // Create a skein (on a host skein: the onboarding app's route on the skein that served this page).
  const made = h("div", { class: "status", id: "create-status" });
  const name = h("input", { type: "text", name: "handle", placeholder: "handle (a hostname label)" });
  m.append(h("h2", {}, "Create a skein here"),
    h("p", { class: "mut small" }, `Asks ${here} for a new skein owned by your key. It works where the onboarding app is installed (a host skein).`),
    h("form", { class: "row", id: "create", onsubmit: async (e) => {
      e.preventDefault();
      const handle = name.value.trim();
      if (!handle) return;
      try {
        status(made, `asking ${here} to create ${handle}`);
        const r = await boxFor(here).af.fetch(`${here}/onboard/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "onboard.create", args: { handle } }) });
        const text = await r.text();
        let v = {};
        try { v = JSON.parse(text); } catch { /* shown as text */ }
        if (r.status === 404) throw new Error("this skein does not create skeins (no onboarding app here)");
        if (r.status !== 200 || !v.result) throw new Error(v.error?.message ?? `HTTP ${r.status} ${text.slice(0, 200)}`);
        const { identity, url: at } = v.result;
        status(made, `created ${handle}: ${at}\nwriting its locator into your wallet`, "ok");
        await addLocator({ identity, url: at, handle });
        status(made, `created ${handle}: ${at}\nlocator written; opening it`, "ok");
        location.href = `${at}/${location.search}#/s/${identity}`;
      } catch (err) { status(made, errText(err), "bad"); }
    } }, name, h("button", { type: "submit", class: "go" }, "Create")), made);
}

function skeinHeader(sk, page) {
  const tab = (p, label) => (p === page ? h("strong", {}, label) : h("a", { href: `#/s/${sk.loc.identity}${p ? `/${p}` : ""}` }, label));
  return h("div", {},
    h("h1", {}, sk.loc.handle || short(sk.loc.identity), " ", h("span", { class: "mut small" }, sk.loc.url)),
    h("div", { class: "key mut small", title: sk.loc.identity }, sk.loc.identity),
    h("nav", { class: "tabs" }, tab("", "apps"), tab("peers", "address book"), tab("log", "log"), tab("threads", "threads"), tab("dispatch", "dispatch table")));
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

async function overview(m, sk) {
  const note = h("div", { class: "status" });
  m.append(note);
  let view;
  try { view = await sk.view(); } catch (e) {
    status(note, errText(e), "bad");
    if (sk.answeredBy && sk.answeredBy !== sk.loc.identity) m.append(h("p", { class: "bad" }, `This URL answers as ${sk.answeredBy}, not the locator's identity.`));
    return;
  }
  if (sk.answeredBy && sk.answeredBy !== sk.loc.identity) m.append(h("p", { class: "bad" }, `This URL answers as ${sk.answeredBy}, not the locator's identity.`));
  m.append(h("p", { class: "small mut", title: view.owner }, view.owner ? `owner ${short(view.owner)}${view.owner === state.me ? " (you)" : ""}` : "not claimed"));

  // Apps installed: each head <app>/app whose root is an app record.
  const apps = [];
  for (const x of view.heads) if (x.name.endsWith("/app")) { const r = await sk.record(x.root); if (r?.kind === "app") apps.push({ head: x, record: r }); }
  m.append(h("h2", {}, "Apps installed"));
  const body = h("tbody");
  for (const a of apps) {
    const st = h("span", { class: "status" });
    body.append(h("tr", { "data-app": a.record.name },
      h("td", {}, h("a", { href: `#/s/${sk.loc.identity}/record/${a.head.root}` }, a.record.name)),
      h("td", {}, a.record.version), h("td", { class: "small" }, a.record.description ?? ""),
      h("td", {}, h("button", { type: "button", onclick: () => uninstall(m, sk, a.record.name, st) }, "Uninstall"), st)));
  }
  m.append(apps.length ? h("table", { id: "apps" }, body) : h("p", { class: "mut", id: "apps" }, "No apps installed: the front door, the messagebox and the static app are the image's."));

  // Install.
  const prompt = h("div", { id: "prompt" });
  const st = h("div", { class: "status", id: "install-status" });
  const hasGit = apps.some((a) => a.record.name === "git");
  m.append(h("h2", {}, "Install"),
    h("p", { class: "mut small" }, hasGit
      ? "Each app is a repository and a commit id. The git app clones that commit into this skein; you review what the app asks for, then approve."
      : "The git app comes first: it clones the other apps into this skein by hash. A skein from the default image carries its tree."));
  const cat = h("tbody");
  for (const e of state.catalog) {
    const installed = apps.find((a) => a.record.name === e.name);
    cat.append(h("tr", { "data-catalog": e.name },
      h("td", {}, e.name), h("td", {}, e.version), h("td", { class: "small" }, e.description, h("br"), h("span", { class: "mut" }, `${e.url} @ ${e.hash.slice(0, 12)}`)),
      h("td", {}, h("button", { type: "button", disabled: !hasGit && e.name !== "git", onclick: () => install(m, sk, e, prompt, st) }, installed ? "Reinstall" : "Install"))));
  }
  m.append(h("table", { id: "catalog" }, cat));
  const url = h("input", { type: "text", name: "url", placeholder: "https://… a git repository" });
  const hash = h("input", { type: "text", name: "hash", placeholder: "commit id (40 hex)" });
  m.append(h("form", { class: "row", id: "install-url", onsubmit: (ev) => { ev.preventDefault(); install(m, sk, { url: url.value.trim(), hash: hash.value.trim() }, prompt, st); } },
    url, hash, h("button", { type: "submit", disabled: !hasGit }, "Clone and review")), st, prompt);

  // A host skein's children: the onboarding app's records.
  const kids = view.heads.filter((x) => x.name.startsWith("onboard/instances/"));
  if (kids.length) {
    m.append(h("h2", {}, "Skeins created here"));
    const kb = h("tbody");
    for (const k of kids) {
      const r = await sk.record(k.root);
      const id = r?.identity instanceof Uint8Array ? toHex(r.identity) : String(r?.identity ?? "");
      const ks = h("span", { class: "status" });
      const have = locatorOf(id);
      kb.append(h("tr", { "data-child": r?.handle ?? "" }, h("td", {}, r?.handle ?? k.name), h("td", {}, r?.url ?? ""), h("td", { class: "key", title: id }, short(id)),
        h("td", {}, have ? h("a", { href: `#/s/${id}` }, "Open") : h("button", { type: "button", onclick: async () => { status(ks, "writing"); try { await addLocator({ identity: id, url: r.url, handle: r.handle }); route(); } catch (e) { status(ks, errText(e), "bad"); } } }, "Add locator"), ks)));
    }
    m.append(h("table", { id: "children" }, kb));
  }

  m.append(h("h2", {}, "Heads"));
  m.append(h("table", { id: "heads" }, h("tbody", {}, view.heads.map((x) => h("tr", {}, h("td", {}, x.name), h("td", {}, show(sk, x.root)))))));
}

/** Install `e` ({url, hash} or a catalog entry): the git app's clone (or, for the git app itself, the tree the image carries), then the prompt. */
async function install(m, sk, e, prompt, st) {
  prompt.replaceChildren();
  try {
    const view = await sk.view();
    const git = await appRecordIn(view, "git");
    let tree, app;
    if (!git) {
      if (!e.image) throw new Error("install the git app first");
      const main = view.heads.find((x) => x.name === "main")?.root;
      const leaf = main && await lookup(view.store, main, e.image);
      if (!leaf || leaf.mode !== "40000") throw new Error(`this skein's tree has no ${e.image}: it was not started from the default image (install the git app with skein-host install)`);
      status(st, `the git app's tree from this skein's image (${e.image})`);
      tree = leaf.cid;
    } else {
      if (!/^[0-9a-fA-F]{40}$/.test(e.hash ?? "")) throw new Error("the hash is a commit id: 40 hex digits");
      status(st, `the git app is cloning ${e.url} at ${e.hash.slice(0, 12)} (a message to its box; the answer read from its thread)`);
      ({ tree, app } = await sk.clone(e.url, e.hash));
    }
    status(st, `reading the manifest out of tree ${short(tree.toString(), 12)}`);
    const stored = await readStoredApp(view.store, tree);
    const plan = await planInstall(stored, view, { modules: { get: async () => undefined } });
    if (app && !plan.recordCid.equals(app)) throw new Error(`the app record rebuilt here (${plan.recordCid}) is not the git app's (${app})`);
    status(st, "");
    const go = h("button", { type: "button", class: "go", id: "approve" }, "Approve and send");
    const no = h("button", { type: "button", onclick: () => prompt.replaceChildren() }, "Cancel");
    const done = h("div", { class: "status" });
    go.onclick = async () => {
      go.disabled = no.disabled = true;
      try {
        status(done, "sending, signed by your wallet");
        const r = await sendInstall(plan, async (box, body) => await sk.send(box, body));
        status(done, `sent ${r.messages} messages; waiting for ${plan.app}/app`);
        await until(async () => { sk.records.clear(); const v = await sk.view(); const a = await appRecordIn(v, plan.app); return a && a.record.tree.equals(plan.record.tree); });
        route();
      } catch (err) { status(done, errText(err), "bad"); go.disabled = no.disabled = false; }
    };
    prompt.append(h("div", { class: "card" },
      h("strong", {}, `${plan.upgrade ? "Upgrade" : "Install"} ${plan.app} ${plan.version}`),
      h("p", { class: "small mut" }, "What the app asks for, resolved against this skein. Approving sends these as messages from you: the objects the skein lacks, the head, each dispatch row, the start."),
      h("pre", { id: "plan" }, describe(plan).join("\n")), h("div", { class: "row" }, go, " ", no), done));
  } catch (err) { status(st, errText(err), "bad"); }
}

async function uninstall(m, sk, name, st) {
  try {
    const view = await sk.view();
    const p = await planUninstall(name, view);
    const lines = [`uninstall ${name}: ${p.stop ? "stop, then " : ""}remove ${p.rows.length} rows (its heads are left)`, ...p.rows.map((r) => `  dispatch remove ${rowKey(r.row)}`)];
    if (!confirm(lines.join("\n"))) return;
    status(st, "sending");
    await sendUninstall(p, async (box, body) => await sk.send(box, body));
    await until(async () => { sk.records.clear(); const v = await sk.view(); return !v.dispatch.some((r) => r.app === name); });
    route();
  } catch (e) { status(st, errText(e), "bad"); }
}

async function until(f, ms = 60_000) {
  const end = Date.now() + ms;
  for (let wait = 300; ; wait = Math.min(wait * 2, 3000)) {
    if (await f()) return;
    if (Date.now() > end) throw new Error("sent; the skein has not shown the change yet");
    await sleep(wait);
  }
}

async function peersPage(m, sk) {
  const view = await sk.view();
  const st = h("div", { class: "status" });
  const body = h("tbody");
  for (const e of view.addressBook) {
    body.append(h("tr", { "data-peer": e.key }, h("td", { class: "key", title: e.key }, short(e.key)), h("td", {}, e.role ?? ""), h("td", {}, e.transport), h("td", {}, e.address), h("td", {}, e.handle ?? ""), h("td", { class: "mut small" }, e.source ?? ""),
      h("td", {}, h("button", { type: "button", onclick: async () => {
        if (!confirm(`Remove ${e.key} from the address book? (a peers message from you)`)) return;
        try { await sk.send("peers", { op: "remove", key: fromHex(e.key) }); await sleep(500); sk.records.clear(); route(); } catch (err) { status(st, errText(err), "bad"); }
      } }, "Remove"))));
  }
  m.append(h("h2", {}, "Address book"), h("p", { class: "mut small" }, "Who this skein can reach, and how. Only its owner's peers messages change it."),
    view.addressBook.length ? h("table", { id: "peers" }, body) : h("p", { class: "mut" }, "Empty."));
  const key = h("input", { type: "text", name: "key", placeholder: "identity key (hex)" });
  const url = h("input", { type: "text", name: "address", placeholder: "its mailbox URL" });
  const handle = h("input", { type: "text", name: "handle", placeholder: "handle (optional)" });
  const show = h("pre", { hidden: true });
  m.append(h("h2", {}, "Add an entry"), h("form", { class: "row", onsubmit: async (ev) => {
    ev.preventDefault();
    const row = { op: "add", key: key.value.trim(), transport: "mailbox", address: url.value.trim(), ...(handle.value.trim() ? { handle: handle.value.trim() } : {}) };
    if (!isKey(row.key)) return status(st, "the key is 33 bytes in hex", "bad");
    show.hidden = false;
    show.textContent = `peers ${JSON.stringify(row)}`;
    if (!confirm(`Send this to the skein's address book, signed by you?\n${show.textContent}`)) return;
    try { await sk.send("peers", { ...row, key: fromHex(row.key) }); await sleep(500); sk.records.clear(); route(); } catch (err) { status(st, errText(err), "bad"); }
  } }, key, url, handle, h("button", { type: "submit" }, "Review and send")), show, st);
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

async function dispatchPage(m, sk) {
  const view = await sk.view();
  m.append(h("h2", {}, "The dispatch table, in order (first match wins)"), h("table", { id: "dispatch" }, h("tbody", {}, view.dispatch.map((r) =>
    h("tr", {}, h("td", {}, r.transport), h("td", {}, `${r.address}${r.prefix ? "*" : ""}`), h("td", { class: "key" }, short(senderText(r.sender))),
      h("td", {}, r.program === "kernel" ? `kernel ${r.fn ?? ""}` : [show(sk, r.program), r.fn ? ` .${r.fn}` : ""]), h("td", { class: "mut small" }, r.app ?? "genesis"))))));
}

// ---------------------------------------------------------------- start

async function start() {
  try { state.catalog = (await (await fetch("site/catalog.json")).json()).apps ?? []; } catch { state.catalog = []; }
  $("connect").onclick = async () => { try { await useWallet(); route(); } catch (e) { $("who").textContent = errText(e); } };
  window.addEventListener("hashchange", () => route());
  try { await useWallet(); } catch (e) { $("who").textContent = `no wallet connected (${errText(e)})`; }
  await route();
  window.siteReady = true;
}

start().catch((e) => { window.siteFailed = errText(e); main().replaceChildren(h("p", { class: "bad" }, errText(e))); });
