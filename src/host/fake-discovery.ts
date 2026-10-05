// A stand-in for the host skein's BRC-169 server, for tests and equivs that
// run no host skein (#113). On a host, the router's own origin's discovery
// requests go to the host skein's onboarding app (shruggr/skein-onboard),
// which answers from its records; a test host that only wants its agents
// and mailbox instances to find each other (the resolve program, the loop,
// the corpus) answers them here instead, from host.db, as the router did
// before #113: an agent's own identity, a mailbox instance's owner's, the
// instance's origin as the messagebox, a certificate signed by the
// certifier key with a serial number of the binding; and a registration
// (POST /account/register, the #113 contract: signed over `register
// <name>@<domain>`) answered with the mailbox instance the manager's create
// makes, without a certificate (the browser page's own mailbox). Not part of
// anything that runs (the router's `discovery` option is a test's).

import { Hash, ProtoWallet, Utils } from "@bsv/sdk";
import { issueHandleCertificate, RESOLVE_PATH, SEARCH_PATH } from "./handles.ts";
import type { HostDb } from "./instances.ts";
import type { Router, RouterRequest, RouterResponse } from "./router.ts";
import { domainOf, REGISTER_PROTOCOL } from "./router.ts";

const json = (status: number, v: unknown): RouterResponse => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(v)) });

/** The router's `discovery` option: manifest and resolve over host.db's rows. */
export function fakeDiscovery(db: HostDb, router: () => Router): (req: RouterRequest, url: URL) => Promise<RouterResponse | undefined> {
  return async (req, url) => {
    const r = router();
    if (req.method === "GET" && url.pathname === "/manifest.json") {
      const { publicKey } = await r.certifier.getPublicKey({ identityKey: true });
      return json(200, { metanet: { trust: { publicKey }, handles: { version: "1.0", resolve: `${r.origin()}${RESOLVE_PATH}`, search: `${r.origin()}${SEARCH_PATH}` } } });
    }
    if (req.method === "GET" && url.pathname === RESOLVE_PATH) {
      const q = (url.searchParams.get("handle") ?? "").replace(/^@/, "");
      const own = domainOf(url.hostname);
      const [h0, d] = q.includes("@") ? q.split("@") : [q, own];
      const handle = h0!.split("+")[0]!.toLowerCase(), domain = (d ?? own).toLowerCase();
      if (!handle) return json(400, { metanetHandles: "1.0", error: { code: "malformed-handle", message: "want ?handle=<handle>" } });
      const row = db.get(handle);
      const key = db.identityOf(handle, domain);
      if (!row || row.status !== "enabled" || !key) return json(404, { metanetHandles: "1.0", error: { code: "handle-not-found", message: `no handle ${handle}@${domain} here` } });
      const serial = Utils.toBase64(Hash.sha256(Utils.toArray(`${handle}@${domain} ${key}`, "utf8")));
      const c = await issueHandleCertificate(r.certifier, handle, domain, key, serial);
      const certificate = { type: c.type, serialNumber: c.serialNumber, subject: c.subject, certifier: c.certifier, revocationOutpoint: c.revocationOutpoint, fields: c.fields, signature: c.signature };
      return json(200, { metanetHandles: "1.0", handle, domain, identityKey: key, certificate, messagebox: r.originOf(handle), ttl: 300, revoked: false });
    }
    if (req.method === "POST" && url.pathname === "/account/register") {
      const b = JSON.parse(new TextDecoder().decode(req.body)) as { username: string; identityKey: string; signature: string };
      const domain = await r.handleDomain();
      const v = await new ProtoWallet("anyone").verifySignature({ protocolID: REGISTER_PROTOCOL, keyID: b.username, counterparty: b.identityKey, data: Utils.toArray(`register ${b.username}@${domain}`, "utf8"), signature: Utils.toArray(b.signature, "hex") }).catch(() => ({ valid: false }));
      if (!v.valid) return json(401, { error: "the signature does not verify for that identity" });
      try {
        const c = await r.createInstance(b.username, b.identityKey, { image: "mailbox", domain });
        return json(200, { handle: c.handle, domain, identityKey: b.identityKey, messagebox: c.url });
      } catch (e) { return json(409, { error: (e as Error).message }); }
    }
    return undefined;
  };
}
