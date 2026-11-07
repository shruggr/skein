// The equivs' hosted inboxes: a router of its own (the inboxes' host) whose host skein — the host image:
// onboard and the messagebox app — keeps the mail of keys outside the agents' host (the owner, the
// inference peer): each key registered as a handle there, read at the messagebox URL its handle resolves
// to. The agents' host keeps no host skein, so its fake discovery still resolves its own instances; it
// names the inbox handles with their messagebox here (`elsewhere`), as a registrar answers a handle whose
// messagebox is elsewhere, and delivers to them over real http (`http`).

import * as fs from "node:fs/promises";
import { join } from "node:path";
import { AuthFetch, PrivateKey, ProtoWallet, Utils } from "@bsv/sdk";
import { HostDb } from "../../src/host/instances.ts";
import type { HttpRequest, HttpResponse } from "../../src/host/providers.ts";
import { fetchHttp, REGISTER_PROTOCOL, Router } from "../../src/host/router.ts";
import { Signer } from "../../src/host/signer.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { routerStore, specFor } from "./backend.ts";

export interface Inboxes {
  router: Router;
  base: string;
  /** The host skein's store, as the kernel's tools name it (replayed once the router has stopped). */
  spec: string;
  /** `key` registered as `handle` (POST /account/register over its session, signed over `register <handle>@localhost`): its messagebox URL. */
  register(key: PrivateKey, handle: string): Promise<string>;
  /** An agents' host's http beyond its own: this host's URLs for real, nothing else. */
  http(req: HttpRequest): Promise<HttpResponse>;
  stop(): Promise<void>;
}

/** The inboxes' host at `home` (made empty), its kernel `command`, its host skein born from the host image. */
export async function inboxes(home: string, o: { command?: string; operator?: PrivateKey; log?(src: string, line: string): void } = {}): Promise<Inboxes> {
  await fs.rm(home, { recursive: true, force: true });
  await fs.mkdir(home, { recursive: true });
  const db = new HostDb(join(home, "host.db"));
  const operator = o.operator ?? PrivateKey.fromRandom();
  const owner = operator.toPublicKey().toString();
  const router: Router = new Router({
    db, walletFor: () => ephemeralWallet(operator), home, providerKeyFor: (n) => new Signer(new PrivateKey("b0b0b0", 16)).providerKey(n),
    owner, idleMs: 0, ledgerMs: 3_600_000, kernel: { ...(o.command ? { command: o.command } : {}), env: { SKEIN_HOME: home } }, ...routerStore(home),
    log: (src, l) => o.log?.(`inboxes ${src}`, l),
  });
  await router.listen(0);
  const base = `http://127.0.0.1:${router.port}`;
  await router.createInstance("host", owner, { host: true, appConfig: { onboard: { onboard: { domain: "localhost", origin: base, messagebox: `${router.originOf("host")}/messagebox` } } } });
  await router.hydrate("host");
  await router.settled();
  return {
    router, base, spec: specFor(home, "host"),
    async register(key, handle) {
      const { signature } = await new ProtoWallet(key).createSignature({ protocolID: REGISTER_PROTOCOL, keyID: handle, counterparty: "anyone", data: Utils.toArray(`register ${handle}@localhost`, "utf8") });
      const r = await new AuthFetch(ephemeralWallet(key)).fetch(`${base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: handle, identityKey: key.toPublicKey().toString(), signature: Utils.toHex(signature) }) });
      const a = await r.json() as { messagebox?: string; error?: string };
      if (r.status !== 200 || !a.messagebox) throw new Error(`register ${handle}: HTTP ${r.status} ${a.error ?? ""}`);
      await router.settled();
      return a.messagebox;
    },
    async http(req) {
      if (new URL(req.url).port === String(router.port)) return await fetchHttp(req);
      throw new Error(`this host answers no http beyond its own (${req.url})`);
    },
    async stop() { await router.settled(); await router.stop(); db.close(); },
  };
}
