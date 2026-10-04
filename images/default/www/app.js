// The management site (shruggr/skein#92). The same files on every skein
// (the default image serves them at / and /site/); what makes the page yours
// is the wallet in the browser. Everything it shows of a skein it reads from
// that skein, on a BRC-104 session signed by your wallet; everything it
// changes there is a message from you to that skein. The skein that served
// the page is never in the path for another skein's data.
//
//   #/                       your skeins (locators in your wallet), add one, create one here; your
//                            handles (certificates in your wallet), register one on this page's host,
//                            each one's profile (#104: name and avatar, signed by your wallet); find a
//                            handle on this page's host (BRC-169 search)
//   #/s/<identity>           a skein: its apps, install, uninstall, children (a host skein's)
//   #/s/<identity>/peers     its address book
//   #/s/<identity>/log, /threads, /thread/<cid>, /record/<cid>, /edges/<cid>, /dispatch
//                            the explorer: the skein's own reads (/explore, its owner's)
//   #/inbox                  the Inbox: a mailbox's box listed (@bsv/message-box-client), and its
//                            metanet_inbox synced into your wallet (@1sat/actions' syncMetanetInbox);
//                            the mailbox your first handle resolves to, unless you typed another
//
// Query string (tests): ?key=<hex> runs a wallet in the tab over that key
// (createWebWallet, webwallet.js) instead of connecting one; &services=<url>
// points that wallet at a 1sat services endpoint.

import { appRecordIn, Certificate, CID, connectWallet, createContext, dagJson, decodeProfile, describe, dispatchOrigin, encodeBlock, encodeProfile, fold, formatOrdinalOutpoint, Hash, LockingScript, lookup, MasterCertificate, MessageBoxClient, outpointFromBytes, outpointToBytes, parseTree, planInstall, planUninstall, ProtoWallet, PushDrop, RawBox, readStoredApp, rowKey, sendInstall, sendUninstall, senderText, syncMetanetInbox, Utils, WalletClient } from "./lib.js";

const q = new URLSearchParams(location.search);
/** The skein that served this page: its base URL (the page is its `/`). */
const here = new URL(".", location.href).href.replace(/\/+$/, "");
/** Locator tokens: PushDrop outputs in this basket, fields [identity (33 bytes), url, handle]. */
const BASKET = "skein-locators";
const PROTOCOL = [1, "skein locator"];
const KEY_ID = "1";
const GIT_RAW = 0x78;
/** BRC-169 §4.5: the handle-certificate type. */
const HANDLE_TYPE = Utils.toBase64(Hash.sha256(Utils.toArray("metanet-handles handle certificate v1", "utf8")));
/** A registration's signature (the host's POST /account/register): protocol, key ID the name, over `register <name>`. */
const REGISTER = [2, "skein register"];
/**
 * A handle's profile (#104): the OpNS profile record (@1sat/utils
 * encodeProfile: DAG-CBOR {domain, name?, avatar?}, the avatar an image
 * inscription's 36-byte outpoint), signed by the holder's wallet under this
 * protocol, key ID "1", counterparty anyone, over those bytes — anyone with
 * the identity key verifies it. Kept in your mailbox instance under the head
 * `profile`: a record {profile: <the bytes>, signature}.
 */
const PROFILE = [1, "metanet handles profile"];
const PROFILE_KEY_ID = "1";
const PROFILE_HEAD = "profile";

const state = { wallet: undefined, me: "", locators: [], catalog: [], boxes: new Map(), host: undefined, handles: undefined };
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
function identicon(key, size = 28) {
  const d = Hash.sha256(Utils.toArray(key, "hex"));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 5 5", width: size, height: size, class: "avatar", "aria-hidden": "true" })) svg.setAttribute(k, String(v));
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
function handleView(key, handle, domain, prof = { hints: {} }) {
  const a = prof.attested, hint = prof.hints;
  let pic;
  if (a?.avatar && hint.avatarURL?.endsWith(`/${a.avatar}`)) pic = h("img", { class: "avatar", src: hint.avatarURL, alt: "", width: 28, height: 28, title: `avatar ${a.avatar}` });
  else if (!a && hint.avatarURL) pic = h("img", { class: "avatar", src: hint.avatarURL, alt: "", width: 28, height: 28, title: "avatar: from the host, unattested" });
  else pic = identicon(key);
  return h("span", { class: "handle" }, pic,
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
  return (state.handles = out);
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
 * when given), signed by your wallet, and written to your mailbox instance
 * as its owner — `objects` with the record {profile, signature}, then `head`
 * `profile` → it. Then the handle is resolved until the host serves it.
 */
async function setProfile(row, name, avatar) {
  let av;
  if (avatar) {
    av = outpointToBytes(formatOrdinalOutpoint(avatar));
    if (!av) throw new Error(`the avatar is not an outpoint (txid_vout or txid.vout): ${avatar}`);
  }
  const bytes = encodeProfile({ domain: row.domain, ...(name ? { name } : {}), ...(av ? { avatar: av } : {}) });
  const { signature } = await state.wallet.createSignature({ protocolID: PROFILE, keyID: PROFILE_KEY_ID, counterparty: "anyone", data: bytes });
  const rec = encodeBlock({ profile: Uint8Array.from(bytes), signature: Uint8Array.from(signature) });
  const identity = await identityAt(row.messagebox);
  const box = boxFor(row.messagebox);
  await box.send(identity, "objects", { records: [{ cid: rec.cid, bytes: rec.bytes }] });
  await box.send(identity, "head", { name: PROFILE_HEAD, tree: rec.cid });
  const want = Utils.toBase64(bytes);
  for (let wait = 250; wait < 8000; wait *= 2) {
    const a = await resolveHandle(row);
    if (a.profile?.record === want) return a;
    await sleep(wait);
  }
  throw new Error("sent to your mailbox; the host does not serve it yet (look again in a moment)");
}

/** The Profile form of one of your handles: the current profile, and Save (setProfile). */
function profileForm(x) {
  const a = x.profile?.attested;
  const name = h("input", { type: "text", name: "name", placeholder: "a name (optional)", value: a?.name ?? "" });
  const avatar = h("input", { type: "text", name: "avatar", placeholder: "avatar: an image inscription's outpoint, txid_vout (optional)", value: a?.avatar ?? "" });
  const st = h("div", { class: "status profile-status" });
  const now = a
    ? `Now: ${a.name ? `name ${a.name}` : "no name"}, ${a.avatar ? `avatar ${a.avatar}` : "no avatar"} (signed by your key, verified here).`
    : "No profile yet.";
  return h("details", { class: "profile" }, h("summary", { class: "small" }, "Profile"),
    h("p", { class: "mut small" }, `${now} Your wallet signs the name and the avatar (an image inscription, by outpoint); your mailbox keeps them, and ${x.domain} serves them with ${x.handle}@${x.domain} when it is resolved or found.`),
    h("form", { class: "row profile-form", onsubmit: async (e) => {
      e.preventDefault();
      try {
        status(st, "signing and sending to your mailbox");
        await setProfile(x, name.value.trim(), avatar.value.trim());
        status(st, "saved: the host serves it", "ok");
        state.handles = undefined;
        await sleep(300);
        route();
      } catch (err) { status(st, errText(err), "bad"); }
    } }, name, avatar, h("button", { type: "submit", class: "go" }, "Save")), st);
}

/**
 * Find a handle on this page's host (BRC-169 §5.6): one query per explicit
 * search (nothing is sent as you type; the button waits for the answer),
 * to the search endpoint the host's manifest names. The results are hints:
 * no certificate comes with them.
 */
function searchSection(m, host) {
  if (!host.search) return;
  const q = h("input", { type: "text", name: "q", placeholder: "a handle or a name" });
  const go = h("button", { type: "submit" }, "Search");
  const st = h("div", { class: "status", id: "search-status" });
  const out = h("div", { id: "search-results" });
  const where = `${host.name ? `${host.name}, ` : ""}${host.domain}`;
  m.append(h("h2", {}, "Find a handle"),
    h("p", { class: "mut small" }, `Asks ${host.search} (${where}) only, when you press Search. Results are hints from the host: resolve a handle before you rely on it. A profile signed by its handle's key is marked; anything else the host adds is unattested.`),
    h("form", { class: "row", id: "search", onsubmit: async (e) => {
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
            h("td", { class: "key", title: x.identityKey }, short(String(x.identityKey))))));
          out.append(h("table", {}, h("tbody", {}, rows)));
        }
      } catch (err) { status(st, errText(err), "bad"); }
      go.disabled = false;
    } }, q, go), st, out);
}

/**
 * Register `name` on this page's host for your key: the host's
 * POST /account/register with your signature over `register <name>`; it
 * creates your mailbox instance and answers with the handle certificate,
 * which your wallet keeps (`acquireCertificate`, direct) unless it holds it.
 */
async function registerHandle(name) {
  const host = await hostInfo();
  if (!host) throw new Error("this page's skein is not on a skein host");
  const { signature } = await state.wallet.createSignature({ protocolID: REGISTER, keyID: name, counterparty: "anyone", data: Utils.toArray(`register ${name}`, "utf8") });
  const r = await fetch(`${host.origin}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, identityKey: state.me, signature: toHex(signature) }) });
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
  if (!state.wallet) {
    m.append(h("h1", {}, "skein"), h("p", {}, "Connect a BRC-100 wallet to see your skeins, create one here, and manage them. Your locators (which skeins you keep, and where) are outputs in your wallet."));
    return;
  }
  try {
    if (parts[0] === "inbox") return await inboxPage(m);
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

  await handlesSection(m);

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

/** Your handles (certificates in your wallet), and Register a handle on this page's host. */
async function handlesSection(m) {
  const host = await hostInfo();
  if (!host) return;
  m.append(h("h2", {}, "Your handles"));
  const at = h("div", { id: "handles" }, h("p", { class: "mut" }, "Reading the handle certificates in your wallet."));
  m.append(at);
  try {
    const list = await myHandles();
    at.replaceChildren(list.length
      ? h("table", {}, h("tbody", {}, list.map((x) => h("tr", { "data-handle": x.handle ? `${x.handle}@${x.domain}` : x.serialNumber },
        h("td", {}, x.handle ? handleView(state.me, x.handle, x.domain, x.profile) : short(x.serialNumber)),
        h("td", {}, x.messagebox ? [h("a", { href: "#/inbox" }, x.messagebox), profileForm(x)] : h("span", { class: "bad" }, x.error ?? ""))))))
      : h("p", { class: "mut" }, `No handle certificate from ${host.domain} in your wallet.`));
  } catch (e) { at.replaceChildren(h("p", { class: "bad" }, `listCertificates: ${errText(e)}`)); }

  const st = h("div", { class: "status", id: "register-status" });
  const name = h("input", { type: "text", name: "handle", placeholder: "a name (a host name label)" });
  m.append(h("h2", {}, "Register a handle"),
    h("p", { class: "mut small" }, `Asks ${host.origin} for <name>@${host.domain} for your key, signed by your wallet: the host creates your mailbox there and answers with the handle certificate, which your wallet keeps. One handle per key on a host.`),
    h("form", { class: "row", id: "register", onsubmit: async (e) => {
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
    } }, name, h("span", { class: "mut" }, `@${host.domain}`), h("button", { type: "submit", class: "go" }, "Register")), st);

  searchSection(m, host);
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
  try { state.catalog = (await (await fetch("site/catalog.json")).json()).apps ?? []; } catch { state.catalog = []; }
  $("connect").onclick = async () => { try { await useWallet(); route(); } catch (e) { $("who").textContent = errText(e); } };
  window.addEventListener("hashchange", () => route());
  try { await useWallet(); } catch (e) { $("who").textContent = `no wallet connected (${errText(e)})`; }
  await route();
  window.siteReady = true;
}

start().catch((e) => { window.siteFailed = errText(e); main().replaceChildren(h("p", { class: "bad" }, errText(e))); });
