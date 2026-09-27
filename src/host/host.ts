// One instance from a management-database row (instances.ts): the kernel
// configuration main.ts runs, in its own process — `skein-host run`
// (supervisor.ts) starts one main.ts per row (#23, "a process per instance").
// The instance gets its own store, runtime (scheduler), wallet, messagebox
// session and delivery provider, and tick; it shares nothing with the others
// but the host wallet, which signs every log entry for all of them (#9: the
// host's identity is the genesis's `host`), the messagebox, and host.db, which
// its resolver reads. Tests start several in one process over memory stores.
// A new instance's genesis is main.ts's plus an open `chat` subscription:
// anyone may open a conversation with it (#24, item 3). That list is only the
// seed of its subscriptions chain (#3, runtime/subscriptions.ts); later
// changes are `subscribe` messages from the owner (`skein-host subscribe`),
// never a new genesis. Replies to what it sent
// are matched before subscriptions — another agent's reply arrives in `chat`
// with `replyTo`, and resumes the thread that awaits it instead of opening a
// new one — so agent↔agent needs nothing more than the resolver: a handle →
// the identity key its `message` is sealed to (hostResolver: the rows, then
// BRC-169, then paymail).

import { Certificate, type WalletInterface } from "@bsv/sdk";
import { rootIdentity, type KeyWallet } from "../runtime/identity.ts";
import { defaultSubscriptions, genesisOf, OPEN_CHAT, short, type InstanceConfig } from "../runtime/log.ts";
import { isIdentity, type Identity } from "../runtime/records.ts";
import { Runtime, type Resolution } from "../runtime/scheduler.ts";
import type { Store } from "../runtime/store.ts";
import type { Stamp } from "../runtime/syscalls.ts";
import { ensureGenesis } from "./entry.ts";
import type { InstanceRow } from "./instances.ts";
import { Delivery, type MessageBox, type RetryPolicy } from "./messagebox.ts";
import { Tick } from "./tick.ts";

type Named = { handle: string; domain: string };

export interface HostOptions {
  /** The host wallet: signs every entry of every instance. */
  host: KeyWallet;
  /** A new instance's owner (its genesis `owner`); needed only to write a genesis. */
  owner?: Identity;
  /** The inference peer (a new genesis's `peers.infer`). */
  infer?: Identity;
  /** A new genesis's names for the owner and the peer (what outbound envelopes call them). Default david@localhost, infer@localhost. */
  ownerHandle?: Named;
  inferHandle?: Named;
  /** The row's instance wallet. */
  wallet(row: InstanceRow): Promise<WalletInterface>;
  /** The row's store, opened (the modules installed). */
  store(row: InstanceRow): Promise<Store>;
  /** A messagebox session as the row's wallet; absent: no delivery provider. */
  box?(row: InstanceRow, wallet: WalletInterface): MessageBox;
  /** Handle → Resolution for the runtime's `resolve` (hostResolver); identityKey "" when unknown. Absent: every resolve fails. */
  resolve?(handle: string, domain: string): Promise<Resolution>;
  /** Delivery poll interval; 0 = do not poll (tests call delivery.poll()). Default 1000. */
  pollMs?: number;
  /** How long the delivery retries a transiently failing send (messagebox.ts DEFAULT_RETRY). */
  retry?: Partial<RetryPolicy>;
  /** Lines, prefixed by the caller. */
  log?(handle: string, line: string): void;
  /** Tests: the clock entries are stamped with. */
  now?: () => Stamp;
}

/** A new instance's genesis config for a row: the seed subscriptions — the owner's boxes, then `chat` from anyone — and the owner's and the peer's names. */
export function configFor(row: Pick<InstanceRow, "handle" | "domain">, o: { owner: Identity; infer?: Identity; ownerHandle?: Named; inferHandle?: Named }): InstanceConfig {
  return {
    owner: o.owner, handle: row.handle, domain: row.domain,
    subscriptions: [...defaultSubscriptions(o.owner), OPEN_CHAT],
    peers: o.infer ? { infer: o.infer } : undefined,
    names: {
      [o.owner]: o.ownerHandle ?? { handle: "david", domain: "localhost" },
      ...(o.infer ? { [o.infer]: o.inferHandle ?? { handle: "infer", domain: "localhost" } } : {}),
    },
  };
}

export interface Running {
  row: InstanceRow;
  identity: Identity;
  store: Store;
  runtime: Runtime;
  tick: Tick;
  delivery?: Delivery;
  stop(): Promise<void>;
}

/**
 * Start one row: connect its wallet, open its store, write its genesis if the
 * store is empty, and wire its runtime to its own providers. Refuses a row
 * whose wallet is not the recorded identity or the genesis's, or whose genesis
 * names another host.
 */
export async function startInstance(row: InstanceRow, o: HostOptions): Promise<Running> {
  const say = (line: string) => o.log?.(row.handle, line);
  const wallet = await o.wallet(row);
  const identity = await rootIdentity(wallet);
  if (row.identity && row.identity !== identity) throw new Error(`wallet ${row.wallet_url} is ${short(identity)}, not the recorded identity ${short(row.identity)}`);
  const store = await o.store(row);
  try {
    if (!(await store.log.tip())) {
      if (!o.owner) throw new Error("an empty store needs the owner's identity key (SKEIN_OWNER) for its genesis");
      const g = await ensureGenesis(store, wallet, o.host, configFor(row, { ...o, owner: o.owner }), o.now?.());
      say(`genesis ${g.entry}`);
    }
    const g = await genesisOf(store);
    const hostKey = await rootIdentity(o.host);
    if (g.host !== hostKey) throw new Error(`the host wallet (${short(hostKey)}) is not this instance's host (${short(g.host)}): its entries would not verify`);
    if (g.identity !== identity) throw new Error(`the wallet (${short(identity)}) is not this instance's identity (${short(g.identity)})`);

    const runtime = new Runtime({ store, wallet, log: say });
    if (o.resolve) runtime.resolver = { resolve: o.resolve };
    const tick = new Tick({ runtime, host: o.host, log: say, now: o.now });
    tick.start();
    let delivery: Delivery | undefined;
    if (o.box) {
      delivery = new Delivery({ runtime, wallet, host: o.host, box: o.box(row, wallet), log: say, now: o.now, retry: o.retry });
      runtime.outbox = delivery;
    } else {
      say("no messagebox (SKEIN_MESSAGEBOX): nothing will be delivered");
    }
    await runtime.start();
    const poll = o.pollMs ?? 1000;
    if (delivery && poll > 0) delivery.start(poll);
    say(`${g.identity} (${g.handle}@${g.domain}) · owner ${short(g.owner)}${g.peers?.infer ? ` · infer ${short(g.peers.infer)}` : ""} · boxes ${(await runtime.boxes()).join(",")} · state ${(await runtime.tip())?.toString()}`);
    return {
      row, identity, store, runtime, tick, delivery,
      async stop() { await tick.stop(); await delivery?.stop(); await runtime.stop(); await store.close(); },
    };
  } catch (e) {
    await store.close();
    throw e;
  }
}

/** The BRC-169 handle-certificate type (§4.5): base64(SHA-256("metanet-handles handle certificate v1")). */
export const HANDLE_CERT_TYPE = "XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8=";

/**
 * The host's resolver, answering the `resolve` import with a Resolution the
 * runtime records whole. In order:
 *
 * 1. its own rows (`rows`, e.g. HostDb.identityOf): `{identityKey, via: "host"}`;
 * 2. BRC-169 (§5.1–5.2, §5.7): the domain's `/manifest.json`; if it publishes
 *    `metanet.handles`, `GET <resolve>?handle=<handle>` answers, final either
 *    way: `{...the response (identityKey, certificate, messagebox, ttl, …),
 *    via: "brc169", checked, unchecked}`. The certificate (BRC-52, §4.1) is
 *    checked against the manifest's certifier key (`metanet.trust.publicKey`)
 *    when there is one — type, certifier, subject = identityKey, the
 *    certificate signature, and fields.handle/domain when they are plaintext;
 *    any failure refuses the handle. Revocation (§4.2) is checked by no one
 *    yet: it is always in `unchecked`, meaning unknown, not revoked;
 * 3. last, for a domain whose manifest has no `metanet.handles` (or none at
 *    all) — BRC-169 forbids probing the well-known path then — the paymail
 *    PKI, `<origin>/bsvalias/id/handle@domain`, which `1sat serve` answers for
 *    every account: `{...its response, identityKey, via: "paymail"}`.
 *
 * `{identityKey: "", error}` when none knows the handle. A domain's origin is
 * the messagebox host's when one is configured (dev: one host serves every
 * domain it is asked about), else https://<domain>.
 */
export function hostResolver(rows: (handle: string, domain: string) => string | null | undefined, messagebox?: string, f: typeof fetch = fetch): (handle: string, domain: string) => Promise<Resolution> {
  const get = async (url: string) => {
    const res = await f(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    let body: unknown;
    try { body = await res.json(); } catch { body = undefined; }
    return { status: res.status, body: body && typeof body === "object" ? body as Record<string, unknown> : undefined };
  };
  return async (handle, domain) => {
    const known = rows(handle, domain);
    if (known) return { identityKey: known, via: "host" };
    const origin = messagebox ? new URL(messagebox).origin : `https://${domain}`;

    const manifest = await get(`${origin}/manifest.json`).catch(() => undefined);
    const metanet = manifest?.status === 200 ? manifest.body?.metanet as { trust?: { publicKey?: unknown }; handles?: { version?: unknown; resolve?: unknown } } | undefined : undefined;
    if (metanet?.handles && typeof metanet.handles === "object") {
      const h = metanet.handles;
      if (typeof h.version !== "string" || h.version.split(".")[0] !== "1") return { identityKey: "", via: "brc169", error: `manifest: metanet.handles version ${JSON.stringify(h.version)} is not 1.x` };
      const endpoint = typeof h.resolve === "string" ? h.resolve : `${origin}/.well-known/metanet-handles/resolve`;
      const r = await get(`${endpoint}?handle=${encodeURIComponent(handle)}`);
      if (r.status !== 200 || !r.body) {
        const e = (r.body?.error ?? {}) as { code?: unknown };
        return { identityKey: "", via: "brc169", error: `${endpoint}: ${r.status}${typeof e.code === "string" ? ` ${e.code}` : ""}`, ...(r.body ? { response: r.body } : {}) };
      }
      const certifier = typeof metanet.trust?.publicKey === "string" ? metanet.trust.publicKey : undefined;
      const v = await checkResolution(r.body, handle, domain, certifier);
      return v.error ? { identityKey: "", via: "brc169", error: v.error, response: r.body } : { ...r.body, identityKey: r.body.identityKey as string, via: "brc169", checked: v.checked, unchecked: v.unchecked };
    }

    const p = await get(`${origin}/bsvalias/id/${encodeURIComponent(handle)}@${encodeURIComponent(domain)}`).catch((e: Error) => ({ status: e.message, body: undefined }));
    const pubkey = p.status === 200 ? p.body?.pubkey : undefined;
    if (typeof pubkey === "string" && isIdentity(pubkey)) return { ...p.body, identityKey: pubkey, via: "paymail" };
    return { identityKey: "", error: `${handle}@${domain}: not a row here, no BRC-169 handles at ${origin}, no paymail (${p.status})` };
  };
}

/**
 * A §5.2 response for handle@domain, checked (§4.1) against the manifest's
 * certifier key when there is one. What was verified goes in `checked`, what
 * could not be in `unchecked`; `error` refuses it.
 */
export async function checkResolution(r: Record<string, unknown>, handle: string, domain: string, certifier?: string): Promise<{ checked: string[]; unchecked: string[]; error?: string }> {
  const checked: string[] = [], unchecked: string[] = [];
  const fail = (error: string) => ({ checked, unchecked, error });
  const key = r.identityKey;
  if (typeof key !== "string" || !isIdentity(key)) return fail("identityKey is not a compressed public key");
  if (r.revoked === true) return fail("revoked");
  if (String(r.handle).toLowerCase() !== handle.toLowerCase() || String(r.domain).toLowerCase() !== domain.toLowerCase()) return fail(`the response is for ${String(r.handle)}@${String(r.domain)}`);
  checked.push("echo");
  if (!certifier) {
    unchecked.push("certificate (the manifest publishes no certifier key)", "revocation");
    return { checked, unchecked };
  }
  const c = r.certificate as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return fail("certificate: none");
  if (c.type !== HANDLE_CERT_TYPE) return fail("certificate: not a BRC-169 handle certificate");
  if (c.certifier !== certifier) return fail(`certificate: certifier ${String(c.certifier)} is not the manifest's ${certifier}`);
  checked.push("certifier");
  if (c.subject !== key) return fail("certificate: subject is not identityKey");
  checked.push("subject");
  const out = c.revocationOutpoint as { txid?: unknown; vout?: unknown } | string | undefined;
  const outpoint = typeof out === "string" ? out : `${String(out?.txid)}.${String(out?.vout)}`;
  const fields = (c.fields ?? {}) as Record<string, string>;
  let ok = false;
  try {
    ok = await new Certificate(String(c.type), String(c.serialNumber), key, certifier, outpoint, fields, String(c.signature)).verify();
  } catch { /* a malformed certificate does not verify */ }
  if (!ok) return fail("certificate: the signature does not verify");
  checked.push("signature");
  // Plaintext fields (base64 of the value) are compared; BRC-52 encrypted ones (IV + ciphertext + tag: 48 bytes or more) need a keyring we are not given.
  for (const [name, want] of [["handle", handle], ["domain", domain]] as const) {
    const raw = typeof fields[name] === "string" ? Buffer.from(fields[name], "base64") : undefined;
    if (!raw) return fail(`certificate: no fields.${name}`);
    if (raw.length >= 48) { unchecked.push(`fields.${name} (encrypted)`); continue; }
    if (raw.toString("utf8").toLowerCase() !== want.toLowerCase()) return fail(`certificate: fields.${name} is ${JSON.stringify(raw.toString("utf8"))}, not ${JSON.stringify(want)}`);
    checked.push(`fields.${name}`);
  }
  unchecked.push("revocation");
  return { checked, unchecked };
}
